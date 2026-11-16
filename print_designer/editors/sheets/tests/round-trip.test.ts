/**
 * Round-trip fidelity check for the browser save path (run with
 * `node tests/round-trip.test.ts` from editors/sheets — Node's TS stripping
 * executes this directly; no Electron, no sidecar).
 *
 *  1. parse a fixture workbook with the in-memory engine;
 *  2. serve a range read through the same code path the renderer uses;
 *  3. edit ONE cell through the gateway planner + byte-preserving splice;
 *  4. every zip entry other than the edited sheet must be byte-identical,
 *     and the edited cell must read back with the new value.
 */

import assert from 'node:assert/strict'

import { buildEditFixture } from './fixture-builder.ts'
import { parseWorkbook } from '../src/adapter/engine/parse-workbook.ts'
import { readRange } from '../src/adapter/engine/worksheet.ts'
import { saveWorkbookBytes, openWorkbookSource } from '../src/adapter/archive.ts'

async function main(): Promise<void> {
  // ── 1. parse ──────────────────────────────────────────────────────────────
  const bytes = await buildEditFixture()
  const parsed = await parseWorkbook(new Uint8Array(bytes), 'edit-fixture.xlsx', 'en')
  assert.ok(parsed.file.sheets.length >= 1, 'workbook has sheets')
  const sheet = parsed.sheets.get(parsed.file.sheets[0]!.id)!
  assert.ok(sheet, 'first sheet parsed')

  // ── 2. range read ─────────────────────────────────────────────────────────
  const range = readRange(sheet, { startRow: 0, endRow: 20, startColumn: 0, endColumn: 10 })
  assert.ok(range.cells.length > 0, 'range read returned cells')
  assert.equal(range.indexingComplete, true, 'fully indexed')
  const cellA1 = range.cells.find((c) => c.row === 0 && c.column === 0)
  assert.ok(cellA1 !== undefined, 'A1 present in range read')

  // ── 3. one-cell edit through the save path ────────────────────────────────
  const before = openWorkbookSource(parsed.originalBytes).parts
  const result = await saveWorkbookBytes(parsed.originalBytes, {
    edits: [
      {
        sheetName: sheet.name,
        row: 0,
        column: 0,
        writeValue: true,
        cell: { value: 'Edited by the round-trip test' },
      },
    ],
    structuralOps: [],
    chartEdits: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    sheetProtections: [],
    visualAdditions: [],
    pageSetupStates: [],
    noteStates: [],
    tableAdditions: [],
    pivotAdditions: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    visualEdits: [],
    sparklineAdditions: [],
    formulaValues: [],
    protectedRangeStates: [],
    tabColorStates: [],
    sheetOps: [],
    sheetOrder: parsed.file.sheets.map((meta) => meta.id),
  })

  // ── 4. byte-preservation: every untouched entry identical ─────────────────
  const after = openWorkbookSource(result.buffer).parts
  const touched = new Set(result.touchedEntries)
  const beforeByName = new Map(before.map((part) => [part.name, part]))
  const afterByName = new Map(after.map((part) => [part.name, part]))
  for (const part of before) {
    const saved = afterByName.get(part.name)
    assert.ok(saved, `${part.name} survived the save`)
    if (touched.has(part.name)) continue
    assert.equal(saved.crc32, part.crc32, `${part.name} crc identical`)
    assert.equal(saved.compressedSize, part.compressedSize, `${part.name} compressed size identical`)
    assert.equal(saved.uncompressedSize, part.uncompressedSize, `${part.name} uncompressed size identical`)
    assert.deepEqual(
      Buffer.from(saved.data).compare(Buffer.from(part.data)) === 0,
      true,
      `${part.name} compressed bytes identical`,
    )
    void beforeByName
  }
  for (const part of after) {
    assert.ok(beforeByName.has(part.name), `${part.name} is not a spurious addition`)
  }

  // ── 5. the edit reads back ────────────────────────────────────────────────
  const reparsed = await parseWorkbook(result.buffer, 'edit-fixture.xlsx', 'en')
  const sheet2 = reparsed.sheets.get(parsed.file.sheets[0]!.id)!
  const range2 = readRange(sheet2, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
  const edited = range2.cells.find((c) => c.row === 0 && c.column === 0)
  assert.equal(edited?.value, 'Edited by the round-trip test', 'edited value persisted')

  process.stdout.write(
    `round-trip OK: ${before.length} entries in, ${after.length} out, ` +
      `${[...touched].length} touched (${[...touched].join(', ')})\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`round-trip FAILED: ${error?.stack ?? error}\n`)
  process.exit(1)
})
