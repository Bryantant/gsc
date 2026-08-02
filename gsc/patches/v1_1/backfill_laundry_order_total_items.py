# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""One-time backfill: computes total_items (row count of laundry_items) on
Laundry Orders created before that field existed. New/edited records
self-heal via LaundryOrder.set_total_items() on every save (see
gsc/gsc/doctype/laundry_order/laundry_order.py), so this only needs to cover
historical rows that won't otherwise be resaved.

Idempotent: recomputes unconditionally from the current child table, safe to
re-run.
"""

import frappe


def execute():
	frappe.reload_doc("gsc", "doctype", "laundry_order")
	frappe.reload_doc("gsc", "doctype", "laundry_order_item")

	orders = frappe.get_all("Laundry Order", pluck="name")
	for name in orders:
		count = frappe.db.count("Laundry Order Item", {"parenttype": "Laundry Order", "parent": name})
		frappe.db.set_value("Laundry Order", name, "total_items", count, update_modified=False)
