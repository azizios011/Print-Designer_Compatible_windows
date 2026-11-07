"""Build the bundled editors under print_designer/editors/.

Wired through Frappe's ``after_build`` hook (see hooks.py). Every
sub-directory of ``print_designer/editors/`` that ships its own
``vite.config.ts`` is an editor; shared source packages live in
``editors/packages/`` and third-party attributions in
``editors/THIRD_PARTY/``.

Each editor is built with Vite into ``print_designer/public/editors/<name>/``
with a base path of ``/assets/print_designer/editors/<name>/`` so the built
index.html and assets resolve under Frappe's static asset mount.

Print Designer's own bundles keep building through Frappe's esbuild pipeline;
this module only touches ``print_designer/public/editors/``.

Set ``SKIP_EDITORS_BUILD=1`` to skip the whole step (e.g. quick backend runs).
"""

import os
import shutil
import subprocess
from pathlib import Path

APP_PATH = Path(__file__).resolve().parent
EDITORS_PATH = APP_PATH / "editors"
PUBLIC_EDITORS_PATH = APP_PATH / "public" / "editors"
ASSETS_BASE = "/assets/print_designer/editors"

# Directories inside editors/ that are not standalone editors
NON_EDITOR_DIRS = {"node_modules", "packages", "THIRD_PARTY"}


def after_build() -> None:
	if os.environ.get("SKIP_EDITORS_BUILD"):
		print("[print_designer] SKIP_EDITORS_BUILD is set - skipping editors build")
		return

	if not EDITORS_PATH.is_dir():
		print("[print_designer] no print_designer/editors directory - nothing to build")
		return

	editors = sorted(
		editor
		for editor in EDITORS_PATH.iterdir()
		if editor.is_dir()
		and editor.name not in NON_EDITOR_DIRS
		and (editor / "vite.config.ts").exists()
	)
	if not editors:
		print("[print_designer] no editors found under print_designer/editors/")
		return

	install_editors_dependencies()

	for editor in editors:
		build_editor(editor)


def install_editors_dependencies() -> None:
	"""Install the editors yarn workspace once for all editors.

	The workspace root carries a committed yarn.lock, so --frozen-lockfile
	keeps the install reproducible and fails loudly on drift.
	"""
	print(f"[print_designer] editors: 'yarn install --frozen-lockfile' in {EDITORS_PATH}")
	run(["yarn", "install", "--frozen-lockfile"], cwd=EDITORS_PATH)


def build_editor(editor_path: Path) -> None:
	name = editor_path.name
	out_dir = PUBLIC_EDITORS_PATH / name
	base = f"{ASSETS_BASE}/{name}/"
	print(f"[print_designer] editors: building '{name}' -> {out_dir} (base {base})")
	run(
		[
			"yarn",
			"vite",
			"build",
			f"--base={base}",
			f"--outDir={out_dir}",
			"--emptyOutDir",
		],
		cwd=editor_path,
	)
	print(f"[print_designer] editors: built '{name}'")


def run(cmd: list[str], cwd: Path) -> None:
	if shutil.which(cmd[0]) is None:
		raise RuntimeError(
			f"'{cmd[0]}' was not found on PATH; it is required to build print_designer/editors"
		)
	result = subprocess.run(cmd, cwd=str(cwd))
	if result.returncode != 0:
		raise RuntimeError(
			f"editors build failed: '{' '.join(cmd)}' exited with code {result.returncode} in {cwd}"
		)
