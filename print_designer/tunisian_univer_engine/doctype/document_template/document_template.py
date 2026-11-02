# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document

from print_designer.tunisian_univer_engine.template_system.contract import (
	slugify,
	validate_layout_rule,
)

_SLUG_PATTERN = re.compile(r"^[0-9A-Za-z_-]+$")
_CATEGORIES = ("vente", "achat", "bank", "other")


class DocumentTemplate(Document):
	def validate(self) -> None:
		if self.category not in _CATEGORIES:
			frappe.throw(_("Unknown category: {0}").format(self.category))
		if not self.owner:
			frappe.throw(_("Owner is required."))
		self.owner_slug = slugify(self.owner)
		if not _SLUG_PATTERN.match(self.owner_slug):
			frappe.throw(_("Owner produces an invalid slug: {0}").format(self.owner_slug))
		if not self.layout_id:
			self.layout_id = "default"
		self.layout_id = slugify(self.layout_id)
		if not _SLUG_PATTERN.match(self.layout_id):
			frappe.throw(_("Layout ID produces an invalid slug: {0}").format(self.layout_id))
		validate_layout_rule(self.category, self.layout_id)
		duplicate = frappe.db.exists(
			"Document Template",
			{
				"category": self.category,
				"owner_doctype": self.owner_doctype,
				"owner": self.owner,
				"layout_id": self.layout_id,
				"name": ("!=", self.name),
			},
		)
		if duplicate:
			frappe.throw(
				_("A template for this category, owner and layout already exists: {0}").format(duplicate)
			)
		for index, row in enumerate(self.versions, 1):
			row.version_no = index
		if self.status == "Active" and not self.active_version:
			frappe.throw(_("Activate a Passed version before setting the status to Active."))
