# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
import requests
from frappe.model.document import Document


class UniverExtractionSettings(Document):
	pass


@frappe.whitelist()
def get_available_models(provider: str = "", api_key: str = "") -> list:
	if not provider or not api_key:
		settings = frappe.get_single("Univer Extraction Settings")
		provider = provider or settings.provider or ""
		api_key = api_key or settings.get_password("api_key") or ""

	if not api_key:
		frappe.throw("Please enter an API key first.")

	try:
		if provider == "Anthropic":
			response = requests.get(
				"https://api.anthropic.com/v1/models",
				headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
				timeout=15,
			)
		elif provider == "OpenRouter":
			response = requests.get(
				"https://openrouter.ai/api/v1/models",
				headers={"Authorization": f"Bearer {api_key}"},
				timeout=15,
			)
		else:
			frappe.throw(f"Unknown provider: {provider}")

		if not response.ok:
			frappe.throw(
				f"Provider returned HTTP {response.status_code}: {response.text[:300]}"
			)

		data = response.json()
		return [m["id"] for m in data.get("data", [])]

	except requests.exceptions.RequestException as e:
		frappe.throw(f"Network error while contacting {provider}: {e}")
