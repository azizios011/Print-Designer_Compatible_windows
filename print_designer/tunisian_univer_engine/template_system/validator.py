# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Static and dynamic validation for the 3-file template contract.

This module intentionally imports neither frappe nor the templates it
checks, so it can be unit-tested and executed inside the restricted
subprocess without site context.
"""

import ast
import json
import os
import subprocess
import sys
import tempfile

ALLOWED_IMPORT_ROOTS = {
	"openpyxl",
	"datetime",
	"decimal",
	"math",
	"re",
	"json",
	"typing",
	"os",
	"pathlib",
	"collections",
	"itertools",
	"copy",
	# the template's own sibling modules (main imports xlsx_creator, etc.)
	"metadata",
	"xlsx_creator",
	"main",
}
FORBIDDEN_CALL_NAMES = {"eval", "exec", "compile", "__import__", "open"}
FORBIDDEN_MODULES = {"subprocess", "socket", "requests"}
FORBIDDEN_OS_ATTRS = {"system", "popen"}
REQUIRED_NAMES = {
	"metadata.py": {"DOCUMENT_TYPE", "DESCRIPTION", "SCHEMA", "SAMPLE_DATA"},
	"xlsx_creator.py": {"build"},
	"main.py": {"run"},
}
RUNNER_RLIMIT_AS = 512 * 1024 * 1024


def validate_files(files: dict) -> dict:
	"""Static contract checks. files = {name: source text}. Returns
	{"passed": bool, "log": [strings]}."""
	log = []
	ok = True
	for name, required in REQUIRED_NAMES.items():
		source = files.get(name)
		if source is None:
			log.append(f"{name}: missing file")
			ok = False
			continue
		try:
			tree = ast.parse(source)
		except SyntaxError as error:
			log.append(f"{name}: syntax error: {error}")
			ok = False
			continue

		defined = {
			node.name
			for node in tree.body
			if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
		}
		defined.update(
			target.id
			for node in tree.body
			if isinstance(node, ast.Assign)
			for target in node.targets
			if isinstance(target, ast.Name)
		)
		missing = sorted(required - defined)
		if missing:
			log.append(f"{name}: missing required names: {', '.join(missing)}")
			ok = False

		for node in ast.walk(tree):
			if isinstance(node, ast.Import):
				for alias in node.names:
					root = alias.name.split(".")[0]
					if root not in ALLOWED_IMPORT_ROOTS:
						log.append(f"{name}: forbidden import '{alias.name}'")
						ok = False
			elif isinstance(node, ast.ImportFrom):
				root = (node.module or "").split(".")[0]
				if node.level:
					log.append(f"{name}: relative imports are not allowed")
					ok = False
				elif root not in ALLOWED_IMPORT_ROOTS:
					log.append(f"{name}: forbidden import '{node.module}'")
					ok = False
			elif isinstance(node, ast.Call):
				func = node.func
				if isinstance(func, ast.Name) and func.id in FORBIDDEN_CALL_NAMES:
					if func.id == "open" and _references_output_path(node.args[:1]):
						continue
					log.append(f"{name}: forbidden call {func.id}()")
					ok = False
				elif (
					isinstance(func, ast.Attribute)
					and isinstance(func.value, ast.Name)
					and func.value.id == "os"
					and func.attr in FORBIDDEN_OS_ATTRS
				):
					log.append(f"{name}: forbidden call os.{func.attr}()")
					ok = False
	return {"passed": ok, "log": log}


def _references_output_path(args) -> bool:
	"""Heuristic: an open() call is allowed when its first argument mentions
	the output_path value the contract hands to the builders."""
	for arg in args:
		for node in ast.walk(arg):
			if isinstance(node, ast.Name) and node.id == "output_path":
				return True
			if isinstance(node, ast.Attribute) and node.attr == "output_path":
				return True
	return False


def run_template_process(
	template_dir: str,
	entry: str,
	output_path: str,
	data: dict,
	assets: dict,
	timeout: int,
) -> None:
	"""Run one template entry function in an isolated subprocess."""
	runner = os.path.join(os.path.dirname(__file__), "_runner.py")
	payload = json.dumps({
		"template_dir": template_dir,
		"entry": entry,
		"data": data or {},
		"output_path": output_path,
		"assets": assets or {},
	})
	try:
		proc = subprocess.run(
			[sys.executable, runner],
			input=payload,
			capture_output=True,
			text=True,
			cwd=template_dir,
			timeout=max(int(timeout or 30), 5),
			env={
				"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
				"HOME": template_dir,
				"PYTHONDONTWRITEBYTECODE": "1",
			},
		)
	except subprocess.TimeoutExpired as error:
		raise TimeoutError(f"the template subprocess timed out after {timeout}s") from error
	result = None
	for line in reversed((proc.stdout or "").splitlines()):
		try:
			parsed = json.loads(line)
		except ValueError:
			continue
		if isinstance(parsed, dict) and parsed.get("ok"):
			result = parsed
			break
	if proc.returncode != 0 or not result:
		detail = ((proc.stderr or "") + " " + (proc.stdout or "")).strip()[-400:]
		raise RuntimeError(f"template subprocess failed: {detail}")
	if not os.path.exists(output_path):
		raise RuntimeError("the template subprocess produced no output file")


def run_dynamic(files: dict, sample_data: dict, timeout: int) -> dict:
	log = []
	with tempfile.TemporaryDirectory() as tmpdir:
		for name, source in files.items():
			with open(os.path.join(tmpdir, name), "w", encoding="utf-8") as handle:
				handle.write(source)
		output_path = os.path.join(tmpdir, "sample_output.xlsx")
		try:
			run_template_process(
				template_dir=tmpdir,
				entry="main",
				output_path=output_path,
				data=sample_data or {},
				assets={"logo": None},
				timeout=timeout,
			)
		except TimeoutError as error:
			log.append(f"runtime: {error}")
			return {"passed": False, "log": log}
		except Exception as error:
			log.append(f"runtime: template failed ({error})")
			return {"passed": False, "log": log}
		try:
			import openpyxl

			workbook = openpyxl.load_workbook(output_path)
			empty = all(
				cell.value is None
				for sheet in workbook.worksheets
				for row in sheet.iter_rows()
				for cell in row
			)
		except Exception as error:
			log.append(f"runtime: the output workbook did not load ({error})")
			return {"passed": False, "log": log}
		if empty:
			log.append("runtime: the output workbook has no data")
			return {"passed": False, "log": log}
	log.append("runtime: sample build OK")
	return {"passed": True, "log": log}


def validate_template(files: dict, timeout: int, sample_data_fn) -> dict:
	"""Full validation: static checks first, the isolated sample build only
	when the static gate passed (sample_data_fn is called lazily so a broken
	metadata.py never executes)."""
	static = validate_files(files)
	log = list(static["log"])
	dynamic = {"passed": False, "log": []}
	if static["passed"]:
		try:
			dynamic = run_dynamic(files, sample_data_fn(), timeout)
		except Exception as error:
			dynamic = {"passed": False, "log": [f"runtime: {error}"]}
		log.extend(dynamic["log"])
	return {"passed": static["passed"] and dynamic["passed"], "log": log}
