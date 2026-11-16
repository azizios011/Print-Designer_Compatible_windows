/**
 * Worksheet part reader: xl/worksheets/sheetN.xml (+ its annotations) into
 * the shapes `workbookFileSchema` / `workbookRangeResultSchema` carry.
 *
 * Everything is parsed once per open (the browser engine holds the whole
 * package in memory — see PORTING.md), and range requests are served from the
 * sparse row map, so the renderer's lazy windowing keeps working unchanged.
 */

import type { WorkbookCellStyle } from '../../shared/desktop-api'
import { attr, attrBool, attrFloat, attrInt, decodeEntities, eachElement, elementText, firstElement, readAttrs } from './xml-utils'

export interface CellArea {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export interface CellRecord {
  row: number
  column: number
  value: string | number | boolean | null
  formula?: string | undefined
  arrayRef?: string | undefined
  styleIndex?: number | undefined
  rich?: RichRun[] | undefined
  /** `<f t="shared" si>` group id (master cells carry the formula text too) */
  sharedFormulaSi?: number | undefined
}

export interface RichRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  color?: string
  size?: number
  family?: string
  vertAlign?: 'subscript' | 'superscript'
}

export interface ParsedRow {
  height?: number | undefined
  customHeight?: boolean | undefined
  hidden: boolean
  outlineLevel?: number | undefined
  collapsed?: boolean | undefined
  styleIndex?: number | undefined
  cells: Map<number, CellRecord>
}

export interface ColumnWidth {
  startColumn: number
  endColumn: number
  width?: number | undefined
  hidden: boolean
  outlineLevel?: number | undefined
  collapsed?: boolean | undefined
  styleIndex?: number | undefined
}

export interface SheetHyperlink {
  row: number
  column: number
  target: string
}

export interface ConditionalRule {
  ranges: CellArea[]
  ruleType: string
  operator?: string | undefined
  formulas: string[]
  text?: string | undefined
  dxfIndex?: number | undefined
  priority: number
  stopIfTrue?: boolean | undefined
  rank?: number | undefined
  percent: boolean
  bottom: boolean
  cfvos: { kind: string; value?: string | undefined; gte?: boolean | undefined }[]
  colors: string[]
  iconSetName?: string | undefined
  iconReverse: boolean
  showValue: boolean
  negativeColor?: string | undefined
  negativeSameAsPositive?: boolean | undefined
  gradient?: boolean | undefined
  axisPosition?: 'automatic' | 'middle' | 'none' | undefined
  axisColor?: string | undefined
  minLength?: number | undefined
  maxLength?: number | undefined
}

export interface DataValidationRule {
  ranges: CellArea[]
  ruleType: string
  operator?: string | undefined
  formulas: string[]
  allowBlank: boolean
  suppressDropdown: boolean
  showInputMessage: boolean
  showErrorMessage: boolean
  errorStyle?: string | undefined
  errorTitle?: string | undefined
  error?: string | undefined
  promptTitle?: string | undefined
  prompt?: string | undefined
}

export interface WireTable {
  range: CellArea
  headerRowCount: number
  showRowStripes: boolean
  showColumnStripes: boolean
  filterActive?: boolean | undefined
  name?: string | undefined
  columns?: string[] | undefined
  styleName?: string | undefined
  headerFill?: string | undefined
  headerFontColor?: string | undefined
  stripeFill?: string | undefined
  totalsRowCount?: number | undefined
}

export interface WireComment {
  row: number
  column: number
  author: string
  text: string
}

export interface SheetProtection {
  protected: boolean
  hasPassword: boolean
}

export interface PageSetup {
  orientation?: 'portrait' | 'landscape'
  paperSize?: number
  scale?: number
  fitToWidth?: number
  fitToHeight?: number
  fitToPage?: boolean
  margins?: {
    left: number
    right: number
    top: number
    bottom: number
    header: number
    footer: number
  }
  printGridlines?: boolean
  printHeadings?: boolean
  oddHeader?: string
  oddFooter?: string
  differentOddEven?: boolean
  differentFirst?: boolean
  headerFooterFixedSize?: boolean
  evenHeader?: string
  evenFooter?: string
  firstHeader?: string
  firstFooter?: string
}

export interface ParsedSheet {
  name: string
  sheetId: string
  partPath: string
  relsPath: string | null
  dimensionRows: number
  dimensionColumns: number
  rows: Map<number, ParsedRow>
  columnWidths: ColumnWidth[]
  defaultRowHeight: number | null
  defaultRowHeightFixed: boolean
  defaultColumnWidth: number | null
  baseColumnWidth: number | null
  freeze: { frozenColumns: number; frozenRows: number } | null
  hidden: boolean
  veryHidden: boolean
  tabColor: string | null
  showGridLines: boolean
  showFormulas: boolean
  showRowColHeaders: boolean
  rightToLeft: boolean
  zoomScale?: number | undefined
  outlineLevelRow?: number | undefined
  outlineLevelCol?: number | undefined
  outlineSummaryBelow: boolean
  outlineSummaryRight: boolean
  merges: CellArea[]
  hyperlinks: SheetHyperlink[]
  conditionalRules: ConditionalRule[]
  dataValidations: DataValidationRule[]
  autoFilter: CellArea | null
  autoFilterColumns: {
    colId: number
    values?: string[]
    blank?: boolean
    customs?: {
      and?: boolean | undefined
      filters: {
        val: string | number
        operator?: 'equal' | 'notEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | undefined
      }[]
    }
  }[]
  sheetProtection: SheetProtection | null
  rowBreaks: number[]
  colBreaks: number[]
  pageSetup: PageSetup | null
  protectedRanges: { name: string; sqref: string; hasPassword: boolean }[]
  tables: WireTable[]
  comments: WireComment[]
  pivotRanges: CellArea[]
  storedCellCount: number
  valueCellCount: number
  valueRowCount: number
  valueColumnCount: number
  sourceXmlBytes: number
}

