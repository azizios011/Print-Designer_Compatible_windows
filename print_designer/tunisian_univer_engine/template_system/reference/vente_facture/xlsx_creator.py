import openpyxl


def build(data, output_path, assets):
	workbook = openpyxl.Workbook()
	sheet = workbook.active
	sheet.title = "Facture"
	sheet["A1"] = data.get("facture_number", "")
	sheet["A2"] = data.get("facture_date", "")
	sheet["A3"] = data.get("client_name", "")

	row = 5
	sheet.cell(row=row, column=1, value="Description")
	sheet.cell(row=row, column=2, value="Quantity")
	sheet.cell(row=row, column=3, value="Unit Price")
	row += 1
	for line in data.get("lines", []):
		sheet.cell(row=row, column=1, value=line.get("description"))
		sheet.cell(row=row, column=2, value=line.get("quantity"))
		sheet.cell(row=row, column=3, value=line.get("unit_price"))
		row += 1

	sheet.cell(row=row + 1, column=3, value=data.get("total_ttc", 0.0))
	workbook.save(output_path)
	return output_path
