/**
 * Plan helpers for the sheets renderer: the streaming/structure gate checks
 * the op executors share with the delete precheck. The AI plan builders that
 * lived here (proposeOperations / runDeterministicPlan) are gone with the AI.
 */
import {
  isStructuralOp,
  type PrimitiveOperation,
  type WorkbookOperation,
} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import { offsetFormulaRefs } from '@genoffice/xlsx-gateway/domain/formula-shift'
import { quadraticFormulaError, type FormulaCostSheet } from './formula-cost'
import { indexedFormulas, sharedFormulaText, SharedFormulaLookup } from './shared-formula-index'
import {
  columnIndex,
  columnLabel,
  formatAddress,
  parseAddress,
  parseRange,
  rangeCellCount,
  type RangeBounds,
} from '@genoffice/xlsx-gateway/domain/cell-address'
import {
  qualifierMatches,
  shiftCellArea,
  shiftFormulaText,
  StructuralShiftError,
} from '@genoffice/xlsx-gateway/gateway/xlsx-structure'
import { MAX_PATCH_ENTRY_BYTES } from '../shared/desktop-api'
import { isSheetRemoved } from './edit-journal'
import { cellKey, parseFormulaReferences } from './formula-closure'
import { t, type StringKey } from './i18n/locale'
import {
  lazyCellEditable,
  lazyRangeEditable,
  lazyWorkbookCellReader,
  normalizeLinkTarget,
  protectSheetGuard,
} from './univer-sync'
import { CLOSURE_MAX_CELLS, type LazyWorkbookState, type UniverRuntime } from './univer-state'

const PIVOT_GATED_OPS = new Set([
  'insert_rows',
  'delete_rows',
  'insert_cols',
  'delete_cols',
  'merge_cells',
  'unmerge_cells',
])
const FILTER_GATED_OPS = new Set(['set_filter', 'clear_filter', 'set_filter_criteria'])
/// Ops that only rewrite workbook.xml, never the sheet's own part.
const SHEET_PART_EXEMPT_OPS = new Set([
  'rename_sheet',
  'move_sheet',
  'set_sheet_hidden',
  'delete_sheet',
])

/** Mirrors the BeforeCommandExecute gates (App.tsx) that silently cancel the
 * facade commands these ops dispatch: checked at propose time and re-checked
 * at apply time so a gated op fails with a model-facing error instead of the
 * tool reporting success on a cancelled command. */
/** A gate refusal: the model-facing reason plus, where the ribbon shows the
 * same refusal today, its localized status-bar string. */
export interface GateFailure {
  readonly reason: string
  readonly messageKey?: StringKey
}

export function lazyGateError(
  state: LazyWorkbookState,
  operation: WorkbookOperation | PrimitiveOperation,
): string | null {
  return lazyGateFailure(state, operation)?.reason ?? null
}

