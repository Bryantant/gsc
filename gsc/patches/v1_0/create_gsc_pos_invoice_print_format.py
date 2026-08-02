# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Create/refresh the "GSC POS Invoice" Custom HTML/Jinja Print Format for Sales
Invoice, and set it as the doctype's default print format on this site (replacing
"Sales Invoice with Item Image").

HTML/CSS source lives in gsc/templates/print_formats/gsc_pos_invoice.{html,css}
(real repo files, not fixtures) and is copied verbatim into the Print Format's
html/css fields here, so re-running this patch after editing a template re-syncs
the DB copy.

Idempotent: safe to re-run.
"""

import frappe
from frappe.custom.doctype.property_setter.property_setter import make_property_setter


def execute():
	html = frappe.read_file(
		frappe.get_app_path("gsc", "templates", "print_formats", "gsc_pos_invoice.html"),
		raise_not_found=True,
	)
	css = frappe.read_file(
		frappe.get_app_path("gsc", "templates", "print_formats", "gsc_pos_invoice.css"),
		raise_not_found=True,
	)

	if frappe.db.exists("Print Format", "GSC POS Invoice"):
		pf = frappe.get_doc("Print Format", "GSC POS Invoice")
	else:
		pf = frappe.new_doc("Print Format")
		pf.name = "GSC POS Invoice"

	pf.update(
		{
			"doc_type": "Sales Invoice",
			"module": "GSC",
			"print_format_type": "Jinja",
			"custom_format": 1,
			"print_format_builder": 0,
			"standard": "No",
			"disabled": 0,
			"pdf_generator": "wkhtmltopdf",
			"page_number": "Hide",
			"margin_top": 8,
			"margin_bottom": 8,
			"margin_left": 8,
			"margin_right": 8,
			"html": html,
			"css": css,
		}
	)
	pf.save(ignore_permissions=True)

	make_property_setter("Sales Invoice", None, "default_print_format", "GSC POS Invoice", "Data")
