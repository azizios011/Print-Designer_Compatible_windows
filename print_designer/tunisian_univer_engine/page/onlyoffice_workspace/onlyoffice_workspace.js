frappe.pages["onlyoffice-workspace"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Document Workspace"),
		single_column: true,
	});
	wrapper.onlyoffice = { editor: null };

	wrapper.onlyoffice.file_field = page.add_field({
		fieldname: "file",
		label: __("File"),
		fieldtype: "Link",
		options: "File",
	});

	page.add_inner_button(__("Open"), () => {
		const file = wrapper.onlyoffice.file_field.get_value();
		if (!file) {
			frappe.msgprint({
				title: __("OnlyOffice Workspace"),
				message: __("Please select a file first."),
				indicator: "orange",
			});
			return;
		}
		frappe.set_route("onlyoffice-workspace", { file: file });
	});

	page.add_inner_button(__("Upload"), () => {
		new frappe.ui.FileUploader({
			as_modal: true,
			disable_file_browser: true,
			restrictions: { allowed_file_types: [".docx", ".xlsx", ".pdf", ".pptx"] },
			on_success: (file_doc) => {
				frappe.set_route("onlyoffice-workspace", { file: file_doc.name });
			},
		});
	});

	page.add_inner_button(__("Close"), () => wrapper.onlyoffice.close_editor());

	wrapper.onlyoffice.editor_wrapper = $(
		'<div class="onlyoffice-editor-wrapper" style="display: none; height: calc(100vh - 150px); min-height: 400px;"></div>'
	).appendTo(page.main);

	wrapper.onlyoffice.reset_placeholder = function () {
		wrapper.onlyoffice.editor_wrapper.html('<div id="onlyoffice-editor"></div>');
	};

	wrapper.onlyoffice.close_editor = function () {
		if (wrapper.onlyoffice.editor) {
			try {
				wrapper.onlyoffice.editor.destroyEditor();
			} catch (error) {
				// the editor may already be gone; nothing to do
			}
			wrapper.onlyoffice.editor = null;
		}
		wrapper.onlyoffice.reset_placeholder();
		wrapper.onlyoffice.editor_wrapper.hide();
		page.set_title(__("Document Workspace"));
	};

	wrapper.onlyoffice.load_api_script = function (api_js_url) {
		if (window.DocsAPI) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const attach = (script) => {
				script.addEventListener("load", () => {
					script.dataset.onlyofficeApiState = "loaded";
					resolve();
				});
				script.addEventListener("error", () => {
					script.dataset.onlyofficeApiState = "failed";
					reject(new Error(__("Failed to load the OnlyOffice API.")));
				});
			};
			const create = () => {
				const script = document.createElement("script");
				script.src = api_js_url;
				script.setAttribute("data-onlyoffice-api", "1");
				script.dataset.onlyofficeApiState = "loading";
				attach(script);
				document.head.appendChild(script);
			};
			const script = document.querySelector("script[data-onlyoffice-api]");
			if (script && script.dataset.onlyofficeApiState === "loading") {
				// an earlier attempt is still in flight; ride along
				attach(script);
				return;
			}
			if (script) {
				// a previous attempt finished without defining DocsAPI (failed
				// load): remove it so a fresh tag is created and this promise
				// can actually settle
				script.remove();
			}
			create();
		});
	};

	wrapper.onlyoffice.open_file = function (file) {
		frappe.call({
			type: "GET",
			method: "print_designer.tunisian_univer_engine.onlyoffice_api.get_editor_config",
			args: { file: file, mode: "edit" },
			callback: function (r) {
				const data = r.message;
				if (!data || !data.config) {
					frappe.msgprint({
						title: __("OnlyOffice Workspace"),
						message: __("Could not load the editor configuration."),
						indicator: "red",
					});
					return;
				}
				wrapper.onlyoffice.open_editor(data);
			},
			error: function (r) {
				let detail = __("Could not load the editor configuration.");
				try {
					const messages = JSON.parse(r._server_messages);
					if (messages && messages.length) {
						detail = JSON.parse(messages[0]).message;
					}
				} catch (error) {
					// keep the generic message
				}
				frappe.msgprint({
					title: __("OnlyOffice Workspace"),
					message: detail,
					indicator: "red",
				});
			},
		});
	};

	wrapper.onlyoffice.open_editor = function (data) {
		const config = data.config;
		config.events = {
			onAppReady: function () {
				console.info("OnlyOffice app ready");
			},
			onDocumentReady: function () {
				console.info("OnlyOffice document ready");
			},
			onWarning: function (event) {
				console.warn("OnlyOffice warning", event && event.data);
			},
			onError: function (event) {
				console.error("OnlyOffice error", event && event.data);
				const description =
					event && event.data && typeof event.data.errorDescription === "string"
						? event.data.errorDescription
						: __("The editor reported an error.");
				frappe.msgprint({
					title: __("OnlyOffice Workspace"),
					message: description,
					indicator: "red",
				});
			},
		};
		config.width = "100%";
		config.height = "100%";
		if (wrapper.onlyoffice.editor) {
			wrapper.onlyoffice.close_editor();
		}
		page.set_title(config.document.title || __("Document Workspace"));
		wrapper.onlyoffice.editor_wrapper.show();
		wrapper.onlyoffice
			.load_api_script(data.api_js_url)
			.then(() => {
				if (window.DocsAPI && !document.getElementById("onlyoffice-editor")) {
					frappe.msgprint({
						title: __("OnlyOffice Workspace"),
						message: __("Editor container missing"),
						indicator: "red",
					});
					return;
				}
				wrapper.onlyoffice.reset_placeholder();
				wrapper.onlyoffice.editor = new DocsAPI.DocEditor("onlyoffice-editor", config);
			})
			.catch(() => {
				frappe.msgprint({
					title: __("OnlyOffice Workspace"),
					message: __("Failed to load the OnlyOffice API script."),
					indicator: "red",
				});
				wrapper.onlyoffice.close_editor();
			});
	};
};

frappe.pages["onlyoffice-workspace"].on_page_show = function (wrapper) {
	const query =
		frappe.route_options ||
		(typeof frappe.utils.get_query_params === "function" ? frappe.utils.get_query_params() : {});
	const file = query.file || null;
	frappe.route_options = null;
	if (file) {
		wrapper.onlyoffice.open_file(file);
	} else {
		wrapper.onlyoffice.close_editor();
	}
};

frappe.pages["onlyoffice-workspace"].on_page_hide = function (wrapper) {
	wrapper.onlyoffice.close_editor();
};