export function lazyGateFailure(
  state: LazyWorkbookState,
  operation: WorkbookOperation | PrimitiveOperation,
): GateFailure | null {
  const sheetId =
    'sheetId' in operation && typeof operation.sheetId === 'string' ? operation.sheetId : undefined
  if (sheetId === undefined) return null
  const isAddedSheet = state.editJournal.sheets.added.has(sheetId)
  // Ops that write inside the worksheet part are unsavable when its XML is
  // above the gateway patch cap; fail here so Apply never succeeds against
  // a save that must fail. Workbook-level ops (rename/move/hide/delete a
  // sheet) only rewrite workbook.xml and stay allowed. add_pivot reads
  // `sheetId` and bakes its output onto `targetSheetId` — gate that one on
  // the write target.
  const writeSheetId = operation.op === 'add_pivot' ? (operation.targetSheetId ?? sheetId) : sheetId
  if (
    !state.editJournal.sheets.added.has(writeSheetId) &&
    !SHEET_PART_EXEMPT_OPS.has(operation.op)
  ) {
    const sheetMeta = state.file.sheets.find((sheet) => sheet.id === writeSheetId)
    if (sheetMeta !== undefined && (sheetMeta.sourceXmlBytes ?? 0) > MAX_PATCH_ENTRY_BYTES) {
      return {
        reason:
          `Sheet "${sheetMeta.name}" is read-only this session: its worksheet XML is ` +
          `${Math.round((sheetMeta.sourceXmlBytes ?? 0) / 1024 / 1024)}MB uncompressed, above the ` +
          `${Math.round(MAX_PATCH_ENTRY_BYTES / 1024 / 1024)}MB save limit, so edits there can never be saved. ` +
          'Write results to another sheet instead — copy_range (with filterColumn/filterValues to ' +
          'extract rows) and aggregate_range both read it fine.',
      }
    }
  }
  if (PIVOT_GATED_OPS.has(operation.op)) {
    const sheetMeta = state.file.sheets.find((sheet) => sheet.id === sheetId)
    if (sheetMeta && sheetMeta.pivotRanges.length > 0) {
      return {
        reason:
          `Sheet "${sheetMeta.name}" contains a PivotTable — row/column inserts, deletions, and merges ` +
          'are blocked there because a shift would desync the baked pivot output. ' +
          'Make the change on a sheet without pivot tables.',
        messageKey: 'appPivotSheetNoStructural',
      }
    }
    if (operation.op === 'merge_cells') {
      // The save gateway refuses this (shiftTablePart); fail before the merge
      // is journaled, or every later edit is held hostage by an unsavable one.
      const table = tableOverlapping(state, sheetId, parseRange(operation.range))
      if (table !== null) {
        return {
          reason:
            `Merging cells over table "${table}" is not supported. ` +
            'Merge outside the table range, or convert the table to a plain range first.',
          messageKey: 'appMergeOverTable',
        }
      }
    }
    return null
  }
  if (FILTER_GATED_OPS.has(operation.op)) {
    if (!isAddedSheet && (!state.formulaMode || !state.flags.preloadComplete)) {
      return state.formulaMode
        ? {
            reason:
              'Filter changes need the workbook fully loaded — it is still loading; retry after loading completes.',
            messageKey: 'appFullLoadRunning',
          }
        : {
            reason:
              'Filter changes need the fully-loaded mode — this workbook is too large and streams partially, so filters cannot be edited.',
          }
    }
    // Table filters are no longer gated here: the save routes them into the
    // table part (applyRoutedFilterState in the gateway).
    return null
  }
  if (
    operation.op === 'set_data_validation' &&
    !isAddedSheet &&
    !state.appliedDvSheets.has(sheetId)
  ) {
    return {
      reason:
        "This sheet's data-validation rules are still being indexed — retry after workbook indexing completes.",
      messageKey: 'appSheetStillIndexing',
    }
  }
  return null
}

/// Name of the first table (file or added this session) whose range
/// intersects `bounds` on the sheet, or null. File tables move through the
/// journaled structural ops by the same rule shiftTablePart applies at save
/// (not fileRangeToScreenRange, which drops rows inserted inside the table);
/// session-added tables are recorded in current coordinates already.
function tableOverlapping(
  state: LazyWorkbookState,
  sheetId: string,
  bounds: RangeBounds,
): string | null {
  const overlaps = (area: RangeBounds): boolean =>
    bounds.startRow <= area.endRow &&
    bounds.endRow >= area.startRow &&
    bounds.startColumn <= area.endColumn &&
    bounds.endColumn >= area.startColumn
  const sheetMeta = state.file.sheets.find((sheet) => sheet.id === sheetId)
  const ops = state.editJournal.structuralOps.get(sheetId) ?? []
  for (const table of sheetMeta?.tables ?? []) {
    let area: RangeBounds | null
    try {
      area = shiftCellArea(table.range, ops)
    } catch (error) {
      // a torn table already dooms the save; refusing here keeps the gate honest
      if (error instanceof StructuralShiftError) return table.name ?? '(unnamed)'
      throw error
    }
    if (area !== null && overlaps(area)) return table.name ?? '(unnamed)'
  }
  for (const table of state.editJournal.tableAdds) {
    if (table.sheetId === sheetId && overlaps(table.area)) return table.name
  }
  return null
}

export interface StreamedRefSheet {
  readonly id: string
  /** current display name (session renames included) */
  readonly name: string
  /** data extent, clamping whole-axis refs; undefined for sheets added this
   * session — those live fully in the grid and are always safe to reference */
  readonly fileExtent?: { readonly rows: number; readonly columns: number } | undefined
}

