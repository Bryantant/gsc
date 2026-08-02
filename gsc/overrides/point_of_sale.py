# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Overrides the POS page's "Recent Orders" list query (wired via
`override_whitelisted_methods` in hooks.py) to add a "Fulfillment Pending"
status -- invoices linked to a Laundry Order whose fulfillment_status isn't
yet "Completed" -- without needing a mirrored/duplicated status field on
Sales Invoice: Laundry Order.sales_invoice is the only link needed, queried
here to build a plain `name in (...)` filter.

Every other status value (Draft/Paid/Return/Partly Paid) delegates unchanged
to core's own get_past_order_list. "Consolidated" is intentionally dropped
from the POS page's dropdown (see point_of_sale.js) since this site's POS
Settings.invoice_type is "Sales Invoice", not "POS Invoice" -- consolidation
is a POS Invoice Merge Log concept that doesn't apply here -- but the status
value is left handled here (falls through to core) in case it's ever passed.
"""

import frappe

from erpnext.selling.page.point_of_sale.point_of_sale import (
	add_doctype_to_results,
	order_results_by_posting_date,
)
from erpnext.selling.page.point_of_sale.point_of_sale import get_past_order_list as _core_get_past_order_list

FULFILLMENT_PENDING_STATUS = "Fulfillment Pending"

SALES_INVOICE_FIELDS = [
	"name",
	"grand_total",
	"currency",
	"customer",
	"customer_name",
	"posting_time",
	"posting_date",
]


@frappe.whitelist()
def get_past_order_list(search_term, status, limit=20):
	if status != FULFILLMENT_PENDING_STATUS:
		return _core_get_past_order_list(search_term, status, limit)

	pending_sales_invoices = frappe.get_all(
		"Laundry Order",
		filters={"fulfillment_status": ["!=", "Completed"]},
		pluck="sales_invoice",
	)
	if not pending_sales_invoices:
		return []

	# No is_created_using_pos / is_consolidated / pos_closing_entry / docstatus
	# filters here (unlike core's other status branches): every invoice in
	# pending_sales_invoices already satisfies all of those, because a Laundry
	# Order only ever gets created (create_laundry_order, on_submit) for a
	# submitted, POS-screen Sales Invoice. Adding pos_closing_entry="not set"
	# here (as core's "Paid" branch does) would have been actively wrong: it
	# would hide any invoice whose business day has already been closed out
	# via POS Closing Entry, even though fulfillment tracking has nothing to
	# do with end-of-day reconciliation - most invoices older than "today"
	# would silently vanish from this filter.
	filters = {"name": ["in", pending_sales_invoices]}

	if search_term:
		invoices = frappe.get_list(
			"Sales Invoice",
			filters=filters,
			or_filters={
				"name": ["like", f"%{search_term}%"],
				"customer_name": ["like", f"%{search_term}%"],
				"customer": ["like", f"%{search_term}%"],
			},
			fields=SALES_INVOICE_FIELDS,
			page_length=limit,
		)
	else:
		invoices = frappe.get_list(
			"Sales Invoice",
			filters=filters,
			fields=SALES_INVOICE_FIELDS,
			page_length=limit,
		)

	invoices = add_doctype_to_results("Sales Invoice", invoices)
	return order_results_by_posting_date(invoices)