// ── address helpers ──────────────────────────────────────────────────────────

/** "C42" → [row, column], 0-based; null when the reference is malformed. */
export function parseCellRef(ref: string): [number, number] | null {
  const match = /^([A-Za-z]{1,3})([0-9]+)$/.exec(ref)
  if (!match) return null
  return [parseInt(match[2]!, 10) - 1, columnLabelToIndex(match[1]!)]
}

export function columnLabelToIndex(label: string): number {
  let index = 0
  for (const ch of label.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

export function indexToColumnLabel(index: number): string {
  let letters = ''
  let remaining = index + 1
  while (remaining > 0) {
    remaining -= 1
    letters = String.fromCharCode(65 + (remaining % 26)) + letters
    remaining = Math.floor(remaining / 26)
  }
  return letters
}

/** "A1:D20" (or a bare "A1") → area, 0-based, clamped non-negative. */
export function parseSqref(sqref: string): CellArea[] {
  const areas: CellArea[] = []
  for (const part of sqref.split(/\s+/)) {
    if (part.trim() === '') continue
    const [from, to] = part.split(':')
    const fromCell = parseCellRef(from ?? '')
    if (!fromCell) continue
    const toCell = to ? parseCellRef(to) : fromCell
    if (!toCell) continue
    areas.push({
      startRow: Math.min(fromCell[0], toCell[0]),
      startColumn: Math.min(fromCell[1], toCell[1]),
      endRow: Math.max(fromCell[0], toCell[0]),
      endColumn: Math.max(fromCell[1], toCell[1]),
    })
  }
  return areas
}

export function areaOverlaps(area: CellArea, range: CellArea): boolean {
  return (
    area.startRow <= range.endRow &&
    area.endRow >= range.startRow &&
    area.startColumn <= range.endColumn &&
    area.endColumn >= range.startColumn
  )
}

function areaLabel(area: CellArea): string {
  const from = `${indexToColumnLabel(area.startColumn)}${area.startRow + 1}`
  const to = `${indexToColumnLabel(area.endColumn)}${area.endRow + 1}`
  return from === to ? from : `${from}:${to}`
}

// ── cell content ─────────────────────────────────────────────────────────────

const ERROR_VALUES = new Set([
  '#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#BUSY!',
])

interface CellParse {
  row: number
  column: number
  value: string | number | boolean | null
  formula?: string
  arrayRef?: string
  styleIndex?: number
  rich?: RichRun[]
  sharedFormulaSi?: number
  sharedFormulaSource?: string
}

function readRichRuns(body: string): RichRun[] | undefined {
  const runs: RichRun[] = []
  let plain = ''
  eachElement(body, 'r', (_tag, runBody) => {
    const run: RichRun = { text: '', bold: false, italic: false, underline: false, strikethrough: false }
    const rPr = firstElement(runBody, 'rPr')
    if (rPr) {
      eachElement(rPr.body, 'b', (tag) => {
        const val = attr(readAttrs(tag), 'val')
        run.bold = val === null || val === '1' || val === 'true'
      })
      eachElement(rPr.body, 'i', (tag) => {
        const val = attr(readAttrs(tag), 'val')
        run.italic = val === null || val === '1' || val === 'true'
      })
      eachElement(rPr.body, 'u', () => {
        run.underline = true
      })
      eachElement(rPr.body, 'strike', () => {
        run.strikethrough = true
      })
      eachElement(rPr.body, 'color', (tag) => {
        const c = readSimpleColor(tag)
        if (c) run.color = c
      })
      eachElement(rPr.body, 'sz', (tag) => {
        const size = attrFloat(readAttrs(tag), 'val')
        if (size !== null && size > 0) run.size = size
      })
      eachElement(rPr.body, 'rFont', (tag) => {
        run.family = decodeEntities(attr(readAttrs(tag), 'val') ?? '')
      })
      eachElement(rPr.body, 'vertAlign', (tag) => {
        const val = attr(readAttrs(tag), 'val')
        if (val === 'subscript' || val === 'superscript') run.vertAlign = val
      })
    }
    eachElement(runBody, 't', (tag, textBody) => {
      const preserve = readAttrs(tag)['xml:space'] === 'preserve'
      const text = elementText(textBody)
      run.text += preserve ? text : text.trim() === text ? text : text.replace(/^\s+|\s+$/g, '')
      plain += run.text
    })
    if (run.text !== '') runs.push(run)
  })
  if (runs.length === 0) return undefined
  void plain
  return runs
}

function readSimpleColor(tagSource: string): string | undefined {
  const attrs = readAttrs(tagSource)
  const rgb = attr(attrs, 'rgb')
  if (rgb && /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})$/.test(rgb)) {
    return `#${rgb.slice(-6).toUpperCase()}`
  }
  return undefined
}

