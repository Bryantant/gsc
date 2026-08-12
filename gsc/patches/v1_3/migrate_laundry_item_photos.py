# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Laundry Order Item now supports up to 8 photos per row, attached as native
File records (attached_to_doctype="Laundry Order Item") instead of the old
single `attach_image_wndt` Attach Image field, which this same release drops
from the doctype JSON.

This is a pre_model_sync patch specifically so it runs BEFORE that field is
removed from the doctype -- `attach_image_wndt` needs to still be a readable
column when this executes. Any photo already uploaded there is copied into a
File record on the same row so it keeps showing up in the new item photo
gallery instead of becoming orphaned data.

Idempotent (skips a row if a File with that exact file_url is already
attached to it), safe to re-run.
"""

import os

import frappe


def execute():
	if not frappe.db.has_column("Laundry Order Item", "attach_image_wndt"):
		return

	rows = frappe.db.sql(
		"""
		select name, attach_image_wndt
		from `tabLaundry Order Item`
		where ifnull(attach_image_wndt, '') != ''
		""",
		as_dict=True,
	)

	for row in rows:
		already_attached = frappe.db.exists(
			"File",
			{
				"attached_to_doctype": "Laundry Order Item",
				"attached_to_name": row.name,
				"file_url": row.attach_image_wndt,
			},
		)
		if already_attached:
			continue

		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"attached_to_doctype": "Laundry Order Item",
				"attached_to_name": row.name,
				"file_url": row.attach_image_wndt,
				"file_name": os.path.basename(row.attach_image_wndt),
				"is_private": 0,
			}
		)
		file_doc.insert(ignore_permissions=True)
