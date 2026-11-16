# Porting GenOffice Sheets to the Print Designer browser editor

Recon for `editors/sheets/` (Milestone 0). Source: GenOffice `apps/sheets`
(Apache-2.0, © Mainfunc, Inc.) in the read-only checkout
`genoffice-Compatible_Frappe_App`. This file records how the upstream app
works and what the browser port replaces.

## a) The desktop API surface (apps/sheets/src/shared/desktop-api.ts)

The renderer talks to the host through one typed interface, `DesktopApi`
(~97 methods), implemented by `src/preload/index.ts` (contextBridge →
`window.desktopApi`) and the Electron main process (`src/main/sheets-main.ts`,
~5.6k lines). For open / edit / save of a plain .xlsx/.xlsm the port needs:

**Needed (implemented by the browser adapter):**

- `selectWorkbook()` — the renderer's single open entry point: returns the
  `workbookFileSchema` metadata (session id, sheets, styles, dxf styles,
  visuals, defined names, theme colors, column widths, freeze, tables,
  comments, pivot ranges…). The desk page hands the File docname over, so the
  adapter turns it into "fetch bytes via `print_designer.api.sheets_editor.open_file`
  → parse → WorkbookFile".
- `readWorkbookRange` — the renderer's whole data layer (`univer-sync.ts`
  installs visible ranges from it; 10 call sites). Must serve
  `workbookRangeResultSchema` (cells with value/formula/styleIndex, row
  heights/hidden/outline, merges, hyperlinks, conditional rules,
  data validations, autoFilter + live criteria, sheetProtection, page breaks,
  pageSetup, protectedRanges, indexedThroughRow/indexingComplete).
- `readWorkbookFormulas`, `readWorkbookRowOutline`, `findWorkbookCells` —
  formula-bar/closure analysis, outline gutter, Find; served from the same
  in-memory model.
- `readWorkbookMedia` — embedded images (renderer fetches them on demand,
  20MB cap upstream).
- `readPivotDefinition`, `readSlicerState`, `readWorkbookRedactions`,
  `readWorkbookQueries` — called once per open by `App.tsx`; return
  minimal-but-schema-valid payloads (no pivots/slicers read, nothing
  withheld, no connections).
- Save: `saveWorkbookEdits` + the chunked-upload trio
  `beginSaveEditsTransfer` / `sendSaveEditsChunk` / `abortSaveEditsTransfer`
  (large saves above `MAX_SAVE_EDITS` upload ordered `WorkbookCellEdit[]`
  chunks, then reference the transfer id). The adapter accumulates chunks and
  runs the same gateway save the Electron main ran.
- `closeWorkbook`, `notifyPendingEdits` (dirty badge), `getUserDisplayName`,
  `getLanguage`/`onLanguageChanged`, `getTheme`/`onThemeChanged`,
  `getDocumentTheme`/`onDocumentThemeChanged` (init payload + `data-theme`),
  `onMenuAction` (Ctrl+S routed from the page via postMessage),
  `hasQueuedWorkbook`/`consumeNewBlankWorkbook` (false), `openExternal`
  (window.open), `autoRenameWorkbook` ({renamed:false}).
- `exportWorkbookBytes()` is a NEW adapter/renderer export (not upstream):
  the integration hook for the sibling print/import-export module, plus a
  `"sheets-save"` postMessage to the parent on every successful save.