function parseCell(cellTag: string, body: string, sharedStrings: string[]): CellParse | null {
  const attrs = readAttrs(cellTag)
  const ref = attr(attrs, 'r')
  if (!ref) return null
  const pos = parseCellRef(ref)
  if (!pos) return null
  const [row, column] = pos
  const cell: CellParse = { row, column, value: null }
  const styleIndex = attrInt(attrs, 's')
  if (styleIndex !== null) cell.styleIndex = styleIndex
  const type = attr(attrs, 't') ?? 'n'

  const valueEl = firstElement(body, 'v')
  const rawValue = valueEl ? elementText(valueEl.body) : ''
  const formulaEl = firstElement(body, 'f')
  if (formulaEl) {
    const fAttrs = readAttrs(formulaEl.tagSource)
    const formulaText = decodeEntities(elementText(formulaEl.body))
    const kind = attr(fAttrs, 't')
    const si = attrInt(fAttrs, 'si')
    if (kind === 'shared') {
      const masterRef = attr(fAttrs, 'ref')
      if (formulaText !== '') {
        // master of a shared group (or an explicit formula in a shared slot)
        cell.formula = formulaText
        if (si !== null) cell.sharedFormulaSi = si
        if (masterRef !== null) cell.arrayRef = masterRef
      } else if (si !== null) {
        // follower: the formula arrives from the master shifted by the offset
        cell.sharedFormulaSi = si
        cell.sharedFormulaSource = ref
      }
    } else {
      if (formulaText !== '') cell.formula = formulaText
      if (si !== null) cell.sharedFormulaSi = si
      if (kind === 'array') {
        const masterRef = attr(fAttrs, 'ref')
        if (masterRef !== null) cell.arrayRef = masterRef
      }
    }
  }

  const isEl = firstElement(body, 'is')
  if (type === 'inlineStr' && isEl) {
    const runs = readRichRuns(isEl.body)
    const textEl = firstElement(isEl.body, 't')
    cell.value = runs ? elementText(isEl.body) : textEl ? elementText(textEl.body) : ''
    if (runs && runs.length > 0) cell.rich = runs
    return cell
  }

  switch (type) {
    case 's': {
      const index = parseInt(rawValue, 10)
      const entry = Number.isFinite(index) ? sharedStrings[index] : undefined
      cell.value = typeof entry === 'string' ? entry : ''
      break
    }
    case 'str':
      cell.value = rawValue
      break
    case 'b':
      cell.value = rawValue === '1' || rawValue.toLowerCase() === 'true'
      break
    case 'e':
      cell.value = rawValue === '' ? '#VALUE!' : rawValue
      break
    case 'd':
      cell.value = rawValue
      break
    default: {
      // numeric
      if (rawValue !== '') {
        const num = Number(rawValue)
        cell.value = Number.isFinite(num) ? num : rawValue
      } else if (cell.formula === undefined) {
        cell.value = null
      }
    }
  }
  return cell
}

// ── the sheet parse ──────────────────────────────────────────────────────────

export function parseWorksheet(
  worksheetXml: string,
  name: string,
  sheetId: string,
  partPath: string,
  relsPath: string | null,
  sharedStrings: string[],
): ParsedSheet {
  const sheet: ParsedSheet = {
    name,
    sheetId,
    partPath,
    relsPath,
    dimensionRows: 1,
    dimensionColumns: 1,
    rows: new Map(),
    columnWidths: [],
    defaultRowHeight: null,
    defaultRowHeightFixed: false,
    defaultColumnWidth: null,
    baseColumnWidth: null,
    freeze: null,
    hidden: false,
    veryHidden: false,
    tabColor: null,
    showGridLines: true,
    showFormulas: false,
    showRowColHeaders: true,
    rightToLeft: false,
    zoomScale: undefined,
    outlineLevelRow: undefined,
    outlineLevelCol: undefined,
    outlineSummaryBelow: true,
    outlineSummaryRight: true,
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    dataValidations: [],
    autoFilter: null,
    autoFilterColumns: [],
    sheetProtection: null,
    rowBreaks: [],
    colBreaks: [],
    pageSetup: null,
    protectedRanges: [],
    tables: [],
    comments: [],
    pivotRanges: [],
    storedCellCount: 0,
    valueCellCount: 0,
    valueRowCount: 0,
    valueColumnCount: 0,
    sourceXmlBytes: worksheetXml.length,
  }

  parseSheetViews(worksheetXml, sheet)
  parseSheetFormatPr(worksheetXml, sheet)
  parseCols(worksheetXml, sheet)
  parseSheetData(worksheetXml, sheet, sharedStrings)
  parseMergeCells(worksheetXml, sheet)
  parseHyperlinks(worksheetXml, sheet)
  parseConditionalFormatting(worksheetXml, sheet)
  parseDataValidations(worksheetXml, sheet)
  parseAutoFilter(worksheetXml, sheet)
  parseSheetProtection(worksheetXml, sheet)
  parseBreaks(worksheetXml, sheet)
  parsePageSetup(worksheetXml, sheet)
  parseProtectedRanges(worksheetXml, sheet)
  parseOutlinePr(worksheetXml, sheet)

  // dimension: prefer <dimension>, fall back to the parsed bounding box
  const dim = firstElement(worksheetXml, 'dimension')
  let maxRow = 0
  let maxCol = 0
  for (const [rowIndex, row] of sheet.rows.entries()) {
    if (row.cells.size === 0 && !row.hidden && row.height === undefined) continue
    maxRow = Math.max(maxRow, rowIndex)
    for (const column of row.cells.keys()) maxCol = Math.max(maxCol, column)
  }
  if (dim) {
    const ref = attr(readAttrs(dim.tagSource), 'ref')
    if (ref) {
      const area = parseSqref(ref)[0]
      if (area) {
        maxRow = Math.max(maxRow, area.endRow)
        maxCol = Math.max(maxCol, area.endColumn)
      }
    }
  }
  sheet.dimensionRows = maxRow + 1
  sheet.dimensionColumns = Math.max(maxCol + 1, 1)
  return sheet
}

