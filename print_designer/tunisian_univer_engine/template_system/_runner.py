"""Subprocess runner for Document Template validation and rendering.

Reads a JSON payload from stdin:
	{"template_dir": "...", "entry": "main", "data": {...},
	 "output_path": "...", "assets": {...}}
Imports the requested template module from template_dir and calls its entry
function, then writes {"ok": true, "output": "..."} to stdout.
"""

import json
import sys

try:
	import resource

	resource.setrlimit(
		resource.RLIMIT_AS,
		(512 * 1024 * 1024, 512 * 1024 * 1024),
	)
except Exception:  # noqa: BLE001 — the limit is best effort (not available everywhere)
	pass


def main() -> None:
	payload = json.loads(sys.stdin.read() or "{}")
	template_dir = payload["template_dir"]
	if template_dir not in sys.path:
		sys.path.insert(0, template_dir)
	entry = payload["entry"]
	module = __import__(entry)
	data = payload.get("data") or {}
	output_path = payload["output_path"]
	assets = payload.get("assets") or {}
	if entry == "main":
		module.run(data, output_path, assets)
	else:
		module.build(data, output_path, assets)
	print(json.dumps({"ok": True, "output": output_path}))


if __name__ == "__main__":
	main()
