// Global OnlyOffice workspace integration, loaded via app_include_js.
// Plain IIFE: three designer buttons (OnlyOffice workspace, GenOffice PDF
// editor, upstream Print Designer) on every create-able form, an
// "Edit in Document Workspace" button on configured Print Format forms, a
// print-designer route redirect (OnlyOffice formats open in the
// workspace; upstream formats keep the upstream designer; ?upstream=1
// bypasses the redirect entirely), and an attachment preview override
// (documents render in view mode with the Document Server in the form's
// right preview panel; on any failure the original browser iframe stays).
// Guards everything; never throws. The Design/Edit buttons are hidden on
// NEW (unsaved) documents; they appear only after the first save.

(function () {
	"use strict";

	var safe = function (fn) {
		try {
			return fn();
		} catch (error) {
			if (window.console && console.warn) {
				console.warn("tu-global:", error);
			}
			return null;
		}
	};

	var install_form_handlers = function () {
		if (!window.$ || !window.frappe || !frappe.model || !frappe.model.can_create) {
			return false;
		}
		$(document).on("form-refresh", function (event, frm) {
			safe(function () {
				if (!frm || !frm.doctype || !frm.meta) {
					return;
				}
				if (frm.is_new() || (frm.doc && frm.doc.__islocal)) {
					return;
				}
				if (frm.doctype === "Print Format") {
					if (frm.doc && frm.doc.onlyoffice_format) {
						frm.remove_custom_button(__("Edit Format"));
						frm.add_custom_button(__("Edit in Document Workspace"), function () {
							frappe.set_route("onlyoffice-workspace", { print_format: frm.doc.name });
						});
					}
					return;
				}
				if (frm.meta.istable || frm.meta.issingle) {
					return;
				}
				if (!frappe.model.can_create("Print Format")) {
					return;
				}
				var get_attachments = function () {
					return (frm.attachments && frm.attachments.get_attachments)
						? frm.attachments.get_attachments()
						: [];
				};
				var pick_attachment = function (exts) {
					var pick = null;
					get_attachments().forEach(function (a) {
						var ext = ((a.file_url || "").split("?")[0].split(".").pop() || "").toLowerCase();
						if (!pick && exts.indexOf(ext) !== -1) {
							pick = a;
						}
					});
					return pick;
				};
				frm.add_custom_button(
					__("OnlyOffice"),
					function () {
						var pick = pick_attachment([
							"xlsx", "docx", "pptx", "pdf", "doc", "odt", "rtf",
							"txt", "xls", "ods", "csv", "ppt", "odp",
						]);
						if (!pick) {
							frappe.msgprint({
								title: __("OnlyOffice Workspace"),
								message: __("Attach a document (xlsx, docx, pdf…) to this record first, then open the editor here."),
								indicator: "orange",
							});
							return;
						}
						frappe.set_route("onlyoffice-workspace", { file: pick.name });
					},
					__("Print")
				);
				frm.add_custom_button(
					__("GenOffice"),
					function () {
						var pick = pick_attachment(["pdf"]);
						if (!pick) {
							frappe.msgprint({
								title: __("GenOffice"),
								message: __("Attach a PDF first; the GenOffice editor opens PDFs only for now."),
								indicator: "orange",
							});
							return;
						}
						frappe.set_route("pdf-editor", { file: pick.name });
					},
					__("Print")
				);
				frm.add_custom_button(
					__("Print Designer"),
					function () {
						// the upstream designer: ?upstream=1 bypasses the
						// OnlyOffice redirect; route options pre-fill its
						// "Create or Edit Print Format" doctype
						frappe.set_route("print-designer", {
							doctype: frm.doctype,
							upstream: 1,
						});
					},
					__("Print")
				);
			});
		});
		return true;
	};

	var install_router_redirect = function () {
		if (
			!window.frappe ||
			!frappe.router ||
			typeof frappe.router.render_page !== "function" ||
			!frappe.db ||
			!frappe.db.get_value
		) {
			return false;
		}
		if (frappe.router.__tu_redirect_installed) {
			return true;
		}
		var original_render_page = frappe.router.render_page;
		var has_upstream_bypass = function () {
			// the Print Designer form button routes here with ?upstream=1 to
			// reach the upstream designer instead of the workspace
			try {
				return new URLSearchParams(window.location.search).get("upstream") === "1";
			} catch (error) {
				return false;
			}
		};
		frappe.router.render_page = function () {
			var route = this.current_route || [];
			var me = this;
			if (route[0] !== "print-designer" || has_upstream_bypass()) {
				return original_render_page.apply(this, arguments);
			}
			var name = route.slice(1).join("/");
			if (!name) {
				// bare print-designer route: the workspace designer, with the
				// doctype coming from the query (route options) when present.
				// ?upstream=1 skips this whole redirect (handled above).
				// replace_route makes the browser forget the print-designer
				// entry (the router resets the flags after set_route).
				safe(function () {
					frappe.route_flags = frappe.route_flags || {};
					frappe.route_flags.replace_route = true;
					frappe.set_route("onlyoffice-workspace", {
						designer: 1,
						doctype: (frappe.route_options || {}).doctype || "",
					});
				});
				return;
			}
			// named print-designer route: OnlyOffice formats open in the
			// workspace, upstream formats keep the upstream designer.
			frappe.db
				.get_value("Print Format", name, "onlyoffice_format")
				.then(function (r) {
					var current = frappe.get_route() || [];
					if (
						current[0] !== "print-designer" ||
						current.slice(1).join("/") !== name
					) {
						// the route moved on while the lookup ran
						return;
					}
					var fmt = r && r.message && r.message.onlyoffice_format;
					if (fmt) {
						safe(function () {
							frappe.route_flags = frappe.route_flags || {};
							frappe.route_flags.replace_route = true;
							frappe.set_route("onlyoffice-workspace", { print_format: name });
						});
					} else {
						original_render_page.call(me);
					}
				})
				.catch(function () {
					// on any lookup failure keep the upstream designer working
					original_render_page.call(me);
				});
		};
		frappe.router.__tu_redirect_installed = true;
		return true;
	};

	var try_install_router = function () {
		if (safe(install_router_redirect)) {
			$(window).off("hashchange", try_install_router);
			return true;
		}
		return false;
	};

	var preview_poll_timer = null;

	var install_preview_override = function () {
		if (
			!window.frappe ||
			!frappe.ui ||
			!frappe.ui.form ||
			!frappe.ui.form.Attachments ||
			typeof frappe.ui.form.Attachments.prototype.show_attachment_preview !== "function" ||
			typeof frappe.ui.form.Attachments.prototype.hide_attachment_preview !== "function"
		) {
			return false;
		}
		var Attachments = frappe.ui.form.Attachments;
		if (Attachments.prototype.__tu_preview_installed) {
			return true;
		}
		Attachments.prototype.__tu_preview_installed = true;

		// file types rendered by the Document Server in the preview panel;
		// images, csv and everything else keep the original preview
		var preview_extensions = [
			"pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf",
		];

		var get_extension = function (file_name) {
			var name = (file_name || "").split("?")[0].toLowerCase();
			return name.indexOf(".") === -1 ? "" : name.split(".").pop();
		};

		var load_api_script = function (api_js_url) {
			if (window.DocsAPI) {
				return Promise.resolve();
			}
			return new Promise(function (resolve, reject) {
				var listen = function (script) {
					script.addEventListener("load", function () {
						script.dataset.onlyofficeApiState = "loaded";
						resolve();
					});
					script.addEventListener("error", function () {
						script.dataset.onlyofficeApiState = "failed";
						reject(new Error(__("Failed to load the OnlyOffice API.")));
					});
				};
				var script = document.querySelector("script[data-onlyoffice-api]");
				if (script && script.dataset.onlyofficeApiState === "loading") {
					// an earlier attempt is still in flight; ride along
					listen(script);
					return;
				}
				if (script) {
					// a previous attempt finished without defining DocsAPI (failed
					// load): remove it so a fresh tag is created and this promise
					// can actually settle
					script.remove();
				}
				script = document.createElement("script");
				script.src = api_js_url;
				script.setAttribute("data-onlyoffice-api", "1");
				script.dataset.onlyofficeApiState = "loading";
				listen(script);
				document.head.appendChild(script);
				// whatever happens, never hold the preview open: fall back to
				// the original iframe if api.js does not arrive within 10s
				setTimeout(function () {
					reject(new Error(__("Failed to load the OnlyOffice API.")));
				}, 10000);
			});
		};

		var destroy_editor = function (attachments) {
			if (!attachments || !attachments.tu_oo_editor) {
				return;
			}
			try {
				attachments.tu_oo_editor.destroyEditor();
			} catch (error) {
				// the editor may already be gone; nothing to do
			}
			attachments.tu_oo_editor = null;
		};

		var body_is_gone = function (attachments) {
			var body = attachments.attachment_preview
				? attachments.attachment_preview.find(".attachment-preview-body")
				: [];
			return !body.length || !document.body.contains(body[0]);
		};

		var open_onlyoffice_preview = function (attachments, attachment) {
			var extension = get_extension(attachment && attachment.file_name);
			if (preview_extensions.indexOf(extension) === -1) {
				// images, csv and other types keep the original preview
				return;
			}
			if (!attachment.name) {
				console.warn("tu-preview: attachment has no File name", attachment);
				return;
			}
			// show_attachment_preview already ran: the header, resize handle
			// and the pdf iframe / unsupported fallback are in place and stay
			// as the fallback until the editor is actually created
			var request_id = attachments.attachment_preview_request_id;
			destroy_editor(attachments);
			frappe.call({
				type: "GET",
				method: "print_designer.tunisian_univer_engine.onlyoffice_api.get_editor_config",
				args: { file: attachment.name, mode: "view", preview: 1 },
				// silent: the framework would msgprint server errors itself;
				// failures here must stay invisible (the original preview stays)
				silent: true,
				callback: function (r) {
					safe(function () {
						var data = r && r.message;
						if (!data || !data.config) {
							console.warn("tu-preview: no editor config for", attachment.name);
							return;
						}
						if (
							attachments.attachment_preview_request_id !== request_id ||
							body_is_gone(attachments)
						) {
							// the user switched file or closed the panel meanwhile
							return;
						}
						load_api_script(data.api_js_url)
							.then(function () {
								safe(function () {
									if (
										attachments.attachment_preview_request_id !== request_id ||
										body_is_gone(attachments)
									) {
										// the user switched file or closed the panel meanwhile
										return;
									}
									attachments.attachment_preview
										.find(".attachment-preview-body")
										.html('<div id="tu-oo-preview" style="width:100%;height:100%"></div>');
									var config = data.config;
									// width and height are not signed, so only these may
									// be set client-side; the rest reached the Document
									// Server inside the JWT built in onlyoffice_api.py
									config.width = "100%";
									config.height = "100%";
									attachments.tu_oo_editor = new DocsAPI.DocEditor("tu-oo-preview", config);
								});
							})
							.catch(function (error) {
								// keep the original iframe / fallback in place
								console.warn("tu-preview: api.js load failed", error);
							});
					});
				},
				error: function (r) {
					safe(function () {
						// keep the original preview in place; log only
						console.warn("tu-preview: editor config request failed", r);
					});
				},
			});
		};

		var original_show = Attachments.prototype.show_attachment_preview;
		Attachments.prototype.show_attachment_preview = function (attachment, file_url) {
			var result = original_show.apply(this, arguments);
			var me = this;
			safe(function () {
				open_onlyoffice_preview(me, attachment);
			});
			return result;
		};

		var original_hide = Attachments.prototype.hide_attachment_preview;
		Attachments.prototype.hide_attachment_preview = function () {
			var me = this;
			safe(function () {
				destroy_editor(me);
			});
			return original_hide.apply(this, arguments);
		};

		return true;
	};

	var try_install_preview = function () {
		if (safe(install_preview_override)) {
			$(window).off("hashchange", try_install_preview);
			if (preview_poll_timer) {
				clearInterval(preview_poll_timer);
				preview_poll_timer = null;
			}
			return true;
		}
		return false;
	};

	var boot = function () {
		safe(install_form_handlers);
		if (!try_install_router()) {
			// the router object appears during desk boot; retry on the first
			// route event (hashchange fires at least once at boot)
			$(window).on("hashchange", try_install_router);
		}
		if (!try_install_preview()) {
			// the Attachments class also appears during desk boot; retry on
			// the first route event and poll briefly so the first forms open
			// with the override too
			$(window).on("hashchange", try_install_preview);
			var tries = 0;
			preview_poll_timer = setInterval(function () {
				tries += 1;
				if (try_install_preview() || tries > 20) {
					clearInterval(preview_poll_timer);
					preview_poll_timer = null;
				}
			}, 500);
		}
	};

	safe(boot);
})();
