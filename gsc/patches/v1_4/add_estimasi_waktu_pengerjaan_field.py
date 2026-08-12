# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Add "Estimasi Waktu Pengerjaan" (estimated ready-for-pickup date) to
Sales Invoice, set from the POS cart -- see
gsc/public/js/point_of_sale.js::gsc.pos.ensure_estimasi_waktu_control.

NOT reqd=1 here: the ask was for this to be mandatory "saat ingin submit" --
at the moment of POS submission -- not for every Sales Invoice everywhere
(desk-created invoices, migration/backlog entries, Data Import). Making the
DocType field itself reqd=1 would block all of those too. Enforcement is
instead client-side only, wrapping Payment.prototype.validate_reqd_invoice_
fields in point_of_sale.js -- the same choke point core's own POS "Complete
Order" button and its Ctrl+Enter shortcut both already funnel through for
their own required-field checks.

No default: the ask was explicitly for this to start blank on every new
order, unlike posting_date (which defaults to today). Leaving `default`
unset is sufficient -- a new Sales Invoice simply has no value for a field
with no default.

The matching read-only field on Laundry Order (fetch_from this field) is
defined directly on that doctype's own JSON, not via a patch -- see
gsc/gsc/doctype/laundry_order/laundry_order.json. Laundry Order is a gsc-owned
doctype, so its own fields don't go through Custom Field / create_custom_fields
the way a field added onto a core doctype like Sales Invoice does.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Sales Invoice": [
		{
			"fieldname": "custom_estimasi_waktu_pengerjaan",
			"fieldtype": "Date",
			"label": "Estimasi Waktu Pengerjaan",
			"insert_after": "customer",
			"no_copy": 0,
		}
	]
}


def execute():
	frappe.reload_doctype("Sales Invoice")
	create_custom_fields(CUSTOM_FIELDS, update=True)
