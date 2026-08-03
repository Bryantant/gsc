# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Auto-creates a Laundry Order when a POS sale is submitted.

The business takes full payment at drop-off (submitted immediately from the
POS screen), but service/handover happens 3-4 days later. Standard Delivery
Notes don't fit -- they document company stock leaving the warehouse, not a
customer's own item being returned after service. Laundry Order tracks that
fulfillment instead, decoupled from how the invoice groups items by qty: one
child row per physical item (shoe/helmet/hat/bag), regardless of whether 2
units of the same service item shared one invoice line.

Triggers on `is_created_using_pos`, NOT `is_pos`: the latter just means "this
invoice collects payment inline" and can be ticked on any manually-created
Sales Invoice from the desk, whereas `is_created_using_pos` is set only by
pos_controller.js when the document is actually created from the physical POS
screen (see pos_controller.js:586/593) -- this matches the same flag core's
own POS "Recent Orders" list (get_invoice_filters in
erpnext/selling/page/point_of_sale/point_of_sale.py) uses to identify
POS-screen invoices, which our custom "Fulfillment Pending" filter
(gsc/overrides/point_of_sale.py) depends on for consistency.

A second, independent trigger -- `custom_is_backlog_entry` (see
gsc/patches/v1_2/add_backlog_sales_invoice_field.py) -- covers the "New
Migration Order" flow, used to enter transactions that were already
in-progress at system cutover with a real historical posting_date.
`is_created_using_pos` can't be reused for this: setting it forces
Sales Invoice.validate() through validate_created_using_pos(), which requires
a currently-OPEN POS Opening Entry for the chosen POS Profile (throws "POS
Opening Entry Missing" otherwise) and validate_full_payment(), which blocks
submission on any partial payment unless the POS Profile allows it -- both
wrong for a migration entry that must submit any time, independent of today's
live cash-drawer session, and must support an outstanding balance.
"""

import frappe
from frappe.utils import cint

from gsc.utils import get_service_item_groups


def create_laundry_order(doc, method=None):
	"""doc_events on_submit hook for Sales Invoice."""
	from_pos_screen = cint(doc.get("is_created_using_pos"))
	backlog_entry = cint(doc.get("custom_is_backlog_entry"))
	if not (from_pos_screen or backlog_entry):
		return
	sync_laundry_order(doc)


def sync_laundry_order(sales_invoice_doc):
	"""Create the linked Laundry Order for a submitted, is_pos Sales Invoice.

	Idempotent: no-ops if one already exists for this invoice. Skips entirely
	if none of the invoice's lines are service items (e.g. a pure retail
	sale). Callable both from the on_submit hook above and the one-time
	backfill patch (gsc/patches/v1_0/backfill_laundry_orders.py), so the
	row-generation logic lives in exactly one place.

	Returns the new Laundry Order's name, or None if none was created.
	"""
	if frappe.db.exists("Laundry Order", {"sales_invoice": sales_invoice_doc.name}):
		return None

	service_groups = set(get_service_item_groups())
	rows = _build_laundry_item_rows(sales_invoice_doc, service_groups)
	if not rows:
		return None

	laundry_order = frappe.get_doc(
		{
			"doctype": "Laundry Order",
			"sales_invoice": sales_invoice_doc.name,
			"laundry_items": rows,
		}
	)
	laundry_order.insert(ignore_permissions=True)
	return laundry_order.name


def _build_laundry_item_rows(sales_invoice_doc, service_groups):
	rows = []
	for item in sales_invoice_doc.items:
		if item.item_group not in service_groups:
			continue
		for _ in range(max(cint(item.qty), 0)):
			rows.append({"item": item.item_code, "item_name": item.item_name})
	return rows
