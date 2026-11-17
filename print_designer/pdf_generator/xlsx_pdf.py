# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt

"""xlsx/xls → PDF through LibreOffice headless — the shared office-conversion
helper for the bundled editors and the document-type system (the Ledger Data
PDF view today, the print/import-export/signature module next).

The conversion MUST render with a French locale: the Grand Livre design's
number format "#,##0.000" must come out as "13 348,562" — without the locale
seed the same file converts with "13,348.562" (thousands and decimal
separators swap). The design files are the source of truth; the locale here
is what makes them true.

The container has NO system locale (no fr_FR.UTF-8, and no `localedef`
output to rely on), so the locale is NOT set through the environment: every
conversion gets a fresh LibreOffice profile whose user/registrymodifications
xcu is pre-seeded with ooSetupSystemLocale/ooLocale = fr-FR, and soffice runs
with LANG=C. Verified: the seed yields "13 348,562" for the Grand Livre
sample; without it, "13,348.562".

`which` does not exist as a shell command in the container — the preflight
uses Python's shutil.which, with explicit fallbacks for the paths
distributions actually use here (/usr/local/bin/soffice, the versioned
/opt/libreoffice*/program/soffice).
"""

import glob
import io
import os
import shutil
import subprocess
import tempfile

import frappe
from frappe import _

SOFFICE_TIMEOUT_S = 90

# locale is carried by the seeded profile, not the environment: LANG stays C
# and any inherited LC_* override is dropped (the container defines none)
PDF_LANG = "C"

LOCALE_SEED_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooSetupSystemLocale" oor:op="fuse"><value>fr-FR</value></prop></item>
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooLocale" oor:op="fuse"><value>fr-FR</value></prop></item>
</oor:items>
"""

# where distributions put the soffice binary when it is not on PATH
SOFFICE_FALLBACK_PATHS = (
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
)
SOFFICE_OPT_GLOBS = ("/opt/libreoffice*/program/soffice",)


def find_soffice() -> str | None:
    """Locate the soffice binary: shutil.which first (the `which` shell
    command does not exist in the container), then the explicit fallback
    paths and the versioned /opt/libreoffice* installs."""
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    candidates = list(SOFFICE_FALLBACK_PATHS)
    for pattern in SOFFICE_OPT_GLOBS:
        candidates.extend(sorted(glob.glob(pattern)))
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _seed_profile(profile_path: str) -> None:
    """Pre-seed the fresh LibreOffice profile with the French UI/document
    locale (fr-FR on both ooSetupSystemLocale and ooLocale): the conversion
    then renders the design's "#,##0.000" as "13 348,562" even though the
    container has no fr_FR system locale."""
    user_dir = os.path.join(profile_path, "user")
    os.makedirs(user_dir, exist_ok=True)
    with open(os.path.join(user_dir, "registrymodifications.xcu"), "w", encoding="utf-8") as stream:
        stream.write(LOCALE_SEED_XCU)


def xlsx_to_pdf(xlsx_bytes: bytes, timeout: int = SOFFICE_TIMEOUT_S) -> bytes:
    """Convert an xlsx byte payload to PDF bytes with LibreOffice headless.

    - every call gets its own -env:UserInstallation profile in the temp dir,
      pre-seeded with the fr-FR locale (see _seed_profile), so concurrent
      conversions never hit LibreOffice's single-instance lock and numbers
      always render French;
    - soffice runs with LANG=C (no system locale is assumed or needed);
    - the temp dir is cleaned up, and a missing soffice binary fails with an
      actionable message (the caller's preflight usually catches it first).
    """
    binary = find_soffice()
    if not binary:
        frappe.throw(
            _(
                "LibreOffice (soffice) n'est pas installe dans cet environnement: la conversion "
                "xlsx → PDF necessite LibreOffice. Installez-le (par exemple apt-get install -y "
                "libreoffice-calc --no-install-recommends) puis reessayez."
            )
        )

    work_dir = tempfile.mkdtemp(prefix="xlsx-pdf-")
    try:
        input_path = os.path.join(work_dir, "input.xlsx")
        with open(input_path, "wb") as stream:
            stream.write(xlsx_bytes)

        profile_path = os.path.join(work_dir, "profile")
        _seed_profile(profile_path)

        env = dict(os.environ)
        env["LANG"] = PDF_LANG
        for key in list(env):
            if key.startswith("LC_"):
                del env[key]

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
            frappe.throw(_("La conversion xlsx → PDF a depasse {0} secondes.").format(timeout))

        pdf_path = os.path.join(work_dir, "input.pdf")
        if not os.path.isfile(pdf_path):
            detail = (result.stderr or result.stdout or "").strip()[-500:]
            frappe.throw(
                _("La conversion xlsx → PDF n'a produit aucun fichier{0}").format(
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
