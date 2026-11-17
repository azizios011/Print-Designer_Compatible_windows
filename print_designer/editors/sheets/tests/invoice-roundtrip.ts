import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWorkbook } from '../src/adapter/engine/parse-workbook.ts'
import { saveWorkbookBytes, openWorkbookSource } from '../src/adapter/archive.ts'
import { readRange } from '../src/adapter/engine/worksheet.ts'

async function main(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/facture-a4.xlsx', import.meta.url))))
  const parsed = await parseWorkbook(bytes, 'facture-a4.xlsx', 'fr')
  const meta = parsed.file.sheets[0]!
  const sheet = parsed.sheets.get(meta.id)!
  process.stdout.write(`sheets: ${parsed.file.sheets.map(s=>s.name).join(', ')} | merges=${sheet.merges.length} | styles=${parsed.file.styles.length}\n`)
  const range = readRange(sheet, { startRow: 0, endRow: 10, startColumn: 0, endColumn: 9 })
  const a1 = range.cells.find(c => c.row === 0 && c.column === 0)
  const d5 = range.cells.find(c => c.row === 4 && c.column === 3)
  process.stdout.write(`A1: ${JSON.stringify(a1?.value)} merges=${JSON.stringify(sheet.merges)}\n`)
  process.stdout.write(`D5 (Qté cell): value=${JSON.stringify(d5?.value)} styleIndex=${d5?.styleIndex} numfmt=${parsed.file.styles[d5?.styleIndex ?? 0]?.numberFormat} border=${JSON.stringify(parsed.file.styles[d5?.styleIndex ?? 0]?.borderTop)}\n`)
  // edit one cell and verify byte preservation
  const result = await saveWorkbookBytes(parsed.originalBytes, {
    edits: [{ sheetName: sheet.name, row: 4, column: 1, writeValue: true, cell: { value: 'Ramettes A4 80g' } }],
    structuralOps: [], chartEdits: [], filterStates: [], hyperlinkEdits: [], cfStates: [], dvStates: [],
    sheetProtections: [], visualAdditions: [], pageSetupStates: [], noteStates: [], tableAdditions: [],
    pivotAdditions: [], pivotCacheRefreshPaths: [], pivotRefreshUpdates: [], visualEdits: [],
    sparklineAdditions: [], formulaValues: [], protectedRangeStates: [], tabColorStates: [],
    sheetOps: [], sheetOrder: parsed.file.sheets.map(s => s.id),
  })
  const before = openWorkbookSource(bytes).parts
  const after = openWorkbookSource(result.buffer).parts
  const touched = new Set(result.touchedEntries)
  let identical = 0
  for (const part of before) {
    const saved = after.find(p => p.name === part.name)
    if (!saved) { process.stdout.write(`DROPPED: ${part.name}\n`); process.exitCode = 1; continue }
    if (touched.has(part.name)) continue
    if (Buffer.from(saved.data).equals(Buffer.from(part.data))) identical++
    else { process.stdout.write(`MODIFIED: ${part.name}\n`); process.exitCode = 1 }
  }
  const reparsed = await parseWorkbook(result.buffer, 'facture-a4.xlsx', 'fr')
  const sheet2 = reparsed.sheets.get(meta.id)!
  const r2 = readRange(sheet2, { startRow: 4, endRow: 4, startColumn: 1, endColumn: 1 })
  process.stdout.write(`OK: ${identical}/${before.length} byte-identical (touched: ${[...touched].join(', ')}); B5 now: ${JSON.stringify(r2.cells.map(c => c.value))}\n`)
  // merged cells survive?
  process.stdout.write(`merges after save: ${sheet2.merges.length}\n`)
}
main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1) })
