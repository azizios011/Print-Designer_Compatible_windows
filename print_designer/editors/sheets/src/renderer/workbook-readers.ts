/**
 * Trimmed copy of the former ai/workbook-readers.ts + ai/workbook-search.ts
 * (Apache-2.0): only the live-readout helpers with in-app callers remain —
 * readCells (the save pipeline's cached-value refresh) and selectWorkbookRange
 * (Find & Replace's jump-to-hit). The AI/MCP readers were cut with the agent.
 */
import type { RangeBounds } from '@genoffice/xlsx-gateway/domain/cell-address'
import type { CellScalar } from '@genoffice/xlsx-gateway/domain/workbook.types'
import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { ensureLazyRangeLoaded } from './univer-sync'
import { lazyCellReader } from './univer-sync'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'

export interface WorkbookReadContext {
  univerRef: { readonly current: UniverRuntime | null }
  lazyWorkbookRef: { readonly current: LazyWorkbookState | null }
  adapterRef: { readonly current: InMemoryWorkbookAdapter }
}

export function readCells(
  ctx: WorkbookReadContext,
  addresses: readonly string[],
  sheetId?: string,
): Record<string, { value: CellScalar; formula?: string; rawValue?: CellScalar | undefined }> {
  const result: Record<
    string,
    { value: CellScalar; formula?: string; rawValue?: CellScalar | undefined }
  > = {}
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  const state = ctx.lazyWorkbookRef.current
  if (state) {
    const worksheet =
      sheetId === undefined ? workbook?.getActiveSheet() : workbook?.getSheetBySheetId(sheetId)
    if (!worksheet) return result
    const reader = lazyCellReader(worksheet)
    for (const address of addresses) {
      // All three fields, not just the rendered value: `formula` is the cell's
      // own text and `rawValue` the model value behind it — the save pipeline
      // compares the latter against the file's cached <v>.
      const cell = reader(address)
      result[address] = cell.formula
        ? { value: cell.value, formula: cell.formula, rawValue: cell.rawValue }
        : { value: cell.value, rawValue: cell.rawValue }
    }
    return result
  }
  const sheets = ctx.adapterRef.current.getSnapshot().sheets
  const targetId = sheetId ?? workbook?.getActiveSheet()?.getSheetId()
  const sheet =
    sheets.find((s) => s.id === targetId) ?? (sheetId === undefined ? sheets[0] : undefined)
  if (!sheet) return result
  // The in-memory model stores only value:null for formula cells; computed
  // values live in Univer's formula engine, backfilled by reading the grid
  const worksheet =
    sheetId === undefined ? workbook?.getActiveSheet() : workbook?.getSheetBySheetId(sheetId)
  for (const address of addresses) {
    const cell = sheet.cells[address] ?? { value: null }
    if (cell.formula) {
      let computed = cell.value
      if (computed === null && worksheet) {
        try {
          computed = worksheet.getRange(address).getValue() ?? null
        } catch {
          /* fail-open */
        }
      }
      result[address] = { value: computed, formula: cell.formula }
    } else {
      result[address] = { value: cell.value }
    }
  }
  return result
}

export type SelectRangeOutcome =
  | { ok: true; sheetName: string }
  | { ok: false; error: string }

/** Activate the target sheet, select the range, and scroll it into view. */
export async function selectWorkbookRange(
  ctx: WorkbookReadContext,
  sheetId: string | undefined,
  bounds: RangeBounds,
  setMessage: (message: string) => void,
): Promise<SelectRangeOutcome> {
  const runtime = ctx.univerRef.current
  const workbook = runtime?.univerAPI.getActiveWorkbook()
  if (!runtime || !workbook) return { ok: false, error: 'No workbook is currently open.' }
  const worksheet = sheetId ? workbook.getSheetBySheetId(sheetId) : workbook.getActiveSheet()
  if (!worksheet) return { ok: false, error: `Unknown sheet: ${sheetId}` }
  try {
    if (worksheet.getSheetId() !== workbook.getActiveSheet()?.getSheetId()) {
      workbook.setActiveSheet(worksheet)
    }
    if (ctx.lazyWorkbookRef.current) {
      // Best-effort: selection works on not-yet-streamed cells too, but
      // loading the range means the user sees data, not an empty grid
      await ensureLazyRangeLoaded(
        runtime,
        ctx.lazyWorkbookRef,
        worksheet,
        { ...bounds },
        setMessage,
      )
    }
    worksheet
      .getRange(
        bounds.startRow,
        bounds.startColumn,
        bounds.endRow - bounds.startRow + 1,
        bounds.endColumn - bounds.startColumn + 1,
      )
      .activate()
    worksheet.scrollToCell(bounds.startRow, bounds.startColumn)
    return { ok: true, sheetName: worksheet.getSheetName() }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Selection failed',
    }
  }
}
