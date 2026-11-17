# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt

"""Whitelisted endpoints for the Ledger Data report's document views.

The XLSX and PDF views of the "Ledger Data" (Grand Livre) report both render
the SAME document: the PDF is always converted from the generated xlsx, never
rendered separately.

Nothing here runs synchronously anymore: at Annuelle scale the Grand Livre is
~32k ledger rows / ~1,000 pages / ~45k merged ranges and the pure openpyxl
build takes ~9 minutes (measured), which no HTTP request survives — the old
synchronous generation is what hung the views on "Generation du Grand Livre...".

Flow:
- prepare_grand_livre_document: cache hit → the document instantly; a fresh
  (filters, data) combination → the size guard, then ONE background job
  (long queue) that builds the xlsx and, when the PDF was requested,
  converts it in the same job; progress is published both in realtime and
  into the cache (the polling fallback);
- get_grand_livre_document_status: polling endpoint (realtime events can be
  lost — the client polls and never waits on a promise alone);
- cancel_grand_livre_document: flips a cancel flag the job honors at stage
  boundaries (the build itself is one library call it cannot interrupt).

The cache key is (user, entreprise, exercice, filters, kind, ledger row
count + max modified) — any data change invalidates the cached files. The
generated files are private Files owned by the caller, overwritten per
(user + company + period) so repeated opens do not bloat the File doctype.

Every method type-annotates its arguments (newer Frappe rejects unannotated
whitelisted arguments with a 417).
"""

import hashlib
import json
import math
import re
import time

import frappe
from frappe import _
from frappe.utils import cint

from print_designer.pdf_generator.xlsx_pdf import (
    find_soffice,
    pdf_page_count,
    xlsx_to_pdf,
)
from print_designer.tunisian_univer_engine.template_system.reference.grand_livre.main import (
    build_grand_livre_xlsx,
    ledger_report,
    workbook_page_count,
)

XLSX_SUFFIX = ".xlsx"
PDF_SUFFIX = ".pdf"

# size guard: above this many filtered rows the views show the
# "choisissez un mois ou un compte" banner instead of auto-generating.
# From the measurement: ~31 ledger rows per page and ~17 ms per row of pure
# build — 5,000 rows ≈ 160 pages ≈ 1.5 min of build, the practical ceiling
# for a comfortable wait even in the background.
GL_DOC_ROW_THRESHOLD = 5000

# measured on the real design: 32,175 rows → 1,040 pages (~31.7 rows/page)
GL_DOC_ROWS_PER_PAGE = 31

# cache / job plumbing
CACHE_PREFIX = "gl_document_state"
CACHE_TTL_S = 24 * 60 * 60
JOB_QUEUE = "long"
# measured: 553 s of build at 32k rows + page count + conversion headroom
JOB_TIMEOUT_S = 3600

PROGRESS_EVENT = "grand_livre_document_progress"
DONE_EVENT = "grand_livre_document_done"

SOFFICE_MISSING_MESSAGE = _(
    "LibreOffice (soffice) n'est pas installe dans cet environnement: la vue PDF ne peut pas "
    "fonctionner ici. Telechargez le .xlsx (bouton ci-dessous) ou installez LibreOffice sur le "
    "serveur puis reessayez."
)


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


def _ledger_stamp(context: dict) -> tuple[int, str]:
    """(row count, max modified) of the context's ledger — the data part of
    the cache key: any posted or edited row invalidates the cached files."""
    row = frappe.db.sql(
        """select count(*) as row_count, max(modified) as last_modified
            from `tabEcriture Comptable`
            where entreprise = %(entreprise)s and exercice = %(exercice)s""",
        {"entreprise": context["entreprise"], "exercice": context["exercice"]},
        as_dict=True,
    )[0]
    return cint(row.row_count), str(row.last_modified or "")


