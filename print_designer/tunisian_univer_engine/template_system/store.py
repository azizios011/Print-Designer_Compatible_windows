# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Materialize, locate and render Document Template versions.

Version files stay as private attachments on the Document Template record.
On activation the active version's files are materialized under
<site>/private/document_type_system/<category>/<owner_slug>/<layout_id>/v<N>/
so the template code can be imported and executed without touching the app
directory. Rendered workbooks cache under .../document_type_system/_cache/.
"""

import hashlib
import json
import os

import frappe

BASE = "document_type_system"
CACHE_DIR = "_cache"


def _private_path(*parts: str) -> str:
	return frappe.get_site_path("private", *parts)


def _template_row(template_name: str):
	return frappe.db.get_value(
		"Document Template",
		template_name,
		["category", "owner_slug", "layout_id", "status", "active_version"],
		as_dict=True,
	)


def version_dir(template_name: str, version_no: int) -> str:
	row = _template_row(template_name)
	if not row:
		frappe.throw(f"Document Template {template_name} not found.")
	return _private_path(BASE, row.category, row.owner_slug, row.layout_id, f"v{version_no}")


def _file_content(file_url: str) -> bytes:
	file_name = frappe.db.get_value("File", {"file_url": file_url}, "name")
	if not file_name:
		frappe.throw(f"Attached file {file_url} not found.")
	content = frappe.get_doc("File", file_name).get_content()
	if isinstance(content, str):
		content = content.encode("utf-8")
	return content


def _version_row(parent, version_no: int):
	for candidate in parent.versions:
		if candidate.version_no == version_no:
			return candidate
	frappe.throw(f"Version {version_no} not found on {parent.name}.")


def materialize_version(template_name: str, version_no: int) -> str:
	"""Write the version's attached files to the private template directory;
	returns the materialized directory."""
	parent = frappe.get_doc("Document Template", template_name)
	row = _version_row(parent, version_no)
	target = version_dir(template_name, version_no)
	os.makedirs(target, exist_ok=True)
	for fieldname, target_name in (
		("metadata_file", "metadata.py"),
		("xlsx_creator_file", "xlsx_creator.py"),
		("main_file", "main.py"),
	):
		file_url = row.get(fieldname)
		if not file_url:
			frappe.throw(f"{fieldname} is empty on {template_name} v{version_no}.")
		with open(os.path.join(target, target_name), "wb") as handle:
			handle.write(_file_content(file_url))
	if row.logo:
		ext = (row.logo.rsplit(".", 1)[-1] or "png").lower()
		with open(os.path.join(target, f"logo.{ext}"), "wb") as handle:
			handle.write(_file_content(row.logo))
	return target


def get_template(category: str, owner_doctype: str, owner: str, layout_id: str | None = None):
	"""Return the active version of the matching template.

	vente templates always resolve to the "default" layout. achat/bank owners
	may hold several layouts: without a layout_id every active layout of the
	owner is returned (a list); with one, a single dict or None."""
	filters = {
		"category": category,
		"owner_doctype": owner_doctype,
		"owner": owner,
		"status": "Active",
	}
	if layout_id or category == "vente":
		filters["layout_id"] = layout_id or "default"
	names = frappe.get_all("Document Template", filters=filters, pluck="name", order_by="modified desc")
	results = []
	for name in names:
		active_version = frappe.db.get_value("Document Template", name, "active_version")
		if not active_version:
			continue
		results.append({
			"template": name,
			"version": active_version,
			"dir": version_dir(name, active_version),
		})
	if layout_id or category == "vente":
		return results[0] if results else None
	return results


def activate_version(template_name: str, version_no: int) -> str:
	"""Materialize the version and mark the template Active on it."""
	parent = frappe.get_doc("Document Template", template_name)
	_version_row(parent, version_no)
	target = materialize_version(template_name, version_no)
	frappe.db.set_value(
		"Document Template",
		template_name,
		{"status": "Active", "active_version": version_no},
	)
	return target


def render(template_name: str, data: dict, version_no: int | None = None) -> str:
	"""Render the template's xlsx_creator for data, cached by
	sha256(json(data) + version); returns the absolute cached file path."""
	parent = frappe.get_doc("Document Template", template_name)
	version_no = version_no or parent.active_version
	if not version_no:
		frappe.throw(f"{template_name} has no active version to render.")
	version_dir_path = version_dir(template_name, version_no)
	if not os.path.isdir(version_dir_path):
		materialize_version(template_name, version_no)

	cache_key = hashlib.sha256(
		json.dumps(data, sort_keys=True, default=str).encode("utf-8") + str(version_no).encode("utf-8")
	).hexdigest()
	cache_path = _private_path(BASE, CACHE_DIR, f"{cache_key}.xlsx")
	os.makedirs(os.path.dirname(cache_path), exist_ok=True)
	if os.path.exists(cache_path):
		return cache_path

	logo_path = None
	for entry in os.listdir(version_dir_path):
		if entry.startswith("logo."):
			logo_path = os.path.join(version_dir_path, entry)
			break

	# imported here to keep this module importable without the validator's
	# subprocess machinery during frappe boot
	from print_designer.tunisian_univer_engine.template_system.validator import run_template_process

	timeout = int(frappe.db.get_single_value("Document Template Settings", "build_timeout_seconds") or 30)
	run_template_process(
		template_dir=version_dir_path,
		entry="xlsx_creator",
		output_path=cache_path,
		data=data,
		assets={"logo": logo_path},
		timeout=timeout,
	)
	if not os.path.exists(cache_path):
		frappe.throw(f"The template did not produce {cache_path}.")
	return cache_path
