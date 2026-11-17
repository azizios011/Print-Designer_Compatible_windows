# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt

"""Whitelisted endpoints for the Ledger Data report's document views.

The XLSX and PDF views of the "Ledger Data" (Grand Livre) report both render
the SAME document: the PDF is always converted from the generated xlsx, never
rendered separately. Each call regenerates and overwrites the caller's private
File (one per user + company + period) so repeated opens do not bloat the
File doctype.

Every method type-annotates its arguments (newer Frappe rejects unannotated
whitelisted arguments with a 417).
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import cint

from print_designer.pdf_generator.xlsx_pdf import pdf_page_count, xlsx_to_pdf
from print_designer.tunisian_univer_engine.template_system.reference.grand_livre.main import (
	build_grand_livre_xlsx,
	ledger_report,
	workbook_page_count,
)

XLSX_SUFFIX = ".xlsx"


def _parse_filters(filters: str) -> dict:
	"""The report client sends its filter values JSON-encoded."""
	try:
		parsed = json.loads(filters) if filters else {}
	except (ValueError, TypeError):
		frappe.throw(_("Invalid filters payload"))
	if not isinstance(parsed, dict):
		frappe.throw(_("Invalid filters payload"))
	return parsed


def _period_dates(filters: dict) -> tuple:
	"""(from_date, to_date) through the report's own period model (clamped to
	the dock context's Exercice)."""
	ledger = ledger_report()
	context = ledger.require_context()
	return ledger.resolve_period(filters, context)


def _document_file_name(label: str, from_date, to_date, suffix: str) -> str:
	"""`Grand Livre <company> <from>-<to>.xlsx` — ASCII-safe for the File doctype."""
	base = f"Grand Livre {label} {from_date:%d-%m-%Y} - {to_date:%d-%m-%Y}"
	safe = re.sub(r"[^A-Za-z0-9 ()_\-.]+", "_", base).strip()
	return f"{safe}{suffix}"


def _save_private_document(file_name: str, content: bytes):
	"""Store the generated document as a private File owned by the caller,
	overwriting the previous generation of the same name (one file per user +
	company + period). When Frappe's dedup points other File records at the
	same blob, a NEW record is created instead of mutating shared bytes."""
	existing = frappe.get_all(
		"File",
		filters={
			"file_name": file_name,
			"is_private": 1,
			"owner": frappe.session.user,
		},
		order_by="creation desc",
		limit=1,
	)
	if existing:
		doc = frappe.get_doc("File", existing[0].name)
		shared = (
			frappe.db.count(
				"File", {"content_hash": doc.content_hash or "", "name": ("!=", doc.name)}
			)
			if doc.content_hash
			else 0
		)
		if not shared:
			doc.save_file(content=content, overwrite=True)
			doc.save()
			return doc
		# shared blob: fall through and create a fresh record
	doc = frappe.new_doc("File")
	doc.file_name = file_name
	doc.is_private = 1
	doc.content = content
	doc.insert()
	return doc


def _generate(filters: str, as_pdf: bool) -> dict:
	parsed = _parse_filters(filters)
	# early gate (the report's query re-checks inside its row builder)
	ledger_report().check_ledger_read_permission()

	xlsx_bytes = build_grand_livre_xlsx(parsed)

	context = ledger_report().require_context()
	from_date, to_date = _period_dates(parsed)
	label = context.get("entreprise_label") or context.get("entreprise") or "Grand Livre"

	if as_pdf:
		pdf_bytes = xlsx_to_pdf(xlsx_bytes)
		content = pdf_bytes
		suffix = ".pdf"
		pages = pdf_page_count(pdf_bytes)
	else:
		content = xlsx_bytes
		suffix = XLSX_SUFFIX
		pages = workbook_page_count(xlsx_bytes)

	file_name = _document_file_name(label, from_date, to_date, suffix)
	doc = _save_private_document(file_name, content)
	return {
		"file": doc.name,
		"file_url": doc.file_url,
		"name": doc.file_name or doc.name,
		"pages": cint(pages),
	}


@frappe.whitelist(methods=["POST"])
def generate_grand_livre_xlsx(filters: str) -> dict:
	"""Build the Grand Livre xlsx for the report's filters and store it as the
	caller's private File. Returns {file, file_url, name, pages}."""
	return _generate(filters, as_pdf=False)


@frappe.whitelist(methods=["POST"])
def generate_grand_livre_pdf(filters: str) -> dict:
	"""Build the Grand Livre xlsx, convert THAT xlsx to PDF (LibreOffice,
	French locale) and store the PDF as the caller's private File. Returns
	{file, file_url, name, pages}."""
	return _generate(filters, as_pdf=True)
