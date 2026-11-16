/**
 * Byte-preserving zip rewrite for the browser save path.
 *
 * The desktop build spliced patched entries back into the archive with the
 * Rust sidecar's `save_archive` (raw copy of untouched entries, deflate of
 * touched/added ones). This module does the same in the browser:
 *
 *  - scan the source zip's local headers + central directory (raw offsets);
 *  - inflate only the entries the save planner reads;
 *  - assemble the output by copying every untouched entry's local header and
 *    compressed bytes VERBATIM (so CRC-32, sizes and the compressed bytes are
 *    identical), re-deflating replaced entries and appending additions;
 *  - verify with the gateway's fail-closed `assertManifestPreserved`.
 */

import { decompressionStream, streamBytes } from '@genoffice/zip-gate'

import { assertManifestPreserved, planWorkbookSave, archiveEntrySchema, type ArchiveEntry, type StreamingSaveRequest } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import type { EntrySource, MutationPlan } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { normalizeOoxmlPartPrefix } from '@genoffice/xlsx-gateway/gateway/xlsx-namespace'
import { MAX_PATCH_ENTRY_BYTES } from '@genoffice/xlsx-gateway/shared/edit-schemas'

// ── raw zip scanning ─────────────────────────────────────────────────────────

interface RawPart {
  name: string
  /** offset of the local header */
  localHeaderOffset: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  /** raw compressed bytes (a view into the source) */
  data: Uint8Array
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const FLAG_ENCRYPTED = 0x1

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function u64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true)
}

/**
 * Scan the central directory. Zip64 extended fields are read for offsets and
 * sizes when present (the reader consumes zip64 archives; the WRITER only
 * produces classic 32-bit archives — workbook sizes stay far under 4 GB).
 */
function scanCentralDirectory(bytes: Uint8Array): { parts: RawPart[]; names: string[]; bytes: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // locate EOCD from the tail (comment ≤ 65535 + fixed 22)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_536); i--) {
    if (u32(view, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).')
  const entryCount = u16(view, eocd + 10)
  let cdOffset = u32(view, eocd + 16)
  // zip64 locator?
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const locatorOffset = eocd - 20
    if (locatorOffset >= 0 && u32(view, locatorOffset) === 0x07064b50) {
      const zip64Eocd = Number(u64(view, locatorOffset + 8))
      if (u32(view, zip64Eocd) === 0x06064b50) {
        const count64 = u64(view, zip64Eocd + 32)
        cdOffset = Number(u64(view, zip64Eocd + 48))
        const parts: RawPart[] = []
        let offset = cdOffset
        for (let index = 0; index < count64; index++) {
          const part = readCentralEntry(view, bytes, offset)
          if (part) parts.push(part)
          offset += 46 + u16(view, offset + 28) + u16(view, offset + 30) + u16(view, offset + 32)
        }
        return { parts, names: parts.map((p) => p.name), bytes }
      }
    }
    throw new Error('Zip64 end-of-central-directory not found.')
  }
  const parts: RawPart[] = []
  let offset = cdOffset
  for (let index = 0; index < entryCount; index++) {
    if (u32(view, offset) !== CENTRAL_SIG) break
    const part = readCentralEntry(view, bytes, offset)
    if (part) parts.push(part)
    offset += 46 + u16(view, offset + 28) + u16(view, offset + 30) + u16(view, offset + 32)
  }
  return { parts, names: parts.map((p) => p.name), bytes }
}

function readCentralEntry(view: DataView, bytes: Uint8Array, offset: number): RawPart | null {
  if (u32(view, offset) !== CENTRAL_SIG) return null
  const flags = u16(view, offset + 8)
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new Error('The workbook is encrypted — the browser build cannot open it.')
  }
  const method = u16(view, offset + 10)
  const crc32 = u32(view, offset + 16)
  let compressedSize = u32(view, offset + 20)
  let uncompressedSize = u32(view, offset + 24)
  const nameLength = u16(view, offset + 28)
  const extraLength = u16(view, offset + 30)
  const commentLength = u16(view, offset + 32)
  const localHeaderOffset = u32(view, offset + 42)
  const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
  // zip64 extra field (header id 0x0001)
  let extraOffset = offset + 46 + nameLength
  const extraEnd = extraOffset + extraLength
  while (extraOffset + 4 <= extraEnd) {
    const headerId = u16(view, extraOffset)
    const size = u16(view, extraOffset + 2)
    if (headerId === 0x0001) {
      let field = extraOffset + 4
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = Number(u64(view, field))
        field += 8
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = Number(u64(view, field))
        field += 8
      }
      if (localHeaderOffset === 0xffffffff) break // writer-side offset unused
      break
    }
    extraOffset += 4 + size
  }
  const data = bytes.subarray(localHeaderOffset + 30 + nameLength + u16(view, localHeaderOffset + 28), localHeaderOffset + 30 + nameLength + u16(view, localHeaderOffset + 28) + compressedSize)
  return { name, localHeaderOffset, method, crc32, compressedSize, uncompressedSize, data }
}

