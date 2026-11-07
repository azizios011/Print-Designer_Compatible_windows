/**
 * Browser adapter for the GenOffice PDF renderer.
 *
 * Implements the same `PdfApi` surface the Electron preload exposed
 * (window.pdfApi), but everything runs in the browser:
 *  - viewing/decryption → pdf.js (already renderer-side upstream)
 *  - page operations (merge/insert/split/extract/resize/crop) → pdf-lib,
 *    byte transforms copied from the upstream main-process module
 *  - file open/save → whitelisted Frappe methods over the File doctype
 *  - a session in-memory store (`gen:` paths) holds locally picked and
 *    freshly generated documents
 *
 * Features that genuinely need the Electron main process (pdfium text
 * editing, OCR, digital certificates, CUPS printing, office conversion)
 * report a structured failure the UI already surfaces as a toast.
 */

import type { PdfApi, SavedSignature } from '../shared/ipc'
import { fromBase64, fetchFrappeFile, saveFrappeFile, toBase64, bootstrap } from './frappe'
import {
  frappePath,
  genPath,
  parseFrappePath,
  vfsGet,
  vfsHas,
  vfsPathName,
  vfsPut,
} from './vfs'
import {
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  insertPdfBytes,
  mergePagesBytes,
  mergePdfBytes,
  replacePagesBytes,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
} from './page-ops'
import { PDFDocument, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { DOC_OPTS } from '../renderer/view-config'

const UNSUPPORTED_MAIN_ONLY =
  'This feature needs the desktop build (PDFium engine) and is not available in the browser yet'

// ── session context ──────────────────────────────────────────────────────────

let consumed = false
/** attachment context of the opened Frappe file, for attaching generated files to the same document */
let sourceAttachment: { doctype: string | null; name: string | null } | null = null

// ── path/bytes plumbing ──────────────────────────────────────────────────────

async function readBytes(path: string): Promise<Uint8Array> {
  const frappe = parseFrappePath(path)
  if (frappe) {
    const data = await fetchFrappeFile(frappe.docname)
    if (data.attachedToDoctype) {
      sourceAttachment = { doctype: data.attachedToDoctype, name: data.attachedToName }
    }
    return fromBase64(data.contentBase64)
  }
  const local = vfsGet(path)
  if (local) return local
  throw new Error(`Unknown document path: ${path}`)
}

async function writeBack(path: string, bytes: Uint8Array): Promise<void> {
  const frappe = parseFrappePath(path)
  if (frappe) {
    await saveFrappeFile({
      file: frappe.docname,
      fileName: frappe.name,
      contentBase64: toBase64(bytes),
    })
    return
  }
  if (vfsHas(path)) {
    vfsPut(path, bytes)
    return
  }
  throw new Error(`Cannot write to path: ${path}`)
}

/** Create a new Frappe File (attached like the source document when known) and return its editor path */
async function newFrappeFile(name: string, bytes: Uint8Array): Promise<string> {
  const result = await saveFrappeFile({
    fileName: name,
    contentBase64: toBase64(bytes),
    attachedToDoctype: sourceAttachment?.doctype ?? null,
    attachedToName: sourceAttachment?.name ?? null,
    isPrivate: true,
  })
  return frappePath(result.docname, result.name)
}

/** Mirror of the main process's openGeneratedPdf: reload this editor on the generated file */
function openGenerated(path: string): void {
  const frappe = parseFrappePath(path)
  const fileParam = frappe ? frappe.docname : encodeURIComponent(path)
  window.setTimeout(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('file', fileParam)
    window.location.replace(url.toString())
  }, 150)
}

// ── pickers ──────────────────────────────────────────────────────────────────

function pickFiles(multiple: boolean, accept = 'application/pdf,.pdf'): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]
      input.remove()
      resolve(files)
    })
    // cancellation: the change event never fires
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (input.isConnected && (input.files?.length ?? 0) === 0) {
            input.remove()
            resolve([])
          }
        }, 1000)
      },
      { once: true },
    )
  })
}

