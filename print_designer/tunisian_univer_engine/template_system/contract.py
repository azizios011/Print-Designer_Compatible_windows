# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The 3-file Document Template contract.

A Document Template version carries three admin-uploaded Python files:

- metadata.py:       DOCUMENT_TYPE: str, DESCRIPTION: str, SCHEMA: dict
                     (the canonical extracted-data shape) and SAMPLE_DATA: dict
                     (valid against SCHEMA, fake values only).
- xlsx_creator.py:   build(data: dict, output_path: str, assets: dict) -> str
                     writes the finished workbook to output_path.
                     assets = {"logo": path or None}. No hardcoded company
                     names and no fallback defaults of another company's data.
- main.py:           run(data: dict, output_path: str, assets: dict) -> str,
                     which calls build.

The LLM fixer receives this contract text plus the failing files and the
validation log; it only corrects existing files and never writes templates
from scratch.
"""

import re

# child-table fieldname for each contract file
FILE_FIELD_MAP = {
	"metadata.py": "metadata_file",
	"xlsx_creator.py": "xlsx_creator_file",
	"main.py": "main_file",
}

KNOWN_FILES = tuple(FILE_FIELD_MAP)

CONTRACT_TEXT = """Document Template contract
==========================

A version carries three Python files:

1. metadata.py must define:
   DOCUMENT_TYPE: str, DESCRIPTION: str, SCHEMA: dict, SAMPLE_DATA: dict
   (SAMPLE_DATA must be valid against SCHEMA and contain fake values only).
2. xlsx_creator.py must define:
   build(data: dict, output_path: str, assets: dict) -> str
   assets = {"logo": path or None}. Do not hardcode company names and do not
   fall back to another company's data.
3. main.py must define:
   run(data: dict, output_path: str, assets: dict) -> str, which calls build.

Allowed imports: openpyxl, datetime, decimal, math, re, json, typing,
os.path, pathlib, collections, itertools, copy. Forbidden: eval, exec,
compile, __import__, open() outside the output path, subprocess, socket,
requests, os.system.
"""

# child-table fieldname for each contract file
FILE_FIELD_MAP = {
	"metadata.py": "metadata_file",
	"xlsx_creator.py": "xlsx_creator_file",
	"main.py": "main_file",
}

_ALLOWED_CATEGORIES = ("vente", "achat", "bank", "other")


def slugify(value: str) -> str:
	"""Lowercase ASCII slug: runs of non-alphanumerics become single dashes."""
	value = (value or "").strip().lower()
	value = re.sub(r"[^0-9a-z]+", "-", value)
	return value.strip("-")


def validate_layout_rule(category: str, layout_id: str) -> None:
	"""vente templates have exactly one design per owner ("default");
	achat/bank owners may hold several layouts."""
	if category not in _ALLOWED_CATEGORIES:
		raise ValueError(f"Unknown category: {category}")
	if category == "vente" and layout_id != "default":
		raise ValueError('Category "vente" only supports layout_id="default".')
