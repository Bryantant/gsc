# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Laundry Order is being reworked into a Work Order: fulfillment_status
becomes derived from Laundry Order Item.item_status instead of manually set,
and gets proper Datetime timeline fields (received_at/ready_at/completed_at).
This single post_model_sync patch handles every one-time cleanup/backfill
step that rework needs (new columns must already exist, so post_model_sync
throughout -- see the rename_field note below for why).

1. Two Custom Fields already existed live on this site from exploratory work
   via Customize Form -- custom_ready_date/custom_received_date (both plain
   Date, zero records populated) -- superseded by the new received_at/ready_at
   Datetime fields now on the doctype JSON. Removed here along with the
   field_order Property Setter that came with them, so the doctype JSON's own
   field_order takes effect again.

2. Renames estimasi_waktu_pengerjaan -> target_ready_date (it already *is*
   "Target Ready Date" -- fetched from Sales Invoice, POS-wired -- just
   renamed for naming consistency with the rest of this rework). Uses the
   real rename_field utility, not a JSON edit, because one existing record
   has data in that column.

   rename_field's own docstring says it "assumes the doctype is already
   synced" -- it looks up the NEW fieldname via frappe.get_meta(), which only
   reflects target_ready_date once schema sync has added the column. Running
   it in pre_model_sync (tried first) made meta.get_field() return None, so
   the whole call silently no-op'd (a print, not an exception -- easy to miss
   in migrate output). frappe.reload_doc() below forces this process's meta
   to pick up the new JSON immediately, so rename_field can find the field.

3. item_status backfill for existing Laundry Order Item rows, derived from
   each row's PARENT's existing (manually-set) fulfillment_status -- not a
   blanket "In Progress" default -- so historical orders that staff had
   already marked Ready/Completed under the old manual system don't silently
   regress to "In Progress" after this migration:

     parent fulfillment_status in (Ready to Collect, Completed) -> item_status = Ready
     parent fulfillment_status = In Progress                    -> item_status = In Progress

   Deliberately does NOT re-run LaundryOrder.validate()/the new derivation
   across existing records -- that would apply the stricter "Completed needs
   a delivery photo" gate retroactively and could downgrade some historical
   Completed orders that lack one. item_status is backfilled directly via
   SQL and existing fulfillment_status values are left untouched; the new
   derivation takes over prospectively, from each record's next real save.

4. received_at backfill for existing Laundry Orders with no value -> creation
   (best available proxy).

Idempotent throughout (every step checks existence/emptiness first), safe to
re-run.
"""

import frappe
from frappe.model.utils.rename_field import rename_field


def execute():
	frappe.reload_doc("gsc", "doctype", "laundry_order")
	frappe.reload_doc("gsc", "doctype", "laundry_order_item")

	for doctype, name in (
		("Custom Field", "Laundry Order-custom_ready_date"),
		("Custom Field", "Laundry Order-custom_received_date"),
		("Property Setter", "Laundry Order-main-field_order"),
	):
		if frappe.db.exists(doctype, name):
			frappe.delete_doc(doctype, name, ignore_permissions=True)

	if frappe.db.has_column("Laundry Order", "estimasi_waktu_pengerjaan") and frappe.db.has_column(
		"Laundry Order", "target_ready_date"
	):
		rename_field("Laundry Order", "estimasi_waktu_pengerjaan", "target_ready_date")

	frappe.db.sql(
		"""
		update `tabLaundry Order Item` loi
		inner join `tabLaundry Order` lo on lo.name = loi.parent
		set loi.item_status = if(lo.fulfillment_status in ('Ready to Collect', 'Completed'), 'Ready', 'In Progress')
		where ifnull(loi.item_status, '') = ''
		"""
	)

	frappe.db.sql(
		"""
		update `tabLaundry Order`
		set received_at = creation
		where received_at is null
		"""
	)
