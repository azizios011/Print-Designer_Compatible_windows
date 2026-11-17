"""A4 invoice workbook the way the Axeane Kompta document-type system generates
them with openpyxl: 9-column layout, merged title cells, borders, number formats."""
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Facture"

widths = [12, 34, 10, 12, 12, 12, 12, 12, 12]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w

thin = Side(style='thin', color='999999')
box = Border(left=thin, right=thin, top=thin, bottom=thin)

# merged header block
ws.merge_cells('A1:I1')
ws['A1'] = 'SOCIÉTÉ AXEANE KOMPTA — FACTURE N° 2026-041'
ws['A1'].font = Font(bold=True, size=14)
ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws.merge_cells('A2:I2')
ws['A2'] = 'Client : Sté Tunisienne de Commerce    MF : 1234567/A/M/000'
ws['A2'].font = Font(size=10)

# header row of the 9-column table
headers = ['Code', 'Désignation', 'Unité', 'Qté', 'P.U. HT', 'Rem. %', 'Montant HT', 'TVA %', 'Montant TTC']
for col, header in enumerate(headers, 1):
    cell = ws.cell(row=4, column=col, value=header)
    cell.font = Font(bold=True, color='FFFFFF')
    cell.fill = PatternFill('solid', fgColor='1F4E79')
    cell.alignment = Alignment(horizontal='center')
    cell.border = box

rows = [
    ('ART-001', 'Papier A4 80g (ramette)', 'U', 120, 8.5, 0, 1020.0, 19, 1213.8),
    ('ART-002', 'Toner laser noir', 'U', 6, 145.0, 5, 827.0, 19, 984.13),
    ('ART-003', 'Classeurs à levier', 'U', 40, 12.0, 0, 480.0, 19, 571.2),
    ('SRV-001', 'Prestation maintenance', 'H', 16, 60.0, 0, 960.0, 19, 1142.4),
]
for r, row in enumerate(rows, 5):
    for c, value in enumerate(row, 1):
        cell = ws.cell(row=r, column=c, value=value)
        cell.border = box
        if c in (5, 7, 9):
            cell.number_format = '#,##0.000'
        if c == 4:
            cell.number_format = '#,##0'

ws.merge_cells('A10:H10')
ws['A10'] = 'Total'
ws['A10'].font = Font(bold=True)
ws['A10'].alignment = Alignment(horizontal='right')
ws['I10'] = 3911.53
ws['I10'].font = Font(bold=True)
ws['I10'].number_format = '#,##0.000'
ws['I10'].border = box

wb.save('/tmp/inv/facture-a4.xlsx')
print('saved /tmp/inv/facture-a4.xlsx')
