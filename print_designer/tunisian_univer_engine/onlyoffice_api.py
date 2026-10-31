# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import requests
import urllib3

import frappe
from frappe import _


def _quiet_tls() -> None:
	"""The dev Document Server answers over a self-signed certificate."""
	urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@frappe.whitelist()
def check_connection() -> dict:
	"""Ping the Document Server healthcheck endpoint.

	Returns {"ok": bool, "detail": str}. The JWT secret is never read,
	returned or logged by this function.
	"""
	frappe.only_for("System Manager")
	settings = frappe.get_single("OnlyOffice Settings")
	internal_url = (settings.internal_url or "").rstrip("/")
	if not internal_url:
		return {"ok": False, "detail": _("Internal URL is not set.")}

	_quiet_tls()
	try:
		response = requests.get(f"{internal_url}/healthcheck", timeout=5, verify=False)
	except requests.exceptions.RequestException as error:
		return {"ok": False, "detail": _("Document Server did not answer: {0}").format(str(error)[:200])}

	body = (response.text or "").strip()
	if response.status_code == 200 and body == "true":
		return {"ok": True, "detail": _("Document Server answered at {0}").format(internal_url)}
	return {
		"ok": False,
		"detail": _("Unexpected answer from {0} (HTTP {1}): {2}").format(
			internal_url, response.status_code, body[:120]
		),
	}
