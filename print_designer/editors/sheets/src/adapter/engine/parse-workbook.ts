/**
 * Workbook assembler: an xlsx/xlsm byte buffer in, the `WorkbookFile`
 * metadata + parsed sheets out — the same shapes the desktop sidecar streamed
 * (see PORTING.md). Held fully in memory; sized for accounting workbooks.
 */

import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'
import { offsetFormulaRefs } from '@genoffice/xlsx-gateway/domain/formula-shift'
import { decodeEntities } from './xml-utils'

import { applyTint, normalFontName, parseStyleParts, parseStyles, parseTheme } from './styles'
import {
  columnLabelToIndex,
  parseCellRef,
  parseSqref,
  parseWorksheet,
  readRange,
  takeSharedFormulaRecords,
  type CellRecord,
  type CellArea,
  type ParsedSheet,
} from './worksheet'
import { attr, attrBool, attrInt, decodeEntities as decodeXml, eachElement, elementText, firstElement, readAttrs } from './xml-utils'
import type { WorkbookFile, WorkbookVisualObject } from '../../shared/desktop-api'

export interface ParsedWorkbook {
  file: WorkbookFile
  sheets: Map<string, ParsedSheet>
  /** zip part bytes by name, for media reads and the save splice */
  entries: Map<string, Uint8Array>
  originalBytes: Uint8Array
}

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_PARTS = 10_000

export class WorkbookParseError extends Error {}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
  await assertZipInflatesWithinLimits(bytes, { maxParts: MAX_PARTS, maxPartBytes: MAX_PACKAGE_BYTES, maxTotalBytes: MAX_PACKAGE_BYTES })
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const count = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir).length
  if (count > MAX_PARTS) throw new WorkbookParseError('Workbook contains too many ZIP entries.')
  return zip
}

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path)
  if (!file) return null
  return file.async('string')
}

