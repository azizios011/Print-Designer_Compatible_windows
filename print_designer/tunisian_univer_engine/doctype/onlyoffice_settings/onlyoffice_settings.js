frappe.ui.form.on("OnlyOffice Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Test Connection"), () => {
			frappe.call({
				method:
					"print_designer.tunisian_univer_engine.onlyoffice_api.check_connection",
				args: {},
				callback: function (r) {
					const result = r.message || {};
					frappe.msgprint({
						title: __("OnlyOffice Connection"),
						indicator: result.ok ? "green" : "red",
						message:
							result.detail ||
							(result.ok
								? __("Document Server reachable.")
								: __("Connection failed.")),
					});
				},
			});
		});
	},
});