/** Current sheet list with file extents for the streamed-formula collector.
 * Session-added sheets carry no extent — they live fully in the grid. */
export function streamedRefSheetList(
  state: LazyWorkbookState,
  workbook: { getSheets(): { getSheetId(): string; getSheetName(): string }[] },
): StreamedRefSheet[] {
  return workbook.getSheets().map((sheet) => {
    const meta = state.file.sheets.find((candidate) => candidate.id === sheet.getSheetId())
    return {
      id: sheet.getSheetId(),
      name: sheet.getSheetName(),
      ...(meta ? { fileExtent: { rows: meta.rowCount, columns: meta.columnCount } } : {}),
    }
  })
}

/** Excel sheet references are case-insensitive; mirror computeFormulaClosure's
 * exact-then-lowercased resolution so a case-variant spelling still collects
 * its precedents instead of silently skipping the pin (and the budget). */
function resolveQualifiedSheet(
  qualifier: string,
  sheets: readonly StreamedRefSheet[],
): StreamedRefSheet | undefined {
  const exact = sheets.find((sheet) => qualifierMatches(qualifier, sheet.name))
  if (exact) return exact
  const unquoted = (
    qualifier.startsWith("'") ? qualifier.slice(1, -1).replaceAll("''", "'") : qualifier
  ).toLowerCase()
  return sheets.find((sheet) => sheet.name.toLowerCase() === unquoted)
}

/**
 * File-sheet cells a formula reads, added to `out` (per sheet id, cellKey
 * sets in screen coordinates). On a streamed workbook Univer's grid only
 * holds the streamed-in viewport of each file sheet, so before such a
 * formula is written, the apply path loads & PINS these cells into the
 * engine (pinStreamedPrecedents) — the formula then computes correctly and
 * survives viewport eviction, exactly like closure-mode formulas. Whole-axis
 * refs clamp to the sheet's data extent (cells past it are empty in the
 * file); refs to session-added sheets and cells already pinned are skipped.
 * Collection stops just past the session budget — the batch gets rejected
 * then (streamedPinBudgetError), so unbounded key sets are never built.
 */
export function collectStreamedFormulaPrecedents(
  formula: string,
  hostSheetId: string,
  sheets: readonly StreamedRefSheet[],
  out: Map<string, Set<number>>,
  alreadyPinned?: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): void {
  let total = 0
  for (const cells of out.values()) total += cells.size
  for (const reference of parseFormulaReferences(formula)) {
    const target =
      reference.qualifier === undefined
        ? sheets.find((sheet) => sheet.id === hostSheetId)
        : resolveQualifiedSheet(reference.qualifier, sheets)
    if (!target?.fileExtent) continue
    const { token } = reference
    const lastRow = target.fileExtent.rows - 1
    const lastColumn = target.fileExtent.columns - 1
    const startRow = Math.max(token.startRow ?? 0, 0)
    const endRow = Math.min(token.endRow ?? lastRow, lastRow)
    const startColumn = Math.max(token.startColumn ?? 0, 0)
    const endColumn = Math.min(token.endColumn ?? lastColumn, lastColumn)
    if (endRow < startRow || endColumn < startColumn) continue
    const pinned = alreadyPinned?.get(target.id)
    let cells = out.get(target.id)
    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = startColumn; column <= endColumn; column += 1) {
        if (total > CLOSURE_MAX_CELLS) return
        if (pinned?.has(`${row}:${column}`)) continue
        const key = cellKey(row, column)
        if (cells?.has(key)) continue
        if (!cells) {
          cells = new Set()
          out.set(target.id, cells)
        }
        cells.add(key)
        total += 1
      }
    }
  }
}

/**
 * Whether an unfiltered streamed copy can carry its source formulas live at
 * the target. `carried` maps 'row:col' (source screen coordinates) to the
 * harvested formula text; the copy shifts every text by one uniform block
 * delta, so guards run per distinct text. Same discipline as any streamed
 * formula write — quadratic-cost formulas and reference sets past the shared
 * session pin budget refuse, and the caller falls back to the frozen-values
 * copy with a notice instead of failing the batch. References inside the
 * copy's own write rectangle are pinned like any other precedent: the copied
 * cells are plain journal cells otherwise, and viewport eviction would wipe
 * the ones outside the current window, leaving in-block formulas computing
 * against blanks while still looking live.
 */
