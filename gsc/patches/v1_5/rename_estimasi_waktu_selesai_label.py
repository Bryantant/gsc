# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Relabel Sales Invoice.custom_estimasi_waktu_pengerjaan to "Estimasi Waktu
Selesai" (was "Estimasi Waktu Pengerjaan").

A follow-up patch rather than an edit to
gsc/patches/v1_4/add_estimasi_waktu_pengerjaan_field.py: that patch already
ran and is recorded in Patch Log on any site that migrated before this
change, so editing it in place would not update anything there -- `bench
migrate` never re-runs a patch already marked executed. Fieldname is
unchanged (custom_estimasi_waktu_pengerjaan) -- this is a display-label-only
rename, not a schema rename; see gsc/public/js/point_of_sale.js's note on
gsc.pos.ESTIMASI_WAKTU_LABEL.

The matching Laundry Order field's label lives directly in that doctype's
own JSON (gsc/gsc/doctype/laundry_order/laundry_order.json), not here --
Laundry Order is gsc-owned, so its field labels sync straight off the JSON on
every migrate and need no patch of their own.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Sales Invoice": [
		{
			"fieldname": "custom_estimasi_waktu_pengerjaan",
			"fieldtype": "Date",
			"label": "Estimasi Waktu Selesai",
			"insert_after": "customer",
			"no_copy": 0,
		}
	]
}


def execute():
	frappe.reload_doctype("Sales Invoice")
	create_custom_fields(CUSTOM_FIELDS, update=True)