def _cache_key(parsed: dict, kind: str, context: dict, stamp: tuple[int, str]) -> str:
    """Deterministic cache key: user + entreprise + exercice + filters + kind
    + the ledger data stamp (row count and max modified)."""
    payload = json.dumps(
        {
            "user": frappe.session.user,
            "entreprise": context["entreprise"],
            "exercice": context["exercice"],
            "filters": parsed,
            "kind": kind,
            "rows": stamp[0],
            "last_modified": stamp[1],
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _state_get(cache_key: str) -> dict | None:
    state = frappe.cache().get_value(f"{CACHE_PREFIX}:{cache_key}")
    return state if isinstance(state, dict) else None


def _state_set(cache_key: str, **updates) -> dict:
    state = _state_get(cache_key) or {}
    state.update(updates)
    state["updated_at"] = time.time()
    frappe.cache().set_value(f"{CACHE_PREFIX}:{cache_key}", state, expires_in_sec=CACHE_TTL_S)
    return state


def _publish(cache_key: str, progress: str) -> None:
    """Progress through realtime AND the cache: the cache is the polling
    fallback for a lost realtime event."""
    _state_set(cache_key, progress=progress)
    frappe.publish_realtime(
        PROGRESS_EVENT,
        {"cache_key": cache_key, "progress": progress, "user": frappe.session.user},
        user=frappe.session.user,
    )


def _filtered_row_count(parsed: dict) -> int:
    """The filtered set size, through the report's own filter builder (the
    same rows the grille would read — the guard threshold applies to it)."""
    ledger = ledger_report()
    context = ledger.require_context()
    from_date, to_date = ledger.resolve_period(parsed, context)
    query_filters = ledger._ledger_filters(parsed, context, from_date, to_date)
    return frappe.db.count("Ecriture Comptable", query_filters)


def _file_exists(file_name: str) -> bool:
    return bool(file_name and frappe.db.exists("File", file_name))


def _cancelled(cache_key: str) -> bool:
    state = _state_get(cache_key) or {}
    return bool(state.get("cancel_requested"))


def _generate_job(cache_key: str, xlsx_key: str, parsed: dict, as_pdf: bool) -> None:
    """The background worker (long queue): build the Grand Livre xlsx, store
    it, and — when the PDF was requested — convert THAT xlsx in the same job
    (one job produces both). Progress goes through _publish at every stage;
    every failure path sets status=failed with a message. Re-running a job
    whose state is already done is a no-op (idempotent)."""
    state = _state_get(cache_key) or {}
    if state.get("status") == "done" and state.get("file"):
        return
    if _cancelled(cache_key):
        _state_set(cache_key, status="cancelled")
        return

    try:
        rows = _filtered_row_count(parsed)
        _publish(cache_key, _("Lecture des ecritures... ({0} lignes)").format(rows))

        # the PDF job reuses the xlsx built by an earlier xlsx run when it is
        # still fresh (same cache key): no second 9-minute build
        xlsx_state = _state_get(xlsx_key) or {}
        xlsx_bytes = None
        if xlsx_state.get("status") == "done" and xlsx_state.get("file") and _file_exists(xlsx_state["file"]):
            try:
                xlsx_bytes = frappe.get_doc("File", xlsx_state["file"]).get_content()
            except Exception:  # noqa: BLE001 — any failure (missing blob, permissions) just rebuilds
                xlsx_bytes = None
        if xlsx_bytes is None:
            xlsx_bytes = build_grand_livre_xlsx(parsed)

        pages = workbook_page_count(xlsx_bytes)
        context = ledger_report().require_context()
        from_date, to_date = _period_dates(parsed)
        label = context.get("entreprise_label") or context.get("entreprise") or "Grand Livre"

        # the xlsx is ALWAYS persisted (also from a PDF run): the xlsx view
        # reopens it instantly afterwards
        xlsx_doc = _save_private_document(_document_file_name(label, from_date, to_date, XLSX_SUFFIX), xlsx_bytes)
        _state_set(
            xlsx_key,
            status="done",
            file=xlsx_doc.name,
            file_url=xlsx_doc.file_url,
            name=xlsx_doc.file_name or xlsx_doc.name,
            pages=pages,
            progress="",
            cancel_requested=0,
        )

        if _cancelled(cache_key):
            _state_set(cache_key, status="cancelled")
            return

        if as_pdf:
            _publish(cache_key, _("Conversion PDF... ({0} pages)").format(pages))
            pdf_bytes = xlsx_to_pdf(xlsx_bytes)
            pdf_pages = pdf_page_count(pdf_bytes)
            pdf_doc = _save_private_document(_document_file_name(label, from_date, to_date, PDF_SUFFIX), pdf_bytes)
            _state_set(
                cache_key,
                status="done",
                file=pdf_doc.name,
                file_url=pdf_doc.file_url,
                name=pdf_doc.file_name or pdf_doc.name,
                pages=pdf_pages,
                rows=rows,
                progress="",
                cancel_requested=0,
            )
        else:
            _state_set(cache_key, status="done", rows=rows, progress="", cancel_requested=0)

        frappe.publish_realtime(
            DONE_EVENT,
            {"cache_key": cache_key, "status": "done", "user": frappe.session.user},
            user=frappe.session.user,
        )
    except Exception:  # noqa: BLE001 — the job must always end in an explicit failed state
        frappe.log_error("Grand Livre document generation failed", frappe.get_traceback())
        error = _("La generation du document a echoue (voir Error Log). Reessayez.")
        _state_set(cache_key, status="failed", error=error, progress="")
        frappe.publish_realtime(
            PROGRESS_EVENT,
            {"cache_key": cache_key, "status": "failed", "error": error, "user": frappe.session.user},
            user=frappe.session.user,
        )


@frappe.whitelist(methods=["POST"])
def prepare_grand_livre_document(filters: str, kind: str = "xlsx", force: int = 0) -> dict:
    """Start-or-collect entry for the document views: the cached document
    when it is fresh, an explicit too_large status above the size guard
    (force overrides), else one background job. Immediate failures come back
    as error statuses — the client never waits on a promise that never
    resolves."""
    kind = "pdf" if kind == "pdf" else "xlsx"
    parsed = _parse_filters(filters)
    ledger_report().check_ledger_read_permission()
    context = ledger_report().require_context()

    if kind == "pdf" and not find_soffice():
        return {"status": "error", "error": SOFFICE_MISSING_MESSAGE}

    stamp = _ledger_stamp(context)
    key = _cache_key(parsed, kind, context, stamp)
    state = _state_get(key) or {}

    if (
        state.get("status") == "done"
        and state.get("file")
        and _file_exists(state["file"])
    ):
        return {
            "status": "done",
            "cache_key": key,
            **{field: state[field] for field in ("file", "file_url", "name", "pages") if state.get(field) is not None},
        }
    if state.get("status") in ("queued", "running"):
        # fresh job: report it; a stale state (worker died) falls through and
        # re-enqueues instead of making the view wait on a dead job forever
        updated_at = cint(state.get("updated_at"))
        if updated_at and (time.time() - updated_at) < JOB_TIMEOUT_S + 600:
            return {"status": state["status"], "cache_key": key, "progress": state.get("progress", "")}

    rows = _filtered_row_count(parsed)
    pages_estimate = math.ceil(rows / GL_DOC_ROWS_PER_PAGE)
    if not cint(force) and rows > GL_DOC_ROW_THRESHOLD:
        return {
            "status": "too_large",
            "cache_key": key,
            "rows": rows,
            "pages": pages_estimate,
            "threshold": GL_DOC_ROW_THRESHOLD,
        }

    _state_set(key, status="queued", progress="", cancel_requested=0, kind=kind, rows=rows)
    # the xlsx twin key (a PDF run fills both states in one job)
    xlsx_key = _cache_key(parsed, "xlsx", context, stamp)
    try:
        frappe.enqueue(
            "print_designer.api.ledger_documents._generate_job",
            queue=JOB_QUEUE,
            timeout=JOB_TIMEOUT_S,
            job_id=f"gl_doc_{key}",
            deduplicate=True,
            cache_key=key,
            xlsx_key=xlsx_key,
            parsed=parsed,
            as_pdf=(kind == "pdf"),
        )
    except Exception:  # noqa: BLE001 — an enqueue failure must surface, never hang the view
        frappe.log_error("Grand Livre document enqueue failed", frappe.get_traceback())
        return {
            "status": "error",
            "error": _("La file de taches de fond est indisponible: reessayez plus tard."),
        }
    return {"status": "queued", "cache_key": key, "rows": rows, "pages": pages_estimate}


@frappe.whitelist(methods=["POST"])
def get_grand_livre_document_status(filters: str = "", kind: str = "xlsx", cache_key: str = "") -> dict:
    """Polling fallback for the document views: the current cache state, or
    an explicit unknown status when the cache entry is gone (a lost redis
    state surfaces as an error in the view instead of an endless wait)."""
    ledger_report().check_ledger_read_permission()
    if not cache_key:
        parsed = _parse_filters(filters)
        context = ledger_report().require_context()
        stamp = _ledger_stamp(context)
        cache_key = _cache_key(parsed, kind, context, stamp)
    state = _state_get(cache_key)
    if not state:
        return {"status": "unknown", "cache_key": cache_key}
    out = {
        "status": state.get("status", "unknown"),
        "cache_key": cache_key,
        "progress": state.get("progress", ""),
        "error": state.get("error", ""),
    }
    out.update({field: state[field] for field in ("file", "file_url", "name", "pages", "rows") if state.get(field) is not None})
    return out


@frappe.whitelist(methods=["POST"])
def cancel_grand_livre_document(filters: str = "", kind: str = "xlsx", cache_key: str = "") -> dict:
    """Flip the cancel flag: the job stops at the next stage boundary (the
    openpyxl build itself is one library call it cannot be interrupted
    mid-way). Returns the new state so the view can stop polling."""
    ledger_report().check_ledger_read_permission()
    if not cache_key:
        parsed = _parse_filters(filters)
        context = ledger_report().require_context()
        stamp = _ledger_stamp(context)
        cache_key = _cache_key(parsed, kind, context, stamp)
    state = _state_get(cache_key) or {}
    if state.get("status") in ("queued", "running"):
        _state_set(cache_key, status="cancelled", cancel_requested=1, progress="")
        return {"status": "cancelled", "cache_key": cache_key}
    return {"status": state.get("status", "unknown"), "cache_key": cache_key}
