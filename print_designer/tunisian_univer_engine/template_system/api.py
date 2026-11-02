# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Whitelisted endpoints for the Document Template system.

Every function is System Manager only; tokens and file contents never
appear in replies, log titles or messages."""

import frappe
from frappe import _

from print_designer.tunisian_univer_engine.template_system import store, validator
from print_designer.tunisian_univer_engine.template_system.llm_fix import (
	fix_version as _fix_version,
)


def _get_version(template_name: str, version_no: int):
	parent = frappe.get_doc("Document Template", template_name)
	for row in parent.versions:
		if row.version_no == version_no:
			return parent, row
	frappe.throw(_("Version {0} not found on {1}.").format(version_no, template_name))


def _version_files(parent, row) -> dict:
	files = {}
	for name, fieldname in (
		("metadata.py", "metadata_file"),
		("xlsx_creator.py", "xlsx_creator_file"),
		("main.py", "main_file"),
	):
		file_url = row.get(fieldname)
		file_name = frappe.db.get_value("File", {"file_url": file_url}, "name") if file_url else None
		content = frappe.get_doc("File", file_name).get_content() if file_name else ""
		files[name] = content if isinstance(content, str) else content.decode("utf-8", "replace")
	return files


def _sample_data(files: dict) -> dict:
	namespace: dict = {}
	# called only after the static gate passed for these exact files
	exec(compile(files.get("metadata.py") or "", "metadata.py", "exec"), namespace)
	return namespace.get("SAMPLE_DATA") or {}


def _settings_timeout() -> int:
	return int(frappe.db.get_single_value("Document Template Settings", "build_timeout_seconds") or 30)


@frappe.whitelist(methods=["POST"])
def validate_version(template: str, version_no: int) -> dict:
	frappe.only_for("System Manager")
	parent, row = _get_version(template, version_no)
	files = _version_files(parent, row)
	timeout = _settings_timeout()
	result = validator.validate_template(
		files=files,
		timeout=timeout,
		sample_data_fn=lambda: _sample_data(files),
	)
	row.validation_status = "Passed" if result["passed"] else "Failed"
	row.validation_log = "\n".join(result["log"])
	parent.save()
	return result


@frappe.whitelist(methods=["POST"])
def fix_version_with_llm(template: str, version_no: int) -> dict:
	frappe.only_for("System Manager")
	return _fix_version(template_name=template, version_no=version_no)


@frappe.whitelist(methods=["POST"])
def activate_version(template: str, version_no: int) -> dict:
	frappe.only_for("System Manager")
	parent, row = _get_version(template, version_no)
	if row.validation_status != "Passed":
		frappe.throw(_("Only validated (Passed) versions can be activated."))
	target = store.activate_version(template_name=template, version_no=version_no)
	return {"ok": True, "status": "Active", "active_version": version_no, "dir": target}


@frappe.whitelist(methods=["GET"])
def preview_version(template: str, version_no: int) -> dict:
	frappe.only_for("System Manager")
	parent, row = _get_version(template, version_no)
	files = _version_files(parent, row)
	timeout = _settings_timeout()
	cache_path = store.render(
		template_name=template,
		data=_sample_data(files),
		version_no=version_no,
	)
	with open(cache_path, "rb") as handle:
		content = handle.read()
	file_doc = frappe.new_doc("File")
	file_doc.file_name = f"preview-{frappe.scrub(template)}-v{version_no}.xlsx"
	file_doc.is_private = 1
	file_doc.attached_to_doctype = "Document Template"
	file_doc.attached_to_name = template
	file_doc.content = content
	file_doc.insert()
	return {"file_url": file_doc.file_url, "file": file_doc.name}