interface IndexedRow extends ParsedRow {
  index: number
}

function ensureRow(sheet: ParsedSheet, index: number): IndexedRow {
  let row = sheet.rows.get(index) as IndexedRow | undefined
  if (!row) {
    row = { index, hidden: false, cells: new Map() }
    sheet.rows.set(index, row)
  }
  return row
}

function parseSheetData(worksheetXml: string, sheet: ParsedSheet, sharedStrings: string[]): void {
  const sheetData = firstElement(worksheetXml, 'sheetData')
  if (!sheetData) return
  eachElement(sheetData.body, 'row', (tag, body) => {
    const attrs = readAttrs(tag)
    const rowIndex = attrInt(attrs, 'r')
    let row: IndexedRow
    if (rowIndex !== null && rowIndex >= 0) {
      row = ensureRow(sheet, rowIndex - 1)
    } else {
      // producers that omit r: sequence after the last row
      let next = 0
      for (const key of sheet.rows.keys()) next = Math.max(next, key + 1)
      row = ensureRow(sheet, next)
    }
    const height = attrFloat(attrs, 'ht')
    if (height !== null) row.height = height
    row.customHeight = attrBool(attrs, 'customHeight')
    row.hidden = attrBool(attrs, 'hidden')
    const outlineLevel = attrInt(attrs, 'outlineLevel')
    if (outlineLevel !== null && outlineLevel > 0) row.outlineLevel = outlineLevel
    if (attrBool(attrs, 'collapsed')) row.collapsed = true
    const rowStyle = attrInt(attrs, 's')
    if (rowStyle !== null && rowStyle > 0) row.styleIndex = rowStyle
    const spans = attr(attrs, 'spans')

    let rowHadValue = false
    let rowMaxCol = -1
    let spanEnd = -1
    if (spans) {
      const parts = spans.split(':')
      const end = parseInt(parts[1] ?? parts[0] ?? '0', 10)
      if (Number.isFinite(end)) spanEnd = end - 1
    }

    eachElement(body, 'c', (cellTag, cellBody) => {
      const cell = parseCell(cellTag, cellBody, sharedStrings)
      if (!cell) return
      const record: CellRecord = {
        row: cell.row,
        column: cell.column,
        value: cell.value,
      }
      if (cell.formula !== undefined) record.formula = cell.formula
      if (cell.arrayRef !== undefined) record.arrayRef = cell.arrayRef
      if (cell.styleIndex !== undefined) record.styleIndex = cell.styleIndex
      if (cell.rich !== undefined) record.rich = cell.rich
      row.cells.set(cell.column, record)
      sheet.storedCellCount += 1
      if (cell.value !== null || cell.formula !== undefined) {
        sheet.valueCellCount += 1
        rowHadValue = true
      }
      rowMaxCol = Math.max(rowMaxCol, cell.column)
      if (cell.sharedFormulaSi !== undefined) {
        sharedFormulaRecords.push({
          sheetId: sheet.sheetId,
          si: cell.sharedFormulaSi,
          row: cell.row,
          column: cell.column,
          ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
        })
      }
    })
    void spanEnd
    if (rowHadValue || row.cells.size > 0) {
      sheet.valueRowCount = Math.max(sheet.valueRowCount, row.index + 1)
      sheet.valueColumnCount = Math.max(sheet.valueColumnCount, rowMaxCol + 1)
    }
  })
}

/// Shared-formula records collected while parsing: every `<f t="shared">`
/// cell with its `si`, whether it carries the master formula or not.
export interface SharedFormulaRecord {
  sheetId: string
  si: number
  row: number
  column: number
  /** master formula text (masters only) */
  formula?: string
}

const sharedFormulaRecords: SharedFormulaRecord[] = []

export function takeSharedFormulaRecords(): SharedFormulaRecord[] {
  return sharedFormulaRecords.splice(0, sharedFormulaRecords.length)
}

// ── annotations ──────────────────────────────────────────────────────────────

function parseSheetViews(worksheetXml: string, sheet: ParsedSheet): void {
  const views = firstElement(worksheetXml, 'sheetViews')
  if (!views) return
  const view = firstElement(views.body, 'sheetView')
  if (!view) return
  const attrs = readAttrs(view.tagSource)
  if (attrBool(attrs, 'showGridLines') === false) sheet.showGridLines = false
  const grid = attr(attrs, 'showGridLines')
  if (grid === '0' || grid === 'false') sheet.showGridLines = false
  if (attrBool(attrs, 'rightToLeft')) sheet.rightToLeft = true
  if (attr(attrs, 'showFormulas') === '1') sheet.showFormulas = true
  const headings = attr(attrs, 'showRowColHeaders')
  if (headings === '0' || headings === 'false') sheet.showRowColHeaders = false
  const zoom = attrInt(attrs, 'zoomScale')
  if (zoom !== null && zoom >= 10 && zoom <= 400) sheet.zoomScale = zoom
  const tab = attrBool(attrs, 'tabSelected')
  void tab
  const pane = firstElement(view.body, 'pane')
  if (pane) {
    const paneAttrs = readAttrs(pane.tagSource)
    if (attr(paneAttrs, 'state') === 'frozen' || attr(paneAttrs, 'state') === 'frozenSplit') {
      const xSplit = attrInt(paneAttrs, 'xSplit') ?? 0
      const ySplit = attrInt(paneAttrs, 'ySplit') ?? 0
      sheet.freeze = { frozenColumns: xSplit, frozenRows: ySplit }
    }
  }
}

