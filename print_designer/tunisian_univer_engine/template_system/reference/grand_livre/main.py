"""Grand Livre — Frappe adapter for the xlsx_creator design.

`build_grand_livre_xlsx(filters)` runs the "Ledger Data" report's own query
path (the dock accounting context, the report's period model and its grille
builder — never a second ledger query), maps the result onto the design's
input shapes, and returns the openpyxl workbook as bytes.

Folder convention (document-type system): metadata.py / xlsx_creator.py /
main.py per document type — see reference/vente_facture/. xlsx_creator.py and
metadata.py are VERBATIM copies of the finished Grand Livre design (openpyxl);
only main.py is new here.
"""

from __future__ import annotations

import io
import re
from datetime import timedelta
from typing import Any

import frappe
from frappe import _
from frappe.utils import flt, getdate

from .xlsx_creator import build_grand_livre_workbook

LEDGER_REPORT_MODULE = "erpnext.custom_modules.reports.report.ledger_data.ledger_data"

BALANCE_TOLERANCE = 0.0005


def ledger_report() -> Any:
	"""The Ledger Data report module — the single query path for the ledger.

	Lazy import: print_designer does not hard-depend on the erpnext fork at
	module load time, and the error names the missing piece.
	"""
	try:
		return frappe.get_module(LEDGER_REPORT_MODULE)
	except Exception:  # noqa: BLE001 — any import failure is surfaced as the same actionable throw
		frappe.throw(
			_("The Ledger Data report is not available (missing module {0}).").format(
				LEDGER_REPORT_MODULE
			)
		)


def _company_info(entreprise: str) -> dict[str, str]:
	"""company_info for the design header block, from the Entreprise record."""
	doc = frappe.db.get_value(
		"Entreprise",
		entreprise,
		[
			"raison_sociale",
			"matricule_fiscal",
			"numero",
			"rue",
			"code_postal",
			"ville",
			"pays_adresse",
			"pays",
		],
		as_dict=True,
	)
	if not doc:
		frappe.throw(_("Entreprise {0} not found").format(entreprise))

	address_parts = [
		part
		for part in (
			doc.numero,
			doc.rue,
			" ".join(part for part in (doc.code_postal, doc.ville) if part),
		)
		if part
	]
	return {
		"name": doc.raison_sociale or entreprise,
		"address": ", ".join(address_parts),
		"country": doc.pays_adresse or doc.pays or "",
		"tax_id": doc.matricule_fiscal or "",
	}


def _fr_date(value: Any) -> str:
	return getdate(value).strftime("%d/%m/%Y") if value else ""


def _account_name(account: str) -> str:
	name = frappe.db.get_value("Chart of Account", account, "account_name")
	return name or account


def _extract_label(filters: dict) -> str:
	"""A short, human-readable statement of the Type Extrait selection for the
	workbook header: "Compte 401000", "Du 401000 au 411999",
	"Saisie libre: 401, 411000, 512-531". Empty when unrestricted
	("Tous les comptes" / "Comptes non soldes")."""
	extract_type = filters.get("extract_type") or "Tous les comptes"
	if extract_type == "Compte":
		target = (filters.get("account") or "").strip()
		if not target:
			return ""
		num = target.split(" · ")[0].strip() if " · " in target else ""
		if not num:
			# the filter value is the Chart of Account name: show its number
			resolved = frappe.db.get_value("Chart of Account", target, "account_number")
			num = resolved or target
		return f"Compte {num}"
	if extract_type == "Intervalle des comptes":
		fr = (filters.get("from_account") or "").strip()
		to = (filters.get("to_account") or "").strip()
		fr = fr.split(" · ")[0].strip() if " · " in fr else fr
		to = to.split(" · ")[0].strip() if " · " in to else to
		parts = []
		if fr:
			parts.append(f"Du {fr}")
		if to:
			parts.append(f"au {to}")
		return " ".join(parts)
	if extract_type == "Saisie libre":
		raw = (filters.get("saisie_libre") or "").strip()
		return f"Saisie libre: {raw}" if raw else ""
	return ""


def _selected_account_names(
	ledger: Any,
	filters: dict,
	context: dict[str, Any],
	from_date,
	to_date,
) -> set[str] | None:
	"""The account restriction from the report's own filter builder, or None
	when the extract is unrestricted. The opening-balance query below is a
	separate read from the grille and must apply the same Compte / Intervalle /
	Saisie libre / grand-livre type selection — otherwise excluded accounts
	would reappear in the workbook with their opening balance."""
	for condition in ledger._ledger_filters(filters, context, from_date, to_date):
		field, operator, value = condition
		if field == "account" and operator == "in":
			return set(value)
		if field == "name" and operator == "=" and value == "":
			# the report's no-match sentinel: an empty selection, not all accounts
			return set()
	return None


