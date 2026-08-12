const FULFILLMENT_STATUS_COLORS = {
	"In Progress": "orange",
	"Ready to Collect": "blue",
	Completed: "green",
};

// Same map used by public/js/laundry_order.js -- kept in sync manually
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

function laundry_status_pill(value, colors) {
	if (!value) return "";
	const color = colors[value] || "gray";
	return `<span class="indicator-pill ${color} filterable ellipsis" data-filter="">
		<span class="ellipsis">${__(value)}</span>
	</span>`;
}

frappe.listview_settings["Laundry Order"] = {
	// A field literally named "status" is always represented by the leading
	// indicator column and never gets its own explicit list column once
	// get_indicator is defined (frappe/public/js/frappe/list/list_view.js,
	// get_fields_in_list_view filtering) -- so Payment Status has to be the
	// indicator here (same convention Sales Invoice's own list view uses),
	// with Fulfillment Status colored separately via `formatters` below.
	get_indicator(doc) {
		const color = PAYMENT_STATUS_COLORS[doc.status] || "gray";
		return [__(doc.status), color, "status,=," + doc.status];
	},
	formatters: {
		fulfillment_status(value) {
			return laundry_status_pill(value, FULFILLMENT_STATUS_COLORS);
		},
	},
};