// ── inflate / deflate / crc ──────────────────────────────────────────────────

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const reader = streamBytes(data).pipeThrough(decompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const done = await reader.read()
    if (done.done) break
    chunks.push(done.value)
    total += done.value.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // the DOM type for CompressionStream does not match the pair overload; same cast zip-gate uses for DecompressionStream
  const stream = new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  const reader = readable.pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const done = await reader.read()
    if (done.done) break
    chunks.push(done.value)
  }
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── the source reader (EntrySource for the save planner) ─────────────────────

export interface WorkbookSource {
  bytes: Uint8Array
  parts: RawPart[]
}

/** Read the raw part table of an xlsx buffer (fail-closed on encrypted parts). */
export function openWorkbookSource(bytes: Uint8Array): WorkbookSource {
  return scanCentralDirectory(bytes)
}

const textDecoder = new TextDecoder('utf-8')

/** An `EntrySource` over the raw parts: planner reads inflate lazily + cached. */
export function createEntrySource(source: WorkbookSource): EntrySource {
  const byName = new Map(source.parts.map((part) => [part.name, part]))
  const textCache = new Map<string, string>()
  return {
    paths: async () => source.parts.map((part) => part.name),
    has: async (path) => byName.has(path),
    canPatch: async (path) => (byName.get(path)?.uncompressedSize ?? 0) <= MAX_PATCH_ENTRY_BYTES,
    containsText: async (path, needle) => {
      const text = await textOf(path)
      return text.includes(needle)
    },
    releaseText: (path) => {
      textCache.delete(path)
    },
    readText: async (path) => textOf(path),
  }

  async function textOf(path: string): Promise<string> {
    const cached = textCache.get(path)
    if (cached !== undefined) return cached
    const part = byName.get(path)
    if (!part) throw new Error(`Workbook is missing ${path}.`)
    if (part.uncompressedSize > MAX_PATCH_ENTRY_BYTES) {
      throw new Error(
        `${path} is ${part.uncompressedSize} bytes uncompressed — too large to edit. ` +
          'Entries above 500MB can be preserved but not patched.',
      )
    }
    const inflated =
      part.method === 0 ? part.data : await inflateRaw(part.data)
    const text = normalizeOoxmlPartPrefix(textDecoder.decode(inflated))
    textCache.set(path, text)
    return text
  }
}

// ── the byte-preserving assembler ────────────────────────────────────────────

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f)
  const d =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
  return { time, date: d }
}

/**
 * Assemble the saved archive: untouched entries are copied verbatim (local
 * header + compressed bytes), replaced entries are re-deflated, additions are
 * appended, removals are dropped, and a fresh central directory is written.
 */
