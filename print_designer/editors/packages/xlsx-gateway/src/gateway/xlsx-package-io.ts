/// Browser port (Print Designer editors) of the streaming save plumbing.
///
/// Upstream (genoffice) drives `planCellEditsToXlsx` with a sidecar-backed
/// `EntrySource` and hands the resulting plan to the Rust sidecar's
/// byte-preserving `save_archive`. In the browser there is no sidecar: this
/// module keeps only the planning half (plus the fail-closed manifest check).
/// The adapter (editors/sheets/src/adapter) implements the byte-preserving
/// zip splice itself and calls `assertManifestPreserved` before accepting the
/// result, mirroring the desktop contract: untouched entries must survive
/// with identical CRC and sizes.

import { z } from 'zod'

import { MAX_PATCH_ENTRY_BYTES } from '../shared/edit-schemas'
import type { WorkbookChartEdit, WorkbookVisualEdit } from '../shared/edit-schemas'
import type { SheetFilterState } from './xlsx-filter'
import type { DefinedNamesState } from './xlsx-defined-names'
import type { SheetPageSetupState } from './xlsx-page-setup'
import type { SheetRedactionState } from './xlsx-redaction'
import type {
  CellEdit,
  BulkConstantFill,
  EntrySource,
  MutationPlan,
  PivotRefreshUpdate,
  SheetCfState,
  SheetDvState,
  SheetHyperlinkEdits,
  SheetNoteState,
  SheetProtectedRangesState,
  SheetProtectionState,
  SheetTabColorState,
  SheetPivotAddition,
  SheetSlicerState,
  SheetSparklineAddition,
  SheetStructuralOps,
  SheetTableAddition,
  SheetTableEdit,
  SheetVisualAddition,
  SheetFormulaValues,
  SheetCellImageAddition,
  ExternalLinkOps,
} from './xlsx-gateway'
import { planCellEditsToXlsx } from './xlsx-gateway'
import type { WorkbookThemeState } from './xlsx-theme'
import type { SheetEditPlan } from './xlsx-sheets'

export const archiveEntrySchema = z.object({
  name: z.string(),
  crc32: z.number(),
  compressedSize: z.number(),
  uncompressedSize: z.number(),
})

export type ArchiveEntry = z.infer<typeof archiveEntrySchema>

export interface StreamingSaveRequest {
  readonly edits: readonly CellEdit[]
  readonly bulkConstantFills?: readonly BulkConstantFill[] | undefined
  readonly structuralOps?: readonly SheetStructuralOps[] | undefined
  readonly chartEdits?: readonly WorkbookChartEdit[] | undefined
  readonly sheetPlan?: SheetEditPlan | undefined
  readonly filterStates?: readonly SheetFilterState[] | undefined
  readonly hyperlinkEdits?: readonly SheetHyperlinkEdits[] | undefined
  readonly cfStates?: readonly SheetCfState[] | undefined
  readonly dvStates?: readonly SheetDvState[] | undefined
  readonly sheetProtections?: readonly SheetProtectionState[] | undefined
  readonly definedNamesState?: DefinedNamesState | null | undefined
  readonly visualAdditions?: readonly SheetVisualAddition[] | undefined
  readonly pageSetupStates?: readonly SheetPageSetupState[] | undefined
  readonly noteStates?: readonly SheetNoteState[] | undefined
  readonly tableAdditions?: readonly SheetTableAddition[] | undefined
  readonly tableEdits?: readonly SheetTableEdit[] | undefined
  /// Session-created pictures in cells ("Place in Cell").
  readonly cellImageAdditions?: readonly SheetCellImageAddition[] | undefined
  readonly pivotAdditions?: readonly SheetPivotAddition[] | undefined
  readonly pivotCacheRefreshPaths?: readonly string[] | undefined
  readonly pivotRefreshUpdates?: readonly PivotRefreshUpdate[] | undefined
  readonly visualEdits?: readonly WorkbookVisualEdit[] | undefined
  readonly sparklineAdditions?: readonly SheetSparklineAddition[] | undefined
  /// Session slicer/timeline panels written as x14/x15 slicer parts; null =
  /// no slicer changes ride this save.
  readonly slicerState?: SheetSlicerState | null | undefined
  /// Recalculated formula-cell values written into <v>
  readonly formulaValues?: readonly SheetFormulaValues[] | undefined
  /// External-link breaks and source retargets, resolved on the final contents
  readonly externalLinkOps?: ExternalLinkOps | null | undefined
  readonly themeState?: WorkbookThemeState | null | undefined
  readonly workbookProtectionState?: { readonly lockStructure: boolean } | null | undefined
  readonly protectedRangeStates?: readonly SheetProtectedRangesState[] | undefined
  readonly tabColorStates?: readonly SheetTabColorState[] | undefined
  /** null/undefined = the caller does not know the marks; the part is left as it is */
  readonly redactionStates?: readonly SheetRedactionState[] | null | undefined
}

