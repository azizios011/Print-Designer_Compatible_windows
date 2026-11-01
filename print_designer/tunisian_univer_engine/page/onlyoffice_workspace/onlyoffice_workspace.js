frappe.pages["onlyoffice-workspace"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Document Workspace"),
		single_column: true,
	});
	wrapper.onlyoffice = { editor: null, open_id: 0, mode: "file", print_format: null, exit_route: null };

	wrapper.onlyoffice.file_field = page.add_field({
		fieldname: "file",
		label: __("File"),
		fieldtype: "Link",
		options: "File",
	});

	wrapper.onlyoffice.buttons = {
		open: page.add_inner_button(__("Open"), () => {
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
		}),
		upload: page.add_inner_button(__("Upload"), () => {
			new frappe.ui.FileUploader({
				as_modal: true,
				disable_file_browser: true,
				restrictions: { allowed_file_types: [".docx", ".xlsx", ".pdf", ".pptx"] },
				on_success: (file_doc) => {
					frappe.set_route("onlyoffice-workspace", { file: file_doc.name });
				},
			});
		}),
		close: page.add_inner_button(__("Close"), () => wrapper.onlyoffice.close_editor()),
	};

	wrapper.onlyoffice.exit_button = page.add_inner_button(__("Exit"), () => {
		wrapper.onlyoffice.set_fullscreen(false);
		if (wrapper.onlyoffice.mode === "print_format" && wrapper.onlyoffice.print_format) {
			frappe.set_route("Form", "Print Format", wrapper.onlyoffice.print_format);
		} else {
			window.history.back();
		}
	});
	$(wrapper.onlyoffice.exit_button).toggle(false);

	wrapper.onlyoffice.editor_wrapper = $(
		'<div class="onlyoffice-editor-wrapper" style="display: none; height: calc(100vh - 150px); min-height: 400px;"></div>'
	).appendTo(page.main);

	wrapper.onlyoffice.reset_placeholder = function () {
		wrapper.onlyoffice.editor_wrapper.html('<div id="onlyoffice-editor"></div>');
	};

	wrapper.onlyoffice.close_editor = function () {
		wrapper.onlyoffice.open_id += 1;
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

	wrapper.onlyoffice.set_fullscreen = function (on) {
		const style_id = "tu-fullscreen-style";
		if (!document.getElementById(style_id)) {
			const style = document.createElement("style");
			style.id = style_id;
			style.textContent =
				"body.tu-fullscreen .body-sidebar-container { display: none !important; }" +
				"body.tu-fullscreen .sidebar-toggle-btn { display: none !important; }" +
				"body.tu-fullscreen .navbar { display: none !important; }" +
				"body.tu-fullscreen .page-toolbar { display: none !important; }" +
				"body.tu-fullscreen .onlyoffice-editor-wrapper { height: calc(100vh - 120px) !important; }";
			document.head.appendChild(style);
		}
		document.body.classList.toggle("tu-fullscreen", !!on);
	};

	wrapper.onlyoffice.set_mode_ui = function (mode) {
		const buttons = wrapper.onlyoffice.buttons;
		const file_mode = mode === "file";
		[buttons.open, buttons.upload, buttons.close].forEach(function (b) {
			if (b) $(b).toggle(file_mode);
		});
		if (wrapper.onlyoffice.exit_button) {
			$(wrapper.onlyoffice.exit_button).toggle(mode === "print_format");
		}
	};

	wrapper.onlyoffice.exit = function () {
		wrapper.onlyoffice.set_fullscreen(false);
		const prev = wrapper.onlyoffice.exit_route;
		if (prev && prev.length) {
			frappe.set_route.apply(null, prev);
		} else {
			frappe.set_route();
		}
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

	wrapper.onlyoffice.open_file = function (file, title_override) {
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
				wrapper.onlyoffice.open_editor(data, title_override);
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

	wrapper.onlyoffice.open_editor = function (data, title_override) {
		if (wrapper.onlyoffice.editor) {
			wrapper.onlyoffice.close_editor();
		}
		wrapper.onlyoffice.open_id += 1;
		const open_id = wrapper.onlyoffice.open_id;
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
		wrapper.onlyoffice.reset_placeholder();
		page.set_title(title_override || config.document.title || __("Document Workspace"));
		wrapper.onlyoffice.editor_wrapper.show();
		wrapper.onlyoffice
			.load_api_script(data.api_js_url)
			.then(() => {
				if (open_id !== wrapper.onlyoffice.open_id) {
					// the user left the page or pressed Close while api.js was loading
					return;
				}
				if (window.DocsAPI && !document.getElementById("onlyoffice-editor")) {
					frappe.msgprint({
						title: __("OnlyOffice Workspace"),
						message: __("Editor container missing"),
						indicator: "red",
					});
					return;
				}
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

	wrapper.onlyoffice.open_print_format = function (name) {
		wrapper.onlyoffice.mode = "print_format";
		wrapper.onlyoffice.print_format = name;
		wrapper.onlyoffice.set_mode_ui("print_format");
		wrapper.onlyoffice.set_fullscreen(true);
		page.set_title(name);
		frappe.call({
			type: "GET",
			method: "print_designer.tunisian_univer_engine.onlyoffice_api.get_print_format_info",
			args: { print_format: name },
			callback: function (r) {
				const info = r.message;
				if (!info || !info.doc_type) {
					frappe.msgprint({
						title: __("OnlyOffice Workspace"),
						message: __("Not an OnlyOffice format"),
						indicator: "red",
					});
					wrapper.onlyoffice.set_fullscreen(false);
					window.history.back();
					return;
				}
				wrapper.onlyoffice.open_file(info.template_file, name);
			},
			error: function (r) {
				let detail = __("Could not load the Print Format info.");
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

	wrapper.onlyoffice.open_designer = function (doctype, docname) {
		wrapper.onlyoffice.mode = "designer";
		wrapper.onlyoffice.designer_doctype = doctype || null;
		wrapper.onlyoffice.designer_docname = docname || null;
		wrapper.onlyoffice.set_mode_ui("designer");
		wrapper.onlyoffice.set_fullscreen(true);
		wrapper.onlyoffice.close_editor();

		let template_ids = {};
		const dialog = new frappe.ui.Dialog({
			title: __("Create or Edit Print Format"),
			fields: [
				{
					fieldname: "action",
					fieldtype: "Select",
					label: __("Action"),
					options: "Create New\nEdit Existing",
					default: "Create New",
					reqd: 1,
				},
				{
					fieldname: "doctype",
					fieldtype: "Link",
					label: __("DocType"),
					options: "DocType",
					reqd: 1,
				},
				{ fieldname: "cb_action", fieldtype: "Section Break" },
				{
					fieldname: "print_format_name",
					fieldtype: "Data",
					label: __("Print Format Name"),
					reqd: 1,
				},
				{
					fieldname: "document_format",
					fieldtype: "Select",
					label: __("Document Format"),
					options: "xlsx\ndocx",
					default: "xlsx",
					reqd: 1,
				},
				{
					fieldname: "template",
					fieldtype: "Select",
					label: __("Template"),
					options: "",
				},
				{
					fieldname: "print_format",
					fieldtype: "Select",
					label: __("Print Format"),
					options: "",
				},
			],
		});

		const load_templates = function () {
			const dt = dialog.get_value("doctype");
			const fmt = dialog.get_value("document_format") || "xlsx";
			if (!dt) {
				return;
			}
			frappe.call({
				type: "GET",
				method: "print_designer.tunisian_univer_engine.onlyoffice_api.get_templates",
				args: { doctype: dt, document_format: fmt },
				callback: function (r) {
					const rows = r.message || [];
					template_ids = {};
					const titles = [];
					rows.forEach(function (row) {
						template_ids[row.title] = row.id;
						titles.push(row.title);
					});
					dialog.set_df_property("template", "options", titles.join("\n"));
					if (titles.length) {
						dialog.set_value("template", titles[0]);
					} else {
						dialog.set_value("template", "");
					}
				},
			});
		};

		const load_print_formats = function () {
			const dt = dialog.get_value("doctype");
			if (!dt) {
				return;
			}
			frappe.call({
				type: "GET",
				method: "print_designer.tunisian_univer_engine.onlyoffice_api.list_print_formats",
				args: { doctype: dt },
				callback: function (r) {
					const names = r.message || [];
					dialog.set_df_property("print_format", "options", names.join("\n"));
					if (!names.length) {
						frappe.msgprint({
							title: __("OnlyOffice Workspace"),
							message: __("No OnlyOffice Print Formats exist for {0} yet.").format(dt),
							indicator: "orange",
						});
					} else {
						dialog.set_value("print_format", names[0]);
					}
				},
			});
		};

		const apply_action_ui = function () {
			const creating = dialog.get_value("action") !== "Edit Existing";
			dialog.set_df_property("print_format_name", "hidden", !creating);
			dialog.set_df_property("print_format_name", "reqd", creating);
			dialog.set_df_property("document_format", "hidden", !creating);
			dialog.set_df_property("template", "hidden", !creating);
			dialog.set_df_property("print_format", "hidden", creating);
			dialog.set_primary_action(creating ? __("Create") : __("Edit"), primary_handler);
			if (creating) {
				load_templates();
			} else {
				load_print_formats();
			}
		};

		const primary_handler = function () {
			const values = dialog.get_values();
			if (!values) {
				return;
			}
			const creating = values.action !== "Edit Existing";
			if (creating) {
				frappe.call({
					type: "POST",
					method: "print_designer.tunisian_univer_engine.onlyoffice_api.create_print_format",
					args: {
						doctype: values.doctype,
						print_format_name: values.print_format_name,
						document_format: values.document_format,
						template_id: template_ids[values.template] || "",
					},
					callback: function (r) {
						dialog.hide();
						frappe.set_route("onlyoffice-workspace", { print_format: r.message.print_format });
					},
					error: function (r) {
						let detail = __("Could not create the Print Format.");
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
			} else {
				if (!values.print_format) {
					frappe.msgprint({
						title: __("OnlyOffice Workspace"),
						message: __("Please select a Print Format."),
						indicator: "orange",
					});
					return;
				}
				dialog.hide();
				frappe.set_route("onlyoffice-workspace", { print_format: values.print_format });
			}
		};

		dialog.fields_dict.action.df.onchange = apply_action_ui;
		dialog.fields_dict.doctype.df.onchange = function () {
			load_templates();
			load_print_formats();
		};
		dialog.fields_dict.document_format.df.onchange = load_templates;

		dialog.set_secondary_action(__("Exit"), function () {
			dialog.hide();
			wrapper.onlyoffice.set_fullscreen(false);
			const prev = wrapper.onlyoffice.exit_route;
			if (prev && prev.length) {
				frappe.set_route.apply(null, prev);
			} else {
				frappe.set_route();
			}
		});

		if (doctype) {
			dialog.set_value("doctype", doctype);
			dialog.set_df_property("doctype", "hidden", 1);
		}
		apply_action_ui();
		dialog.show();
	};
};

frappe.pages["onlyoffice-workspace"].on_page_show = function (wrapper) {
	const query =
		frappe.route_options ||
		(typeof frappe.utils.get_query_params === "function" ? frappe.utils.get_query_params() : {});
	const print_format = query.print_format || null;
	const designer = query.designer || null;
	const doctype = query.doctype || null;
	const docname = query.docname || null;
	const file = query.file || null;
	frappe.route_options = null;
	if (print_format) {
		wrapper.onlyoffice.open_print_format(print_format);
	} else if (designer) {
		wrapper.onlyoffice.open_designer(doctype, docname);
	} else if (file) {
		wrapper.onlyoffice.mode = "file";
		wrapper.onlyoffice.set_mode_ui("file");
		wrapper.onlyoffice.set_fullscreen(false);
		wrapper.onlyoffice.open_file(file);
	} else {
		wrapper.onlyoffice.mode = "file";
		wrapper.onlyoffice.set_mode_ui("file");
		wrapper.onlyoffice.set_fullscreen(false);
		wrapper.onlyoffice.close_editor();
	}
};

frappe.pages["onlyoffice-workspace"].on_page_hide = function (wrapper) {
	wrapper.onlyoffice.set_fullscreen(false);
	wrapper.onlyoffice.close_editor();
};
