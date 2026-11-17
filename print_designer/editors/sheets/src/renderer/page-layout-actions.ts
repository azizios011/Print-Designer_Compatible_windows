/**
 * Page Layout commands, header/footer, freeze journaling. Extracted from
 * App.tsx; the App component passes a PageLayoutContext built fresh per call
 * so refs and state never go stale. Page-setup edits journal per-sheet print
 * settings; nothing renders in the grid (Univer has no page-layout view),
 * everything lands in the saved file. Printing/PDF export itself is cut with
 * the desktop build; the document-level page setup stays.
 */
import type { FWorksheet } from '@univerjs/sheets/facade'
import type { WorkbookOperation } from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import type { ApplyOutcome } from '@genoffice/xlsx-gateway/domain/workbook.types'

import { columnLabel } from '@genoffice/xlsx-gateway/domain/cell-address'
import {
  isSheetRemoved,
  journalSize,
  recordPageSetup,
  recordThemeColors,
  recordThemeFonts,
  type PageSetupJournalState,
} from './edit-journal'
import type { HeaderFooterResult } from './HeaderFooterDialog'
import { t } from './i18n/locale'
import { fileToScreen } from './view-transform'
import { COLOR_SCHEMES, FONT_SCHEMES, rethemeStyles, THEME_PRESETS } from './themes'
import { ensureSheetFileState, loadVisibleRange } from './univer-sync'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'

/// Excel's cap on repeat-rows: a taller span is truncated to its top rows.
const MAX_PRINT_TITLE_ROWS = 21

/// `start:end` 1-based rows for print titles, truncated to the cap.
function clampTitleRows(start: number, end: number): string {
  const safeStart = Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1
  const safeEnd = Number.isFinite(end) ? Math.floor(end) : safeStart
  return `${safeStart}:${Math.min(Math.max(safeEnd, safeStart), safeStart + MAX_PRINT_TITLE_ROWS - 1)}`
}

const PAPER_NAMES: Record<string, string> = {
  1: 'Letter',
  3: 'Tabloid',
  5: 'Legal',
  7: 'Executive',
  8: 'A3',
  9: 'A4',
  11: 'A5',
}

/** The App refs/state the page-layout actions need; built fresh per call. */
export interface PageLayoutContext {
  univerRef: { readonly current: UniverRuntime | null }
  /// The App's live ref (not a snapshot): loadVisibleRange's staleness
  /// guards compare against `.current` after awaits.
  lazyWorkbookRef: { current: LazyWorkbookState | null }
  setMessage: (message: string) => void
  setPendingEdits: (count: number) => void
  /// Page-setup edits run as set_page_setup ops through the shared executor.
  runOps: (
    ops: readonly WorkbookOperation[],
    successMessage?: string | null,
  ) => Promise<ApplyOutcome>
}

const PAGE_SETUP_OP_FIELDS = new Set([
  'orientation',
  'paperSize',
  'scale',
  'fitToWidth',
  'fitToHeight',
  'fitToPage',
  'margins',
  'printGridlines',
  'printHeadings',
  'printArea',
])

/// The sheet's manual page breaks (file + journal, in screen coordinates) —
/// the merged view the Breaks commands edit. Formerly page-break-preview.tsx;
/// the overlay is cut with the print pipeline, the document data stays.
export function effectivePageBreaks(
  state: LazyWorkbookState,
  sheetId: string,
): { rowBreaks: number[]; colBreaks: number[] } | null {
  const journal = state.editJournal.pageSetup.get(sheetId)
  const file = state.sheetPageBreaks.get(sheetId)
  const isAdded = state.editJournal.sheets.added.has(sheetId)
  if (journal?.rowBreaks === undefined && journal?.colBreaks === undefined && !file && !isAdded) {
    return null
  }
  const ops = state.editJournal.structuralOps.get(sheetId) ?? []
  const mapped = (axis: 'row' | 'column', ids: readonly number[]): number[] =>
    ids.map((id) => fileToScreen(ops, axis, id)).filter((id): id is number => id !== null && id > 0)
  return {
    rowBreaks: journal?.rowBreaks ?? mapped('row', file?.rowBreaks ?? []),
    colBreaks: journal?.colBreaks ?? mapped('column', file?.colBreaks ?? []),
  }
}

