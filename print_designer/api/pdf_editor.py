"""Whitelisted file I/O for the bundled PDF editor (print_designer/editors/pdf).

The editor runs in a browser iframe, so every byte that in GenOffice crossed
the Electron main process crosses here instead: opening a PDF attached to a
document and saving (overwriting or creating) a File — always permission
checked, always via the File doctype.
"""

import base64

import frappe
from frappe import _
from frappe.utils import cint

PDF_SUFFIX = ".pdf"


def _base64_size(content_base64: str) -> int:
	# 4 base64 chars ≈ 3 bytes; padding tolerance is irrelevant at this scale
	return (len(content_base64) * 3) // 4


@frappe.whitelist(methods=["POST"])
def open_file(file: str) -> dict:
	"""Read a File document (its bytes base64-encoded) for the editor iframe."""
	doc = frappe.get_doc("File", file)
	doc.check_permission("read")

	if doc.is_folder:
		frappe.throw(_("Cannot open a folder in the PDF editor"))
	if doc.file_name and not doc.file_name.lower().endswith(PDF_SUFFIX):
		frappe.throw(_("The PDF editor can only open .pdf files"))

	content = doc.get_content()
	if isinstance(content, str):
		content = content.encode("utf-8")

	return {
		"docname": doc.name,
		"name": doc.file_name or doc.name,
		"contentBase64": base64.b64encode(content).decode("ascii"),
		"attachedToDoctype": doc.attached_to_doctype or None,
		"attachedToName": doc.attached_to_name or None,
		"isPrivate": cint(doc.is_private),
	}


@frappe.whitelist(methods=["POST"])
def save_file(
	file: str | None = None,
	file_name: str | None = None,
	content_base64: str | None = None,
	attached_to_doctype: str | None = None,
	attached_to_name: str | None = None,
	is_private: int | None = None,
) -> dict:
	"""Overwrite an existing File's content, or create a new File.

	With `file`: the File document's write permission gates the overwrite and
	the file name is not changed. Without it: a new File is created (attached
	to `attached_to_doctype`/`attached_to_name` when the caller may write that
	document, otherwise a private file in Home).
	"""
	if not content_base64:
		frappe.throw(_("Missing file content"))
	if not file_name or not file_name.lower().endswith(PDF_SUFFIX):
		frappe.throw(_("The PDF editor only saves .pdf files"))

	content = base64.b64decode(content_base64)

	if file:
		doc = frappe.get_doc("File", file)
		doc.check_permission("write")
		if doc.is_folder:
			frappe.throw(_("Cannot save over a folder"))
		if doc.content_hash:
			# Frappe deduplication can point several File records at one blob on
			# disk; overwriting in place would silently change all of them
			shared = frappe.db.count(
				"File", {"content_hash": doc.content_hash, "name": ["!=", doc.name]}
			)
			if shared:
				frappe.throw(
					_("This file's content is shared with {0} other File record(s); cannot overwrite").format(
						shared
					)
				)
		doc.save_file(content=content, overwrite=True)
		doc.save()
		return {"docname": doc.name, "name": doc.file_name or doc.name}

	attached_to_doctype = (attached_to_doctype or "").strip() or None
	attached_to_name = (attached_to_name or "").strip() or None
	if bool(attached_to_doctype) != bool(attached_to_name):
		frappe.throw(_("attached_to_doctype and attached_to_name must be given together"))
	if attached_to_doctype:
		if not frappe.db.exists("DocType", attached_to_doctype):
			frappe.throw(_("Unknown doctype {0}").format(attached_to_doctype))
		# Attaching output to a document requires editing that document
		if not frappe.has_permission(attached_to_doctype, "write", attached_to_name):
			frappe.throw(_("Not permitted to attach files to this document"), frappe.PermissionError)

	doc = frappe.new_doc("File")
	doc.file_name = file_name
	doc.attached_to_doctype = attached_to_doctype
	doc.attached_to_name = attached_to_name
	doc.is_private = cint(is_private) if is_private is not None else 1
	doc.content = content
	doc.insert()
	return {"docname": doc.name, "name": doc.file_name or doc.name}
