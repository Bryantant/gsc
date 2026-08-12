# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Sets Laundry Order Item.photo_count from actual attached File records.

Runs in post_model_sync (after the `photo_count` column exists) and after
gsc.patches.v1_3.migrate_laundry_item_photos (pre_model_sync) has copied any
legacy attach_image_wndt values into File attachments -- so this single
count-by-attachment query covers both migrated and newly-uploaded photos.

Safe to re-run: it's a plain recompute, not additive.
"""

import frappe


def execute():
	frappe.reload_doc("gsc", "doctype", "laundry_order_item")

	frappe.db.sql(
		"""
		update `tabLaundry Order Item` loi
		set photo_count = (
			select count(*) from `tabFile` f
			where f.attached_to_doctype = 'Laundry Order Item'
			and f.attached_to_name = loi.name
			and f.is_folder = 0
		)
		"""
	)