function parseSheetFormatPr(worksheetXml: string, sheet: ParsedSheet): void {
  const el = firstElement(worksheetXml, 'sheetFormatPr')
  if (!el) return
  const attrs = readAttrs(el.tagSource)
  const defaultRowHeight = attrFloat(attrs, 'defaultRowHeight')
  sheet.defaultRowHeight = defaultRowHeight === 0 ? null : defaultRowHeight
  sheet.defaultRowHeightFixed = attrBool(attrs, 'customHeight')
  const defaultColumnWidth = attrFloat(attrs, 'defaultColWidth')
  sheet.defaultColumnWidth = defaultColumnWidth === 0 ? null : defaultColumnWidth
  const baseColumnWidth = attrFloat(attrs, 'baseColWidth')
  sheet.baseColumnWidth = baseColumnWidth === null ? null : baseColumnWidth
  const outlineRow = attrInt(attrs, 'outlineLevelRow')
  if (outlineRow !== null && outlineRow > 0) sheet.outlineLevelRow = outlineRow
  const outlineCol = attrInt(attrs, 'outlineLevelCol')
  if (outlineCol !== null && outlineCol > 0) sheet.outlineLevelCol = outlineCol
}

function parseCols(worksheetXml: string, sheet: ParsedSheet): void {
  const cols = firstElement(worksheetXml, 'cols')
  if (!cols) return
  eachElement(cols.body, 'col', (tag) => {
    const attrs = readAttrs(tag)
    const min = attrInt(attrs, 'min')
    const max = attrInt(attrs, 'max')
    if (min === null || max === null) return
    const width = attrFloat(attrs, 'width')
    const column: ColumnWidth = {
      startColumn: min - 1,
      endColumn: max - 1,
      width: width === null ? undefined : width,
      hidden: attrBool(attrs, 'hidden'),
      collapsed: attrBool(attrs, 'collapsed') || undefined,
      styleIndex: attrInt(attrs, 'style') ?? undefined,
    }
    const outlineLevel = attrInt(attrs, 'outlineLevel')
    if (outlineLevel !== null && outlineLevel > 0) column.outlineLevel = outlineLevel
    if (column.width === undefined && !column.hidden && column.outlineLevel === undefined && !column.collapsed && column.styleIndex === undefined) return
    sheet.columnWidths.push(column)
  })
}

function parseMergeCells(worksheetXml: string, sheet: ParsedSheet): void {
  const el = firstElement(worksheetXml, 'mergeCells')
  if (!el) return
  eachElement(el.body, 'mergeCell', (tag) => {
    const ref = attr(readAttrs(tag), 'ref')
    if (!ref) return
    const area = parseSqref(ref)[0]
    if (area) sheet.merges.push(area)
  })
}

function parseHyperlinks(worksheetXml: string, sheet: ParsedSheet): void {
  const el = firstElement(worksheetXml, 'hyperlinks')
  if (!el) return
  eachElement(el.body, 'hyperlink', (tag) => {
    const attrs = readAttrs(tag)
    const ref = attr(attrs, 'ref')
    if (!ref) return
    const location = attr(attrs, 'location')
    const rid = attr(attrs, 'r:id') ?? attr(attrs, 'id')
    // internal anchors land immediately; external relationship targets are
    // resolved by the workbook assembler through the sheet's rels (`rel:<id>`)
    const target = location !== null ? location : rid !== null ? `rel:${rid}` : null
    if (target === null) return
    const area = parseSqref(ref)[0]
    if (!area) return
    for (let row = area.startRow; row <= area.endRow; row++) {
      for (let column = area.startColumn; column <= area.endColumn; column++) {
        sheet.hyperlinks.push({ row, column, target })
      }
    }
  })
}

