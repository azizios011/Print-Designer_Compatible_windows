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
  packages/           vendored shared packages (@genoffice/ui, @genoffice/i18n)
  pdf/                the PDF editor (GenOffice apps/pdf renderer + browser adapter)
  THIRD_PARTY/        LICENSE/NOTICE of vendored upstream code
```

## Commands

```
cd print_designer/editors
yarn install --frozen-lockfile
cd pdf && yarn typecheck && yarn build
```

`bench build` runs the same steps through `print_designer/build.py` and emits
`print_designer/public/editors/pdf/` served at
`/assets/print_designer/editors/pdf/`. Set `SKIP_EDITORS_BUILD=1` to skip.

## PDF editor provenance

`pdf/src/renderer` and `pdf/src/shared` are trimmed copies of GenOffice
`apps/pdf` (Apache-2.0, © Mainfunc, Inc. — see `THIRD_PARTY/genoffice/`):
the Electron main process and preload are replaced by `pdf/src/adapter/`
(browser adapter: pdf.js viewing, pdf-lib page operations, Frappe File
open/save), and the AI layer, OCR, digital-certificate signing and
main-process printing were removed. UI strings ship for en, fr and ar.
