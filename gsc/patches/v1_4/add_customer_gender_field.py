# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Add a 3-option Gender field to Customer, for the POS "New Customer" dialog.

A NEW field, fieldname `custom_gender`, deliberately separate from core's own
`gender` field: core's is a Link to the "Gender" doctype (a master list with
entries like Male/Female/Other/Prefer not to say/...), whereas the counter
wants exactly three fixed choices ("Pria"/"Wanita"/"-"). Reusing the core
field would mean seeding + filtering that master list down to three rows and
keeping it that way forever; a plain Select with hardcoded options is simpler
and self-contained, at the cost of a second gender-shaped field existing on
Customer. Both stay visible on the desk Customer form (core's `gender` field
depends_on customer_type=='Individual'; ours doesn't, since walk-in POS
customers are always created as Individual -- see
gsc/public/js/point_of_sale.js::gsc.pos.open_new_customer_dialog).

NOT reqd=1 here: making it mandatory at the DocType level would apply
everywhere Customer is created or re-saved (desk form, Data Import, other
Quick Entry triggers across the system), which is broader than intended.
Enforcement is instead a dialog-level `reqd` on the bespoke Customer dialog
gsc opens from the POS "+" button -- see the same function above. A Customer
created any other way is free to leave this blank.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Customer": [
		{
			"fieldname": "custom_gender",
			"fieldtype": "Select",
			"label": "Gender",
			"options": "\nPria\nWanita\n-",
			"insert_after": "customer_name",
			"default": "",
			"no_copy": 0,
		}
	]
}


def execute():
	frappe.reload_doctype("Customer")
	create_custom_fields(CUSTOM_FIELDS, update=True)
