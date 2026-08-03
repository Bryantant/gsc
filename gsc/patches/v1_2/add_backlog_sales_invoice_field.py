# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Add a Migration Entry flag to Sales Invoice.

Backs the "New Migration Order" Workspace shortcut, used to move
already-in-progress transactions (paid or not, item not yet collected) into
the system at cutover, with a real historical posting_date instead of the
live POS screen's fixed "Today". See
gsc/overrides/sales_invoice.py::create_laundry_order for why this is a
dedicated flag rather than reusing `is_created_using_pos` -- that flag drags
in POS Opening Entry / full-payment validation that would either block
submission entirely or corrupt today's live cash-drawer session.

This app no longer uses fixtures for custom fields (see
bp/patches/v1_0/add_customer_location_fields.py for the precedent) --
create_custom_fields(update=True) is non-destructive and safe to re-run.

NOT no_copy: the "New Migration Order" Workspace shortcut sets this field by
appending it to the /new route's query string (?custom_is_backlog_entry=1),
which Frappe applies via frappe.route_options -- and that copy step skips any
field with no_copy=1 (same reason posting_date, which IS no_copy, can't be
prefilled this way either). No-copying this field would silently defeat the
entire launch mechanism: the URL param would be dropped, is_created_using_pos
would stay unset too, and the invoice would submit as an ordinary sale with no
Laundry Order ever created. The tradeoff this accepts: "Duplicate" on an
existing migration-entry invoice will carry the flag forward -- acceptable,
since sync_laundry_order() is idempotent per-invoice anyway.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Sales Invoice": [
		{
			"fieldname": "custom_is_backlog_entry",
			"fieldtype": "Check",
			"label": "Migration Entry (In-Progress at Cutover)",
			"insert_after": "is_pos",
			"default": "0",
			"hidden": 1,
			"no_copy": 0,
		}
	]
}


def execute():
	frappe.reload_doctype("Sales Invoice")
	create_custom_fields(CUSTOM_FIELDS, update=True)
