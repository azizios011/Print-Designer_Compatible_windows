# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Deterministic parsers for digital bank statement PDFs.

Each parser module registered in PARSERS must expose:

	NAME: str
		Identifier used in the extraction response's "source" field.
	detect(doc) -> bool
		Whether the document matches this bank's statement layout.
	parse(doc) -> dict | None
		{"data": <releve_bancaire-shaped dict>, "checks": <reconciliation
		dict>} for the parsed statement, or None when the layout matched but
		no rows could be parsed (the caller then falls back to the VLM).

parse_statement opens the PDF with pymupdf and is the single entry point;
pymupdf is imported lazily so the rest of the app keeps working without it.
"""

from print_designer.tunisian_univer_engine.parsers import banque_zitouna

PARSERS = [banque_zitouna]

# A digital statement has a text layer; a scan has almost no words on page 1.
MIN_TEXT_LAYER_WORDS = 50


def parse_statement(pdf_bytes: bytes) -> dict | None:
	import pymupdf

	doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
	try:
		if doc.page_count < 1:
			return None
		if len(doc[0].get_text("words")) < MIN_TEXT_LAYER_WORDS:
			return None
		for parser in PARSERS:
			if not parser.detect(doc):
				continue
			result = parser.parse(doc)
			if result is None:
				return None
			return {"source": f"parser:{parser.NAME}", **result}
		return None
	finally:
		doc.close()
