# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""One-time backfill: creates a Laundry Order for pre-existing POS-screen
Sales Invoices that predate this feature, so historical service sales get an
ops-tracking record too. Reuses gsc.overrides.sales_invoice.sync_laundry_order
so this doesn't duplicate the row-generation logic used by the on_submit hook.

Filters on `is_created_using_pos`, matching the on_submit hook's trigger
condition (see gsc/overrides/sales_invoice.py for why that flag, not is_pos).

Idempotent (sync_laundry_order no-ops if a Laundry Order already exists for
that invoice), safe to re-run.
"""

import frappe

from gsc.overrides.sales_invoice import sync_laundry_order


def execute():
	frappe.reload_doc("gsc", "doctype", "laundry_order")
	frappe.reload_doc("gsc", "doctype", "laundry_order_item")

	invoice_names = frappe.get_all(
		"Sales Invoice",
		filters={"is_created_using_pos": 1, "docstatus": 1},
		pluck="name",
	)
	for name in invoice_names:
		sync_laundry_order(frappe.get_doc("Sales Invoice", name))
