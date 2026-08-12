# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Sales Invoice overrides: POS shift bypass, and Laundry Order auto-creation.

The business takes payment at drop-off (submitted immediately from the POS
screen), but service/handover happens 3-4 days later. Standard Delivery
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
in-progress at system cutover with a real historical posting_date. It stays a
dedicated flag purely so migration entries remain identifiable as such and
stay off the POS screen's "Recent Orders" list; the validation reasons that
originally forced them apart are gone (see GSCSalesInvoice below and
POS Profile.allow_partial_payment, set by
gsc/patches/v1_3/add_credit_mode_of_payment.py).
"""

import frappe
from frappe.utils import cint

from erpnext.accounts.doctype.sales_invoice.sales_invoice import SalesInvoice

from gsc.utils import get_service_item_groups


class GSCSalesInvoice(SalesInvoice):
	"""Wired via `override_doctype_class` in hooks.py.

	GSC's counter does not reconcile a cash drawer per cashier shift, so the
	POS screen never creates a POS Opening Entry (see the check_opening_entry
	patch in gsc/public/js/point_of_sale.js). Core's own validation is the
	other half of that requirement and has to come out too, otherwise every
	POS sale throws "POS Opening Entry Missing".
	"""

	def validate_pos_opening_entry(self):
		"""No-op: GSC runs its POS without cashier shifts.

		Core's version (erpnext .../sales_invoice.py::validate_pos_opening_entry)
		throws unless an Open POS Opening Entry exists for this POS Profile
		*whose period_start_date is today*. That last clause is also what makes
		back-dating impossible, so removing it is what lets the POS screen's
		"Tanggal Transaksi" control post to a historical date.

		Only reached from validate_created_using_pos(); that caller's two other
		checks (pos_profile is set, POS Settings.invoice_type isn't "POS
		Invoice") still run, and both are still wanted.
		"""
		pass


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
