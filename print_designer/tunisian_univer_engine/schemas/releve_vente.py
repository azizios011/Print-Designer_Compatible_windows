# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Field names match Releve Vente (header) and Releve Vente Detail (entries).

SCHEMA = {
	"company": "string or null",
	"posting_date": "string or null (formatted as YYYY-MM-DD)",
	"entries": [
		{
			"client_code": "string or null",
			"client_name": "string or null",
			"operation": "string or null",
			"reference": "string or null",
			"date": "string or null (formatted as YYYY-MM-DD)",
			"ttc": "number or null",
			"ht": "number or null",
			"remise": "number or null",
			"tot_net_ht": "number or null",
			"tva_percent": "number or null",
			"montant_tva": "number or null",
		}
	],
}
