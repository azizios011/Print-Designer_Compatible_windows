# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""LLM-based repair for failed Document Template versions.

Triggered by the admin "Fix with AI" button on a Failed version, only when
fixing is enabled and the attempt budget allows it. The helper never writes
templates from scratch, never sees real client data and never auto-activates
a version."""

import difflib
import json
import re

import frappe
import requests
from frappe import _

from print_designer.tunisian_univer_engine.template_system.contract import (
	CONTRACT_TEXT,
	FILE_FIELD_MAP,
	KNOWN_FILES,
)

SYSTEM_PROMPT = (
	"You correct existing Python template files so they satisfy the given "
	"contract and fix the reported error. Make the smallest change necessary. "
	"Do not redesign the layout or add features. Return the complete corrected "
	'file(s) as JSON: {"files": {"<name>.py": "<content>"}}'
)


def _ai_settings() -> tuple[str, str, str]:
	settings = frappe.get_single("AI Settings")
	api_key = settings.get_password("api_key", raise_exception=False)
	if not api_key:
		frappe.throw(_("An API key is required to run the LLM fixer."))
	return settings.provider or "", api_key, settings.model or ""


def _call_text(provider: str, api_key: str, model: str, system: str, user: str) -> str:
	if provider == "Anthropic":
		response = requests.post(
			"https://api.anthropic.com/v1/messages",
			headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
			json={
				"model": model,
				"max_tokens": 8000,
				"system": system,
				"messages": [{"role": "user", "content": user}],
			},
			timeout=120,
		)
		response.raise_for_status()
		blocks = response.json().get("content", [])
		return "".join(block.get("text", "") for block in blocks if block.get("type") == "text")
	if provider == "OpenRouter":
		response = requests.post(
			"https://openrouter.ai/api/v1/chat/completions",
			headers={"Authorization": f"Bearer {api_key}"},
			json={
				"model": model,
				"messages": [
					{"role": "system", "content": system},
					{"role": "user", "content": user},
				],
			},
			timeout=120,
		)
		response.raise_for_status()
		return response.json()["choices"][0]["message"]["content"]
	frappe.throw(_("Unsupported provider: {0}").format(provider))


def _parse_files(raw: str) -> dict:
	import ast

	cleaned = (raw or "").strip()
	if cleaned.startswith("```"):
		cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
		cleaned = re.sub(r"\s*```$", "", cleaned)
	files = json.loads(cleaned).get("files", {})
	result = {}
	for name, content in files.items():
		if name in KNOWN_FILES and isinstance(content, str):
			ast.parse(content)  # only syntactically valid files are accepted
			result[name] = content
	return result


def _strip_queries(text: str) -> str:
	return re.sub(r"\?\S+", "", text or "")


def _version_files(parent, row) -> dict:
	files = {}
	for name, fieldname in FILE_FIELD_MAP.items():
		file_url = row.get(fieldname)
		file_name = frappe.db.get_value("File", {"file_url": file_url}, "name") if file_url else None
		content = frappe.get_doc("File", file_name).get_content() if file_name else ""
		files[name] = content if isinstance(content, str) else content.decode("utf-8", "replace")
	return files


def _sample_data_from_metadata(metadata_source: str) -> dict:
	import ast

	namespace: dict = {}
	# the metadata source passed the static gate before it was stored
	exec(compile(metadata_source, "metadata.py", "exec"), namespace)
	return namespace.get("SAMPLE_DATA") or {}


def _diff(old: str, new: str, name: str) -> str:
	return "\n".join(
		difflib.unified_diff(
			(old or "").splitlines(),
			(new or "").splitlines(),
			fromfile=f"previous/{name}",
			tofile=f"fixed/{name}",
			lineterm="",
		)
	)


def fix_version(template_name: str, version_no: int) -> dict:
	"""Run up to fix_max_attempts LLM repair rounds on a Failed version.

	Every round appends a new version row (created_by_llm=1) carrying the
	corrected files and a unified diff against the previous files; the
	validation re-runs on each row. The template is never auto-activated."""
	parent = frappe.get_doc("Document Template", template_name)
	settings_doc = frappe.get_single("Document Template Settings")
	if not settings_doc.fix_enabled:
		frappe.throw(_("LLM fixing is disabled in Document Template Settings."))
	row = None
	for candidate in parent.versions:
		if candidate.version_no == version_no:
			row = candidate
			break
	if row is None:
		frappe.throw(_("Version {0} not found.").format(version_no))
	if row.validation_status != "Failed":
		frappe.throw(_("Only failed versions can be fixed with the LLM."))
	max_attempts = int(settings_doc.fix_max_attempts or 3)
	llm_rows = sum(1 for r in parent.versions if r.created_by_llm)
	if llm_rows >= max_attempts:
		frappe.throw(
			_("The LLM fix attempt limit ({0}) has been reached for this template.").format(max_attempts)
		)
	provider, api_key, model = _ai_settings()

	latest_files = _version_files(parent, row)
	latest_log = row.validation_log or ""
	attempts = []
	passed = False
	latest_version = version_no
	remaining = max(0, max_attempts - llm_rows)
	for _ in range(remaining):
		user_prompt = (
			CONTRACT_TEXT
			+ "\n\nCurrent files:\n"
			+ json.dumps({name: latest_files.get(name, "") for name in KNOWN_FILES}, indent=2)
			+ "\n\nValidation log of the failing version:\n"
			+ _strip_queries(latest_log)
		)
		raw = _call_text(provider, api_key, model, SYSTEM_PROMPT, user_prompt)
		corrected = _parse_files(raw)
		if not corrected:
			attempts.append({"ok": False, "detail": "the model returned no usable files"})
			continue
		merged = dict(latest_files)
		merged.update(corrected)
		version_no_new = len(parent.versions) + 1
		row_new = parent.append(
			"versions",
			{"version_no": version_no_new, "created_by_llm": 1, "validation_status": "Pending"},
		)
		for name in KNOWN_FILES:
			file_doc = frappe.new_doc("File")
			file_doc.file_name = f"{parent.name}-v{version_no_new}-{name}"
			file_doc.is_private = 1
			file_doc.attached_to_doctype = "Document Template"
			file_doc.attached_to_name = parent.name
			file_doc.content = merged[name].encode("utf-8")
			file_doc.insert()
			row_new.set(FILE_FIELD_MAP[name], file_doc.file_url)
		row_new.llm_diff = "\n\n".join(
			_diff(latest_files.get(name, ""), merged.get(name, ""), name)
			for name in KNOWN_FILES
			if latest_files.get(name, "") != merged.get(name, "")
		) or "no changes"
		parent.save()

		from print_designer.tunisian_univer_engine.template_system.validator import validate_template

		timeout = int(
			frappe.db.get_single_value("Document Template Settings", "build_timeout_seconds") or 30
		)
		result = validate_template(
			files=merged,
			timeout=timeout,
			sample_data_fn=lambda: _sample_data_from_metadata(merged["metadata.py"]),
		)
		row_new.db_set({
			"validation_status": "Passed" if result["passed"] else "Failed",
			"validation_log": "\n".join(result["log"]),
		})
		attempts.append({"version": version_no_new, "passed": result["passed"]})
		latest_files = merged
		latest_log = "\n".join(result["log"])
		if result["passed"]:
			passed = True
			break
	return {"attempts": attempts, "passed": passed, "latest_version": latest_version}