/** Package-relative form of a ZIP entry name (null when it escapes the root). */
function canonicalEntryName(raw: string): string | null {
  if (raw.includes('\0')) return null
  const segments: string[] = []
  for (const segment of raw.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.pop() === undefined) return null
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

interface WorkbookRel {
  id: string
  type: string
  target: string
  targetIsExternal: boolean
}

const REL_WORKSHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
const REL_SHARED_STRINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings'
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing'
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const REL_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'
const REL_PIVOT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable'
const REL_PIVOT_CACHE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition'

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return canonicalEntryName(target.slice(1)) ?? target.slice(1)
  const parts = `${baseDir}/${target}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function parseRels(relsXml: string, baseDir: string): WorkbookRel[] {
  const rels: WorkbookRel[] = []
  eachElement(relsXml, 'Relationship', (tag) => {
    const attrs = readAttrs(tag)
    const id = attr(attrs, 'Id')
    const type = attr(attrs, 'Type')
    const target = attr(attrs, 'Target')
    if (!id || !type || !target) return
    rels.push({
      id,
      type,
      target,
      targetIsExternal: attr(attrs, 'TargetMode') === 'External',
    })
    void baseDir
  })
  return rels
}

/** Open+parse a workbook buffer. `lang` picks the short-date convention. */
export async function parseWorkbook(
  bytes: Uint8Array,
  fileName: string,
  lang: 'en' | 'fr' | 'ar',
): Promise<ParsedWorkbook> {
  const zip = await loadZip(bytes)
  const entries = new Map<string, Uint8Array>()
  let totalUncompressed = 0
  for (const [rawName, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    const name = canonicalEntryName(rawName)
    if (!name) continue
    const data = await file.async('uint8array')
    entries.set(name, data)
    totalUncompressed += data.length
    if (totalUncompressed > MAX_PACKAGE_BYTES) {
      throw new WorkbookParseError('Workbook exceeds the uncompressed size limit.')
    }
  }

  const workbookXml = await readPart(zip, 'xl/workbook.xml')
  if (workbookXml === null) throw new WorkbookParseError('Workbook is missing xl/workbook.xml.')
  const relsXml = (await readPart(zip, 'xl/_rels/workbook.xml.rels')) ?? ''
  const rels = parseRels(relsXml, 'xl')
  const relById = new Map(rels.map((rel) => [rel.id, rel]))

  const sharedStrings: string[] = []
  const sharedStringsRel = rels.find((rel) => rel.type === REL_SHARED_STRINGS)
  if (sharedStringsRel) {
    const sharedStringsXml = await readPart(zip, resolvePartPath('xl', sharedStringsRel.target))
    if (sharedStringsXml) {
      eachElement(sharedStringsXml, 'si', (_tag, body) => {
        const tEl = firstElement(body, 't')
        if (tEl) {
          sharedStrings.push(decodeXml(elementText(tEl.body)))
          return
        }
        // rich shared string: concatenate the runs' text
        let text = ''
        eachElement(body, 'r', (_t, runBody) => {
          const runT = firstElement(runBody, 't')
          if (runT) text += decodeXml(elementText(runT.body))
        })
        if (text === '' && body.trim() !== '') text = decodeXml(elementText(body))
        sharedStrings.push(text)
      })
    }
  }

  const themeXml =
    (await readPart(zip, 'xl/theme/theme1.xml')) ??
    ''
  const theme = themeXml !== '' ? parseTheme(themeXml) : { colors: ['#FFFFFF', '#000000', '#FFFFFF', '#000000', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#0563C1', '#954F72'], majorFont: 'Calibri Light', minorFont: 'Calibri' }

  const shortDateFormat = lang === 'en' ? 'm/d/yyyy' : 'dd/mm/yyyy'
  const stylesXml = await readPart(zip, 'xl/styles.xml')
  let styles: ReturnType<typeof parseStyles> = { styles: [], dxfStyles: [], shortDateFormat }
  let parsedStyleParts: ReturnType<typeof parseStyleParts> | null = null
  if (stylesXml) {
    parsedStyleParts = parseStyleParts(stylesXml, theme)
    styles = parseStyles(stylesXml, theme, shortDateFormat)
  }

  // sheets in workbook order
  const sheetDecls: { name: string; sheetId: string; state: string | null; relId: string | null; position: number }[] = []
  let position = 0
  eachElement(workbookXml, 'sheet', (tag) => {
    const attrs = readAttrs(tag)
    const name = decodeXml(attr(attrs, 'name') ?? '')
    const sheetId = attr(attrs, 'sheetId') ?? String(position + 1)
    const state = attr(attrs, 'state')
    const relId = attr(attrs, 'r:id') ?? attr(attrs, 'id')
    sheetDecls.push({ name, sheetId: `sheet-${sheetId}`, state, relId, position: position++ })
  })
  if (sheetDecls.length === 0) throw new WorkbookParseError('Workbook contains no readable worksheets.')

  const parsedSheets = new Map<string, ParsedSheet>()
  const sheetMetas: WorkbookFile['sheets'] = []
  const visuals: WorkbookVisualObject[] = []
  const definedNames: WorkbookFile['definedNames'] = []
  let visualSeq = 0

  for (const decl of sheetDecls) {
    const rel = decl.relId ? relById.get(decl.relId) : undefined
    const partPath = rel ? resolvePartPath('xl', rel.target) : `xl/worksheets/sheet${decl.position + 1}.xml`
    const worksheetXml = await readPart(zip, partPath)
    if (worksheetXml === null) continue // dangling relationship: skip the sheet (like readBasicWorkbook)

    const sheetRelsPath = `${partPath.replace(/[^/]+$/, '')}_rels/${partPath.split('/').pop()}.rels`
    const sheetRelsXml = (await readPart(zip, sheetRelsPath)) ?? ''
    const sheetRels = parseRels(sheetRelsXml, partPath.replace(/[^/]+$/, ''))
    const sheetRelById = new Map(sheetRels.map((r) => [r.id, r]))

    const sheet = parseWorksheet(worksheetXml, decl.name, decl.sheetId, partPath, sheetRelsPath || null, sharedStrings)
    sheet.hidden = decl.state === 'hidden'
    sheet.veryHidden = decl.state === 'veryHidden'
    resolveSharedFormulas(sheet)
    parsedSheets.set(sheet.sheetId, sheet)

    // notes: comments part via relationship
    const commentsRel = sheetRels.find((r) => r.type === REL_COMMENTS)
    if (commentsRel) {
      const commentsPath = resolvePartPath(partPath.replace(/[^/]+$/, ''), commentsRel.target)
      const commentsXml = await readPart(zip, commentsPath)
      if (commentsXml) parseComments(commentsXml, sheet)
    }

    // tables: table parts via relationships (or tableParts refs in the sheet xml)
    const tableRels = sheetRels.filter((r) => r.type === REL_TABLE)
    const tablePartPaths: string[] = []
    for (const rel2 of tableRels) tablePartPaths.push(resolvePartPath(partPath.replace(/[^/]+$/, ''), rel2.target))
    eachElement(worksheetXml, 'tablePart', (tag) => {
      const rid = attr(readAttrs(tag), 'r:id') ?? attr(readAttrs(tag), 'id')
      const rel2 = rid ? sheetRelById.get(rid) : undefined
      if (rel2) tablePartPaths.push(resolvePartPath(partPath.replace(/[^/]+$/, ''), rel2.target))
    })
    for (const tablePath of new Set(tablePartPaths)) {
      const tableXml = await readPart(zip, tablePath)
      if (tableXml) parseTable(tableXml, sheet)
    }

    // visuals: images (charts stay in the package but are not rendered yet)
    const drawingRels = sheetRels.filter((r) => r.type === REL_DRAWING)
    for (const drawingRel of drawingRels) {
      const drawingPath = resolvePartPath(partPath.replace(/[^/]+$/, ''), drawingRel.target)
      const drawingXml = await readPart(zip, drawingPath)
      if (!drawingXml) continue
      const drawingDir = drawingPath.replace(/[^/]+$/, '')
      const drawingRelsPath = `${drawingDir}_rels/${drawingPath.split('/').pop()}.rels`
      const drawingRelsXml = (await readPart(zip, drawingRelsPath)) ?? ''
      const dRels = parseRels(drawingRelsXml, drawingDir)
      const dRelById = new Map(dRels.map((r) => [r.id, r]))
      parseDrawing(drawingXml, sheet.sheetId, dRelById, entries, visuals, () => `visual-${visualSeq++}`)
    }

    sheetMetas.push(sheetMetadata(sheet, decl.position))
  }

  if (sheetMetas.length === 0) throw new WorkbookParseError('Workbook contains no readable worksheets.')

  // defined names (workbook-level + sheet-scoped)
  eachElement(workbookXml, 'definedName', (tag, body) => {
    const attrs = readAttrs(tag)
    const name = decodeXml(attr(attrs, 'name') ?? '')
    const formula = decodeXml(elementText(body)).trim()
    if (name === '' || formula === '') return
    const localSheetId = attrInt(attrs, 'localSheetId')
    definedNames.push({
      name,
      formula,
      ...(localSheetId !== null ? { sheetIndex: localSheetId } : {}),
    })
  })

  // active tab
  const bookViews = firstElement(workbookXml, 'bookViews')
  let activeTab = 0
  if (bookViews) {
    const view = firstElement(bookViews.body, 'workbookView')
    const tab = view ? attrInt(readAttrs(view.tagSource), 'activeTab') : null
    if (tab !== null) activeTab = tab
  }
  const date1904 = (() => {
    const workbookPr = firstElement(workbookXml, 'workbookPr')
    if (!workbookPr) return false
    const attrs = readAttrs(workbookPr.tagSource)
    const dateAttr = attr(attrs, 'date1904')
    return dateAttr === '1' || dateAttr === 'true'
  })()

  const file: WorkbookFile = {
    sessionId: crypto.randomUUID(),
    name: fileName,
    sha256: await sha256Hex(bytes),
    entryCount: entries.size,
    sheets: sheetMetas,
    activeTab,
    styles: styles.styles,
    dxfStyles: styles.dxfStyles,
    visuals,
    definedNames,
    readOnly: false,
    themeColors: theme.colors,
    themeFonts: {
      major: theme.majorFont,
      minor: theme.minorFont,
      ...(theme.minorEa ? { minorEa: theme.minorEa } : {}),
    },
    ...(parsedStyleParts ? { normalFontName: normalFontName(parsedStyleParts, theme) } : {}),
    date1904,
    shortDateFormat: styles.shortDateFormat,
  }
  return { file, sheets: parsedSheets, entries, originalBytes: bytes }
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Materialize `<f t="shared" si>` followers: each follower's formula is the
 * master's with its references shifted by the (row, column) offset — the same
 * semantics Excel applies (gateway `offsetFormulaRefs`).
 */
function resolveSharedFormulas(sheet: ParsedSheet): void {
  const masters = new Map<number, { row: number; column: number; formula: string }>()
  for (const row of sheet.rows.values()) {
    for (const cell of row.cells.values()) {
      if (cell.sharedFormulaSi !== undefined && cell.formula !== undefined) {
        masters.set(cell.sharedFormulaSi, { row: cell.row, column: cell.column, formula: cell.formula })
      }
    }
  }
  for (const record of takeSharedFormulaRecords()) {
    if (record.sheetId !== sheet.sheetId || record.formula !== undefined) continue
    const master = masters.get(record.si)
    if (!master) continue // dangling si: the cell keeps no formula (Excel degrades the same way)
    const shifted = offsetFormulaRefs(
      master.formula,
      record.row - master.row,
      record.column - master.column,
    )
    const row = sheet.rows.get(record.row)
    const cell = row?.cells.get(record.column)
    if (cell && cell.formula === undefined) cell.formula = shifted
  }
}

/** Worksheet metadata in the wire shape. */
function sheetMetadata(sheet: ParsedSheet, index: number): WorkbookFile['sheets'][number] {
  const firstCell = sheet.rows.size > 0 ? 1 : 1
  void firstCell
  const printAreaNames = new Map<string, string>()
  void printAreaNames
  return {
    id: sheet.sheetId,
    name: sheet.name,
    rowCount: sheet.dimensionRows,
    columnCount: sheet.dimensionColumns,
    sourceXmlBytes: sheet.sourceXmlBytes,
    storedCellCount: sheet.storedCellCount,
    valueCellCount: sheet.valueCellCount,
    valueRowCount: sheet.valueRowCount,
    valueColumnCount: sheet.valueColumnCount,
    columnWidths: sheet.columnWidths.map((c) => ({
      startColumn: c.startColumn,
      endColumn: c.endColumn,
      ...(c.width !== undefined ? { width: c.width } : {}),
      hidden: c.hidden,
      ...(c.outlineLevel !== undefined ? { outlineLevel: c.outlineLevel } : {}),
      ...(c.collapsed ? { collapsed: c.collapsed } : {}),
      ...(c.styleIndex !== undefined ? { styleIndex: c.styleIndex } : {}),
    })),
    defaultRowHeight: sheet.defaultRowHeight,
    defaultRowHeightFixed: sheet.defaultRowHeightFixed,
    defaultColumnWidth: sheet.defaultColumnWidth,
    baseColumnWidth: sheet.baseColumnWidth,
    freeze: sheet.freeze,
    hidden: sheet.hidden,
    veryHidden: sheet.veryHidden || undefined,
    tabColor: sheet.tabColor,
    showGridLines: sheet.showGridLines,
    showFormulas: sheet.showFormulas || undefined,
    showRowColHeaders: sheet.showRowColHeaders || undefined,
    rightToLeft: sheet.rightToLeft || undefined,
    zoomScale: sheet.zoomScale,
    outlineLevelRow: sheet.outlineLevelRow,
    outlineLevelCol: sheet.outlineLevelCol,
    outlineSummaryBelow: sheet.outlineSummaryBelow ? undefined : false,
    outlineSummaryRight: sheet.outlineSummaryRight ? undefined : false,
    tables: sheet.tables,
    comments: sheet.comments,
    pivotRanges: sheet.pivotRanges,
    pivotTables: [],
    sparklines: [],
    cellImages: [],
  }
  void index
}

/** notes: xl/commentsN.xml → sheet.comments */
function parseComments(commentsXml: string, sheet: ParsedSheet): void {
  const authors: string[] = []
  const authorsEl = firstElement(commentsXml, 'authors')
  if (authorsEl) {
    eachElement(authorsEl.body, 'author', (_tag, body) => {
      authors.push(decodeXml(elementText(body)))
    })
  }
  const list = firstElement(commentsXml, 'commentList')
  if (!list) return
  eachElement(list.body, 'comment', (tag, body) => {
    const attrs = readAttrs(tag)
    const ref = attr(attrs, 'ref')
    const authorIndex = attrInt(attrs, 'authorId') ?? 0
    if (!ref) return
    const pos = parseCellRef(ref.split(':')[0] ?? ref)
    if (!pos) return
    const textEl = firstElement(body, 'text')
    const text = textEl
      ? decodeXml(elementText(textEl.body))
      : ''
    sheet.comments.push({
      row: pos[0],
      column: pos[1],
      author: authors[authorIndex] ?? '',
      text,
    })
  })
}

/** xl/tables/tableN.xml → sheet.tables */
function parseTable(tableXml: string, sheet: ParsedSheet): void {
  const attrs = readAttrs(firstElement(tableXml, 'table')?.tagSource ?? '')
  const displayName = decodeXml(attr(attrs, 'displayName') ?? attr(attrs, 'name') ?? '')
  const ref = attr(attrs, 'ref')
  if (ref === null || displayName === '') return
  const area = parseSqref(ref)[0]
  if (!area) return
  const table: {
    range: CellArea
    headerRowCount: number
    showRowStripes: boolean
    showColumnStripes: boolean
    filterActive?: boolean
    name?: string
    columns?: string[]
    styleName?: string
    headerFill?: string
    headerFontColor?: string
    stripeFill?: string
    totalsRowCount?: number
  } = {
    range: area,
    headerRowCount: attrInt(attrs, 'headerRowCount') ?? 1,
    showRowStripes: false,
    showColumnStripes: false,
    name: displayName,
  }
  const totalsRowCount = attrInt(attrs, 'totalsRowCount')
  if (totalsRowCount !== null && totalsRowCount > 0) table.totalsRowCount = totalsRowCount
  const tableStyle = firstElement(tableXml, 'tableStyleInfo')
  if (tableStyle) {
    const styleAttrs = readAttrs(tableStyle.tagSource)
    const styleName = decodeXml(attr(styleAttrs, 'name') ?? '')
    if (styleName !== '') table.styleName = styleName
    table.showRowStripes = attrBool(styleAttrs, 'showRowStripes')
    table.showColumnStripes = attrBool(styleAttrs, 'showColumnStripes')
  }
  const autoFilter = firstElement(tableXml, 'autoFilter')
  if (autoFilter) table.filterActive = true
  const columns: string[] = []
  eachElement(tableXml, 'tableColumn', (tag) => {
    columns.push(decodeXml(attr(readAttrs(tag), 'name') ?? ''))
  })
  if (columns.length > 0) table.columns = columns
  sheet.tables.push(table)
}

/**
 * Drawing part → image visuals (charts stay in the package untouched; the
 * renderer shows them as preserved-on-save objects the browser cannot draw
 * yet — documented in PORTING.md).
 */
function parseDrawing(
  drawingXml: string,
  sheetId: string,
  rels: Map<string, WorkbookRel>,
  entries: Map<string, Uint8Array>,
  visuals: WorkbookVisualObject[],
  nextVisualId: () => string,
): void {
  const readAnchor = (tagSource: string, body: string, kind: 'twoCell' | 'oneCell' | 'absolute'): { from: number[]; to: number[] | null } | null => {
    void kind
    const fromEl = firstElement(body, 'xdr:from') ?? firstElement(body, 'from')
    if (!fromEl) return null
    const readPoint = (container: string): number[] | null => {
      const colEl = firstElement(container, 'xdr:col') ?? firstElement(container, 'col')
      const colOff = firstElement(container, 'xdr:colOff') ?? firstElement(container, 'colOff')
      const rowEl = firstElement(container, 'xdr:row') ?? firstElement(container, 'row')
      const rowOff = firstElement(container, 'xdr:rowOff') ?? firstElement(container, 'rowOff')
      if (!colEl || !rowEl) return null
      return [
        elementNumber(colEl.body),
        elementNumber(rowEl.body),
        colOff ? elementNumber(colOff.body) : 0,
        rowOff ? elementNumber(rowOff.body) : 0,
      ]
    }
    const from = readPoint(fromEl.body)
    if (!from) return null
    const toEl = firstElement(body, 'xdr:to') ?? firstElement(body, 'to')
    const to = toEl ? readPoint(toEl.body) : null
    void tagSource
    return { from, to }
  }
  const elementNumber = (body: string): number => {
    const n = Number(elementText(body).trim())
    return Number.isFinite(n) ? n : 0
  }
  eachElement(drawingXml, 'twoCellAnchor', (_tag, body) => {
    handleAnchor(readAnchor('', body, 'twoCell'), body, true)
  })
  eachElement(drawingXml, 'oneCellAnchor', (_tag, body) => {
    handleAnchor(readAnchor('', body, 'oneCell'), body, false)
  })
  eachElement(drawingXml, 'absoluteAnchor', (_tag, body) => {
    handleAnchor(readAnchor('', body, 'absolute'), body, false)
  })

  function handleAnchor(
    anchor: { from: number[]; to: number[] | null } | null,
    body: string,
    twoCell: boolean,
  ): void {
    if (!anchor) return
    const pic = firstElement(body, 'xdr:pic') ?? firstElement(body, 'pic')
    if (!pic) return // charts/shapes: preserved on save, not rendered yet
    const blip = firstElement(pic.body, 'a:blip')
    if (!blip) return
    const embedId = attr(readAttrs(blip.tagSource), 'r:embed') ?? attr(readAttrs(blip.tagSource), 'r:link')
    const rel = embedId ? rels.get(embedId) : undefined
    if (!rel || rel.targetIsExternal) return
    const mediaPath = resolvePartPath('xl', rel.target.startsWith('../') ? rel.target.replace(/^(\.\.\/)+/, 'media/') : rel.target)
    const bytes = entries.get(mediaPath)
    if (!bytes) return
    const mime = mediaMime(mediaPath, bytes)
    if (mime === null) return
    const [fromColumnRaw, fromRowRaw, fromColumnOffsetRaw, fromRowOffsetRaw] = anchor.from
    const fromColumn = fromColumnRaw ?? 0
    const fromRow = fromRowRaw ?? 0
    const fromColumnOffset = fromColumnOffsetRaw ?? 0
    const fromRowOffset = fromRowOffsetRaw ?? 0
    let toColumn = fromColumn
    let toRow = fromRow
    let toColumnOffset = fromColumnOffset
    let toRowOffset = fromRowOffset
    let explicitTo = false
    if (anchor.to) {
      const [c, r, co, ro] = anchor.to
      toColumn = c ?? fromColumn
      toRow = r ?? fromRow
      toColumnOffset = co ?? fromColumnOffset
      toRowOffset = ro ?? fromRowOffset
      explicitTo = twoCell
    } else {
      toColumn += 1
      toRow += 1
    }
    const visual: WorkbookVisualObject = {
      id: nextVisualId(),
      sheetId,
      kind: 'image',
      anchor: {
        fromRow,
        fromColumn,
        fromRowOffset,
        fromColumnOffset,
        toRow,
        toColumn,
        toRowOffset,
        toColumnOffset,
        ...(explicitTo ? { explicitTo } : {}),
      },
      mediaPath,
      mediaType: mime,
    }
    visuals.push(visual)
  }
}

function mediaMime(path: string, bytes: Uint8Array): string | null {
  const lower = path.toLowerCase()
  const byExt =
    lower.endsWith('.png') ? 'image/png'
    : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
    : lower.endsWith('.gif') ? 'image/gif'
    : lower.endsWith('.bmp') ? 'image/bmp'
    : lower.endsWith('.webp') ? 'image/webp'
    : lower.endsWith('.emf') || lower.endsWith('.wmf') ? null
    : null
  if (byExt !== null) return byExt
  // magic-byte sniff for extensionless parts
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return null
}

export { readRange, parseCellRef, columnLabelToIndex, parseSqref, applyTint }
