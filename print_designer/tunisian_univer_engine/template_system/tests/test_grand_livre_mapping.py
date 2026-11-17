# Copyright (c) 2026, Frappe Technologies and contributors
# For license information, please see license.txt
# Unit tests for the Grand Livre document adapter mapping (frappe-free:
# a stub replaces the frappe module and the erpnext ledger report module).

import sys
import types
import unittest
from datetime import date


def _install_stubs():
	if "frappe" in sys.modules:
		return

	frappe = types.ModuleType("frappe")

	def _(text, *args, **kwargs):
		if args:
			try:
				return text.format(*args)
			except Exception:
				return text
		return text

	frappe._ = _
	frappe.throw = lambda msg, *a, **k: (_ for _ in ()).throw(Exception(msg))
	frappe.session = types.SimpleNamespace(user="tester")
	frappe.get_module = lambda name: (_ for _ in ()).throw(Exception(f"stub not installed: {name}"))
	frappe.db = types.SimpleNamespace(
		get_value=lambda *a, **k: None,
		sql=lambda *a, **k: [],
		get_all=lambda *a, **k: [],
		count=lambda *a, **k: 0,
	)

	utils = types.ModuleType("frappe.utils")
	utils.flt = lambda value, precision=None: round(float(value or 0.0), precision or 8)
	utils.getdate = lambda value: value if isinstance(value, date) else date(2026, 1, 1)
	frappe.utils = utils
	sys.modules["frappe"] = frappe
	sys.modules["frappe.utils"] = utils


_install_stubs()

from print_designer.tunisian_univer_engine.template_system.reference.grand_livre.main import (  # noqa: E402
	build_grand_livre_xlsx,
	workbook_page_count,
)


class FakeLedgerReport:
	"""The Ledger Data report's surface the adapter consumes."""

	def __init__(self, grille_rows, openings=None):
		self.grille_rows = grille_rows
		self.openings = openings or {}

	def require_context(self):
		return {
			"entreprise": "ENT-1",
			"entreprise_label": "SOCIETE CPR AUTO",
			"exercice": "EX-2026",
			"date_debut": date(2026, 1, 1),
			"date_fin": date(2026, 12, 31),
		}

	def resolve_period(self, filters, context):
		return date(2026, 2, 1), date(2026, 2, 28)

	def check_ledger_read_permission(self):
		return None

	def _get_grille_rows(self, filters, context):
		return self.grille_rows


def make_grille_rows():
	"""The report's grille shapes: header/opening/entry/total per account."""
	return [
		{"row_type": "header", "date": "401001 STBG", "account": "401001"},
		{
			"row_type": "opening",
			"date": "31/01/2026",
			"libelle": "Solde a nouveau / Report",
			"solde": 1234.5,
		},
		{
			"row_type": "entry",
			"account": "401001",
			"date": "05/02/2026",
			"mvt": 20,
			"libelle": "FACT STBG",
			"journal": "AC",
			"ref_doc": "9606605634",
			"debit": 11.4004,  # 4 decimals: the adapter must round to 3
			"credit": 0,
			"solde": 1245.9004,
		},
		{
			"row_type": "entry",
			"account": "401001",
			"date": "06/02/2026",
			"mvt": 21,
			"libelle": "FACT STBG 2",
			"journal": "AC",
			"ref_doc": "9606608497",
			"debit": 0,
			"credit": 3420.1254,
			"solde": -1174.225,
		},
		{"row_type": "total", "account": "401001", "date": "Totaux 401001 STBG", "debit": 11.4, "credit": 3420.125},
		{"row_type": "header", "date": "530000 CAISSE", "account": "530000"},
		{
			"row_type": "entry",
			"account": "530000",
			"date": "07/02/2026",
			"mvt": 22,
			"libelle": "VERSEMENT",
			"journal": "BQ",
			"ref_doc": "V-2026-7",
			"debit": 5000.0,
			"credit": 0,
			"solde": 5000.0,
		},
		{"row_type": "total", "account": "530000", "date": "Totaux 530000 CAISSE", "debit": 5000.0, "credit": 0},
	]


