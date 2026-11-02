DOCUMENT_TYPE = "vente_facture"
DESCRIPTION = "Reference vente facture template (generic, no company data)."
SCHEMA = {
	"facture_number": str,
	"facture_date": str,
	"client_name": str,
	"lines": [
		{
			"description": str,
			"quantity": float,
			"unit_price": float,
		}
	],
	"total_ttc": float,
}
SAMPLE_DATA = {
	"facture_number": "F-2026-0001",
	"facture_date": "2026-11-02",
	"client_name": "SAMPLE CLIENT",
	"lines": [
		{"description": "Prestation A", "quantity": 2, "unit_price": 100.0},
		{"description": "Prestation B", "quantity": 1, "unit_price": 250.0},
	],
	"total_ttc": 540.0,
}
