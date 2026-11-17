/**
 * Browser adapter for the GenOffice Sheets renderer.
 *
 * Implements the same `DesktopApi` surface the Electron preload exposed
 * (window.desktopApi), but everything runs in the browser:
 *  - workbook reads → the in-memory TS engine (adapter/engine), served through
 *    the same read-range protocol the Rust sidecar streamed;
 *  - workbook saves → the xlsx-gateway planner + a byte-preserving zip splice
 *    (adapter/archive), verified fail-closed with assertManifestPreserved;
 *  - file open/save → whitelisted Frappe methods over the File doctype.
 *
 * Features that genuinely needed the desktop (recalculation without cached
 * values, external-link refresh, printing/PDF export, CSV save) report a
 * structured failure the renderer already surfaces as a toast or status line.
 */

import type {
  DesktopApi,
  WorkbookFile,
  WorkbookRangeRequest,
  WorkbookRangeResult,
  WorkbookFormulaCellsRequest,
  WorkbookFormulaCellsResult,
  WorkbookFindCellsRequest,
  WorkbookFindCellsResult,
  WorkbookRowOutlineResult,
  WorkbookRecalcRequest,
  WorkbookRecalcResult,
  WorkbookSaveRequest,
  WorkbookSaveResult,
  WorkbookSaveEditsBegin,
  WorkbookSaveEditsChunk,
  WorkbookSaveEditsAbort,
  WorkbookMediaRequest,
  WorkbookMediaResult,
  ExternalLinksResult,
  ExternalLinksUpdateResult,
  ExternalLinkUsageResult,
  ExternalLinksRequest,
  MenuAction,
  UiTheme,
  DocTheme,
  AutoSaveDefault,
  WorkbookPivotRequest,
  WorkbookPivotDefinition,
  WorkbookSlicerStateRequest,
  WorkbookSlicerState,
} from '../shared/desktop-api'
import { saveEditsChunkArraySchema } from '../shared/desktop-api'
import { parseWorkbook, WorkbookParseError, type ParsedWorkbook } from './engine/parse-workbook'
import { readRange as readSheetRange, type ParsedSheet } from './engine/worksheet'
import { saveWorkbookBytes } from './archive'
import type { StreamingSaveRequest } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import type { SheetStructuralOps } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import {
  bootstrap,
  fetchFrappeFile,
  saveFrappeFile,
  toBase64,
  fromBase64,
} from './frappe'

const UNSUPPORTED_BROWSER =
  'This feature needs the desktop build and is not available in the browser yet'

// ── session state ────────────────────────────────────────────────────────────

interface WorkbookSession {
  readonly file: WorkbookFile
  readonly parsed: ParsedWorkbook
  /** display name the Frappe File record carries */
  fileName: string
  docname: string
  attachedToDoctype: string | null
  attachedToName: string | null
  isPrivate: boolean
}

let session: WorkbookSession | null = null
let selectConsumed = false

/** sidecar session lookups fail the same way an unknown sessionId did upstream */
function requireSession(sessionId: string): WorkbookSession {
  if (session === null || session.file.sessionId !== sessionId) {
    throw new Error('The workbook session is no longer open.')
  }
  return session
}

function sheetOf(state: WorkbookSession, sheetId: string): ParsedSheet {
  const sheet = state.parsed.sheets.get(sheetId)
  if (!sheet) throw new Error(`Unknown worksheet ${sheetId}.`)
  return sheet
}

