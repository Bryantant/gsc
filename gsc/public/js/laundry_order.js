frappe.ui.form.on("Laundry Order", {
	setup(frm) {
		frm.set_query("item", "laundry_items", () => ({
			query: "gsc.queries.laundry_item_query",
		}));
	},

	refresh(frm) {
		if (!frm.doc.sales_invoice) return;

		// frm.doc.status is a fetch_from snapshot of sales_invoice.status taken
		// once when the link was set (on_submit, before any Payment Entry
		// exists) and never refreshed afterwards, so it goes stale the moment
		// the invoice is later paid off elsewhere. Ask the invoice directly
		// for its current outstanding_amount instead -- the same field
		// get_payment_entry's set_payment_type() itself keys off of to decide
		// Receive vs Pay -- so the button only appears when there's actually
		// something left to receive, and never defaults to "Pay" for an
		// invoice that's already settled.
		frappe.db
			.get_value("Sales Invoice", frm.doc.sales_invoice, ["docstatus", "outstanding_amount"])
			.then(({ message }) => {
				if (!message || message.docstatus !== 1 || message.outstanding_amount <= 0) return;

				frm.add_custom_button(__("Payment"), () => {
					// Same call the Sales Invoice's own "Create > Payment" button makes
					// (erpnext/public/js/controllers/transaction.js make_mapped_payment_entry) --
					// reused here so staff don't have to leave Laundry Order to record payment.
					frappe.call({
						method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
						args: { dt: "Sales Invoice", dn: frm.doc.sales_invoice },
						callback: (r) => {
							const doclist = frappe.model.sync(r.message);
							frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
						},
					});
				}, __("Create"));
			});
	},
});
