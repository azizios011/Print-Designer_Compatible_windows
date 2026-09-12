# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Header keys match Releve Bancaire / Bank Account. Line keys match Tunisian
# statement columns (date, libellé, valeur, débit, crédit) plus opening/closing
# balances which are printed on the statement but not stored on the doctype.

SCHEMA = {
	"company": "string or null (company name as printed)",
	"iban": "string or null (RIB / IBAN of the account, exactly as printed)",
	"bank_account": "string or null (account label or number as printed)",
	"period_from": "string or null (statement start date, formatted as YYYY-MM-DD)",
	"period_to": "string or null (statement end date, formatted as YYYY-MM-DD)",
	"reference_number": "string or null (statement number as printed)",
	"opening_balance": "number or null",
	"closing_balance": "number or null",
	"entries": [
		{
			"date": "string or null (operation date, formatted as YYYY-MM-DD)",
			"libelle": "string or null (libellé / description of the line)",
			"valeur": "string or null (date de valeur, formatted as YYYY-MM-DD)",
			"debit": "number or null",
			"credit": "number or null",
		}
	],
}