async function parseFromBytes(bytes: Uint8Array, fileName: string, lang: 'en' | 'fr' | 'ar'): Promise<ParsedWorkbook> {
  try {
    return await parseWorkbook(bytes, fileName, lang)
  } catch (error) {
    if (error instanceof WorkbookParseError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new WorkbookParseError(`The workbook could not be opened: ${message}`)
  }
}

// ── chunked save transfers (main-process SaveEditsTransferStore parity) ─────

const MAX_SAVE_EDITS_TOTAL = 10_000_000

interface PendingTransfer {
  readonly sessionId: string
  readonly total: number
  readonly chunks: WorkbookSaveRequest['edits'][]
  received: number
}

const transfers = new Map<string, PendingTransfer>()

function takeTransfer(transferId: string | undefined, sessionId: string): WorkbookSaveRequest['edits'] {
  if (transferId === undefined) return []
  const transfer = transfers.get(transferId)
  transfers.delete(transferId)
  if (!transfer || transfer.sessionId !== sessionId) {
    throw new Error('Unknown save transfer.')
  }
  if (transfer.received !== transfer.total) throw new Error('Save transfer is incomplete.')
  const edits: WorkbookSaveRequest['edits'] = []
  for (const chunk of transfer.chunks) edits.push(...chunk)
  return edits
}

// ── save ─────────────────────────────────────────────────────────────────────

async function saveWorkbook(
  sessionId: string,
  edits: WorkbookSaveRequest['edits'],
  request: Omit<WorkbookSaveRequest, 'sessionId' | 'mode' | 'edits' | 'editsTransferId'>,
  mode: 'save' | 'save-as',
): Promise<WorkbookSaveResult> {
  const state = requireSession(sessionId)
  if (state.file.readOnly) {
    throw new Error('This workbook is open read-only — edits cannot be saved')
  }
  const parsed = state.parsed

  /** sheetId → file sheet name, the resolution the desktop main performed */
  const resolveSheetName = (sheetId: string): string => {
    const sheet = parsed.sheets.get(sheetId)
    if (!sheet) throw new Error(`Unknown worksheet ${sheetId}.`)
    return sheet.name
  }

  // sheet ops → plan (renames / additions / removals / hidden / order), like
  // the desktop save handler; tab colors ride the ops as well
  const renames: { sheetName: string; newName: string }[] = []
  const addedSheetNames = new Map<string, string>()
  const duplicateSources = new Map<string, string>()
  const hiddenChanges: { sheetName: string; hidden: boolean }[] = []
  const tabColorStates: { sheetName: string; color: string | null }[] = []
  const removals: string[] = []
  let orderChanged = false
  for (const op of request.sheetOps) {
    if (op.kind === 'add-sheet') {
      addedSheetNames.set(op.sheetId, op.name)
      continue
    }
    if (op.kind === 'duplicate-sheet') {
      const sourceName = resolveSheetName(op.sourceSheetId)
      addedSheetNames.set(op.sheetId, op.name)
      duplicateSources.set(op.sheetId, sourceName)
      continue
    }
    if (op.kind === 'reorder-sheets') {
      orderChanged = true
      continue
    }
    const sheetName = addedSheetNames.get(op.sheetId) ?? resolveSheetName(op.sheetId)
    if (op.kind === 'rename-sheet') renames.push({ sheetName, newName: op.newName })
    else if (op.kind === 'set-sheet-hidden') hiddenChanges.push({ sheetName, hidden: op.hidden })
    else if (op.kind === 'set-sheet-tab-color') tabColorStates.push({ sheetName, color: op.color })
    else removals.push(sheetName)
  }
  const renameByOriginal = new Map(renames.map((rename) => [rename.sheetName, rename.newName]))
  const resolveFinalSheetName = (sheetId: string): string => {
    const sheetName = addedSheetNames.get(sheetId) ?? resolveSheetName(sheetId)
    return addedSheetNames.has(sheetId) ? sheetName : (renameByOriginal.get(sheetName) ?? sheetName)
  }
  let sheetPlan: StreamingSaveRequest['sheetPlan']
  if (request.sheetOps.some((op) => op.kind !== 'set-sheet-tab-color')) {
    sheetPlan = {
      renames,
      additions: [...addedSheetNames].map(([sheetId, name]) => ({
        name,
        sourceSheetName: duplicateSources.get(sheetId),
      })),
      removals,
      hiddenChanges,
      orderChanged,
      order: request.sheetOrder.map(resolveFinalSheetName),
    }
  }

  // wire edits (sheetId + flat value/formula) → gateway CellEdit
  const cellEdits = edits.map((edit) => ({
    sheetName: resolveSheetName(edit.sheetId),
    row: edit.row,
    column: edit.column,
    writeValue: edit.writeValue,
    cell: { value: edit.value, formula: edit.formula },
    style: edit.style,
    rich: edit.rich,
    styleReset: edit.styleReset,
  }))
  const bulkConstantFills = (request.bulkConstantFills ?? []).map(({ sheetId, ...fill }) => ({
    sheetName: resolveSheetName(sheetId),
    ...fill,
  }))
  const opsBySheet = new Map<string, SheetStructuralOps['ops'][number][]>()
  for (const op of request.structuralOps) {
    const sheetName = resolveSheetName(op.sheetId)
    const sheetOps = opsBySheet.get(sheetName) ?? []
    if ('range' in op) {
      sheetOps.push({ kind: op.kind, range: op.range })
    } else if ('size' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, size: op.size })
    } else if ('level' in op) {
      sheetOps.push({
        kind: op.kind,
        start: op.start,
        end: op.end,
        level: op.level,
        ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }),
      })
    } else if ('summaryBelow' in op) {
      sheetOps.push({ kind: op.kind, summaryBelow: op.summaryBelow, summaryRight: op.summaryRight })
    } else if ('hidden' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, hidden: op.hidden })
    } else if ('style' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, style: op.style })
    } else if ('before' in op) {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count, before: op.before })
    } else {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count })
    }
    opsBySheet.set(sheetName, sheetOps)
  }
  const structuralOps: SheetStructuralOps[] = [...opsBySheet].map(([sheetName, ops]) => ({
    sheetName,
    ops,
  }))
  const filterStates = request.filterStates.map((state2) => ({
    sheetName: resolveSheetName(state2.sheetId),
    filter: state2.filter,
    hiddenRows: state2.hiddenRows,
    visibilityRange: state2.visibilityRange,
  }))
  const linksBySheet = new Map<string, { row: number; column: number; target: string | null }[]>()
  for (const link of request.hyperlinkEdits) {
    const sheetName = resolveSheetName(link.sheetId)
    const sheetLinks = linksBySheet.get(sheetName) ?? []
    sheetLinks.push({ row: link.row, column: link.column, target: link.target })
    linksBySheet.set(sheetName, sheetLinks)
  }
  const hyperlinkEdits = [...linksBySheet].map(([sheetName, links]) => ({ sheetName, edits: links }))
  const cfStates = request.cfStates.map((state2) => ({
    sheetName: resolveSheetName(state2.sheetId),
    rules: state2.rules,
  }))
  const dvStates = request.dvStates.map((state2) => ({
    sheetName: resolveSheetName(state2.sheetId),
    rules: state2.rules,
  }))
  const sheetProtections = request.sheetProtections.map(({ sheetId, ...state2 }) => ({
    sheetName: resolveSheetName(sheetId),
    ...state2,
  }))
  const protectedRangeStates = request.protectedRangeStates.map((state2) => ({
    sheetName: resolveSheetName(state2.sheetId),
    ranges: state2.ranges,
  }))
  const pageSetupStates = request.pageSetupStates.map(({ sheetId, ...state2 }) => ({
    sheetName: resolveSheetName(sheetId),
    ...state2,
  }))
  const noteStates = request.noteStates.map(({ sheetId, notes }) => ({
    sheetName: resolveSheetName(sheetId),
    notes,
  }))
  const visualAdditions = request.visualAdditions.map((addition) => ({
    sheetName: resolveSheetName(addition.sheetId),
    anchor: addition.anchor,
    chart: addition.chart,
    shape: addition.shape,
    image: addition.image,
  }))
  const cellImageAdditions = (request.cellImageAdditions ?? []).map(({ sheetId, ...addition }) => ({
    sheetName: resolveSheetName(sheetId),
    ...addition,
  }))
  const tableAdditions = request.tableAdditions.map((table) => ({
    sheetName: resolveSheetName(table.sheetId),
    area: table.area,
    name: table.name,
    columnNames: table.columnNames,
    style: table.style,
    bandedRows: table.bandedRows,
    options: {
      headerRow: table.headerRow,
      totalsRow: table.totalsRow,
      firstColumn: table.firstColumn,
      lastColumn: table.lastColumn,
      bandedColumns: table.bandedColumns,
      filterButton: table.filterButton,
    },
  }))
  const tableEdits = (request.tableEdits ?? []).map(({ sheetId, ...edit }) => ({
    ...edit,
    sheetName: resolveSheetName(sheetId),
  }))
  const sparklineAdditions = request.sparklineAdditions.map(({ sheetId, ...group }) => ({
    sheetName: resolveSheetName(sheetId),
    ...group,
  }))
  const formulaValuesBySheet = new Map<
    string,
    { row: number; column: number; value: string | number | boolean | null | { error: string } }[]
  >()
  for (const cell of request.formulaValues) {
    const sheetName = resolveSheetName(cell.sheetId)
    const list = formulaValuesBySheet.get(sheetName) ?? []
    list.push({ row: cell.row, column: cell.column, value: cell.value })
    formulaValuesBySheet.set(sheetName, list)
  }
  const formulaValues = [...formulaValuesBySheet].map(([sheetName, cells]) => ({ sheetName, cells }))

  // The gateway validates every patch module it runs and fails the save closed
  // on a shape it cannot represent.
  const result = await saveWorkbookBytes(parsed.originalBytes, {
    edits: cellEdits,
    bulkConstantFills,
    structuralOps,
    chartEdits: request.chartEdits,
    // Located by package-absolute drawingPath, so no sheet-name mapping.
    visualEdits: request.visualEdits,
    sheetPlan,
    filterStates,
    hyperlinkEdits,
    cfStates,
    dvStates,
    sheetProtections,
    tabColorStates,
    definedNamesState: request.definedNamesState ?? null,
    themeState: request.themeState ?? null,
    workbookProtectionState: request.workbookProtectionState ?? null,
    protectedRangeStates,
    visualAdditions,
    cellImageAdditions,
    pageSetupStates,
    noteStates,
    tableAdditions,
    tableEdits,
    pivotAdditions: request.pivotAdditions.map((pivot) => ({
      sheetName: resolveSheetName(pivot.sheetId),
      sourceSheetName: resolveSheetName(pivot.sourceSheetId),
      sourceArea: pivot.sourceArea,
      location: pivot.location,
      name: pivot.name,
      fieldNames: pivot.fieldNames,
      rowFieldIndices: pivot.rowFieldIndices,
      columnFieldIndex: pivot.columnFieldIndex,
      pageFieldIndices: pivot.pageFieldIndices,
      pageLevelItems: pivot.pageLevelItems,
      pageItems: pivot.pageItems,
      rowItems: pivot.rowItems,
      rowLevelItems: pivot.rowLevelItems,
      rowLines: pivot.rowLines,
      columnItems: pivot.columnItems,
      columnFieldIndices: pivot.columnFieldIndices,
      colLevelItems: pivot.colLevelItems,
      colLines: pivot.colLines,
      groupings: pivot.groupings,
      filters: pivot.filters,
      rowHiddenItems: pivot.rowHiddenItems,
      colHiddenItems: pivot.colHiddenItems,
      values: pivot.values,
    })),
    sparklineAdditions,
    slicerState:
      request.slicerState === null || request.slicerState === undefined
        ? null
        : {
            slicers: request.slicerState.slicers.map(({ sheetId, ...control }) => ({
              ...control,
              sheetName: resolveSheetName(sheetId),
            })),
            removals: [...request.slicerState.removals],
          },
    formulaValues,
    pivotCacheRefreshPaths: request.pivotCacheRefreshPaths,
    pivotRefreshUpdates: request.pivotRefreshUpdates.map((update) => ({
      cachePath: update.cachePath,
      sheetName: resolveSheetName(update.sheetId),
      newOutputRef: update.newOutputRef,
      ...(update.relayout === undefined
        ? {}
        : {
            relayout: (({ sheetId: _sheetId, sourceSheetId, ...rest }) => ({
              ...rest,
              sourceSheetName: resolveSheetName(sourceSheetId),
            }))(update.relayout),
          }),
    })),
    redactionStates: null,
    externalLinkOps: request.externalLinkOps ?? null,
  })
  // write through the whitelisted API: Save overwrites the opened File in
  // place; Save As creates a new File attached to the same document
  const target =
    mode === 'save-as'
      ? await saveFrappeFile({
          fileName: saveAsName(request.defaultName, state.fileName),
          contentBase64: toBase64(result.buffer),
          attachedToDoctype: state.attachedToDoctype,
          attachedToName: state.attachedToName,
          isPrivate: state.isPrivate,
        })
      : await saveFrappeFile({
          file: state.docname,
          fileName: state.fileName,
          contentBase64: toBase64(result.buffer),
        })
  // session swap: re-parse the saved bytes — new sessionId (and a new docname
  // for Save As), the same swap the desktop session replacement performed
  const lang = (await bootstrap()).lang
  const reparsed = await parseFromBytes(result.buffer, target.name, lang)
  const next: WorkbookSession = {
    file: reparsed.file,
    parsed: reparsed,
    fileName: target.name,
    docname: target.docname,
    attachedToDoctype: state.attachedToDoctype,
    attachedToName: state.attachedToName,
    isPrivate: state.isPrivate,
  }
  session = next
  // sibling-module hook: the print/import-export/signature module listens for saves
  window.parent.postMessage(
    { type: 'sheets-save', file: next.docname, name: next.fileName },
    window.location.origin,
  )
  return {
    canceled: false,
    file: reparsed.file,
    touchedEntries: [...result.touchedEntries],
  }
}