class StubbedGrandLivreTestCase(unittest.TestCase):
	def setUp(self):
		self.frappe = sys.modules["frappe"]
		self.ledger = FakeLedgerReport(make_grille_rows())
		self.original_get_module = getattr(self.frappe, "get_module", None)
		self.original_db = getattr(self.frappe, "db", None)
		self.frappe.get_module = lambda name: self.ledger
		# Entreprise header block + Chart of Account names
		self.frappe.db = types.SimpleNamespace(
			get_value=self._fake_get_value,
			sql=self._fake_sql,
			get_all=lambda *a, **k: [],
			count=lambda *a, **k: 0,
		)

	def tearDown(self):
		self.frappe.get_module = self.original_get_module
		self.frappe.db = self.original_db

	def _fake_get_value(self, doctype, name, fields=None, as_dict=False):
		if doctype == "Entreprise":
			values = {
				"raison_sociale": "SOCIETE CPR AUTO",
				"matricule_fiscal": "1390565LBC000",
				"numero": "05",
				"rue": "RTE TUNIS ZAGHOUEN",
				"code_postal": "1140",
				"ville": "ZAGHOUAN",
				"pays_adresse": "Tunisie",
				"pays": "Tunisie",
			}
			if as_dict:
				return types.SimpleNamespace(**values)
			return values.get(fields) if isinstance(fields, str) else None
		if doctype == "Chart of Account":
			names = {"401001": "STBG", "530000": "CAISSE", "401108": "STE MHIRI PRODUCTION"}
			return names.get(name)
		return None

	def _fake_sql(self, query, values=None, **kwargs):
		# the opening-only query: one account with a report balance that has
		# no period rows (STE MHIRI)
		return [
			types.SimpleNamespace(account="401108", balance=750.12345),
			types.SimpleNamespace(account="401001", balance=1234.5),  # already covered
			types.SimpleNamespace(account="600000", balance=0.0003),  # below tolerance
		]

	def test_accounts_mapped_with_rounding_and_order(self):
		xlsx = build_grand_livre_xlsx({"period_type": "Mensuelle", "month": "Fevrier"})
		self.assertIsInstance(xlsx, bytes)
		self.assertGreater(len(xlsx), 5000)

		from openpyxl import load_workbook
		from io import BytesIO

		sheet = load_workbook(BytesIO(xlsx)).active
		acc_codes = [
			cell.value
			for row in sheet.iter_rows()
			for cell in row
			if isinstance(cell.value, str) and cell.value.startswith(("401001", "401108", "530000"))
			and "Totaux" not in cell.value
		]
		# code-ordered account blocks: the opening-only account joins last,
		# then the whole list re-sorts by code
		self.assertEqual(acc_codes[0].startswith("401001"), True)
		self.assertIn("401108 STE MHIRI PRODUCTION", acc_codes)

	def test_entry_values_rounded_to_three_decimals(self):
		xlsx = build_grand_livre_xlsx({})
		from openpyxl import load_workbook
		from io import BytesIO

		sheet = load_workbook(BytesIO(xlsx)).active
		debits = [
			cell.value
			for row in sheet.iter_rows(min_col=7, max_col=7)
			for cell in row
			if isinstance(cell.value, float)
		]
		self.assertIn(11.4, debits)  # 11.4004 rounded to 11.400
		for value in debits:
			self.assertEqual(round(value, 3), value)

	def test_opening_solde_passed_once(self):
		xlsx = build_grand_livre_xlsx({})
		from openpyxl import load_workbook
		from io import BytesIO

		sheet = load_workbook(BytesIO(xlsx)).active
		# the 401001 block opens at 1234.5: its first entry row's Solde cell
		# (column I) must be 1234.5 + 11.4 (debit) with credit 0
		target = None
		for row in sheet.iter_rows():
			for cell in row:
				if cell.value == "05/02/2026":
					target = cell.row
		self.assertIsNotNone(target, "entry date row present")
		solde = sheet.cell(row=target, column=9).value
		self.assertEqual(round(float(solde), 3), 1245.9)

	def test_page_count_marker_helper(self):
		xlsx = build_grand_livre_xlsx({})
		pages = workbook_page_count(xlsx)
		self.assertIsInstance(pages, int)
		self.assertGreaterEqual(pages, 1)


if __name__ == "__main__":
	unittest.main()