export function handlePageLayoutCommand(ctx: PageLayoutContext, rest: string): void {
  const runtime = ctx.univerRef.current
  const state = ctx.lazyWorkbookRef.current
  if (!runtime) return
  if (!state) {
    ctx.setMessage(t('appPageSetupNeedsFile'))
    return
  }
  const worksheet = runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()
  const sheetId = worksheet?.getSheetId()
  if (!sheetId || isSheetRemoved(state.editJournal, sheetId)) return
  const recordDirect = (patch: PageSetupJournalState, note: string): void => {
    recordPageSetup(state.editJournal, sheetId, patch)
    ctx.setPendingEdits(journalSize(state.editJournal))
    ctx.setMessage(t('appPageSetupRecorded', { note }))
  }
  // Fields set_page_setup carries (fitToPage is derived by the executor);
  // breaks and print titles have no op yet and journal directly.
  const record = (patch: PageSetupJournalState, note: string): void => {
    if (!Object.keys(patch).every((key) => PAGE_SETUP_OP_FIELDS.has(key))) {
      recordDirect(patch, note)
      return
    }
    const op: WorkbookOperation = {
      op: 'set_page_setup',
      sheetId,
      ...(patch.orientation !== undefined ? { orientation: patch.orientation } : {}),
      ...(patch.paperSize !== undefined ? { paperSize: patch.paperSize } : {}),
      ...(patch.scale !== undefined ? { scale: patch.scale } : {}),
      ...(patch.fitToWidth !== undefined ? { fitToWidth: patch.fitToWidth } : {}),
      ...(patch.fitToHeight !== undefined ? { fitToHeight: patch.fitToHeight } : {}),
      ...(patch.margins !== undefined ? { margins: patch.margins } : {}),
      ...(patch.printGridlines !== undefined ? { printGridlines: patch.printGridlines } : {}),
      ...(patch.printHeadings !== undefined ? { printHeadings: patch.printHeadings } : {}),
      ...(patch.printArea !== undefined ? { printArea: patch.printArea } : {}),
    }
    void ctx.runOps([op], t('appPageSetupRecorded', { note }))
  }
  const separator = rest.indexOf(':')
  const key = separator === -1 ? rest : rest.slice(0, separator)
  const value = separator === -1 ? '' : rest.slice(separator + 1)
  const prior = state.editJournal.pageSetup.get(sheetId) ?? {}
  switch (key) {
    case 'orientation':
      if (value !== 'portrait' && value !== 'landscape') return
      record(
        { orientation: value },
        value === 'portrait' ? t('appOrientationPortrait') : t('appOrientationLandscape'),
      )
      return
    case 'margins':
      if (value !== 'normal' && value !== 'wide' && value !== 'narrow') return
      record(
        { margins: value },
        t(
          value === 'normal'
            ? 'appMarginsNormal'
            : value === 'wide'
              ? 'appMarginsWide'
              : 'appMarginsNarrow',
        ),
      )
      return
    case 'paper': {
      const code = Number(value)
      if (!Number.isInteger(code) || code < 1 || code > 118) return
      record({ paperSize: code }, t('appPaperSizeNote', { name: PAPER_NAMES[value] ?? value }))
      return
    }
    case 'scale': {
      const scale = Number(value)
      if (!Number.isInteger(scale) || scale < 10 || scale > 400) return
      record({ scale, fitToPage: false }, t('appPrintScaleNote', { scale }))
      return
    }
    case 'fit-width':
    case 'fit-height': {
      const pages = Number(value)
      if (!Number.isInteger(pages) || pages < 0 || pages > 1_000) return
      // Excel treats the untouched other axis as Automatic (0) once
      // fit-to-page engages.
      const fitToWidth = key === 'fit-width' ? pages : (prior.fitToWidth ?? 0)
      const fitToHeight = key === 'fit-height' ? pages : (prior.fitToHeight ?? 0)
      const fitValue = pages === 0 ? t('appFitAutomatic') : t('appFitPages', { count: pages })
      record(
        { fitToWidth, fitToHeight, fitToPage: fitToWidth > 0 || fitToHeight > 0 },
        key === 'fit-width'
          ? t('appFitWidthNote', { value: fitValue })
          : t('appFitHeightNote', { value: fitValue }),
      )
      return
    }
    case 'fit': {
      const [width, height] = value.split(',').map(Number)
      if (!Number.isInteger(width) || !Number.isInteger(height)) return
      if (width === undefined || height === undefined || width < 0 || height < 0) return
      record(
        { fitToWidth: width, fitToHeight: height, fitToPage: width > 0 || height > 0 },
        t('appFitWidthNote', {
          value: width === 0 ? t('appFitAutomatic') : t('appFitPages', { count: width }),
        }),
      )
      return
    }
    case 'print-gridlines':
      record(
        { printGridlines: value === '1' },
        value === '1' ? t('appGridlinesWillPrint') : t('appGridlinesWontPrint'),
      )
      return
    case 'print-headings':
      record(
        { printHeadings: value === '1' },
        value === '1' ? t('appHeadingsWillPrint') : t('appHeadingsWontPrint'),
      )
      return
    case 'print-area': {
      if (value === 'clear') {
        record({ printArea: null }, t('appPrintAreaCleared'))
        return
      }
      const range = runtime.univerAPI.getActiveWorkbook()?.getActiveRange()
      if (!range) {
        ctx.setMessage(t('appSelectPrintRange'))
        return
      }
      const startColumn = range.getColumn()
      const startRow = range.getRow()
      const area =
        `${columnLabel(startColumn)}${startRow + 1}` +
        `:${columnLabel(startColumn + range.getWidth() - 1)}${startRow + range.getHeight()}`
      record({ printArea: area }, t('appPrintAreaNote', { area }))
      return
    }
    case 'theme':
    case 'theme-colors':
    case 'theme-fonts': {
      if (!state.file.themeColors || (key === 'theme-fonts' && !state.file.themeFonts)) {
        ctx.setMessage(t('appThemeNeedsThemePart'))
        return
      }
      const colors =
        key === 'theme-fonts' ? undefined : COLOR_SCHEMES.find((entry) => entry.id === value)
      // A theme without a rewritable fontScheme keeps its fonts: journaling
      // one would poison every subsequent save.
      const fonts =
        key === 'theme-colors' || !state.file.themeFonts
          ? undefined
          : key === 'theme'
            ? THEME_PRESETS.find((entry) => entry.id === value)?.fonts
            : FONT_SCHEMES.find((entry) => entry.id === value)
      if (colors === undefined && fonts === undefined) return
      if (colors !== undefined) {
        recordThemeColors(state.editJournal, colors.name, colors.values)
        state.file.themeColors = [...colors.values]
      }
      if (fonts !== undefined) {
        recordThemeFonts(state.editJournal, fonts.name, fonts.major, fonts.minor)
        state.file.themeFonts = { major: fonts.major, minor: fonts.minor }
      }
      // Live re-resolution: styles carrying theme provenance recolor now;
      // charts/CF colors follow on the save's reopen (which reparses the
      // rewritten theme part).
      state.file.styles = rethemeStyles(
        state.file.styles,
        state.file.themeColors,
        state.file.themeFonts ?? null,
      )
      for (const loadedSheetId of [...state.loadedRanges.keys()]) {
        state.loadedRanges.delete(loadedSheetId)
        state.appliedRowKeys.delete(loadedSheetId)
      }
      ctx.setPendingEdits(journalSize(state.editJournal))
      const active = runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()
      if (active) {
        // Silent repaint: this reload only re-applies the re-themed styles;
        // its async streaming progress would otherwise land after (and wipe)
        // the theme confirmation below.
        void loadVisibleRange(runtime, ctx.lazyWorkbookRef, active, () => undefined)
      }
      ctx.setMessage(t('appThemeApplied', { name: (colors ?? fonts)?.name ?? value }))
      return
    }
    case 'breaks': {
      if (value !== 'insert' && value !== 'remove' && value !== 'reset') return
      const current = effectivePageBreaks(state, sheetId)
      if (current === null) {
        ctx.setMessage(t('appBreaksNeedIndexed'))
        return
      }
      if (value === 'reset') {
        record({ rowBreaks: [], colBreaks: [] }, t('appBreaksReset'))
        return
      }
      const range = runtime.univerAPI.getActiveWorkbook()?.getActiveRange()
      if (!range || !worksheet) {
        ctx.setMessage(t('appBreaksNeedCell'))
        return
      }
      const row = range.getRow()
      const column = range.getColumn()
      // Excel: a full-row selection places only the horizontal break, a
      // full-column selection only the vertical one; a cell places both.
      const fullRow = range.getWidth() >= worksheet.getMaxColumns()
      const fullColumn = range.getHeight() >= worksheet.getMaxRows()
      const wantRow = !fullColumn && row > 0
      const wantColumn = !fullRow && column > 0
      if (value === 'insert') {
        if (!wantRow && !wantColumn) {
          ctx.setMessage(t('appBreaksNeedCell'))
          return
        }
        const rowBreaks = wantRow
          ? [...new Set([...current.rowBreaks, row])].sort((a, b) => a - b)
          : current.rowBreaks
        const colBreaks = wantColumn
          ? [...new Set([...current.colBreaks, column])].sort((a, b) => a - b)
          : current.colBreaks
        record({ rowBreaks, colBreaks }, t('appBreakInserted'))
        return
      }
      const rowBreaks = current.rowBreaks.filter((id) => !(wantRow && id === row))
      const colBreaks = current.colBreaks.filter((id) => !(wantColumn && id === column))
      if (
        rowBreaks.length === current.rowBreaks.length &&
        colBreaks.length === current.colBreaks.length
      ) {
        ctx.setMessage(t('appBreakNoneHere'))
        return
      }
      record({ rowBreaks, colBreaks }, t('appBreakRemoved'))
      return
    }
    case 'print-titles': {
      if (value === 'clear') {
        record({ printTitles: null }, t('appPrintTitlesCleared'))
        return
      }
      if (value === 'first-row') {
        record({ printTitles: '1:1' }, t('appRow1Repeats'))
        return
      }
      const range = runtime.univerAPI.getActiveWorkbook()?.getActiveRange()
      if (!range) {
        ctx.setMessage(t('appSelectRepeatRows'))
        return
      }
      const start = range.getRow() + 1
      // Cap at the layout's 21 title rows so a tall selection still repeats
      // its top rows instead of being dropped downstream as an over-cap span.
      const rows = clampTitleRows(start, range.getRow() + range.getHeight())
      record({ printTitles: rows }, t('appRowsRepeat', { rows }))
      return
    }
    default:
      return
  }
}

/// Insert → Header & Footer OK: journals the printed header/footer of the
/// active sheet; the save writes the worksheet's <headerFooter> element.
export function handleApplyHeaderFooter(
  ctx: PageLayoutContext,
  result: HeaderFooterResult,
): string | null {
  const state = ctx.lazyWorkbookRef.current
  if (!state) return t('appHfNeedsFile')
  const sheetId = ctx.univerRef.current?.univerAPI
    .getActiveWorkbook()
    ?.getActiveSheet()
    ?.getSheetId()
  if (!sheetId || isSheetRemoved(state.editJournal, sheetId)) {
    return t('appActiveSheetUnavailable')
  }
  recordPageSetup(state.editJournal, sheetId, { header: result.header, footer: result.footer })
  ctx.setPendingEdits(journalSize(state.editJournal))
  ctx.setMessage(t('appHfUpdated'))
  return null
}
