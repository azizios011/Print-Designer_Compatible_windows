import JSZip from 'jszip'
import { parseWorkbook } from '/home/ERP_PROD/Print-Designer_Compatible_windows/print_designer/editors/sheets/src/adapter/engine/parse-workbook.ts'
import { readRange } from '/home/ERP_PROD/Print-Designer_Compatible_windows/print_designer/editors/sheets/src/adapter/engine/worksheet.ts'

async function main() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C4"/><sheetData>
<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f t="shared" ref="C1:C3" si="0">A1*B1</f><v>6</v></c></row>
<row r="2"><c r="A2"><v>4</v></c><c r="B2"><v>5</v></c><c r="C2"><f t="shared" si="0"/><v>20</v></c></row>
<row r="3"><c r="A3"><v>10</v></c><c r="B3"><v>2</v></c><c r="C3"><f t="shared" si="0"/><v>20</v></c></row>
<row r="4"><c r="A4"><f>SUM(A1:A3)</f><v>16</v></c><c r="C4"><f t="array" ref="C4:C4">A1+A2</f><v>6</v></c></row>
</sheetData></worksheet>`)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const parsed = await parseWorkbook(bytes as unknown as Uint8Array, 'shared.xlsx', 'en')
  const sheet = parsed.sheets.get(parsed.file.sheets[0]!.id)!
  const range = readRange(sheet, { startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 })
  for (const c of range.cells) {
    if (c.column === 2) process.stdout.write(`C${c.row + 1}: formula=${c.formula} value=${c.value} arrayRef=${c.arrayRef ?? '-'}\n`)
  }
  const a4 = range.cells.find(c => c.row === 3 && c.column === 0)
  process.stdout.write(`A4: formula=${a4?.formula}\n`)
  void parsed
}
main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1) })