def _opening_only_accounts(
	context: dict[str, Any],
	exercice_debut,
	until,
	known_accounts: set[str],
	selected_accounts: set[str] | None = None,
) -> dict[str, float]:
	"""Net balances of accounts that posted nothing inside the period but
	carry a non-zero "Solde a nouveau" — the design shows them with their
	report balance. The statement mirrors the grille's own opening query
	(same Entreprise/Exercice scope, same date clamp), narrowed only by the
	exclusion of accounts the period rows already cover."""
	if exercice_debut is None or until < exercice_debut:
		return {}
	opening_rows = frappe.db.sql(
		"""select account, sum(debit) - sum(credit) as balance
			from `tabEcriture Comptable`
			where entreprise = %(entreprise)s
				and exercice = %(exercice)s
				and posting_date >= %(exercice_start)s
				and posting_date <= %(until)s
			group by account""",
		{
			"entreprise": context["entreprise"],
			"exercice": context["exercice"],
			"exercice_start": exercice_debut,
			"until": until,
		},
		as_dict=True,
	)
	return {
		row.account: flt(row.balance, 3)
		for row in opening_rows
		if row.account not in known_accounts
		and (selected_accounts is None or row.account in selected_accounts)
		and abs(flt(row.balance, 3)) > BALANCE_TOLERANCE
	}


def build_grand_livre_xlsx(filters: dict, generated_at: str | None = None) -> bytes:
	"""Build the Grand Livre workbook for the report's filters — returns bytes.

	Data source: the Ledger Data report's own path (context gate, period
	model, ledger query, grille grouping). Accounts with period entries come
	from the grille rows; accounts whose only movements predate the period
	join with their non-zero opening balance (the design's "Solde a nouveau").
	Every money value is rounded to 3 decimals (TND millimes) before the
	builder sums it, so its float totals do not drift.
	"""
	ledger = ledger_report()
	filters = filters or {}

	# the report's own gate + period model + ledger query (one path)
	context = ledger.require_context()
	from_date, to_date = ledger.resolve_period(filters, context)
	grille_rows = ledger._get_grille_rows(filters, context)

	accounts: list[dict[str, Any]] = []
	by_account: dict[str, dict[str, Any]] = {}
	current: dict[str, Any] | None = None
	for row in grille_rows:
		row_type = row.get("row_type")
		code = row.get("account")
		if row_type == "header":
			current = {"code": code, "name": _account_name(code), "entries": [], "opening_solde": 0.0}
			by_account[code] = current
			accounts.append(current)
		elif row_type == "opening":
			if current is not None:
				current["opening_solde"] = flt(row.get("solde"), 3)
		elif row_type == "entry" and current is not None:
			current["entries"].append(
				{
					"date": row.get("date") or _fr_date(row.get("posting_date")),
					"mvt": row.get("mvt") or "",
					"libelle": row.get("libelle") or "",
					"jrn": row.get("journal") or "",
					"ref": row.get("ref_doc") or "",
					"debit": flt(row.get("debit"), 3),
					"credit": flt(row.get("credit"), 3),
				}
			)

	# accounts with a report balance but no period rows
	exercice_debut = getdate(context["date_debut"]) if context.get("date_debut") else None
	selected_accounts = _selected_account_names(ledger, filters, context, from_date, to_date)
	openings = _opening_only_accounts(
		context,
		exercice_debut,
		from_date - timedelta(days=1),
		set(by_account),
		selected_accounts,
	)
	for code, opening in sorted(openings.items()):
		account = {"code": code, "name": _account_name(code), "entries": [], "opening_solde": opening}
		accounts.append(account)
		by_account[code] = account

	# stable, code-ordered output (the grille order is display-based)
	accounts.sort(key=lambda a: a["code"])

	company_info = _company_info(context["entreprise"])
	period = {"from_date": _fr_date(from_date), "to_date": _fr_date(to_date)}
	extract_label = _extract_label(filters)

	workbook = build_grand_livre_workbook(
		company_info,
		period,
		accounts,
		generated_at=generated_at,
		paginate_for_pdf=True,
		extract_label=extract_label,
	)
	buffer = io.BytesIO()
	workbook.save(buffer)
	return buffer.getvalue()


def workbook_page_count(xlsx_bytes: bytes, read_only: bool = True) -> int:
	"""The design's own page count: the "Page X/Y" footer markers it writes.

	The PDF must match this total (the MAX_PAGE_HEIGHT_PT budget); the
	conversion check compares the LibreOffice PDF page count against it.
	read_only (the default) scans values only — at Grand Livre scale the
	normal-mode load alone costs tens of seconds.
	"""
	workbook = load_workbook_from_bytes(xlsx_bytes, read_only=read_only)
	sheet = workbook.active
	pages = 0
	try:
		for row in sheet.iter_rows():
			for cell in row:
				if isinstance(cell.value, str):
					match = re.match(r"^Page \d+/(\d+)$", cell.value)
					if match:
						pages = max(pages, int(match.group(1)))
	finally:
		workbook.close()
	return pages


def load_workbook_from_bytes(xlsx_bytes: bytes, read_only: bool = False):
	from openpyxl import load_workbook

	return load_workbook(io.BytesIO(xlsx_bytes), read_only=read_only)
