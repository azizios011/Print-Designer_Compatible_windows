# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from urllib.parse import urlencode

import requests

import frappe
from frappe import _
from print_designer.tunisian_univer_engine.onlyoffice_core import (
	FILE_TYPES,
	document_key,
	get_settings,
	internalize,
	sign,
	verify,
)

MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024


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

	try:
		response = requests.get(f"{internal_url}/healthcheck", timeout=5)
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


@frappe.whitelist(methods=["GET"])
def get_editor_config(file: str, mode: str = "edit") -> dict:
	file_doc = frappe.get_doc("File", file)
	file_doc.check_permission("read")
	ext = (file_doc.file_name or "").rsplit(".", 1)[-1].lower()
	if ext not in FILE_TYPES:
		frappe.throw(_("Unsupported file type."))
	document_type, can_edit = FILE_TYPES[ext]
	settings = get_settings()
	mode = "edit" if (mode == "edit" and can_edit and file_doc.has_permission("write")) else "view"

	# download_url and callbackUrl are fetched by the DOCUMENT SERVER, so they
	# must point at Frappe via frappe_internal_url (internal_url would make the
	# Document Server call itself). The token travels as oo_token: Frappe's
	# request handling strips a form_dict "token" before dispatch.
	frappe_internal_url = (settings.frappe_internal_url or "").rstrip("/")
	if not frappe_internal_url:
		frappe.throw(
			_("Frappe Internal URL is empty. Set it in OnlyOffice Settings: it is how the Document Server reaches Frappe.")
		)
	api_base = "{0}/api/method/print_designer.tunisian_univer_engine.onlyoffice_api".format(frappe_internal_url)
	download_url = "{0}.download?{1}".format(
		api_base,
		urlencode({"file": file, "oo_token": sign({"purpose": "oo-download", "file": file}, ttl=1800)}),
	)

	editor_config = {
		"mode": mode,
		"lang": frappe.local.lang or "en",
		"user": {"id": frappe.session.user, "name": frappe.utils.get_fullname(frappe.session.user)},
		"customization": {"forcesave": True},
	}
	if mode == "edit":
		editor_config["callbackUrl"] = "{0}.save_callback?{1}".format(
			api_base,
			urlencode(
				{
					"file": file,
					"oo_token": sign(
						{"purpose": "oo-save", "file": file, "user": frappe.session.user}, ttl=86400
					),
				}
			),
		)

	config = {
		"documentType": document_type,
		"type": "desktop",
		"document": {
			"fileType": ext,
			"title": file_doc.file_name,
			"key": document_key(file_doc),
			"url": download_url,
			"permissions": {"edit": mode == "edit", "download": True, "print": True},
		},
		"editorConfig": editor_config,
	}
	config["token"] = sign(config)
	return {
		"config": config,
		"api_js_url": "{0}/web-apps/apps/api/documents/api.js".format((settings.public_url or "").rstrip("/")),
		"mode": mode,
	}


@frappe.whitelist(allow_guest=True, methods=["GET"])
def download(file: str, oo_token: str) -> None:
	payload = verify(oo_token)
	if payload.get("purpose") != "oo-download" or payload.get("file") != file:
		frappe.throw(_("Invalid download token."), frappe.PermissionError)
	file_doc = frappe.get_doc("File", file)
	file_doc.flags.ignore_permissions = True
	frappe.local.response["type"] = "download"
	frappe.local.response["filename"] = file_doc.file_name
	frappe.local.response["filecontent"] = file_doc.get_content()


@frappe.whitelist(allow_guest=True, methods=["POST"])
def save_callback() -> dict:
	"""Document Server save callback.

	The Document Server posts JSON; frappe v17 maps form_dict to the JSON
	body only, so the file name and the outer callback token travel in the
	QUERY STRING and are read from the request args here. The Document
	Server's own JWT arrives inside the JSON body as "token".
	"""
	file = frappe.request.args.get("file")
	oo_token = frappe.request.args.get("oo_token")
	payload = verify(oo_token)
	if payload.get("purpose") != "oo-save" or payload.get("file") != file:
		frappe.throw(_("Invalid callback token."), frappe.PermissionError)

	status = None
	try:
		body = frappe.request.get_json(silent=True) or {}
		callback_token = body.get("token")
		if not callback_token:
			header = frappe.get_request_header("Authorization") or ""
			if header.startswith("Bearer "):
				callback_token = header[len("Bearer ") :].strip()
		if not callback_token:
			return {"error": 1}
		try:
			claims = verify(callback_token)
		except frappe.PermissionError:
			return {"error": 1}
		data = claims.get("payload", claims)
		status = data.get("status")
		if status in (2, 6):
			_overwrite_file_from_document_server(file, str(data.get("url") or ""), user=payload.get("user"))
			return {"error": 0}
		if status in (1, 3, 4, 7):
			return {"error": 0}
		return {"error": 1}
	except Exception as error:
		frappe.log_error(
			title=_("OnlyOffice save callback failed"),
			message=_("file={0} status={1} error={2}").format(file, status, type(error).__name__),
		)
		return {"error": 1}


def _overwrite_file_from_document_server(file: str, url: str, user: str) -> None:
	if not url:
		frappe.throw(_("Document Server returned no file URL."))
	local_url = internalize(url)
	response = requests.get(local_url, timeout=30, stream=True)
	response.raise_for_status()
	chunks = []
	total = 0
	for chunk in response.iter_content(chunk_size=1024 * 1024):
		total += len(chunk)
		if total > MAX_DOWNLOAD_SIZE:
			frappe.throw(_("File exceeds the 100 MB limit."))
		chunks.append(chunk)
	content = b"".join(chunks)

	file_doc = frappe.get_doc("File", file)
	if file_doc.is_remote_file:
		frappe.throw(_("Remote files cannot be overwritten."))
	file_doc.flags.ignore_permissions = True
	file_doc.flags.skip_file_size_check = True
	file_doc.save_file(content=content, overwrite=True, ignore_existing_file_check=True)
	file_doc.save()
	file_doc.db_set("modified_by", user, update_modified=False)