function parseConditionalFormatting(worksheetXml: string, sheet: ParsedSheet): void {
  eachElement(worksheetXml, 'conditionalFormatting', (tag, body) => {
    const sqref = attr(readAttrs(tag), 'sqref')
    const ranges = sqref ? parseSqref(sqref) : []
    eachElement(body, 'cfRule', (ruleTag, ruleBody) => {
      const attrs = readAttrs(ruleTag)
      const ruleType = attr(attrs, 'type')
      if (ruleType === null) return
      const rule: ConditionalRule = {
        ranges,
        ruleType,
        formulas: [],
        priority: attrInt(attrs, 'priority') ?? 0,
        percent: false,
        bottom: false,
        cfvos: [],
        colors: [],
        iconReverse: false,
        showValue: true,
      }
      const dxfIndex = attrInt(attrs, 'dxfId')
      if (dxfIndex !== null && dxfIndex >= 0) rule.dxfIndex = dxfIndex
      if (attrBool(attrs, 'stopIfTrue')) rule.stopIfTrue = true
      const operator = attr(attrs, 'operator')
      if (operator) rule.operator = operator
      const text = attr(attrs, 'text')
      if (text !== null) rule.text = decodeEntities(text)
      const rank = attrInt(attrs, 'rank')
      if (rank !== null) rule.rank = rank
      if (attrBool(attrs, 'percent')) rule.percent = true
      if (attrBool(attrs, 'bottom')) rule.bottom = true
      eachElement(ruleBody, 'formula', (_t, formulaBody) => {
        rule.formulas.push(decodeEntities(elementText(formulaBody)))
      })
      eachElement(ruleBody, 'color', (colorTag) => {
        const c = readSimpleColor(colorTag)
        if (c) rule.colors.push(c)
      })
      eachElement(ruleBody, 'cfvo', (cfvoTag) => {
        const cfvoAttrs = readAttrs(cfvoTag)
        const cfvoValue = attr(cfvoAttrs, 'val')
        rule.cfvos.push({
          kind: attr(cfvoAttrs, 'type') ?? 'num',
          ...(cfvoValue !== null ? { value: cfvoValue } : {}),
          ...(attrBool(cfvoAttrs, 'gte') ? { gte: true } : {}),
        })
      })
      eachElement(ruleBody, 'colorScale', (_t, csBody) => {
        eachElement(csBody, 'color', (colorTag) => {
          const c = readSimpleColor(colorTag)
          if (c) rule.colors.push(c)
        })
      })
      eachElement(ruleBody, 'dataBar', (barTag, barBody) => {
        eachElement(barBody, 'color', (colorTag) => {
          const c = readSimpleColor(colorTag)
          if (c) rule.colors.push(c)
        })
        const barAttrs = readAttrs(barTag)
        const minLength = attrInt(barAttrs, 'minLength')
        const maxLength = attrInt(barAttrs, 'maxLength')
        if (minLength !== null) rule.minLength = minLength
        if (maxLength !== null) rule.maxLength = maxLength
      })
      eachElement(ruleBody, 'iconSet', (iconTag) => {
        const iconAttrs = readAttrs(iconTag)
        const iconSetName = attr(iconAttrs, 'iconSet')
        if (iconSetName) rule.iconSetName = iconSetName
        rule.iconReverse = attrBool(iconAttrs, 'reverse')
        rule.showValue = attr(iconAttrs, 'showValue') !== '0'
      })
      sheet.conditionalRules.push(rule)
    })
  })
}

function parseDataValidations(worksheetXml: string, sheet: ParsedSheet): void {
  eachElement(worksheetXml, 'dataValidations', (_tag, body) => {
    eachElement(body, 'dataValidation', (tag, ruleBody) => {
      const attrs = readAttrs(tag)
      const sqref = attr(attrs, 'sqref')
      if (!sqref) return
      const ranges = parseSqref(sqref)
      if (ranges.length === 0) return
      const ruleType = attr(attrs, 'type')
      if (ruleType === null) return
      const rule: DataValidationRule = {
        ranges,
        ruleType,
        formulas: [],
        allowBlank: attrBool(attrs, 'allowBlank'),
        // OOXML showDropDown="1" SUPPRESSES the dropdown
        suppressDropdown: attrBool(attrs, 'showDropDown'),
        showInputMessage: attrBool(attrs, 'showInputMessage'),
        showErrorMessage: attrBool(attrs, 'showErrorMessage'),
      }
      const operator = attr(attrs, 'operator')
      if (operator) rule.operator = operator
      const errorStyle = attr(attrs, 'errorStyle')
      if (errorStyle) rule.errorStyle = errorStyle
      const errorTitle = attr(attrs, 'errorTitle')
      if (errorTitle) rule.errorTitle = decodeEntities(errorTitle)
      const error = attr(attrs, 'error')
      if (error) rule.error = decodeEntities(error)
      const promptTitle = attr(attrs, 'promptTitle')
      if (promptTitle) rule.promptTitle = decodeEntities(promptTitle)
      const prompt = attr(attrs, 'prompt')
      if (prompt) rule.prompt = decodeEntities(prompt)
      eachElement(ruleBody, 'formula1', (_t, fb) => {
        rule.formulas.push(decodeEntities(elementText(fb)))
      })
      eachElement(ruleBody, 'formula2', (_t, fb) => {
        rule.formulas.push(decodeEntities(elementText(fb)))
      })
      sheet.dataValidations.push(rule)
    })
  })
}

