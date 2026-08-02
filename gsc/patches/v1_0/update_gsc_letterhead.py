# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Rename the default Letter Head from "Company Letterhead - Grey" to "GSC Letter
Head" and refresh its content from gsc/templates/letter_heads/gsc_letter_head.html
(navy card matching the "GSC POS Invoice" print format's brand color, website/email/
contact lines removed per Bry's request).

Idempotent: safe to re-run. Rename only happens once (old name is looked up only if
the new name doesn't already exist); content is re-synced from the repo file on
every run, same pattern as create_gsc_pos_invoice_print_format.py.
"""

import frappe

OLD_NAME = "Company Letterhead - Grey"
NEW_NAME = "GSC Letter Head"


def execute():
	if not frappe.db.exists("Letter Head", NEW_NAME) and frappe.db.exists("Letter Head", OLD_NAME):
		frappe.rename_doc("Letter Head", OLD_NAME, NEW_NAME, force=True)

	content = frappe.read_file(
		frappe.get_app_path("gsc", "templates", "letter_heads", "gsc_letter_head.html"),
		raise_not_found=True,
	)

	if frappe.db.exists("Letter Head", NEW_NAME):
		lh = frappe.get_doc("Letter Head", NEW_NAME)
	else:
		lh = frappe.new_doc("Letter Head")
		lh.name = NEW_NAME
		lh.is_default = 1

	lh.content = content
	lh.save(ignore_permissions=True)
