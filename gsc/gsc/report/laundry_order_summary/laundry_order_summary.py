# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Script Report, not a static Query Report: the query needs to omit WHERE
clauses for filters the user hasn't touched, and a plain Query Report's
%(fieldname)s placeholders raise a KeyError the moment a filter key is simply
absent from the request -- which the report page's first load does for any
filter still at its unset default. Building the WHERE clause in Python lets
each filter be skipped outright via filters.get(...) instead.
"""

import frappe
from frappe import _


def execute(filters=None):
	filters = filters or {}
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_columns():
	return [
		{
			"label": _("Laundry Order"),
			"fieldname": "name",
			"fieldtype": "Link",
			"options": "Laundry Order",
			"width": 130,
		},
		{"label": _("Posting Date"), "fieldname": "posting_date", "fieldtype": "Date", "width": 110},
		{"label": _("Days Since Order"), "fieldname": "days_since_order", "fieldtype": "Int", "width": 120},
		{
			"label": _("Sales Invoice"),
			"fieldname": "sales_invoice",
			"fieldtype": "Link",
			"options": "Sales Invoice",
			"width": 150,
		},
		{"label": _("Customer Name"), "fieldname": "customer_name", "fieldtype": "Data", "width": 150},
		{
			"label": _("Fulfillment Status"),
			"fieldname": "fulfillment_status",
			"fieldtype": "Data",
			"width": 130,
		},
		{"label": _("Total Items"), "fieldname": "total_items", "fieldtype": "Int", "width": 100},
		{"label": _("Invoice Status"), "fieldname": "status", "fieldtype": "Data", "width": 110},
		{"label": _("Grand Total"), "fieldname": "grand_total", "fieldtype": "Currency", "width": 120},
		{"label": _("Pickup"), "fieldname": "is_pickup", "fieldtype": "Check", "width": 80},
		{"label": _("Delivery"), "fieldname": "is_delivery", "fieldtype": "Check", "width": 80},
		{
			"label": _("Sold By"),
			"fieldname": "owner",
			"fieldtype": "Link",
			"options": "User",
			"width": 150,
		},
	]


def get_data(filters):
	conditions, values = _build_conditions(filters)
	where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

	return frappe.db.sql(
		f"""
		SELECT
			lo.name,
			si.posting_date,
			DATEDIFF(CURDATE(), si.posting_date) AS days_since_order,
			lo.sales_invoice,
			lo.customer_name,
			lo.fulfillment_status,
			lo.total_items,
			si.status,
			si.grand_total,
			lo.is_pickup,
			lo.is_delivery,
			si.owner
		FROM `tabLaundry Order` lo
		LEFT JOIN `tabSales Invoice` si ON si.name = lo.sales_invoice
		{where_clause}
		ORDER BY si.posting_date DESC, si.posting_time DESC
		""",
		values,
		as_dict=True,
	)


def _build_conditions(filters):
	conditions = []
	values = {}

	if filters.get("fulfillment_status"):
		conditions.append("lo.fulfillment_status = %(fulfillment_status)s")
		values["fulfillment_status"] = filters["fulfillment_status"]

	if filters.get("customer"):
		conditions.append("lo.customer = %(customer)s")
		values["customer"] = filters["customer"]

	if filters.get("sales_invoice"):
		conditions.append("lo.sales_invoice = %(sales_invoice)s")
		values["sales_invoice"] = filters["sales_invoice"]

	if filters.get("from_date"):
		conditions.append("si.posting_date >= %(from_date)s")
		values["from_date"] = filters["from_date"]

	if filters.get("to_date"):
		conditions.append("si.posting_date <= %(to_date)s")
		values["to_date"] = filters["to_date"]

	return conditions, values
