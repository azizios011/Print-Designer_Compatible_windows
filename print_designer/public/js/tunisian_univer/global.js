// Global OnlyOffice workspace integration, loaded via app_include_js.
// Plain IIFE: a "Design Print Format" button on every create-able form, an
// "Edit in Document Workspace" button on configured Print Format forms, and
// a print-designer route redirect (OnlyOffice formats open in the
// workspace; upstream formats keep the upstream designer). Guards
// everything; never throws.

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
				frm.add_custom_button(
					__("Design Print Format"),
					function () {
						frappe.set_route("onlyoffice-workspace", {
							designer: 1,
							doctype: frm.doctype,
							docname: frm.doc.name,
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
		frappe.router.render_page = function () {
			var route = this.current_route || [];
			var me = this;
			if (route[0] !== "print-designer") {
				return original_render_page.apply(this, arguments);
			}
			var name = route.slice(1).join("/");
			if (!name) {
				// bare print-designer route: the workspace designer, with the
				// doctype coming from the query (route options) when present.
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

	var boot = function () {
		safe(install_form_handlers);
		if (!try_install_router()) {
			// the router object appears during desk boot; retry on the first
			// route event (hashchange fires at least once at boot)
			$(window).on("hashchange", try_install_router);
		}
	};

	safe(boot);
})();
