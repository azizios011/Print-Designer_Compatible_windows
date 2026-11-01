# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import datetime
import hashlib
import re
from urllib.parse import urlsplit

import frappe
import jwt
from frappe import _

# OnlyOffice Settings field meanings:
#   internal_url        = how Frappe reaches the Document Server (e.g. http://onlyoffice)
#   frappe_internal_url = how the Document Server reaches Frappe (e.g. http://frappe-dev-default:8000)
#   public_url          = how the BROWSER reaches the Document Server (e.g. http://localhost)

FILE_TYPES = {
	"docx": ("word", True),
	"xlsx": ("cell", True),
	"pptx": ("slide", True),
	"pdf": ("pdf", True),
	"doc": ("word", False),
	"odt": ("word", False),
	"rtf": ("word", False),
	"txt": ("word", False),
	"xls": ("cell", False),
	"ods": ("cell", False),
	"csv": ("cell", False),
	"ppt": ("slide", False),
	"odp": ("slide", False),
}


def get_settings():
	settings = frappe.get_single("OnlyOffice Settings")
	jwt_secret = settings.get_password("jwt_secret", raise_exception=False)
	if not settings.enabled or not jwt_secret:
		frappe.throw(
			_("OnlyOffice is not enabled or the JWT secret is missing. Set it up in OnlyOffice Settings."),
			frappe.ValidationError,
		)
	return settings


def secret() -> str:
	return get_settings().get_password("jwt_secret")


def sign(payload: dict, ttl: int | None = None) -> str:
	claims = dict(payload or {})
	if ttl:
		claims["exp"] = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=ttl)
	return jwt.encode(claims, secret(), algorithm="HS256")


def verify(token: str) -> dict:
	try:
		return jwt.decode(token or "", secret(), algorithms=["HS256"])
	except jwt.PyJWTError as error:
		frappe.throw(_("Invalid or expired OnlyOffice token."), frappe.PermissionError)


def document_key(file_doc) -> str:
	raw = f"{file_doc.modified}-{file_doc.content_hash or ''}-{file_doc.file_size or 0}"
	digest = hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]
	key = f"{file_doc.name}-{digest}"
	key = re.sub(r"[^0-9A-Za-z._=-]", "_", key)
	return key[:120]


def internalize(url: str) -> str:
	parts = urlsplit(url or "")
	if not parts.path.startswith("/"):
		frappe.throw(_("Unexpected Document Server URL."), frappe.ValidationError)
	settings = get_settings()
	query = f"?{parts.query}" if parts.query else ""
	return f"{settings.internal_url.rstrip('/')}{parts.path}{query}"