export function carryCopyFormulasPlan(
  state: LazyWorkbookState,
  workbook: { getSheets(): { getSheetId(): string; getSheetName(): string }[] },
  targetSheetId: string,
  targetSheetName: string,
  carried: ReadonlyMap<string, string>,
  rowDelta: number,
  columnDelta: number,
): { ok: true; needs: Map<string, Set<number>> } | { ok: false; reason: string } {
  const offsetTexts = new Set<string>()
  for (const text of carried.values()) {
    offsetTexts.add(offsetFormulaRefs(text, rowDelta, columnDelta))
  }
  const costSheets = lazyFormulaCostSheets(state)
  for (const text of offsetTexts) {
    if (quadraticFormulaError(text, targetSheetName, costSheets) !== null) {
      return {
        ok: false,
        reason:
          'a copied formula would be too expensive to evaluate live ' +
          '(criteria/lookup function over a large range)',
      }
    }
  }
  const needs = new Map<string, Set<number>>()
  const refSheets = streamedRefSheetList(state, workbook)
  for (const text of offsetTexts) {
    collectStreamedFormulaPrecedents(text, targetSheetId, refSheets, needs, state.closure.pinned)
  }
  if (streamedPinBudgetError(state, needs) !== null) {
    return {
      ok: false,
      reason:
        'their references exceed the live-formula session budget. Copy a smaller block, ' +
        'or rebuild the formulas that must stay live with fill_range/set_formula',
    }
  }
  return { ok: true, needs }
}

/**
 * Session budget check for on-demand precedent pinning, shared with closure
 * mode's own budget (CLOSURE_MAX_CELLS): beyond it the engine cannot hold
 * the referenced data, so the batch fails closed with alternatives instead
 * of letting the formulas display silently wrong results.
 */
/**
 * The save rewrites every formula across a row/column deletion and fails
 * closed when a reference lands fully inside the deleted span (the rewrite
 * cannot produce #REF! yet) — which used to surface only at ⌘S, after the
 * apply had reported success and the canvas showed the deletion. Run the
 * exact same rewrite (shiftFormulaText) over the known formula texts at
 * apply time and fail the batch loud instead, workbook untouched.
 *
 * Best-effort by design: prior structural session ops shift the file texts'
 * coordinates (the save replays ops in sequence; this check does not), and a
 * truncated or still-indexing formula index leaves texts unknown — those
 * cases return null and keep today's save-time guard as the backstop.
 */
type DeleteSpanOp =
  | { op: 'delete_rows'; sheetId: string; row: number; count: number }
  | { op: 'delete_cols'; sheetId: string; column: string; count: number }

function deleteSpanSpec(
  state: LazyWorkbookState,
  sheetNameOf: (sheetId: string) => string | undefined,
  operation: DeleteSpanOp,
): {
  axis: 'row' | 'column'
  shift: { boundary: number; delta: number; deleted: { start: number; end: number } }
  deletedSheetName: string
} {
  const axis = operation.op === 'delete_cols' ? ('column' as const) : ('row' as const)
  const index = operation.op === 'delete_cols' ? columnIndex(operation.column) : operation.row - 1
  return {
    axis,
    shift: {
      boundary: index,
      delta: -operation.count,
      deleted: { start: index, end: index + operation.count - 1 },
    },
    deletedSheetName:
      state.file.sheets.find((sheet) => sheet.id === operation.sheetId)?.name ??
      sheetNameOf(operation.sheetId) ??
      '',
  }
}

/// A formula whose own cell is in the deleted span goes with it — the save
/// drops those cells before it rewrites references — so it is no reason to
/// refuse the deletion, whatever it references.
function removedWithSpan(
  spec: ReturnType<typeof deleteSpanSpec>,
  row: number,
  column: number,
): boolean {
  const index = spec.axis === 'column' ? column : row
  return index >= spec.shift.deleted.start && index <= spec.shift.deleted.end
}

