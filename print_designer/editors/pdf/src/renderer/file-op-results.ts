/**
 * Result shapes of the file-level page operations (merge/split/extract/…).
 *
 * Relocated from GenOffice `apps/pdf/src/renderer/ai/tools.ts` (Apache-2.0,
 * see editors/THIRD_PARTY/genoffice/) when the AI tool layer was removed —
 * the operations themselves and their result contracts stay identical.
 */

export type RotateDelta = 90 | -90 | 180
export type TextAlign = 'left' | 'center' | 'right'

export type CropRect = { l: number; t: number; r: number; b: number }

/** A native picker was dismissed; flushed = the pending edits had already been saved to disk first */
export type FileOpCanceled = { ok: true; canceled: true; flushed: boolean }

/** In-place rewrite: pageCount is read from the reloaded document */
export type FileOpResult =
  { ok: true; pageCount: number } | FileOpCanceled | { ok: false; error: string }

export type NewFileResult =
  { ok: true; savedPath: string } | FileOpCanceled | { ok: false; error: string }

export type SplitPdfOutcome =
  { ok: true; savedDir: string; count: number } | FileOpCanceled | { ok: false; error: string }
