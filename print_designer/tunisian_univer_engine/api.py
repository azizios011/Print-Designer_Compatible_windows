# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import base64
import json

import frappe
import requests

from print_designer.tunisian_univer_engine import parsers
from print_designer.tunisian_univer_engine.schemas import SCHEMAS

MAX_PDF_PAGES = 12


def _get_settings() -> tuple[str, str, str]:
	settings = frappe.get_single("Univer Extraction Settings")
	api_key = settings.get_password("api_key")
	if not api_key:
		frappe.throw("No API key configured. Set one in Univer Extraction Settings.")
	if not settings.model:
		frappe.throw("No model selected in Univer Extraction Settings. Click 'Refresh Models List' and choose one.")
	return settings.provider, api_key, settings.model


def _load_file_bytes(attachment: str) -> tuple[bytes, str]:
	file_doc = frappe.get_doc("File", {"file_url": attachment})
	file_path = file_doc.get_full_path()
	with open(file_path, "rb") as f:
		content = f.read()
	ext = file_path.lower().rsplit(".", 1)[-1]
	return content, ext


def _pdf_page_count(pdf_bytes: bytes) -> int:
	import pymupdf

	with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
		return doc.page_count


def _pdf_pages_to_pngs(pdf_bytes: bytes) -> list[bytes]:
	import pymupdf

	with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
		return [page.get_pixmap(dpi=200).tobytes("png") for page in doc]


def _build_extraction_prompt(schema: dict, doc_type: str) -> str:
	shape = json.dumps(schema, indent=2, ensure_ascii=False)
	label = doc_type.replace("_", " ")
	return f"""You are extracting structured data from a Tunisian {label}.
Return ONLY a single JSON object, with no markdown formatting, no code fences, and no commentary before or after it.

The JSON object must exactly match this shape:
{shape}

Rules:
- Use numbers (not strings) for numeric fields.
- If a value is not present on the document, use null.
- Do not compute or include any total fields that are not in the shape above."""


def _call_anthropic(api_key: str, model: str, content: bytes, ext: str, prompt: str) -> str:
	if ext == "pdf":
		media_type, block_type = "application/pdf", "document"
	elif ext in ("jpg", "jpeg"):
		media_type, block_type = "image/jpeg", "image"
	elif ext == "png":
		media_type, block_type = "image/png", "image"
	else:
		frappe.throw(f"Unsupported attachment type: .{ext}")

	encoded = base64.b64encode(content).decode("utf-8")
	response = requests.post(
		"https://api.anthropic.com/v1/messages",
		headers={
			"x-api-key": api_key,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		json={
			"model": model,
			"max_tokens": 2000,
			"messages": [
				{
					"role": "user",
					"content": [
						{
							"type": block_type,
							"source": {"type": "base64", "media_type": media_type, "data": encoded},
						},
						{"type": "text", "text": prompt},
					],
				}
			],
		},
		timeout=60,
	)
	response.raise_for_status()
	result = response.json()
	return "".join(
		block.get("text", "") for block in result.get("content", []) if block.get("type") == "text"
	)


def _call_openrouter(api_key: str, model: str, content: bytes, ext: str, prompt: str) -> str:
	if ext == "pdf":
		images = [("image/png", png) for png in _pdf_pages_to_pngs(content)]
	elif ext in ("jpg", "jpeg"):
		images = [("image/jpeg", content)]
	elif ext == "png":
		images = [("image/png", content)]
	else:
		frappe.throw(f"Unsupported attachment type: .{ext}")

	encoded_images = [
		{
			"type": "image_url",
			"image_url": {
				"url": f"data:{media_type};base64,{base64.b64encode(image).decode('utf-8')}"
			},
		}
		for media_type, image in images
	]
	response = requests.post(
		"https://openrouter.ai/api/v1/chat/completions",
		headers={
			"Authorization": f"Bearer {api_key}",
			"content-type": "application/json",
		},
		json={
			"model": model,
			"max_tokens": 2000,
			"messages": [
				{
					"role": "user",
					"content": [{"type": "text", "text": prompt}, *encoded_images],
				}
			],
		},
		timeout=60,
	)
	response.raise_for_status()
	result = response.json()
	choices = result.get("choices", [])
	if not choices:
		frappe.throw("No response from OpenRouter.")
	return choices[0]["message"]["content"]


@frappe.whitelist()
def extract_document(attachment: str, doc_type: str) -> dict:
	if not attachment:
		return {"success": False, "error": "No attachment provided."}

	schema = SCHEMAS.get(doc_type)
	if schema is None:
		return {
			"success": False,
			"error": f"Unknown doc_type: {doc_type}. Expected one of: {', '.join(SCHEMAS)}",
		}

	try:
		content, ext = _load_file_bytes(attachment)
	except Exception as e:
		return {"success": False, "error": f"Could not read the attached file: {e}"}

	# digital statements with a text layer are parsed exactly; the VLM is
	# only the fallback for scans or unknown layouts
	if doc_type == "releve_bancaire" and ext == "pdf":
		parser_result = _parse_statement(content)
		if parser_result is not None:
			return {"success": True, **parser_result}

	if ext == "pdf" and _pdf_page_count(content) > MAX_PDF_PAGES:
		return {
			"success": False,
			"error": "Document too long for automatic extraction (max 12 pages)",
		}

	try:
		provider, api_key, model = _get_settings()
	except Exception as e:
		return {"success": False, "error": str(e)}

	prompt = _build_extraction_prompt(schema, doc_type)

	try:
		if provider == "Anthropic":
			text = _call_anthropic(api_key, model, content, ext, prompt)
		elif provider == "OpenRouter":
			text = _call_openrouter(api_key, model, content, ext, prompt)
		else:
			return {"success": False, "error": f"Unknown provider: {provider}"}
	except requests.exceptions.RequestException as e:
		return {"success": False, "error": f"API request failed: {e}"}
	except Exception as e:
		return {"success": False, "error": str(e)}

	try:
		cleaned = text.strip()
		if cleaned.startswith("```"):
			cleaned = cleaned.strip("`")
			if cleaned.lower().startswith("json"):
				cleaned = cleaned[4:]
			cleaned = cleaned.strip()
		extracted = json.loads(cleaned)
	except Exception as e:
		return {"success": False, "error": f"Could not parse the extraction response: {e}"}

	return {"success": True, "data": extracted, "source": "vlm"}


def _parse_statement(pdf_bytes: bytes) -> dict | None:
	"""Run the deterministic statement parsers; any parser failure falls back
	to the VLM path instead of failing the extraction."""
	try:
		return parsers.parse_statement(pdf_bytes)
	except Exception:
		frappe.log_error(title="Bank statement parser failed", message=frappe.get_traceback())
		return None


@frappe.whitelist()
def get_schema(doc_type: str) -> dict:
	schema = SCHEMAS.get(doc_type)
	if schema is None:
		return {"success": False, "error": "Unknown document type"}
	return {"success": True, "schema": schema}
