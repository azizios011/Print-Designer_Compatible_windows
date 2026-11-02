# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt
# Unit tests for the template validator (frappe-free; run with the bench
# venv python or any interpreter that has openpyxl).

import unittest

from print_designer.tunisian_univer_engine.template_system.contract import validate_layout_rule
from print_designer.tunisian_univer_engine.template_system.validator import (
	validate_files,
	validate_template,
)

GOOD_METADATA = '''DOCUMENT_TYPE = "vente_facture"
DESCRIPTION = "Test template"
SCHEMA = {"client": str, "total": float}
SAMPLE_DATA = {"client": "TEST", "total": 10.5}
'''

GOOD_XLSX_CREATOR = '''import openpyxl


def build(data, output_path, assets):
	workbook = openpyxl.Workbook()
	sheet = workbook.active
	sheet["A1"] = data.get("client", "")
	workbook.save(output_path)
	return output_path
'''

GOOD_MAIN = '''import xlsx_creator


def run(data, output_path, assets):
	return xlsx_creator.build(data, output_path, assets)
'''


def good_files():
	return {
		"metadata.py": GOOD_METADATA,
		"xlsx_creator.py": GOOD_XLSX_CREATOR,
		"main.py": GOOD_MAIN,
	}


class TestStaticValidation(unittest.TestCase):
	def test_good_set_passes(self):
		result = validate_files(good_files())
		self.assertTrue(result["passed"], result["log"])

	def test_missing_function_fails(self):
		files = good_files()
		files["main.py"] = "def other():\n    pass\n"
		result = validate_files(files)
		self.assertFalse(result["passed"])

	def test_forbidden_import_fails(self):
		files = good_files()
		files["main.py"] = (
			"import subprocess\n\n\ndef run(data, output_path, assets):\n    return output_path\n"
		)
		result = validate_files(files)
		self.assertFalse(result["passed"])

	def test_forbidden_eval_fails(self):
		files = good_files()
		files["main.py"] = 'def run(data, output_path, assets):\n    eval("1 + 1")\n    return output_path\n'
		result = validate_files(files)
		self.assertFalse(result["passed"])

	def test_open_outside_output_path_fails(self):
		files = good_files()
		files["main.py"] = (
			'def run(data, output_path, assets):\n'
			'    with open("/etc/passwd") as handle:\n'
			"        handle.read()\n"
			"    return output_path\n"
		)
		result = validate_files(files)
		self.assertFalse(result["passed"])


class TestDynamicValidation(unittest.TestCase):
	def test_runtime_error_fails(self):
		files = good_files()
		files["main.py"] = (
			'def run(data, output_path, assets):\n    raise ValueError("boom")\n    return output_path\n'
		)
		result = validate_template(files, 30, sample_data_fn=lambda: {})
		self.assertFalse(result["passed"])

	def test_timeout_fails(self):
		files = good_files()
		files["main.py"] = (
			"import time\n\n\ndef run(data, output_path, assets):\n    time.sleep(30)\n    return output_path\n"
		)
		result = validate_template(files, 3, sample_data_fn=lambda: {})
		self.assertFalse(result["passed"])

	def test_good_set_passes_dynamically(self):
		result = validate_template(good_files(), 30, sample_data_fn=lambda: {"client": "TEST"})
		self.assertTrue(result["passed"])


class TestLayoutRule(unittest.TestCase):
	def test_vente_requires_default_layout(self):
		with self.assertRaises(ValueError):
			validate_layout_rule("vente", "layout-2")

	def test_vente_default_ok(self):
		validate_layout_rule("vente", "default")

	def test_achat_allows_custom_layouts(self):
		validate_layout_rule("achat", "layout-2")

	def test_unknown_category_rejected(self):
		with self.assertRaises(ValueError):
			validate_layout_rule("inexistant", "default")


if __name__ == "__main__":
	unittest.main()