**Cut entirely (renderer code removed with them):** the whole AI layer —
`aiChat`, `aiStream*`, `aiGsk*`, `webSearch`, `imageSearch`, `generateImage`,
`fetchImage`, `onAiStream`, `skills*`, `get/setAiSettings`, AI panel prefs,
attachments (`pickAttachments`, `addAttachmentPaths`, `addPastedImage`,
`readAttachment*`, `getPathForFile`), MCP bridge (`onMcpCommand`,
`reportMcpResult`, `signalMcpReady`), screen capture, workbook merge
(`selectWorkbooksForMerge`, `openWorkbooksForMerge`), cross-workbook pick,
`openSourcePath`, shell home/recovery prompts (`onRecoveryPrompt`,
`writeWorkbookRecovery` → no-op, no crash-recovery files in a browser tab),
`consumeHeadlessExport`, `updateWorkbookPassword` (encrypted OOXML opens
report a structured failure), `onChromePressed`, `onWorkbookRenamed`,
`onSidecarCrashed` (no process to crash), `onCloseSaveRequest` /
`reportCloseSaveResult` (the page's beforeunload guard replaces it).

**Structured failure (surface exists upstream, feature stays desktop-only):**
`printWorkbook`, `listPrinters`, `exportPdf`, `exportCsv`, `confirmCsvSave`,
`captureScreenSources`, `listWorkbookConnections`, `refreshWorkbookConnection`,
external-link source pick/reveal, `listWorkbookTabs`, encrypted workbooks.
Same convention as the PDF adapter: the UI already toasts the error.

## b) How an xlsx reaches Univer upstream

- **Open**: the main process starts a long-lived Rust sidecar
  (`apps/sheets/native/xlsx-engine`, JSON-lines over stdio,
  `src/main/xlsx-sidecar-client.ts`). `open` returns the workbook metadata
  (sheet ids are `sheet-<sheetId>`); worksheet XML is streamed once into
  256-row temporary chunks and `read_range` serves only the visible range +
  buffer (≤100k cells per request). Univer starts with worksheet dimensions
  and empty sparse cell data; scroll/sheet-switch install new windows and
  clear the old ones. Styles are resolved from `styles.xml` into
  `cellStyleSchema` entries; drawings/charts/notes/pivots/sparklines come
  from dedicated sidecar passes.
- **Save**: the renderer journals every edit (`edit-journal.ts`), then the
  main process runs `@genoffice/xlsx-gateway` (`saveWorkbookViaSidecar` in
  `packages/xlsx-gateway/src/gateway/xlsx-package-io.ts`): the gateway plans
  patched XML entry contents (cells, styles, structure, CF/DV, page setup,
  notes, tables, pivots, hyperlinks, theme…), the sidecar `save_archive`
  command rewrites only the touched zip entries **byte-preserving** —
  untouched entries keep their original compressed bytes — and the result is
  written through a temp file + atomic rename, failing closed when any
  unexpected entry would change.

## c) Engine decision for our setup

Evaluation per the milestone order:

1. **WASM (chosen upstream direction, NOT viable here yet).** The engine
   exposes no WASM entry points today: `native/xlsx-engine` has zero
   `wasm-bindgen` exports (the feature `single-thread` only removes threading
   so a WASM build *could* be tested). Making it run in a Worker requires
   (i) writing the bindgen facade, (ii) converting `open(path)` to
   open-from-bytes (WASM has no fs), (iii) getting `calamine`/`zip`/
   `quick-xml`/`ironcalc` to compile for wasm32-unknown-unknown
   (`getrandom` js feature, no threads), and (iv) a TS worker harness.
   **The container has no Rust toolchain** — `cargo`, `rustc`, `rustup` are
   all missing. That is two blockers, and (i)–(iii) are real Rust work.
2. **Native sidecar behind a Frappe API** — rejected: Frappe serves requests
   across many gunicorn workers; a per-session long-lived child process has
   no home (no shared state, no lifecycle owner), and shipping an executable
   the web server spawns per session is a liability for a hosted desk.
3. **Pure-TypeScript reader + gateway save (CHOSEN).** `@genoffice/xlsx-gateway`
   is explicitly "no Electron, no Univer" (deps: jszip, zip-gate, numfmt,
   zod) and `zip-gate` is deliberately Node-free (DecompressionStream over
   `Blob`/streams) — both run in the browser as-is. The adapter parses the
   whole package once into the same shapes the sidecar streams (metadata +
   per-range results served from memory; the renderer's lazy windowing is
   untouched — it just gets its windows instantly). Save reuses the gateway's
   planner; the zip rewrite is a browser `ArchiveClient` over a new
   byte-preserving entry-splice writer built on zip-gate's raw-part scanner
   (untouched entries keep their original compressed bytes, matching the
   sidecar's contract; jszip is used only for *reading* inflates and would
   NOT satisfy byte-preservation on write).

**Size limit to document:** full-load-in-memory. Normal accounting workbooks
(invoices, relevés, ledgers — tens of thousands of rows) are fine; files
whose *uncompressed* OOXML exceeds roughly 256 MB (the gateway's own
`XLSX_ZIP_LIMITS` total cap) or that need streaming windows (multi-million
cell sheets) will hit memory pressure. That is the trade WASM removes later.

**Toolchain ask (not needed for this path, recorded for the future WASM
upgrade):** add to the container image (azurelinux-default,
`Frappe_Rust_Windows_Orchestrator` branch DEV-0.1,
`docker_container-iso/Defualt`):
`rustup` + stable toolchain (`rustup-init -y --default-toolchain stable`)
and `rustup target add wasm32-unknown-unknown`; then `after_build` can
compile the engine behind a `build_editors_wasm()` step with a clear skip
message. Without those two packages the WASM path cannot even be attempted —
it was not silently skipped, it was evaluated and deferred for the reasons
above.

## What gets vendored (M1)

- `editors/packages/xlsx-gateway` ← `packages/xlsx-gateway/src` (pure TS;
  domain + gateway + shared), package.json trimmed to jszip/numfmt/zod.
- `editors/packages/zip-gate` ← `packages/zip-gate/src`.
- `editors/sheets/src/renderer` ← `apps/sheets/src/renderer` minus
  `ai/`, `mcp-bridge*`, `print-*`, `pdf-*`/export, recovery/merge/UI screens
  that only exist in the desktop shell; `src/shared` ← the schemas/types.
- `editors/sheets/src/adapter` ← new: `frappe.ts` (handshake + File I/O,
  same shape as the PDF adapter), `engine/` (TS xlsx reader →
  workbookFileSchema + range results), `archive.ts` (byte-preserving zip
  writer), `index.ts` (the `window.desktopApi` implementation).

## Fixtures / tests (M2)

`apps/sheets/tests/fixture-builder.ts` builds OOXML packages in memory from
the gateway DSL (no Electron, no sidecar) — reused as the M2 round-trip
fixture source, together with an openpyxl-generated A4 invoice workbook
(the document-type system generates those).