async function assemble(source: WorkbookSource, plan: MutationPlan): Promise<Uint8Array> {
  const replaced = plan.replaced
  const added = plan.added
  const addedBinary = plan.addedBinary ?? new Map()
  const removed = new Set(plan.removedEntries)
  const touched = new Set(plan.touchedEntries)

  const chunks: Uint8Array[] = []
  const centralRecords: {
    name: string
    crc32: number
    compressedSize: number
    uncompressedSize: number
    method: number
    localHeaderOffset: number
  }[] = []
  let offset = 0

  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk)
    offset += chunk.length
  }

  const writeDeflated = async (name: string, content: string | Uint8Array): Promise<void> => {
    const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const compressed = raw.length >= 128 ? await deflateRaw(raw) : raw
    const useStored = compressed.length >= raw.length
    const payload = useStored ? raw : compressed
    const method = useStored ? 0 : 8
    const crc = crc32(raw)
    const { time, date } = dosDateTime(new Date())
    const entryStart = offset
    const header = new Uint8Array(30 + name.length)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, LOCAL_SIG, true)
    headerView.setUint16(4, 20, true) // version needed
    headerView.setUint16(6, 0x0800, true) // UTF-8 names
    headerView.setUint16(8, method, true)
    headerView.setUint16(10, time, true)
    headerView.setUint16(12, date, true)
    headerView.setUint32(14, crc, true)
    headerView.setUint32(18, payload.length, true)
    headerView.setUint32(22, raw.length, true)
    headerView.setUint16(26, name.length, true)
    headerView.setUint16(28, 0, true)
    header.set(new TextEncoder().encode(name), 30)
    push(header)
    push(payload)
    centralRecords.push({ name, crc32: crc, compressedSize: payload.length, uncompressedSize: raw.length, method, localHeaderOffset: entryStart })
  }

  const writeRaw = async (part: RawPart): Promise<void> => {
    // copy the local header verbatim, then the raw compressed bytes verbatim
    const view = new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength)
    const nameLength = u16(view, part.localHeaderOffset + 26)
    const extraLength = u16(view, part.localHeaderOffset + 28)
    const headerLength = 30 + nameLength + extraLength
    const entryStart = offset
    push(source.bytes.subarray(part.localHeaderOffset, part.localHeaderOffset + headerLength))
    push(part.data)
    centralRecords.push({
      name: part.name,
      crc32: part.crc32,
      compressedSize: part.compressedSize,
      uncompressedSize: part.uncompressedSize,
      method: part.method,
      localHeaderOffset: entryStart,
    })
  }

  const touchedOrRemoved = new Set([...touched, ...removed])
  for (const part of source.parts) {
    if (touchedOrRemoved.has(part.name)) continue
    await writeRaw(part)
  }

  const encoder = new TextEncoder()
  for (const [name, content] of replaced) {
    await writeDeflated(name, content)
  }
  for (const [name, content] of added) {
    await writeDeflated(name, content)
  }
  for (const [name, bytes] of addedBinary) {
    await writeDeflated(name, bytes)
  }

  // central directory
  const cdStart = offset
  for (const record of centralRecords) {
    const extra = new Uint8Array(0)
    const recordBytes = new Uint8Array(46 + record.name.length + extra.length)
    const recordView = new DataView(recordBytes.buffer)
    recordView.setUint32(0, CENTRAL_SIG, true)
    recordView.setUint16(4, 20, true) // made by
    recordView.setUint16(6, 20, true) // needed
    recordView.setUint16(8, 0x0800, true) // UTF-8 flag
    recordView.setUint16(10, record.method, true)
    recordView.setUint16(12, 0, true) // time (unused for preservation checks)
    recordView.setUint16(14, 0, true) // date
    recordView.setUint32(16, record.crc32, true)
    recordView.setUint32(20, record.compressedSize, true)
    recordView.setUint32(24, record.uncompressedSize, true)
    recordView.setUint16(28, record.name.length, true)
    recordView.setUint16(30, extra.length, true)
    recordView.setUint16(32, 0, true)
    recordView.setUint16(34, 0, true)
    recordView.setUint16(36, 0, true)
    recordView.setUint16(38, 0, true)
    recordView.setUint32(42, record.localHeaderOffset, true)
    recordBytes.set(encoder.encode(record.name), 46)
    push(recordBytes)
  }
  const cdSize = offset - cdStart

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, EOCD_SIG, true)
  eocdView.setUint16(8, centralRecords.length, true)
  eocdView.setUint16(10, centralRecords.length, true)
  eocdView.setUint32(12, cdSize, true)
  eocdView.setUint32(16, cdStart, true)
  push(eocd)

  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

/**
 * Plan + assemble + verify one save. `sourceBytes` are the ORIGINAL workbook
 * bytes this session opened (stale-buffer saves fail the manifest check).
 */
export async function saveWorkbookBytes(
  sourceBytes: Uint8Array,
  request: StreamingSaveRequest,
): Promise<{ buffer: Uint8Array; touchedEntries: readonly string[]; removedEntries: readonly string[]; addedEntries: readonly string[] }> {
  const source = openWorkbookSource(sourceBytes)
  const before: ArchiveEntry[] = source.parts.map((part) => ({
    name: part.name,
    crc32: part.crc32,
    compressedSize: part.compressedSize,
    uncompressedSize: part.uncompressedSize,
  }))
  for (const entry of before) archiveEntrySchema.parse(entry)
  const entrySource = createEntrySource(source)
  const plan = await planWorkbookSave(entrySource, request)
  const buffer = await assemble(source, plan)
  const after = openWorkbookSource(buffer).parts.map((part) => ({
    name: part.name,
    crc32: part.crc32,
    compressedSize: part.compressedSize,
    uncompressedSize: part.uncompressedSize,
  }))
  // fail closed: any undeclared difference aborts the save
  assertManifestPreserved(plan, before, after)
  return {
    buffer,
    touchedEntries: plan.touchedEntries,
    removedEntries: plan.removedEntries,
    addedEntries: plan.addedEntries,
  }
}