function pickPdfBytes(multiple: false): Promise<{ name: string; bytes: Uint8Array } | null>
function pickPdfBytes(multiple: true): Promise<{ name: string; bytes: Uint8Array }[]>
async function pickPdfBytes(
  multiple: boolean,
): Promise<{ name: string; bytes: Uint8Array }[] | { name: string; bytes: Uint8Array } | null> {
  const files = await pickFiles(multiple)
  if (files.length === 0) return null
  const picked = await Promise.all(
    files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  )
  return multiple ? picked : picked[0]!
}

// ── pdf.js text extraction (Compare feature) ─────────────────────────────────

async function extractTextPages(
  bytes: Uint8Array,
  password?: string,
): Promise<{ pageCount: number; pages: string[] }> {
  const doc = await getDocument({ data: bytes.slice(), password, ...DOC_OPTS }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim(),
    )
  }
  return { pageCount: doc.numPages, pages }
}

// ── pdf-lib page-op pieces used by save() ────────────────────────────────────

async function applyPageOps(
  bytes: Uint8Array,
  opts: {
    blankPages?: { pageIndex: number; width: number; height: number }[]
    rotations?: { pageIndex: number; delta: number }[]
    deletedPages?: number[]
    pageOrder?: number[]
  },
): Promise<Uint8Array> {
  let doc = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const blank of opts.blankPages ?? []) {
    const at = Math.min(Math.max(blank.pageIndex + 1, 0), doc.getPageCount())
    doc.insertPage(at, [blank.width, blank.height])
  }
  for (const { pageIndex, delta } of opts.rotations ?? []) {
    const page = doc.getPage(pageIndex)
    const current = (((page.getRotation().angle % 360) + 360) % 360) as number
    page.setRotation(degrees((current + delta) % 360))
  }
  for (const pageIndex of [...(opts.deletedPages ?? [])].sort((a, b) => b - a)) {
    if (pageIndex >= 0 && pageIndex < doc.getPageCount()) doc.removePage(pageIndex)
  }
  if (opts.pageOrder !== undefined) {
    const src = doc
    const out = await PDFDocument.create()
    const copied = await out.copyPages(src, opts.pageOrder)
    for (const p of copied) out.addPage(p)
    doc = out
  }
  return doc.save({ useObjectStreams: false })
}

/** Layers this build cannot materialize in the browser (they need the PDFium engine) */
const UNSAVEDABLE_KEYS = [
  'markups',
  'annotDeletes',
  'drawings',
  'noteEdits',
  'formValues',
  'stamps',
  'textEdits',
  'textInserts',
  'imageEdits',
  'redactions',
  'staticFormFills',
  'formWidgetEdits',
  'formFields',
  'attachments',
  'outline',
  'encryption',
] as const

// ── saved signature stamps (localStorage stand-in for the main-process store) ─

const SIG_STORE_KEY = 'pdf-editor-saved-signatures'

function readSignatures(): SavedSignature[] {
  try {
    return JSON.parse(localStorage.getItem(SIG_STORE_KEY) ?? '[]') as SavedSignature[]
  } catch {
    return []
  }
}

function writeSignatures(list: SavedSignature[]): void {
  localStorage.setItem(SIG_STORE_KEY, JSON.stringify(list.slice(0, 20)))
}

// ── the adapter ──────────────────────────────────────────────────────────────

