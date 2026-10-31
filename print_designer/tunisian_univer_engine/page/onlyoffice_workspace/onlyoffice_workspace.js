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
		'<div class="onlyoffice-editor-wrapper" style="display: none;">' +
			'<div id="onlyoffice-editor" style="height: calc(100vh - 140px);"></div>' +
			"</div>"
	).appendTo(page.main);

	wrapper.onlyoffice.close_editor = function () {
		if (wrapper.onlyoffice.editor) {
			try {
				wrapper.onlyoffice.editor.destroyEditor();
			} catch (error) {
				// the editor may already be gone; nothing to do
			}
			wrapper.onlyoffice.editor = null;
		}
		wrapper.onlyoffice.editor_wrapper.empty().hide();
		page.set_title(__("Document Workspace"));
	};

	wrapper.onlyoffice.load_api_script = function (api_js_url) {
		if (window.DocsAPI) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			let script = document.querySelector("script[data-onlyoffice-api]");
			if (!script) {
				script = document.createElement("script");
				script.src = api_js_url;
				script.setAttribute("data-onlyoffice-api", "1");
				script.onload = () => resolve();
				script.onerror = () => reject(new Error(__("Failed to load the OnlyOffice API.")));
				document.head.appendChild(script);
				return;
			}
			script.addEventListener("load", () => resolve());
			script.addEventListener("error", () =>
				reject(new Error(__("Failed to load the OnlyOffice API.")))
			);
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
			onError: function () {
				frappe.msgprint({
					title: __("OnlyOffice Workspace"),
					message: __("The editor reported an error."),
					indicator: "red",
				});
			},
		};
		if (wrapper.onlyoffice.editor) {
			wrapper.onlyoffice.close_editor();
		}
		page.set_title(config.document.title || __("Document Workspace"));
		wrapper.onlyoffice.editor_wrapper.show();
		wrapper.onlyoffice
			.load_api_script(data.api_js_url)
			.then(() => {
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
