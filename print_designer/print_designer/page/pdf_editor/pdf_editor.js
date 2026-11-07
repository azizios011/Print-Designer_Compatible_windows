frappe.pages["pdf-editor"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("PDF Editor"),
		single_column: true,
	});

	const body = page.main;
	body.html(`
		<div class="pdf-editor-page" style="
			position: relative;
			height: calc(100vh - 112px);
			margin: 0 -15px;
			overflow: hidden;
			display: none;
		">
			<iframe class="pdf-editor-frame" title="PDF Editor" style="
				border: 0;
				width: 100%;
				height: 100%;
				display: block;
			"></iframe>
		</div>
		<div class="pdf-editor-empty text-center" style="padding-top: 15vh;">
			<p class="text-muted">${__("Pick a PDF file to edit")}</p>
			<button class="btn btn-primary btn-sm pdf-editor-pick">${__("Choose PDF")}</button>
		</div>
	`);

	const holder = body.find(".pdf-editor-page");
	const empty = body.find(".pdf-editor-empty");
	const iframe = body.find(".pdf-editor-frame");
	let initPayload = null;

	function params() {
		return new URLSearchParams(window.location.search);
	}

	function openFile(file) {
		empty.hide();
		holder.show();
		initPayload = {
			type: "pdf-editor-init",
			file: file,
			lang: frappe.boot.lang || "en",
			csrfToken: frappe.csrf_token,
			fullName: frappe.user_info(frappe.session.user).fullname,
		};
		// the editor signals pdf-editor-ready on every boot (also after a
		// generated document replaces the current one via a cache-busted reload)
		const src = "/assets/print_designer/editors/pdf/index.html";
		iframe.attr("src", iframe.attr("src") ? src + "?r=" + Date.now() : src);
	}

	window.addEventListener("message", (ev) => {
		if (ev.source !== iframe[0].contentWindow) return;
		if (ev.data && ev.data.type === "pdf-editor-ready" && initPayload) {
			iframe[0].contentWindow.postMessage(initPayload, window.location.origin);
		}
	});

	empty.find(".pdf-editor-pick").on("click", () => {
		const dialog = new frappe.ui.Dialog({
			title: __("Choose PDF"),
			fields: [
				{
					fieldname: "file",
					fieldtype: "Link",
					options: "File",
					label: __("PDF File"),
					reqd: 1,
					get_query: () => ({ filters: { is_folder: 0, file_name: ["like", "%.pdf"] } }),
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