function deletedSpanTextError(
  texts: readonly string[],
  spec: ReturnType<typeof deleteSpanSpec>,
  qualifiedOnly: boolean,
): string | null {
  for (const text of texts) {
    try {
      shiftFormulaText(text, spec.deletedSheetName, spec.shift, spec.axis, qualifiedOnly)
    } catch (error) {
      if (error instanceof StructuralShiftError) {
        const span = spec.axis === 'column' ? 'columns' : 'rows'
        return (
          `A formula (${text.length > 80 ? `${text.slice(0, 80)}…` : text}) references only the ` +
          `deleted ${span} — the save cannot rewrite it to #REF! yet, so the deletion would ` +
          'fail there. Update or remove such formulas first (find_cells locates them), then retry.'
        )
      }
      throw error
    }
  }
  return null
}

export async function structuralDeleteFormulaError(
  state: LazyWorkbookState,
  workbook: { getSheets(): { getSheetId(): string; getSheetName(): string }[] },
  operation: DeleteSpanOp,
): Promise<string | null> {
  if ([...state.editJournal.structuralOps.values()].some((ops) => ops.length > 0)) return null
  const sheets = workbook.getSheets()
  const spec = deleteSpanSpec(
    state,
    (id) => sheets.find((sheet) => sheet.getSheetId() === id)?.getSheetName(),
    operation,
  )
  const fileSheetIds = new Set(state.file.sheets.map((sheet) => sheet.id))
  for (const sheet of sheets) {
    const sheetId = sheet.getSheetId()
    if (isSheetRemoved(state.editJournal, sheetId)) continue
    const targetSheet = sheetId === operation.sheetId
    const removed = (row: number, column: number) =>
      targetSheet && removedWithSpan(spec, row, column)
    const journalCells = state.editJournal.cells.get(sheetId)
    const texts: string[] = []
    if (journalCells) {
      for (const entry of journalCells.values()) {
        if (entry.formula && !removed(entry.row, entry.column)) texts.push(entry.formula)
      }
    }
    if (fileSheetIds.has(sheetId)) {
      let result
      try {
        result = await window.desktopApi.readWorkbookFormulas({
          sessionId: state.file.sessionId,
          sheetId,
        })
      } catch {
        return null
      }
      if (result.truncated || !result.indexingComplete) return null
      for (const cell of indexedFormulas(
        result.cells,
        new SharedFormulaLookup(result.sharedGroups),
      )) {
        // Only a CONTENT overwrite supersedes the file's formula text — a
        // style-only journal entry leaves the formula in force.
        const entry = journalCells?.get(`${cell.row}:${cell.column}`)
        if (entry && (entry.hasValue || entry.formula)) continue
        if (removed(cell.row, cell.column)) continue
        texts.push(cell.formula)
      }
    }
    // Formulas on other sheets only shift through explicit qualifiers —
    // the same split the save applies.
    const error = deletedSpanTextError(texts, spec, !targetSheet)
    if (error) return error
  }
  return null
}

/**
 * Synchronous variant for the UI's BeforeCommandExecute delete gate. In
 * full-load mode the model holds every live formula, so the scan is exact;
 * on streamed workbooks only the harvested formula index and the journal
 * are available synchronously — best-effort, with the save-time guard as
 * the backstop either way.
 */
