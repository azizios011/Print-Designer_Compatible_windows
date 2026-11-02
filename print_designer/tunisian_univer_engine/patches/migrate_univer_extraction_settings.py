import frappe
from frappe.utils.password import get_decrypted_password


def execute():
	"""Copy Univer Extraction Settings data into AI Settings (idempotent), then
	drop the old single when the framework allows it."""
	if not frappe.db.exists("DocType", "AI Settings"):
		# the Axeane Settings module lives in the frappe fork and may not have
		# synced yet on the first migrate (stale app_modules cache)
		from frappe.model.sync import sync_for

		sync_for("frappe", force=True)
	if not frappe.db.exists("DocType", "AI Settings"):
		frappe.log_error(
			title="Univer Extraction Settings migration skipped",
			message="AI Settings doctype not found; run bench migrate again after the module cache clears.",
		)
		return
	old = frappe.db.get_singles_dict("Univer Extraction Settings") or {}
	if not old:
		return

	ai = frappe.get_doc("AI Settings", "AI Settings")
	if ai.get_password("api_key", raise_exception=False):
		return  # already migrated

	ai.provider = old.get("provider") or ai.provider
	ai.model = old.get("model") or ai.model
	api_key = get_decrypted_password(
		"Univer Extraction Settings", "Univer Extraction Settings", "api_key", raise_exception=False
	) or ""
	if api_key:
		ai.api_key = api_key
	ai.save(ignore_permissions=True)

	try:
		frappe.delete_doc("DocType", "Univer Extraction Settings", force=1, ignore_missing=True)
	except Exception:
		frappe.log_error(title="Univer Extraction Settings cleanup failed", message=frappe.get_traceback())
