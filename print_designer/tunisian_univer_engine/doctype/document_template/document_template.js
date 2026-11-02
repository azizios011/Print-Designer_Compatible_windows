frappe.ui.form.on("Document Template", {
	refresh(frm) {
		const selected = () => {
			const rows = frm.fields_dict.versions.grid.get_selected_children();
			return rows && rows.length ? rows[0] : null;
		};
		const require_row = (statuses) => {
			const row = selected();
			if (!row) {
				frappe.msgprint({
					title: __("Document Templates"),
					message: __("Select a version row in the Versions table first."),
					indicator: "orange",
				});
				return null;
			}
			if (statuses && statuses.indexOf(row.validation_status) === -1) {
				frappe.msgprint({
					title: __("Document Templates"),
					message: __("This action needs a version with status: {0}").format(statuses.join(", ")),
					indicator: "orange",
				});
				return null;
			}
			return row;
		};
		frm.add_custom_button(__("Validate"), () => {
			const row = require_row(null);
			if (!row) return;
			frappe.call({
				type: "POST",
				method: "print_designer.tunisian_univer_engine.template_system.api.validate_version",
				args: { template: frm.doc.name, version_no: row.version_no },
				callback: function (r) {
					frm.reload_doc();
					frappe.msgprint({
						title: __("Document Templates"),
						message: r.message.passed
							? __("Validation passed.")
							: __("Validation failed — see the log."),
						indicator: r.message.passed ? "green" : "red",
					});
				},
			});
		});
		frm.add_custom_button(__("Fix with AI"), () => {
			const row = require_row(["Failed"]);
			if (!row) return;
			frappe.call({
				type: "POST",
				method: "print_designer.tunisian_univer_engine.template_system.api.fix_version_with_llm",
				args: { template: frm.doc.name, version_no: row.version_no },
				callback: function (r) {
					frm.reload_doc();
					const summary = r.message || {};
					frappe.msgprint({
						title: __("Document Templates"),
						message: __("LLM fix finished: {0} attempt(s), final status: {1}").format(
							summary.attempts ? summary.attempts.length : 0,
							summary.passed ? __("Passed") : __("Failed")
						),
						indicator: summary.passed ? "green" : "red",
					});
				},
			});
		});
		frm.add_custom_button(__("Preview"), () => {
			const row = require_row(null);
			if (!row) return;
			frappe.call({
				type: "GET",
				method: "print_designer.tunisian_univer_engine.template_system.api.preview_version",
				args: { template: frm.doc.name, version_no: row.version_no },
				callback: function (r) {
					const url = r.message && r.message.file_url;
					if (url) {
						window.open(url, "_blank");
					}
				},
			});
		});
		frm.add_custom_button(__("Activate"), () => {
			const row = require_row(["Passed"]);
			if (!row) return;
			frappe.call({
				type: "POST",
				method: "print_designer.tunisian_univer_engine.template_system.api.activate_version",
				args: { template: frm.doc.name, version_no: row.version_no },
				callback: function () {
					frm.reload_doc();
					frappe.show_alert({ message: __("Version activated."), indicator: "green" });
				},
			});
		});
		frm.add_custom_button(__("Show Log / Diff"), () => {
			const row = selected();
			if (!row) {
				frappe.msgprint({
					title: __("Document Templates"),
					message: __("Select a version row in the Versions table first."),
					indicator: "orange",
				});
				return;
			}
			frappe.msgprint({
				title: __("Version {0} — log and diff").format(row.version_no),
				indicator: "blue",
				message:
					"<pre>" +
					frappe.utils.escape_html((row.validation_log || "") + "\n\n" + (row.llm_diff || "")) +
					"</pre>",
			});
		});
	},
});