/** Save As name: the dialog suggestion, else a copy of the current name. */
function saveAsName(defaultName: string | undefined, currentName: string): string {
  const base = (defaultName ?? `${currentName.replace(/\.xlsx?$/i, '')} (copy)`).trim()
  const safe = base.replace(/[\\/:*?"<>|]/g, '_')
  return safe.toLowerCase().endsWith('.xlsx') ? safe : `${safe}.xlsx`
}

// ── the adapter ──────────────────────────────────────────────────────────────

export const sheetsApi: DesktopApi = {
  async getLanguage() {
    return (await bootstrap()).lang
  },

  onLanguageChanged() {
    return () => {}
  },

  async getTheme(): Promise<UiTheme> {
    return 'system'
  },

  onThemeChanged() {
    return () => {}
  },

  async getDocumentTheme(): Promise<DocTheme> {
    return 'follow'
  },

  onDocumentThemeChanged() {
    return () => {}
  },

  async getAutoSaveDefault(): Promise<AutoSaveDefault> {
    return { on: false, updatedAt: 0 }
  },

  onAutoSaveDefaultChanged() {
    return () => {}
  },

  /** true until the handed-over File docname has been consumed by selectWorkbook */
  async hasQueuedWorkbook(): Promise<boolean> {
    if (selectConsumed) return false
    const { file } = await bootstrap()
    return file !== null
  },

  /**
   * The single open entry point. The desk page hands the File docname over at
   * boot; opening it fetches the bytes through the whitelisted API and parses
   * them with the in-memory engine.
   */
  async selectWorkbook(): Promise<WorkbookFile | null> {
    if (selectConsumed) return session === null ? null : session.file
    selectConsumed = true
    const { file: fileParam, lang } = await bootstrap()
    if (!fileParam) return null
    const boot = await bootstrap()
    const data = await fetchFrappeFile(fileParam)
    if (!/\.(xlsx|xlsm)$/i.test(data.name)) {
      throw new Error('The spreadsheet editor can only open .xlsx and .xlsm files')
    }
    const bytes = fromBase64(data.contentBase64)
    const parsed = await parseFromBytes(bytes, data.name, lang)
    if (boot.readonly) parsed.file.readOnly = true
    session = {
      file: parsed.file,
      parsed,
      fileName: data.name,
      docname: data.docname,
      attachedToDoctype: data.attachedToDoctype,
      attachedToName: data.attachedToName,
      isPrivate: data.isPrivate,
    }
    return session.file
  },

  async readWorkbookRange(request: WorkbookRangeRequest): Promise<WorkbookRangeResult> {
    const state = requireSession(request.sessionId)
    const sheet = sheetOf(state, request.sheetId)
    const result = readSheetRange(sheet, request.range)
    const wire: WorkbookRangeResult = {
      cells: result.cells.map((cell) => ({
        row: cell.row,
        column: cell.column,
        value: cell.value,
        ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
        ...(cell.arrayRef !== undefined ? { arrayRef: cell.arrayRef } : {}),
        ...(cell.styleIndex !== undefined ? { styleIndex: cell.styleIndex } : {}),
        ...(cell.rich !== undefined ? { rich: cell.rich } : {}),
      })),
      rows: result.rows,
      merges: result.merges,
      hyperlinks: result.hyperlinks.map((link) => ({
        row: link.row,
        column: link.column,
        target: link.target,
      })),
      conditionalRules: result.conditionalRules,
      autoFilter: result.autoFilter,
      autoFilterColumns: result.autoFilterColumns,
      dataValidations: result.dataValidations,
      sheetProtection: result.sheetProtection,
      rowBreaks: result.rowBreaks,
      colBreaks: result.colBreaks,
      pageSetup: result.pageSetup ?? null,
      protectedRanges: result.protectedRanges,
      indexedThroughRow: result.indexedThroughRow,
      indexingComplete: result.indexingComplete,
    }
    return wire
  },

  async readWorkbookFormulas(request: WorkbookFormulaCellsRequest): Promise<WorkbookFormulaCellsResult> {
    const state = requireSession(request.sessionId)
    const sheet = sheetOf(state, request.sheetId)
    const cells: WorkbookFormulaCellsResult['cells'] = []
    for (const row of sheet.rows.values()) {
      for (const cell of row.cells.values()) {
        if (cell.formula === undefined) continue
        cells.push({
          row: cell.row,
          column: cell.column,
          value: cell.value,
          formula: cell.formula,
          ...(cell.arrayRef !== undefined ? { arrayRef: cell.arrayRef } : {}),
          ...(cell.styleIndex !== undefined ? { styleIndex: cell.styleIndex } : {}),
        })
        if (cells.length >= 100_000) {
          return { cells, sharedGroups: [], indexingComplete: false, truncated: true }
        }
      }
    }
    return { cells, sharedGroups: [], indexingComplete: true, truncated: false }
  },

  async findWorkbookCells(request: WorkbookFindCellsRequest): Promise<WorkbookFindCellsResult> {
    const state = requireSession(request.sessionId)
    const query = request.matchCase ? request.query : request.query.toLowerCase()
    const wildcards = request.wildcards
      ? new RegExp(
          `^${request.query.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`))}$`,
          request.matchCase ? '' : 'i',
        )
      : null
    const matches: WorkbookFindCellsResult['matches'] = []
    const sheetIds = request.sheetId ? [request.sheetId] : [...state.parsed.sheets.keys()]
    let resumeSheetPassed = true
    for (const sheetId of sheetIds) {
      if (request.resumeAt !== undefined && !resumeSheetPassed) {
        if (sheetId === request.resumeAt.sheetId) resumeSheetPassed = true
        else continue
      }
      const sheet = state.parsed.sheets.get(sheetId)
      if (!sheet) continue
      for (const [rowIndex, row] of sheet.rows.entries()) {
        if (request.resumeAt !== undefined && sheetId === request.resumeAt.sheetId && rowIndex < request.resumeAt.row) continue
        for (const cell of row.cells.values()) {
          if (
            request.resumeAt !== undefined &&
            sheetId === request.resumeAt.sheetId &&
            rowIndex === request.resumeAt.row &&
            cell.column <= request.resumeAt.column
          ) {
            continue
          }
          const hasFormula = cell.formula !== undefined
          if (request.lookIn === 'formulas_only' && !hasFormula) continue
          if (request.lookIn === 'formulas' && !hasFormula && cell.value === null) continue
          if (request.lookIn === 'values' && hasFormula) continue
          const candidates: string[] = []
          if (request.lookIn !== 'formulas_only' && cell.value !== null) {
            candidates.push(typeof cell.value === 'string' ? cell.value : String(cell.value))
          }
          if (request.lookIn !== 'values' && hasFormula && cell.formula !== undefined) candidates.push(cell.formula)
          let hit = false
          let valueText: string | null = null
          let formulaText: string | undefined
          for (const candidate of candidates) {
            const haystack = request.matchCase ? candidate : candidate.toLowerCase()
            const found = wildcards ? wildcards.test(candidate) : haystack.includes(query)
            if (!found) continue
            hit = true
            if (candidate === cell.formula) formulaText = candidate
            else valueText = candidate
            if (!request.matchEntireCell) break
          }
          if (!hit) continue
          if (request.matchEntireCell && wildcards === null) {
            const whole = candidates.some((candidate) =>
              (request.matchCase ? candidate : candidate.toLowerCase()) === query,
            )
            if (!whole) continue
          }
          matches.push({
            sheetId,
            row: cell.row,
            column: cell.column,
            value: cell.value,
            valueText,
            ...(formulaText !== undefined ? { formulaText } : {}),
          })
          if (matches.length >= request.limit) {
            return {
              matches,
              complete: false,
              nextCursor: { sheetId, row: cell.row, column: cell.column },
              indexingComplete: true,
            }
          }
        }
      }
    }
    void resumeSheetPassed
    return { matches, complete: true, indexingComplete: true }
  },

  async readWorkbookRowOutline(request: WorkbookFormulaCellsRequest): Promise<WorkbookRowOutlineResult> {
    const state = requireSession(request.sessionId)
    const sheet = sheetOf(state, request.sheetId)
    const rows: WorkbookRowOutlineResult['rows'] = []
    for (const [rowIndex, row] of sheet.rows.entries()) {
      if (row.outlineLevel === undefined && !row.collapsed) continue
      rows.push({
        row: rowIndex,
        level: row.outlineLevel ?? 0,
        ...(row.collapsed ? { collapsed: true } : {}),
        ...(row.hidden ? { hidden: true } : {}),
      })
    }
    return { rows, indexingComplete: true }
  },

  async recalcWorkbook(_request: WorkbookRecalcRequest): Promise<WorkbookRecalcResult> {
    // the desktop recalculation ran IronCalc in the sidecar; the browser keeps
    // the workbook's cached values (the renderer fails soft on this error)
    throw new Error('Recalculation without cached values is not available in the browser build yet')
  },

  async listExternalLinks(request: ExternalLinksRequest): Promise<ExternalLinksResult> {
    requireSession(request.sessionId)
    // the engine does not read externalReferences parts yet: the panel stays
    // empty instead of showing half-identified links
    return { links: [] }
  },

  async updateExternalLinks(_request: ExternalLinksRequest): Promise<ExternalLinksUpdateResult> {
    throw new Error('Refreshing external links is not available in the browser build yet')
  },

  async readExternalLinkUsage(_request: ExternalLinksRequest): Promise<ExternalLinkUsageResult> {
    return { links: [] }
  },

  async readWorkbookMedia(request: WorkbookMediaRequest): Promise<WorkbookMediaResult> {
    const state = requireSession(request.sessionId)
    const visual = state.file.visuals.find((candidate) => candidate.id === request.visualId)
    if (!visual || visual.mediaPath === undefined) {
      throw new Error('Media not found.')
    }
    const bytes = state.parsed.entries.get(visual.mediaPath)
    if (!bytes) throw new Error('Media not found.')
    return { mediaType: visual.mediaType ?? 'image/png', base64: toBase64(bytes) }
  },

  async readPivotDefinition(_request: WorkbookPivotRequest): Promise<WorkbookPivotDefinition> {
    throw new Error('Pivot refresh is not available in the browser build yet')
  },

  async readSlicerState(_request: WorkbookSlicerStateRequest): Promise<WorkbookSlicerState> {
    // the engine does not read slicer parts; panels restore empty
    return []
  },

  async saveWorkbookEdits(request: WorkbookSaveRequest): Promise<WorkbookSaveResult> {
    const edits = takeTransfer(request.editsTransferId, request.sessionId)
    return saveWorkbook(request.sessionId, edits, request, request.mode)
  },

  async beginSaveEditsTransfer(request: WorkbookSaveEditsBegin): Promise<void> {
    if (transfers.has(request.transferId)) throw new Error('Save transfer already exists.')
    transfers.set(request.transferId, {
      sessionId: request.sessionId,
      total: request.total,
      chunks: [],
      received: 0,
    })
  },

  async sendSaveEditsChunk(request: WorkbookSaveEditsChunk): Promise<void> {
    const transfer = transfers.get(request.transferId)
    if (!transfer || transfer.sessionId !== request.sessionId) {
      throw new Error('Unknown save transfer.')
    }
    if (request.seq !== transfer.chunks.length) {
      transfers.delete(request.transferId)
      throw new Error('Save transfer chunk out of order.')
    }
    // the wire carries the slice as JSON (see the schema note) — validate the
    // same way the main-process store did before accepting it
    let edits: WorkbookSaveRequest['edits']
    try {
      edits = saveEditsChunkArraySchema.parse(JSON.parse(request.editsJson))
    } catch {
      transfers.delete(request.transferId)
      throw new Error('Save transfer chunk is malformed.')
    }
    if (transfer.received + edits.length > transfer.total || transfer.received + edits.length > MAX_SAVE_EDITS_TOTAL) {
      transfers.delete(request.transferId)
      throw new Error('Save transfer exceeds its declared size.')
    }
    transfer.chunks.push(edits)
    transfer.received += edits.length
  },

  async abortSaveEditsTransfer(request: WorkbookSaveEditsAbort): Promise<void> {
    const transfer = transfers.get(request.transferId)
    if (transfer && transfer.sessionId === request.sessionId) transfers.delete(request.transferId)
  },

  async closeWorkbook(sessionId: string): Promise<void> {
    const state = requireSession(sessionId)
    for (const [transferId, transfer] of transfers) {
      if (transfer.sessionId === state.file.sessionId) transfers.delete(transferId)
    }
    if (session !== null && session.file.sessionId === sessionId) session = null
  },

  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener')
  },

  onMenuAction(handler: (action: MenuAction) => void): () => void {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      const data = event.data as Partial<{ type: string; action: string }>
      if (data?.type !== 'sheets-editor-menu') return
      handler(data.action as MenuAction)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  },

  notifyPendingEdits(count: number): void {
    window.parent.postMessage({ type: 'sheets-pending-edits', count }, window.location.origin)
  },

  async getUserDisplayName(): Promise<string> {
    const { fullName } = await bootstrap()
    return fullName || 'user'
  },
}

// ── the sibling-module hook ──────────────────────────────────────────────────

/**
 * The current workbook's bytes, exactly as they would be saved (journal edits
 * applied, byte-preserving). Exposed for the print / import-export / signature
 * module; also available as `window.sheetsEditorApi`.
 */
export async function exportWorkbookBytes(): Promise<Uint8Array | null> {
  if (session === null) return null
  const state = session
  const result = await saveWorkbookBytes(state.parsed.originalBytes, { edits: [] })
  return result.buffer
}

declare global {
  interface Window {
    // same shape renderer/env.d.ts declares; re-stated here so the adapter
    // file set compiles standalone
    desktopApi: DesktopApi
    sheetsEditorApi: {
      exportWorkbookBytes: typeof exportWorkbookBytes
      currentFile: () => { docname: string; fileName: string } | null
    }
  }
}

window.sheetsEditorApi = {
  exportWorkbookBytes,
  currentFile: () =>
    session === null
      ? null
      : { docname: session.docname, fileName: session.fileName },
}

// Expose under the same global the preload used; the renderer types it via env.d.ts
window.desktopApi = sheetsApi
