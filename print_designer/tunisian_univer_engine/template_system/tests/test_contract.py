# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt
# Unit tests for the Document Template contract rules (frappe-free).

import unittest

from print_designer.tunisian_univer_engine.template_system.contract import (
	slugify,
	validate_layout_rule,
)


class TestSlugify(unittest.TestCase):
	def test_basic(self):
		self.assertEqual(slugify("Customer: TEST_co"), "customer-test-co")

	def test_strips_dashes(self):
		self.assertEqual(slugify("--hello world--"), "hello-world")

	def test_ascii_only(self):
		self.assertEqual(slugify("Café Ünïcode"), "caf-unicode")


class TestLayoutRule(unittest.TestCase):
	def test_vente_requires_default_layout(self):
		with self.assertRaises(ValueError):
			validate_layout_rule("vente", "layout-2")

	def test_vente_default_ok(self):
		validate_layout_rule("vente", "default")

	def test_achat_allows_custom_layouts(self):
		validate_layout_rule("achat", "layout-2")

	def test_bank_allows_custom_layouts(self):
		validate_layout_rule("bank", "layout-b")

	def test_unknown_category_rejected(self):
		with self.assertRaises(ValueError):
			validate_layout_rule("inexistant", "default")


if __name__ == "__main__":
	unittest.main()