export interface StreamingSaveResult {
  readonly touchedEntries: readonly string[]
  readonly removedEntries: readonly string[]
  readonly addedEntries: readonly string[]
}

/// Plans a streaming save against an in-memory `EntrySource` (the browser
/// adapter's raw-zip reader). The returned plan lists every entry the save
/// touches — the adapter splices exactly those into the source archive and
/// copies every other entry's compressed bytes verbatim.
export async function planWorkbookSave(
  source: EntrySource,
  request: StreamingSaveRequest,
): Promise<MutationPlan> {
  return planCellEditsToXlsx(
    source,
    request.edits,
    request.structuralOps ?? [],
    request.chartEdits ?? [],
    request.sheetPlan,
    request.filterStates ?? [],
    request.hyperlinkEdits ?? [],
    request.cfStates ?? [],
    request.dvStates ?? [],
    request.sheetProtections ?? [],
    request.definedNamesState ?? null,
    request.visualAdditions ?? [],
    request.pageSetupStates ?? [],
    request.noteStates ?? [],
    request.tableAdditions ?? [],
    request.pivotAdditions ?? [],
    request.pivotCacheRefreshPaths ?? [],
    request.pivotRefreshUpdates ?? [],
    request.visualEdits ?? [],
    request.sparklineAdditions ?? [],
    request.formulaValues ?? [],
    request.themeState ?? null,
    request.workbookProtectionState ?? null,
    request.protectedRangeStates ?? [],
    request.bulkConstantFills ?? [],
    request.tabColorStates ?? [],
    request.tableEdits ?? [],
    request.cellImageAdditions ?? [],
    request.externalLinkOps ?? null,
    request.redactionStates ?? null,
    request.slicerState ?? null,
  )
}

export function resultOfPlan(plan: MutationPlan): StreamingSaveResult {
  return {
    touchedEntries: plan.touchedEntries,
    removedEntries: plan.removedEntries,
    addedEntries: plan.addedEntries,
  }
}

/// Size gate shared with the planner's patch cap: entries above
/// MAX_PATCH_ENTRY_BYTES can be preserved but not patched.
export function assertPatchable(name: string, uncompressedSize: number): void {
  if (uncompressedSize > MAX_PATCH_ENTRY_BYTES) {
    throw new Error(
      `${name} is ${uncompressedSize} bytes uncompressed — too large to edit. ` +
        'Entries above 500MB can be preserved but not patched.',
    )
  }
}

/// Fails closed when the saved archive differs from the source anywhere the
/// plan did not declare: untouched entries must survive byte-preserving raw
/// copy (identical CRC and sizes), removals must vanish, additions must
/// appear, and nothing else may exist.
export function assertManifestPreserved(
  plan: Pick<MutationPlan, 'replaced' | 'added' | 'removedEntries'> &
    Partial<Pick<MutationPlan, 'addedBinary'>>,
  before: readonly ArchiveEntry[],
  after: readonly ArchiveEntry[],
): void {
  const removed = new Set(plan.removedEntries)
  const replaced = new Set(plan.replaced.keys())
  const added = new Set([...plan.added.keys(), ...(plan.addedBinary?.keys() ?? [])])
  const beforeByName = new Map(before.map((entry) => [entry.name, entry]))
  const afterByName = new Map(after.map((entry) => [entry.name, entry]))

  for (const entry of before) {
    const saved = afterByName.get(entry.name)
    if (removed.has(entry.name)) {
      if (saved) throw new Error(`Saving should have removed ${entry.name} but did not — aborted.`)
      continue
    }
    if (!saved) throw new Error(`Saving would drop ${entry.name} — aborted.`)
    if (replaced.has(entry.name)) continue
    if (
      saved.crc32 !== entry.crc32 ||
      saved.compressedSize !== entry.compressedSize ||
      saved.uncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error(`Saving would unexpectedly modify ${entry.name} — aborted.`)
    }
  }
  for (const name of added) {
    if (beforeByName.has(name)) {
      throw new Error(`Saving should have created ${name} but it already existed — aborted.`)
    }
    if (!afterByName.has(name)) {
      throw new Error(`Saving should have created ${name} but did not — aborted.`)
    }
  }
  for (const entry of after) {
    if (!beforeByName.has(entry.name) && !added.has(entry.name)) {
      throw new Error(`Saving would unexpectedly create ${entry.name} — aborted.`)
    }
  }
}
