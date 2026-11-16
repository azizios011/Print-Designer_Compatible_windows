frappe.pages["sheets-editor"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Sheets Editor"),
		single_column: true,
	});

	const body = page.main;
	body.html(`
		<div class="sheets-editor-page" style="
			position: relative;
			height: calc(100vh - 112px);
			margin: 0 -15px;
			overflow: hidden;
			display: none;
		">
			<iframe class="sheets-editor-frame" title="Sheets Editor" style="
				border: 0;
				width: 100%;
				height: 100%;
				display: block;
			"></iframe>
		</div>
		<div class="sheets-editor-empty text-center" style="padding-top: 15vh;">
			<p class="text-muted">${__("Pick a spreadsheet file to edit")}</p>
			<button class="btn btn-primary btn-sm sheets-editor-pick">${__("Choose Spreadsheet")}</button>
		</div>
	`);

	const holder = body.find(".sheets-editor-page");
	const empty = body.find(".sheets-editor-empty");
	const iframe = body.find(".sheets-editor-frame");
	let initPayload = null;
	let pendingEdits = 0;

	function params() {
		return new URLSearchParams(window.location.search);
	}

	function openFile(file) {
		empty.hide();
		holder.show();
		initPayload = {
			type: "sheets-editor-init",
			file: file,
			lang: frappe.boot.lang || "en",
			csrfToken: frappe.csrf_token,
			fullName: frappe.user_info(frappe.session.user).fullname,
			// integration hook: /app/sheets-editor?file=...&readonly=1
			readonly: params().get("readonly") === "1",
		};
		// the editor signals sheets-editor-ready on every boot (also after a
		// save-driven session swap reloads the workbook in place)
		const src = "/assets/print_designer/editors/sheets/index.html";
		iframe.attr("src", iframe.attr("src") ? src + "?r=" + Date.now() : src);
	}

	window.addEventListener("message", (ev) => {
		if (ev.source !== iframe[0].contentWindow) return;
		const data = ev.data || {};
		if (data.type === "sheets-editor-ready" && initPayload) {
			iframe[0].contentWindow.postMessage(initPayload, window.location.origin);
		} else if (data.type === "sheets-pending-edits") {
			// dirty-state guard: warn before leaving with unsaved edits
			pendingEdits = data.count || 0;
		} else if (data.type === "sheets-save") {
			// saved (overwrite): keep the URL pointing at the same File
		}
	});

	// Ctrl+S / Cmd+S on the desk page: relay the save to the editor iframe
	$(document).on("keydown", (e) => {
		if (!(e.ctrlKey || e.metaKey)) return;
		if (frappe.get_route()[0] !== "sheets-editor") return;
		if (String.fromCharCode(e.which).toUpperCase() === "S") {
			e.preventDefault();
			iframe[0].contentWindow.postMessage(
				{ type: "sheets-editor-menu", action: "save" },
				window.location.origin,
			);
		}
	});

	window.addEventListener("beforeunload", (ev) => {
		if (pendingEdits > 0) {
			ev.preventDefault();
			ev.returnValue = "";
		}
	});

	empty.find(".sheets-editor-pick").on("click", () => {
		const dialog = new frappe.ui.Dialog({
			title: __("Choose Spreadsheet"),
			fields: [
				{
					fieldname: "file",
					fieldtype: "Link",
					options: "File",
					label: __("Spreadsheet File"),
					reqd: 1,
					get_query: () => ({
						filters: { is_folder: 0, file_name: ["like", "%.xls"] },
					}),
				},
			],
			primary_action_label: __("Open"),
			primary_action(values) {
				dialog.hide();
				const url = new URL(window.location.href);
				url.searchParams.set("file", values.file);
				frappe.router.push_state(url.pathname + url.search);
				openFile(values.file);
			},
		});
		dialog.show();
	});

	const file = params().get("file");
	if (file) openFile(file);
	else empty.show();
};
