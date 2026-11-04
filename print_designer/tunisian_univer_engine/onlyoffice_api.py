# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import os
import re
from urllib.parse import urlencode, urlsplit

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
from print_designer.tunisian_univer_engine.templates.registry import (
	build as build_template,
	get_templates as get_registry_templates,
)

MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024


def _reply(code: int) -> None:
	"""Answer the Document Server with exactly {"error": code} at the top level."""
	frappe.local.response["error"] = code


def _strip_query_strings(text: str) -> str:
	"""Remove every URL query string (?...) from text before logging it."""
	return re.sub(r"\?\S+", "", text or "")


def _prepare_log_dirs() -> None:
	"""frappe's logger writes to ../logs (bench level) and <site>/logs (site
	level) relative to the working directory; create both so
	RotatingFileHandler cannot fail inside the callback."""
	os.makedirs(os.path.abspath(os.path.join(os.getcwd(), "..", "logs")), exist_ok=True)
	os.makedirs(os.path.join(os.getcwd(), "dev.local", "logs"), exist_ok=True)


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
def get_editor_config(file: str, mode: str = "edit", preview: int = 0) -> dict:
	file_doc = frappe.get_doc("File", file)
	file_doc.check_permission("read")
	ext = (file_doc.file_name or "").rsplit(".", 1)[-1].lower()
	if ext not in FILE_TYPES:
		frappe.throw(_("Unsupported file type."))
	document_type, can_edit = FILE_TYPES[ext]
	settings = get_settings()
	if preview:
		# the attachment preview panel is strictly read-only: no callbackUrl
		mode = "view"
	else:
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
	if preview:
		# compact read-only viewer chrome for the preview panel; unknown keys
		# are ignored by the Document Server, and forcesave stays out
		editor_config["customization"] = {
			"compactHeader": True,
			"compactToolbar": True,
			"hideRightMenu": True,
			"toolbarHideFileName": True,
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

	permissions = {"edit": mode == "edit", "download": True, "print": True}
	if preview:
		permissions = {"edit": False, "comment": False, "download": True, "print": True}

	config = {
		"documentType": document_type,
		"type": "desktop",
		"document": {
			"fileType": ext,
			"title": file_doc.file_name,
			"key": document_key(file_doc),
			"url": download_url,
			"permissions": permissions,
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
def save_callback() -> None:
	"""Document Server save callback.

	Replies with exactly {"error": 0|1} at the top level of the response
	(frappe.local.response), with no frappe "message" wrapper. The Document
	Server posts JSON; frappe maps form_dict to the JSON body only, so the
	file name and the outer callback token travel in the QUERY STRING and
	are read from the request args here. The Document Server's own JWT
	arrives inside the JSON body as "token".
	"""
	_prepare_log_dirs()
	log = frappe.logger("onlyoffice", allow_site=True, file_count=5)
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
			log.error("callback file=%s: no Document Server token in body or header", file)
			_reply(1)
			return
		try:
			claims = verify(callback_token)
		except frappe.PermissionError:
			log.error("callback file=%s: invalid Document Server token", file)
			_reply(1)
			return
		data = claims.get("payload", claims)
		status = data.get("status")
		log.info("callback file=%s status=%s", file, status)
		if status in (2, 6):
			url = str(data.get("url") or "")
			if not url:
				log.error("callback file=%s status=%s: no url in Document Server payload", file, status)
				_reply(1)
				return
			log.info("download url path=%s", urlsplit(url).path)
			content, download_status = _download_from_document_server(url)
			log.info("download status=%s bytes=%s", download_status, len(content))
			_overwrite_file(file=file, content=content, user=payload.get("user"))
			log.info("save ok file=%s bytes=%s", file, len(content))
			_reply(0)
			return
		if status in (1, 3, 4, 7):
			_reply(0)
			return
		log.error("callback file=%s: unknown status=%s", file, status)
		_reply(1)
		return
	except Exception as error:
		detail = _strip_query_strings(
			"{0}: {1}".format(type(error).__name__, str(error))
			+ " | traceback: "
			+ frappe.get_traceback(with_context=False)[:4000]
		)
		log.error("callback file=%s status=%s %s", file, status, detail)
		frappe.log_error(title=_("OnlyOffice save callback failed"), message=detail)
		_reply(1)
		return


def _download_from_document_server(url: str) -> tuple[bytes, int]:
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
	return b"".join(chunks), response.status_code


def _overwrite_file(file: str, content: bytes, user: str) -> None:
	file_doc = frappe.get_doc("File", file)
	if file_doc.is_remote_file:
		frappe.throw(_("Remote files cannot be overwritten."))
	file_doc.flags.ignore_permissions = True
	file_doc.flags.skip_file_size_check = True
	file_doc.save_file(content=content, overwrite=True, ignore_existing_file_check=True)
	file_doc.save()
	file_doc.db_set("modified_by", user, update_modified=False)


@frappe.whitelist(methods=["GET"])
def get_templates(doctype: str, document_format: str) -> list:
	return get_registry_templates(doctype, document_format)


@frappe.whitelist(methods=["POST"])
def create_print_format(
	doctype: str, print_format_name: str, document_format: str, template_id: str
) -> dict:
	frappe.has_permission("Print Format", "create", throw=True)
	if document_format not in ("xlsx", "docx"):
		frappe.throw(_("Document Format must be xlsx or docx."))
	if not frappe.db.exists("DocType", doctype):
		frappe.throw(_("DocType {0} does not exist.").format(doctype))
	if frappe.db.exists("Print Format", print_format_name):
		frappe.throw(_("Print Format {0} already exists.").format(print_format_name))

	ext, content = build_template(template_id)

	format_doc = frappe.new_doc("Print Format")
	format_doc.doc_type = doctype
	format_doc.name = print_format_name
	format_doc.standard = "No"
	format_doc.custom_format = 1
	format_doc.html = "<!-- Designed in the OnlyOffice Document Workspace -->"
	format_doc.onlyoffice_format = document_format
	format_doc.insert()

	file_doc = frappe.new_doc("File")
	file_doc.file_name = f"{print_format_name}.{ext}"
	file_doc.is_private = 1
	file_doc.attached_to_doctype = "Print Format"
	file_doc.attached_to_name = format_doc.name
	file_doc.content = content
	file_doc.insert()

	format_doc.db_set("onlyoffice_template", file_doc.name)
	return {"print_format": format_doc.name, "file": file_doc.name}


@frappe.whitelist(methods=["GET"])
def get_print_format_info(print_format: str) -> dict:
	frappe.has_permission("Print Format", "read", doc=print_format, throw=True)
	row = frappe.db.get_value(
		"Print Format",
		print_format,
		["doc_type", "onlyoffice_format", "onlyoffice_template"],
		as_dict=True,
	)
	if not row or not row.onlyoffice_format:
		return {}
	return {
		"doc_type": row.doc_type,
		"document_format": row.onlyoffice_format,
		"template_file": row.onlyoffice_template,
	}


@frappe.whitelist(methods=["GET"])
def list_print_formats(doctype: str) -> list:
	names = frappe.get_all(
		"Print Format",
		filters={"doc_type": doctype, "onlyoffice_format": ("is", "set")},
		order_by="creation desc",
		pluck="name",
	)
	return [name for name in names if frappe.has_permission("Print Format", "read", doc=name)]