function parseAutoFilter(worksheetXml: string, sheet: ParsedSheet): void {
  const el = firstElement(worksheetXml, 'autoFilter')
  if (!el) return
  const ref = attr(readAttrs(el.tagSource), 'ref')
  if (!ref) return
  sheet.autoFilter = parseSqref(ref)[0] ?? null
  eachElement(el.body, 'filterColumn', (tag, body) => {
    const colId = attrInt(readAttrs(tag), 'colId')
    if (colId === null) return
    const column: ParsedSheet['autoFilterColumns'][number] = { colId }
    const values: string[] = []
    let blank: boolean | undefined
    eachElement(body, 'filter', (filterTag) => {
      const val = attr(readAttrs(filterTag), 'val')
      if (val !== null) values.push(decodeEntities(val))
    })
    const blanks = firstElement(body, 'blank')
    if (blanks) blank = true
    if (values.length > 0) column.values = values
    if (blank) column.blank = blank
    const customFilters = firstElement(body, 'customFilters')
    if (customFilters) {
      const and = attr(readAttrs(customFilters.tagSource), 'and') === '1'
      const filters: { val: string | number; operator?: 'equal' | 'notEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | undefined }[] = []
      const OPERATORS = new Set(['equal', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'])
      eachElement(customFilters.body, 'customFilter', (cfTag) => {
        const cfAttrs = readAttrs(cfTag)
        const val = attr(cfAttrs, 'val')
        if (val === null) return
        const operator = attr(cfAttrs, 'operator')
        const num = Number(val)
        filters.push({
          val: Number.isFinite(num) && val.trim() !== '' ? num : decodeEntities(val),
          ...(operator !== null && OPERATORS.has(operator) ? { operator: operator as 'equal' } : {}),
        })
      })
      if (filters.length > 0) column.customs = { ...(and ? { and } : {}), filters }
    }
    if (column.values !== undefined || column.blank !== undefined || column.customs !== undefined) {
      sheet.autoFilterColumns.push(column)
    }
  })
}

function parseSheetProtection(worksheetXml: string, sheet: ParsedSheet): void {
  const el = firstElement(worksheetXml, 'sheetProtection')
  if (!el) return
  const attrs = readAttrs(el.tagSource)
  sheet.sheetProtection = {
    protected: attrBool(attrs, 'sheet'),
    hasPassword: attr(attrs, 'password') !== null || attr(attrs, 'algorithmName') !== null,
  }
}

function parseBreaks(worksheetXml: string, sheet: ParsedSheet): void {
  eachElement(worksheetXml, 'rowBreaks', (_tag, body) => {
    eachElement(body, 'brk', (tag) => {
      const id = attrInt(readAttrs(tag), 'id')
      const maxAttr = attrInt(readAttrs(tag), 'max')
      const man = attrBool(readAttrs(tag), 'man')
      if (id !== null && man && (maxAttr === null || maxAttr > 0)) sheet.rowBreaks.push(id)
    })
  })
  eachElement(worksheetXml, 'colBreaks', (_tag, body) => {
    eachElement(body, 'brk', (tag) => {
      const id = attrInt(readAttrs(tag), 'id')
      const maxAttr = attrInt(readAttrs(tag), 'max')
      const man = attrBool(readAttrs(tag), 'man')
      if (id !== null && man && (maxAttr === null || maxAttr > 0)) sheet.colBreaks.push(id)
    })
  })
}

const PAPER_DEFAULTS: Record<string, string> = {}

function parsePageSetup(worksheetXml: string, sheet: ParsedSheet): void {
  const setup: PageSetup = {}
  let hasAny = false
  const setupEl = firstElement(worksheetXml, 'pageSetup')
  if (setupEl) {
    const attrs = readAttrs(setupEl.tagSource)
    const orientation = attr(attrs, 'orientation')
    if (orientation === 'portrait' || orientation === 'landscape') {
      setup.orientation = orientation
      hasAny = true
    }
    const paperSize = attrInt(attrs, 'paperSize')
    if (paperSize !== null) {
      setup.paperSize = paperSize
      hasAny = true
    }
    const scale = attrInt(attrs, 'scale')
    if (scale !== null) {
      setup.scale = scale
      hasAny = true
    }
    const fitToWidth = attrInt(attrs, 'fitToWidth')
    if (fitToWidth !== null) {
      setup.fitToWidth = fitToWidth
      hasAny = true
    }
    const fitToHeight = attrInt(attrs, 'fitToHeight')
    if (fitToHeight !== null) {
      setup.fitToHeight = fitToHeight
      hasAny = true
    }
    if (attrBool(attrs, 'fitToPage')) {
      setup.fitToPage = true
      hasAny = true
    }
  }
  const sheetPr = firstElement(worksheetXml, 'sheetPr')
  if (sheetPr) {
    const pageSetUpPr = firstElement(sheetPr.body, 'pageSetUpPr')
    if (pageSetUpPr && attrBool(readAttrs(pageSetUpPr.tagSource), 'fitToPage')) {
      setup.fitToPage = true
      hasAny = true
    }
    const tabColor = firstElement(sheetPr.body, 'tabColor')
    if (tabColor) {
      const c = readSimpleColor(tabColor.body) ?? undefined
      if (c) sheet.tabColor = c
      const themeSlot = attrInt(readAttrs(tabColor.tagSource), 'theme')
      void themeSlot
    }
  }
  const marginsEl = firstElement(worksheetXml, 'pageMargins')
  if (marginsEl) {
    const m = readAttrs(marginsEl.tagSource)
    setup.margins = {
      left: attrFloat(m, 'left') ?? 0.75,
      right: attrFloat(m, 'right') ?? 0.75,
      top: attrFloat(m, 'top') ?? 1,
      bottom: attrFloat(m, 'bottom') ?? 1,
      header: attrFloat(m, 'header') ?? 0.5,
      footer: attrFloat(m, 'footer') ?? 0.5,
    }
    hasAny = true
  }
  const printOptions = firstElement(worksheetXml, 'printOptions')
  if (printOptions) {
    const attrs = readAttrs(printOptions.tagSource)
    if (attrBool(attrs, 'gridLines')) {
      setup.printGridlines = true
      hasAny = true
    }
    if (attrBool(attrs, 'headings')) {
      setup.printHeadings = true
      hasAny = true
    }
  }
  const headerFooter = firstElement(worksheetXml, 'headerFooter')
  if (headerFooter) {
    const hfAttrs = readAttrs(headerFooter.tagSource)
    if (attrBool(hfAttrs, 'differentOddEven')) setup.differentOddEven = true
    if (attrBool(hfAttrs, 'differentFirst')) setup.differentFirst = true
    if (attr(hfAttrs, 'scaleWithDoc') === '0') setup.headerFooterFixedSize = true
    for (const [key, name] of [
      ['oddHeader', 'oddHeader'],
      ['oddFooter', 'oddFooter'],
      ['evenHeader', 'evenHeader'],
      ['evenFooter', 'evenFooter'],
      ['firstHeader', 'firstHeader'],
      ['firstFooter', 'firstFooter'],
    ] as const) {
      const el = firstElement(headerFooter.body, name)
      if (el) {
        const text = elementText(el.body)
        if (text !== '') {
          setup[key] = text
          hasAny = true
        }
      }
    }
  }
  void PAPER_DEFAULTS
  if (hasAny) sheet.pageSetup = setup
}

function parseProtectedRanges(worksheetXml: string, sheet: ParsedSheet): void {
  eachElement(worksheetXml, 'protectedRanges', (_tag, body) => {
    eachElement(body, 'protectedRange', (tag) => {
      const attrs = readAttrs(tag)
      const sqref = attr(attrs, 'sqref')
      if (!sqref) return
      sheet.protectedRanges.push({
        name: attr(attrs, 'name') ?? 'Range1',
        sqref,
        hasPassword: attr(attrs, 'password') !== null || attr(attrs, 'algorithmName') !== null,
      })
    })
  })
}

function parseOutlinePr(worksheetXml: string, sheet: ParsedSheet): void {
  const sheetPr = firstElement(worksheetXml, 'sheetPr')
  if (!sheetPr) return
  const outlinePr = firstElement(sheetPr.body, 'outlinePr')
  if (!outlinePr) return
  const attrs = readAttrs(outlinePr.tagSource)
  if (attr(attrs, 'summaryBelow') === '0') sheet.outlineSummaryBelow = false
  if (attr(attrs, 'summaryRight') === '0') sheet.outlineSummaryRight = false
}

// ── range serving ────────────────────────────────────────────────────────────

/** Serve one workbookRangeResult window from the parsed sheet. */
export function readRange(sheet: ParsedSheet, range: CellArea): {
  cells: CellRecord[]
  rows: {
    row: number
    height?: number
    customHeight?: boolean
    hidden: boolean
    outlineLevel?: number
    collapsed?: boolean
    styleIndex?: number
  }[]
  merges: CellArea[]
  hyperlinks: SheetHyperlink[]
  conditionalRules: ConditionalRule[]
  autoFilter: CellArea | null
  autoFilterColumns: ParsedSheet['autoFilterColumns']
  dataValidations: DataValidationRule[]
  sheetProtection: SheetProtection | null
  rowBreaks: number[]
  colBreaks: number[]
  pageSetup: PageSetup | null
  protectedRanges: { name: string; sqref: string; hasPassword: boolean }[]
  indexedThroughRow: number | null
  indexingComplete: boolean
} {
  const cells: CellRecord[] = []
  const rowsOut: ReturnType<typeof readRange>['rows'] = []
  for (let row = range.startRow; row <= range.endRow; row++) {
    const parsed = sheet.rows.get(row)
    if (!parsed) continue
    for (const cell of parsed.cells.values()) {
      if (cell.column < range.startColumn || cell.column > range.endColumn) continue
      cells.push(cell)
    }
    if (
      parsed.height !== undefined ||
      parsed.hidden ||
      parsed.outlineLevel !== undefined ||
      parsed.collapsed ||
      parsed.styleIndex !== undefined ||
      parsed.cells.size > 0
    ) {
      rowsOut.push({
        row,
        ...(parsed.height !== undefined ? { height: parsed.height } : {}),
        ...(parsed.customHeight ? { customHeight: parsed.customHeight } : {}),
        hidden: parsed.hidden,
        ...(parsed.outlineLevel !== undefined ? { outlineLevel: parsed.outlineLevel } : {}),
        ...(parsed.collapsed ? { collapsed: parsed.collapsed } : {}),
        ...(parsed.styleIndex !== undefined ? { styleIndex: parsed.styleIndex } : {}),
      })
    }
  }
  const styleOnlyRows = sheet.rows.size === 0 && sheet.columnWidths.length === 0
  void styleOnlyRows
  return {
    cells,
    rows: rowsOut,
    merges: sheet.merges.filter((merge) => areaOverlaps(merge, range)),
    hyperlinks: sheet.hyperlinks.filter((link) =>
      link.row >= range.startRow && link.row <= range.endRow && link.column >= range.startColumn && link.column <= range.endColumn,
    ),
    conditionalRules: sheet.conditionalRules,
    autoFilter: sheet.autoFilter,
    autoFilterColumns: sheet.autoFilterColumns,
    dataValidations: sheet.dataValidations,
    sheetProtection: sheet.sheetProtection,
    rowBreaks: sheet.rowBreaks,
    colBreaks: sheet.colBreaks,
    pageSetup: sheet.pageSetup,
    protectedRanges: sheet.protectedRanges,
    indexedThroughRow: sheet.dimensionRows,
    indexingComplete: true,
  }
}

/** Highest column letter helper re-exported for tests. */
export { areaLabel, ensureRow as ensureRowAt }
export type { WorkbookCellStyle }
