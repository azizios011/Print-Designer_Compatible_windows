# Print Designer — bundled editors

Standalone editors built by Vite into `print_designer/public/editors/<name>/`
through the `after_build` hook (`print_designer/build.py`). Each
sub-directory with its own `vite.config.ts` is one editor; shared source
packages live in `packages/`; third-party attributions live in
`THIRD_PARTY/`.

## Layout

```
editors/
  package.json        yarn workspace root (single yarn.lock for all editors)
  tsconfig.base.json  shared strict-TS baseline
  packages/           vendored shared packages (@genoffice/ui, @genoffice/i18n,
                      @genoffice/xlsx-gateway, @genoffice/zip-gate)
  pdf/                the PDF editor (GenOffice apps/pdf renderer + browser adapter)
  sheets/             the Sheets editor (GenOffice apps/sheets renderer + browser
                      adapter with an in-memory xlsx engine; see sheets/PORTING.md)
  THIRD_PARTY/        LICENSE/NOTICE of vendored upstream code
```

## Commands

```
cd print_designer/editors
yarn install --frozen-lockfile
cd pdf && yarn typecheck && yarn build
```

`bench build` runs the same steps through `print_designer/build.py` and emits
`print_designer/public/editors/<name>/` served at
`/assets/print_designer/editors/<name>/`. Set `SKIP_EDITORS_BUILD=1` to skip.

## PDF editor provenance

`pdf/src/renderer` and `pdf/src/shared` are trimmed copies of GenOffice
`apps/pdf` (Apache-2.0, © Mainfunc, Inc. — see `THIRD_PARTY/genoffice/`):
the Electron main process and preload are replaced by `pdf/src/adapter/`
(browser adapter: pdf.js viewing, pdf-lib page operations, Frappe File
open/save), and the AI layer, OCR, digital-certificate signing and
main-process printing were removed. UI strings ship for en, fr and ar.

## Sheets editor provenance

`sheets/src/renderer` and `sheets/src/shared` are trimmed copies of GenOffice
`apps/sheets` (Apache-2.0, © Mainfunc, Inc. — see `THIRD_PARTY/genoffice/`):
the Electron main process, preload and the Rust XLSX sidecar are replaced by
`sheets/src/adapter/` — an in-memory TypeScript workbook engine
(`adapter/engine/`, the whole package is parsed once; sized for accounting
workbooks) plus a byte-preserving zip writer (`adapter/archive.ts`) that keeps
every untouched OOXML entry byte-identical on save through the vendored
`@genoffice/xlsx-gateway` planner, fail-closed via `assertManifestPreserved`.
Open/save go through the whitelisted `print_designer.api.sheets_editor` API.
The AI layer, MCP bridge, screen capture, crash-recovery copies, workbook
merge and print/PDF-export UI were removed. UI strings ship for en, fr and ar.

Integration hook for the sibling print / import-export / signature module:
`window.sheetsEditorApi.exportWorkbookBytes()` (saved-state bytes),
`window.sheetsEditorApi.currentFile()`, the `"sheets-save"` postMessage from
the editor iframe, and a `readonly` init field planned for the page host.