export const pdfApi: PdfApi = {
  async consumePending() {
    if (consumed) return null
    consumed = true
    const { file } = await bootstrap()
    if (!file) return null
    const frappe = parseFrappePath(file) ?? null
    // the desk page passes the File docname; carry a display name if it hands one over
    if (frappe) return file
    try {
      const data = await fetchFrappeFile(file)
      return frappePath(data.docname, data.name)
    } catch {
      return null
    }
  },

  async openSourcePath() {
    // shell-routed document navigation has no browser equivalent
  },

  async readFile(path) {
    const bytes = await readBytes(path)
    // hand the caller its own copy: pdf.js transfers the buffer to its worker
    return bytes.slice().buffer
  },

  async readFileChunk(path, start, end) {
    const bytes = await readBytes(path)
    return { data: bytes.slice(start, end), fileSize: bytes.length }
  },

  async decryptPdf() {
    return {
      ok: false,
      reason: 'Encrypted PDFs cannot be unlocked for editing in the browser build yet',
    }
  },

  async compareReadPdf() {
    const picked = await pickPdfBytes(false)
    if (!picked) return { ok: false, canceled: true }
    try {
      const { pageCount, pages } = await extractTextPages(picked.bytes)
      return { ok: true, name: picked.name, pageCount, pages }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  async compareReadOpen(path, password) {
    try {
      const bytes = await readBytes(path)
      const { pageCount, pages } = await extractTextPages(bytes, password)
      const frappe = parseFrappePath(path)
      return {
        ok: true,
        name: frappe ? frappe.name : vfsPathName(path),
        pageCount,
        pages,
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  async pickAttachmentFile() {
    const picked = await pickPdfBytes(false)
    if (!picked) return { ok: false, cancelled: true }
    return { ok: true, name: picked.name, bytesBase64: toBase64(picked.bytes) }
  },

  async exportAttachment(_path, name, bytesBase64) {
    const blob = new Blob([fromBase64(bytesBase64).slice().buffer], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true, targetPath: name }
  },

  async reduceFileSize() {
    return { ok: false, reason: UNSUPPORTED_MAIN_ONLY }
  },

  async save(request) {
    try {
      const hasUnsavableLayer = UNSAVEDABLE_KEYS.some((key) => {
        const value = (request as unknown as Record<string, unknown>)[key]
        return Array.isArray(value) ? value.length > 0 : value !== undefined
      })
      if (hasUnsavableLayer) {
        return {
          ok: false,
          error:
            'This edit layer (markup, text, form, protection, …) is not saved by the browser build yet',
        }
      }
      let bytes = await readBytes(request.path)
      bytes = await applyPageOps(bytes, {
        blankPages: request.blankPages,
        rotations: request.rotations,
        deletedPages: request.deletedPages,
        pageOrder: request.pageOrder,
      })
      const meta = request.metadata
      if (meta || request.pageOrder !== undefined) {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false })
        if (meta) {
          if (meta.title !== undefined) doc.setTitle(meta.title)
          if (meta.author !== undefined) doc.setAuthor(meta.author)
          if (meta.subject !== undefined) doc.setSubject(meta.subject)
          doc.setModificationDate(new Date())
        }
        bytes = await doc.save({ useObjectStreams: false })
      }
      await writeBack(request.path, bytes)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async requestRedactionCopy() {
    // Permanent redaction is a main-process rewrite in upstream; refuse it here
    return false
  },

  async autoRename() {
    // File names belong to the Frappe File document; no auto-rename in the browser
    return { renamed: false }
  },

  async isUntitled() {
    return false
  },

  async validateTextEdits() {
    return []
  },

  async listEditFonts() {
    return []
  },

  async canDrawText() {
    return false
  },

  async listPageImages() {
    return []
  },

  async listStaticFormFills() {
    return []
  },

  async pageImagePng() {
    return null
  },

  async pagePreviewPng() {
    return null
  },

  extractPages: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const out = await extractPagesBytes(bytes, request.pages)
      const savedPath = await newFrappeFile(uniqueName(request.suggestedName), out)
      openGenerated(savedPath)
      return { ok: true, savedPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  insertPdf: async (request) => {
    const picked = await pickPdfBytes(false)
    if (!picked) return { ok: true, canceled: true }
    try {
      const bytes = await readBytes(request.path)
      const { merged, count } = await insertPdfBytes(
        bytes,
        picked.bytes,
        typeof request.afterPageIndex === 'number' ? request.afterPageIndex : -1,
      )
      await writeBack(request.path, merged)
      return { ok: true, insertedCount: count }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  insertBlankPage: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const merged = await insertBlankPageBytes(
        bytes,
        typeof request.afterPageIndex === 'number' ? request.afterPageIndex : -1,
      )
      await writeBack(request.path, merged)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  splitPdf: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const parts = await splitPdfBytes(bytes, request.chunkSize)
      for (let i = 0; i < parts.length; i++) {
        await newFrappeFile(`${request.baseName}-${i + 1}.pdf`, parts[i]!)
      }
      return { ok: true, savedDir: '', count: parts.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  mergePdf: async (request) => {
    const picked = await pickPdfBytes(true)
    if (!picked || picked.length === 0) return { ok: true, canceled: true }
    try {
      const bytes = await readBytes(request.path)
      const { merged, appended } = await mergePdfBytes(
        bytes,
        picked.map((p) => p.bytes),
      )
      const savedPath = await newFrappeFile(uniqueName(request.suggestedName), merged)
      openGenerated(savedPath)
      return { ok: true, savedPath, appendedCount: appended }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  mergePages: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const merged = await mergePagesBytes(bytes, {
        perSheet: request.perSheet,
        direction: request.direction === 'horizontal' ? 'horizontal' : 'vertical',
        separator: request.separator === true,
      })
      const savedPath = await newFrappeFile(uniqueName(request.suggestedName), merged)
      openGenerated(savedPath)
      return { ok: true, savedPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  replacePages: async (request) => {
    const picked = await pickPdfBytes(false)
    if (!picked) return { ok: true, canceled: true }
    try {
      const bytes = await readBytes(request.path)
      const { merged, removed, inserted } = await replacePagesBytes(bytes, picked.bytes, request.pages)
      await writeBack(request.path, merged)
      return { ok: true, removed, inserted }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  setPageSize: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const merged = await setPageSizeBytes(bytes, request.width, request.height)
      await writeBack(request.path, merged)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  splitPages: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const merged = await splitPagesBytes(bytes, request.perPage)
      const savedPath = await newFrappeFile(uniqueName(request.suggestedName), merged)
      openGenerated(savedPath)
      return { ok: true, savedPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  cropPages: async (request) => {
    try {
      const bytes = await readBytes(request.path)
      const merged = await cropPagesBytes(bytes, request.pages, request.rect)
      await writeBack(request.path, merged)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  exportImages: async (request) => {
    const mime = request.format === 'jpg' ? 'image/jpeg' : 'image/png'
    const ext = request.format === 'jpg' ? 'jpg' : 'png'
    for (let i = 0; i < request.images.length; i++) {
      const blob = new Blob([fromBase64(request.images[i]!).slice().buffer], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${request.baseName}-p${request.pageNumbers[i] ?? i + 1}.${ext}`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
    return { ok: true, savedDir: 'Downloads', count: request.images.length }
  },

  async convertOffice() {
    throw new Error(UNSUPPORTED_MAIN_ONLY)
  },

  async listSavedSignatures() {
    return readSignatures()
  },

  async addSavedSignature(data) {
    const list = readSignatures()
    list.unshift({ id: `sig-${Date.now()}`, createdAt: Date.now(), data })
    writeSignatures(list)
    return list
  },

  async removeSavedSignature(id) {
    const list = readSignatures().filter((s) => s.id !== id)
    writeSignatures(list)
    return list
  },

  async getUsername() {
    const { fullName } = await bootstrap()
    return fullName || 'user'
  },

  onUsernameChanged() {
    return () => {}
  },

  setDirty() {
    // no shell to mirror dirty state to
  },

  onCloseSaveRequest() {
    return () => {}
  },

  sendCloseSaveResult() {},

  onSaveAsRequest() {
    return () => {}
  },

  sendSaveAsResult() {},

  onSaveAsFlow() {
    return () => {}
  },

  onPrintRequest() {
    return () => {}
  },

  async print() {
    return { ok: false, error: 'Printing is not available in the browser build yet' }
  },

  async printFile() {
    return { ok: false, error: 'Printing is not available in the browser build yet' }
  },

  async listPrinters() {
    return []
  },

  async printerOptions() {
    return []
  },

  onFileRenamed() {
    return () => {}
  },

  async getLanguage() {
    return (await bootstrap()).lang
  },

  onLanguageChanged() {
    return () => {}
  },

  async getTheme() {
    return 'system'
  },

  onThemeChanged() {
    return () => {}
  },
}

/** Sanitize a suggested file name for the Frappe File doctype */
function uniqueName(suggested: string): string {
  const base = (suggested || 'document.pdf').replace(/[\\/:*?"<>|]/g, '_')
  return base.endsWith('.pdf') ? base : `${base}.pdf`
}

// Expose under the same global the preload used; the renderer types it via env.d.ts
window.pdfApi = pdfApi
