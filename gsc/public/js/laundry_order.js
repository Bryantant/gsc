const UNPAYABLE_STATUSES = [
	"Paid",
	"Draft",
	"Cancelled",
	"Credit Note Issued",
	"Return",
	"Internal Transfer",
];

// Same map used by public/js/laundry_order_list.js -- kept in sync manually
// since list view and form view are separate page loads (no shared module).
const PAYMENT_STATUS_COLORS = {
	Draft: "red",
	Unpaid: "orange",
	Paid: "green",
	Return: "gray",
	"Credit Note Issued": "gray",
	"Unpaid and Discounted": "orange",
	"Partly Paid and Discounted": "yellow",
	"Overdue and Discounted": "red",
	Overdue: "red",
	"Partly Paid": "yellow",
	"Internal Transfer": "darkgrey",
	Cancelled: "red",
};

frappe.ui.form.on("Laundry Order", {
	setup(frm) {
		frm.set_query("item", "laundry_items", () => ({
			query: "gsc.queries.laundry_item_query",
		}));
	},

	refresh(frm) {
		if (frm.doc.status) {
			frm.dashboard.add_indicator(
				__("Status Pembayaran: {0}", [__(frm.doc.status)]),
				PAYMENT_STATUS_COLORS[frm.doc.status] || "gray"
			);
		}

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
