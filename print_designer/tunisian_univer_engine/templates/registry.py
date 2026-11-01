# Hardcoded document designs are added here: one builder function per design,
# registered in TEMPLATES below. get_templates() filters by doctype and
# document format; build() materialises the requested template.

import frappe
from frappe import _

from print_designer.tunisian_univer_engine.templates.builders import blank_docx, blank_xlsx

TEMPLATES = [
	{
		"id": "blank-xlsx",
		"title": "Blank Spreadsheet",
		"document_format": "xlsx",
		"doctypes": ["*"],
		"builder": blank_xlsx,
	},
	{
		"id": "blank-docx",
		"title": "Blank Document",
		"document_format": "docx",
		"doctypes": ["*"],
		"builder": blank_docx,
	},
]


def get_templates(doctype: str, document_format: str) -> list:
	return [
		{"id": template["id"], "title": template["title"]}
		for template in TEMPLATES
		if template["document_format"] == document_format
		and (doctype in template["doctypes"] or "*" in template["doctypes"])
	]


def build(template_id: str) -> tuple[str, bytes]:
	for template in TEMPLATES:
		if template["id"] == template_id:
			return template["document_format"], template["builder"]()
	frappe.throw(_("Unknown template: {0}").format(template_id), frappe.ValidationError)
