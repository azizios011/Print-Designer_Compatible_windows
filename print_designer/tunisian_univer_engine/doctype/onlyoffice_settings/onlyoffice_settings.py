# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class OnlyOfficeSettings(Document):
	def validate(self) -> None:
		for fieldname in ("public_url", "internal_url", "frappe_internal_url"):
			url = (getattr(self, fieldname) or "").strip()
			if not url:
				continue
			url = url.rstrip("/")
			if not (url.startswith("http://") or url.startswith("https://")):
				label = self.meta.get_label(fieldname)
				frappe.throw(_("{0} must start with http:// or https://").format(label))
			setattr(self, fieldname, url)
		if self.enabled and not self.get_password("jwt_secret", raise_exception=False):
			frappe.throw(_("JWT Secret is required when OnlyOffice is enabled."))
