const UNPAYABLE_STATUSES = [
	"Paid",
	"Draft",
	"Cancelled",
	"Credit Note Issued",
	"Return",
	"Internal Transfer",
];

frappe.ui.form.on("Laundry Order", {
	setup(frm) {
		frm.set_query("item", "laundry_items", () => ({
			query: "gsc.queries.laundry_item_query",
		}));
	},

	refresh(frm) {
		if (frm.doc.sales_invoice && !UNPAYABLE_STATUSES.includes(frm.doc.status)) {
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
		}
	},
});
