frappe.ui.form.on("Laundry Order", {
	setup(frm) {
		frm.set_query("item", "laundry_items", () => ({
			query: "gsc.queries.laundry_item_query",
		}));
	},
});
