# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt

"""Grand Livre design validation (frappe-free; run inside the container with
`python3 -m unittest`-style or directly: `python3 validate.py`).

Validates the BUILDER (xlsx_creator) against the design contract:

1. "Page X/Y" footer markers: total Y equals the page count implied by the
   manual row breaks (so the PDF, converted by LibreOffice, must have exactly
   Y pages);
2. no row is cut across pages: every page's body rows stay inside the
   MAX_PAGE_HEIGHT_PT budget (header + footer ride on top of it);
3. the design landmarks are present on every page: company block, "Grand
   Livre" title, "Du ... Au ...", account header box ("Mouvements"/"Solde"),
   the grey-lilac "A reporter" bar, "Date de tirage ..." + "Page X/Y" footer;
4. A4 portrait, fitToWidth=1, gridlines off, the millimes number format.

When LibreOffice (soffice) is available the script ALSO converts the long
sample to PDF (French locale) and compares the PDF page count against the
markers — the conversion acceptance check. Page PNGs land next to the output
for the visual checklist (pdftoppm, optional).
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metadata  # noqa: E402
import xlsx_creator  # noqa: E402

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
	status = "PASS" if ok else "FAIL"
	print(f"[{status}] {name}{(' — ' + detail) if detail else ''}")
	if not ok:
		FAILURES.append(f"{name}: {detail}")


def build_long_workbook():
	"""A 200+ entry, multi-account sample with long labels/refs that wrap."""
	company = {
		"name": "SOCIETE CPR AUTO",
		"address": "05 RTE TUNIS ZAGHOUEN, 1140 ZAGHOUAN",
		"country": "Tunisie",
		"tax_id": "1390565LBC000",
	}
	period = {"from_date": "01/01/2026", "to_date": "31/03/2026"}

	accounts = []
	for block in range(6):
		entries = []
		for i in range(40):
			index = block * 40 + i
			entries.append(
				{
					"date": f"{(i % 28) + 1:02d}/0{(i % 3) + 1}/2026",
					"mvt": 1000 + index,
					"libelle": (
						f"FACTURE FOURNISSEUR ARTICLE LONG LIBELLE #{index + 1} — "
						"LIVRAISON MAGASIN CENTRAL ZAGHOUAN"
						if index % 3 == 0
						else f"FAC FOURNISSEUR ARTICLE #{index + 1}"
					),
					"jrn": "AC",
					"ref": f"FAC-2026-{index + 1:05d}-LONGREF" if index % 4 == 0 else f"FAC-2026-{index + 1:05d}",
					"debit": round(1250.5005 + index, 3) if index % 5 == 0 else 0.0,
					"credit": 0.0 if index % 5 == 0 else round(3420.1254 + index, 3),
				}
			)
		accounts.append(
			{
				"code": f"{401000 + block * 11:06d}",
				"name": f"FOURNISSEUR BLOC {block + 1}",
				"opening_solde": round(1000.0 + block, 3),
				"entries": entries,
			}
		)
	return xlsx_creator.build_grand_livre_workbook(company, period, accounts)


def workbook_page_segments(workbook):
	"""Row-index segments per page: [1..b1], [b1+1..b2], ..., last open."""
	sheet = workbook.active
	breaks = sorted(b.id for b in sheet.row_breaks.brk)
	segments = []
	start = 1
	for brk in breaks:
		segments.append((start, brk))
		start = brk + 1
	segments.append((start, sheet.max_row))
	return sheet, segments


def row_height(sheet, row):
	dimension = sheet.row_dimensions.get(row)
	return dimension.height if dimension is not None and dimension.height else 15.0


def page_texts(sheet, start, end):
	texts = []
	for row in sheet.iter_rows(min_row=start, max_row=end):
		for cell in row:
			if isinstance(cell.value, str) and cell.value.strip():
				texts.append(cell.value.strip())
	return texts


def main() -> int:
	body_budget = metadata.MAX_PAGE_HEIGHT_PT - metadata.PAGE_HEADER_HEIGHT - metadata.PAGE_FOOTER_HEIGHT

	workbooks = {
		"template sample": build_sample_workbook(),
		"long dataset (240 entries, 6 accounts)": build_long_workbook(),
	}

	for label, workbook in workbooks.items():
		print(f"\n=== {label} ===")
		sheet, segments = workbook_page_segments(workbook)

		# 1. the "Page X/Y" markers
		markers = []
		for start, end in segments:
			found = [t for t in page_texts(sheet, start, end) if re.match(r"^Page \d+/\d+$", t)]
			markers.append(found)
			check(f"page {len(markers)} carries exactly one 'Page X/Y' marker", len(found) == 1, str(found))
		total = len(markers)
		ok_totals = all(
			len(found) == 1 and found[0] == f"Page {number}/{total}"
			for number, found in enumerate(markers, 1)
		)
		check("markers run 1..Y with Y = page count", ok_totals, f"{total} pages")

		# 2. no row cut across pages: body budget respected per page
		for number, (start, end) in enumerate(segments, 1):
			heights = sum(row_height(sheet, row) for row in range(start, end + 1))
			# the page writes its own header/footer rows as content rows; the
			# builder's budget governs the body only — check the real total
			check(
				f"page {number} total height <= MAX_PAGE_HEIGHT_PT",
				heights <= metadata.MAX_PAGE_HEIGHT_PT + 0.01,
				f"{heights:.1f}pt (budget {metadata.MAX_PAGE_HEIGHT_PT:.0f}pt)",
			)

		# 3. design landmarks on every page
		for number, (start, end) in enumerate(segments, 1):
			texts = page_texts(sheet, start, end)
			check(f"page {number} has the 'Grand Livre' title", any(t == "Grand Livre" for t in texts))
			check(f"page {number} has the 'Du ... Au ...' period line", any(t.startswith("Du ") and " Au " in t for t in texts))
			check(f"page {number} has an account header box (Mouvements)", "Mouvements" in texts and "Solde" in texts)
			check(f"page {number} has the 'A reporter' bar", "A reporter" in texts)
			check(f"page {number} has the 'Date de tirage' footer", any(t.startswith("Date de tirage") for t in texts))
			check(f"page {number} has the company block", any("SOCIETE CPR AUTO" == t for t in texts))

		# 4. page setup + number format
		check("A4 portrait", sheet.page_setup.paperSize == 9 and sheet.page_setup.orientation == "portrait")
		check("fitToWidth=1", str(sheet.page_setup.fitToWidth) == "1")
		check("gridlines off", sheet.views.sheetView[0].showGridLines is False)
		debit_cells = [
			cell
			for row in sheet.iter_rows(min_col=7, max_col=9)
			for cell in row
			if isinstance(cell.value, (int, float))
		]
		check(
			"millimes number format on money cells",
			bool(debit_cells) and all(c.number_format == metadata.NUM_FMT for c in debit_cells),
			f"{len(debit_cells)} cells",
		)

	# ── optional LibreOffice conversion check ────────────────────────────────
	workbook = build_long_workbook()
	work_dir = tempfile.mkdtemp(prefix="gl-validate-")
	xlsx_path = os.path.join(work_dir, "grand_livre_long.xlsx")
	workbook.save(xlsx_path)
	binary = shutil.which("soffice") or shutil.which("libreoffice")
	if not binary and os.path.isfile("/usr/lib/libreoffice/program/soffice"):
		binary = "/usr/lib/libreoffice/program/soffice"
	if not binary:
		print(
			"\n[SKIP] LibreOffice (soffice) not installed in this container — "
			"run this script where LibreOffice exists to verify the PDF page "
			"count against the markers."
		)
	else:
		print("\n=== LibreOffice conversion (French locale) ===")
		env = dict(os.environ)
		env["LANG"] = "fr_FR.UTF-8"
		env["LC_ALL"] = "fr_FR.UTF-8"
		profile = os.path.join(work_dir, "profile")
		result = subprocess.run(
			[
				binary,
				"--headless",
				"--norestore",
				f"-env:UserInstallation=file://{profile}",
				"--convert-to",
				"pdf:calc_pdf_Export",
				"--outdir",
				work_dir,
				xlsx_path,
			],
			capture_output=True,
			text=True,
			timeout=120,
			env=env,
			check=False,
		)
		pdf_path = os.path.join(work_dir, "grand_livre_long.pdf")
		if not os.path.isfile(pdf_path):
			check("LibreOffice produced a PDF", False, (result.stderr or result.stdout or "")[-300:])
		else:
			try:
				from pypdf import PdfReader
			except ImportError:
				from PyPDF2 import PdfReader  # type: ignore[no-redef]
			pdf_pages = len(PdfReader(pdf_path).pages)
			sheet, segments = workbook_page_segments(workbook)
			marker_total = len(segments)
			check(
				"PDF page count equals the 'Page X/Y' total",
				pdf_pages == marker_total,
				f"pdf={pdf_pages} markers={marker_total}",
			)
			# French number rendering: pull page 1's text and look for a
			# comma-decimal figure
			try:
				text_out = subprocess.run(
					["pdftotext", pdf_path, "-"],
					capture_output=True,
					text=True,
					timeout=60,
					env=env,
					check=False,
				).stdout
				check(
					"French number format in the PDF (comma decimal)",
					bool(re.search(r"\d{1,3}( \d{3})*,\d{3}\b", text_out)),
				)
			except FileNotFoundError:
				print("[SKIP] pdftotext not available for the French-number check")
			pdftoppm = shutil.which("pdftoppm")
			if pdftoppm:
				subprocess.run(
					[pdftoppm, "-png", "-r", "80", pdf_path, os.path.join(work_dir, "page")],
					check=False,
					timeout=120,
				)
				print(f"page PNGs written to {work_dir}/page-*.png for the visual checklist")
			else:
				print(f"[SKIP] pdftoppm not available; PDF at {pdf_path} for manual inspection")

	print(f"\noutput kept in {work_dir} (grand_livre_long.xlsx)")
	if FAILURES:
		print(f"\n{len(FAILURES)} FAILURE(S)")
		for failure in FAILURES:
			print(f" - {failure}")
		return 1
	print("\nALL CHECKS PASSED")
	return 0


def build_sample_workbook():
	"""The design's own sample (template.py __main__ data), built in-process."""
	company = {
		"name": "SOCIETE CPR AUTO",
		"address": "05 RTE TUNIS ZAGHOUEN",
		"country": "Tunisie",
		"tax_id": "1390565LBC000",
	}
	period = {"from_date": "01/01/2026", "to_date": "31/01/2026"}
	long_entries = [
		{
			"date": f"{(i % 28) + 1:02d}/01/2026",
			"mvt": 100 + i,
			"libelle": f"FAC FOURNISSEUR ARTICLE #{i + 1}",
			"jrn": "AC",
			"ref": f"FAC-2026-{i + 1:05d}",
			"debit": 1250.500 if i % 5 == 0 else 0.0,
			"credit": 0.0 if i % 5 == 0 else 3420.125,
		}
		for i in range(42)
	]
	accounts = [
		{
			"code": "108000",
			"name": "CPT D'EXPLOIT.",
			"entries": [
				{"date": "06/01/2026", "mvt": 22, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606606250", "debit": 0, "credit": 11.400},
				{"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 0, "credit": 5700.891},
				{"date": "23/01/2026", "mvt": 110, "libelle": "FAC LE MOTEUR DIESEL", "jrn": "AC", "ref": "SAVFAC-26/0271", "debit": 0, "credit": 511.440},
			],
		},
		{
			"code": "401001",
			"name": "STBG",
			"entries": [
				{"date": "01/01/2026", "mvt": 20, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606605634", "debit": 0, "credit": 13348.562},
				{"date": "06/01/2026", "mvt": 22, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606606250", "debit": 11.400, "credit": 0},
				{"date": "15/01/2026", "mvt": 21, "libelle": "FACT STBG", "jrn": "AC", "ref": "9606608497", "debit": 0, "credit": 10980.117},
			],
		},
		{
			"code": "401108",
			"name": "STE MHIRI PRODUCTION",
			"entries": [
				{"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 5700.891, "credit": 0},
				{"date": "06/01/2026", "mvt": 107, "libelle": "FAC STE MHIRI", "jrn": "AC", "ref": "FC000144", "debit": 0, "credit": 5700.891},
			],
		},
		{
			"code": "607003",
			"name": "ACHATS 19%",
			"entries": long_entries,
		},
	]
	return xlsx_creator.build_grand_livre_workbook(company, period, accounts)


if __name__ == "__main__":
	raise SystemExit(main())