export function structuralDeleteFormulaErrorSync(
  state: LazyWorkbookState,
  workbook: {
    getSheets(): {
      getSheetId(): string
      getSheetName(): string
      getMaxRows(): number
      getMaxColumns(): number
      getRange(
        row: number,
        column: number,
        rows: number,
        columns: number,
      ): { getFormulas(): string[][] }
    }[]
  },
  operation: DeleteSpanOp,
): string | null {
  // Session structural ops only invalidate the STREAMED path's texts (the
  // harvested index is in file coordinates); the full-load model already
  // reflects them, so formulaMode keeps checking.
  const structuralShifted = [...state.editJournal.structuralOps.values()].some(
    (ops) => ops.length > 0,
  )
  if (!state.formulaMode && structuralShifted) return null
  const sheets = workbook.getSheets()
  const spec = deleteSpanSpec(
    state,
    (id) => sheets.find((sheet) => sheet.getSheetId() === id)?.getSheetName(),
    operation,
  )
  for (const sheet of sheets) {
    const sheetId = sheet.getSheetId()
    if (isSheetRemoved(state.editJournal, sheetId)) continue
    const targetSheet = sheetId === operation.sheetId
    const removed = (row: number, column: number) =>
      targetSheet && removedWithSpan(spec, row, column)
    const texts: string[] = []
    if (state.formulaMode) {
      // the live model already reflects every session edit
      const formulas = sheet.getRange(0, 0, sheet.getMaxRows(), sheet.getMaxColumns()).getFormulas()
      formulas.forEach((cells, row) =>
        cells.forEach((formula, column) => {
          if (formula && !removed(row, column)) texts.push(formula)
        }),
      )
    } else {
      const journalCells = state.editJournal.cells.get(sheetId)
      if (journalCells) {
        for (const entry of journalCells.values()) {
          if (entry.formula && !removed(entry.row, entry.column)) texts.push(entry.formula)
        }
      }
      const harvested = state.formulaText.get(sheetId)
      if (harvested) {
        for (const [key, text] of harvested) {
          const entry = journalCells?.get(key)
          if (entry && (entry.hasValue || entry.formula)) continue
          const [row, column] = key.split(':').map(Number)
          if (removed(row ?? -1, column ?? -1)) continue
          texts.push(text)
        }
      }
      state.sharedFormulaGroups.get(sheetId)?.forEachFollower((row, column, group) => {
        const entry = journalCells?.get(`${row}:${column}`)
        if (entry && (entry.hasValue || entry.formula)) return
        if (removed(row, column)) return
        texts.push(sharedFormulaText(group, row, column))
      })
    }
    const error = deletedSpanTextError(texts, spec, !targetSheet)
    if (error) return error
  }
  return null
}

export function streamedPinBudgetError(
  state: LazyWorkbookState,
  needs: ReadonlyMap<string, ReadonlySet<number>>,
): string | null {
  let needed = 0
  for (const cells of needs.values()) needed += cells.size
  if (needed === 0) return null
  let pinnedCount = 0
  for (const pinned of state.closure.pinned.values()) pinnedCount += pinned.size
  if (pinnedCount + needed <= CLOSURE_MAX_CELLS) return null
  return (
    'This workbook is too large for a full load — formulas stay live here by loading the file cells they reference ' +
    `into the engine, within a session budget of ${CLOSURE_MAX_CELLS.toLocaleString('en-US')} cells. This batch's formulas need ` +
    `~${needed.toLocaleString('en-US')} more cells (${pinnedCount.toLocaleString('en-US')} already loaded) and exceed it. ` +
    'For statistics over bigger ranges use aggregate_range and write the result as a static value; to extract matching ' +
    'rows use copy_range filterColumn/filterValues (static values, reads the real file data). Formulas referencing only ' +
    'sheets added this session are always fine.'
  )
}

/** Every formula a batch would write: set_formula plus "="-strings in set_range. */
function* formulaOperations(
  operations: readonly WorkbookOperation[],
): Generator<{ sheetId: string; formula: string }> {
  for (const operation of operations) {
    if (operation.op === 'set_formula') {
      yield { sheetId: operation.sheetId, formula: operation.formula }
    } else if (operation.op === 'set_range') {
      for (const row of operation.values) {
        for (const value of row) {
          if (typeof value === 'string' && value.startsWith('=')) {
            yield { sheetId: operation.sheetId, formula: value }
          }
        }
      }
    }
  }
}

function lazyFormulaCostSheets(state: LazyWorkbookState): FormulaCostSheet[] {
  return state.file.sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rowCount,
    columns: sheet.columnCount,
  }))
}

/** Demo sheets carry no extent metadata; derive it from the populated cells. */
function demoFormulaCostSheets(
  sheets: readonly { name: string; cells: Readonly<Record<string, unknown>> }[],
): FormulaCostSheet[] {
  return sheets.map((sheet) => {
    let rows = 1
    let columns = 1
    for (const address of Object.keys(sheet.cells)) {
      const cell = parseAddress(address)
      rows = Math.max(rows, cell.row + 1)
      columns = Math.max(columns, cell.column + 1)
    }
    return { name: sheet.name, rows, columns }
  })
}
