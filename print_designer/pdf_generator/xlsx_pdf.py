# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt

"""xlsx/xls → PDF through LibreOffice headless — the shared office-conversion
helper for the bundled editors and the document-type system (the Ledger Data
PDF view today, the print/import-export/signature module next).

The conversion MUST run with a French locale: the Grand Livre design's number
format "#,##0.000" renders as "13 348,562" only when LibreOffice's locale is
French — without it the same file converts with "13,348.562" (the thousands
and decimal separators swap). The design files are the source of truth; the
locale here is what makes them true.
"""

import io
import os
import shutil
import subprocess
import tempfile

import frappe
from frappe import _

SOFFICE_TIMEOUT_S = 90
PDF_LANG = "fr_FR.UTF-8"

# where distributions put the soffice binary when it is not on PATH
SOFFICE_FALLBACK_PATHS = (
	"/usr/lib/libreoffice/program/soffice",
	"/opt/libreoffice/program/soffice",
	"/snap/bin/libreoffice",
)


def find_soffice() -> str | None:
	found = shutil.which("soffice") or shutil.which("libreoffice")
	if found:
		return found
	for candidate in SOFFICE_FALLBACK_PATHS:
		if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
			return candidate
	return None


def xlsx_to_pdf(xlsx_bytes: bytes, timeout: int = SOFFICE_TIMEOUT_S) -> bytes:
	"""Convert an xlsx byte payload to PDF bytes with LibreOffice headless.

	- forces a French locale (LANG/LC_ALL) so number formats render TND-style
	  ("13 348,562");
	- gives every call its own -env:UserInstallation profile in the temp dir,
	  so concurrent conversions never hit LibreOffice's single-instance lock;
	- cleans the temp dir up, and fails with an actionable message when the
	  soffice binary is missing.
	"""
	binary = find_soffice()
	if not binary:
		frappe.throw(
			_(
				"LibreOffice (soffice) is not installed on this server — the xlsx→PDF conversion needs it. "
				"Install libreoffice (e.g. apt-get install -y libreoffice-calc --no-install-recommends) "
				"and the French locale (locales + locale-gen fr_FR.UTF-8)."
			)
		)

	work_dir = tempfile.mkdtemp(prefix="xlsx-pdf-")
	try:
		input_path = os.path.join(work_dir, "input.xlsx")
		with open(input_path, "wb") as stream:
			stream.write(xlsx_bytes)

		profile_path = os.path.join(work_dir, "profile")
		env = dict(os.environ)
		env["LANG"] = PDF_LANG
		env["LC_ALL"] = PDF_LANG

		command = [
			binary,
			"--headless",
			"--norestore",
			"--nolockcheck",
			"--nodefault",
			f"-env:UserInstallation=file://{profile_path}",
			"--convert-to",
			"pdf:calc_pdf_Export",
			"--outdir",
			work_dir,
			input_path,
		]
		try:
			result = subprocess.run(
				command,
				capture_output=True,
				text=True,
				timeout=timeout,
				env=env,
				check=False,
			)
		except subprocess.TimeoutExpired:
			frappe.throw(_("The xlsx→PDF conversion timed out after {0} seconds.").format(timeout))

		pdf_path = os.path.join(work_dir, "input.pdf")
		if not os.path.isfile(pdf_path):
			detail = (result.stderr or result.stdout or "").strip()[-500:]
			frappe.throw(
				_("The xlsx→PDF conversion produced no output{0}").format(
					f": {detail}" if detail else "."
				)
			)
		with open(pdf_path, "rb") as stream:
			return stream.read()
	finally:
		shutil.rmtree(work_dir, ignore_errors=True)


def pdf_page_count(pdf_bytes: bytes) -> int:
	"""Page count of a PDF payload (pypdf, vendored with frappe)."""
	try:
		from pypdf import PdfReader
	except ImportError:  # older frappe images ship PyPDF2
		from PyPDF2 import PdfReader  # type: ignore[no-redef]

	reader = PdfReader(io.BytesIO(pdf_bytes))
	return len(reader.pages)
