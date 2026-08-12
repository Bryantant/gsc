# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Converts Contact Person mobile/phone numbers from E.164 ("+62...") back
to local Indonesian format ("0..."), per Bry's request - the site is
standardising on local format for Contact Person display.

Only touches numbers that actually start with "+62": non-Indonesian Contacts
(e.g. "+65...", "+16469384323") are left untouched, matching the same
country-code awareness as gsc.api.normalize_phone.

Updates all three places a Contact's number lives so they stay in sync -
mobile_no and phone on the parent, plus the phone_nos child rows (see
frappe.contacts.doctype.contact.contact.Contact.set_primary - the parent
fields are a cache recomputed from this child table on every save, so
leaving it stale would just get overwritten back to "+62..." the next time
someone edits the contact).

Idempotent: re-running only matches rows still starting with "+62".
"""

import frappe


def execute():
	before = frappe.db.count("Contact", {"mobile_no": ["like", "+62%"]})

	frappe.db.sql(
		"""
		update `tabContact`
		set mobile_no = concat('0', substring(mobile_no, 4))
		where mobile_no like '+62%%'
		"""
	)
	frappe.db.sql(
		"""
		update `tabContact`
		set phone = concat('0', substring(phone, 4))
		where phone like '+62%%'
		"""
	)
	frappe.db.sql(
		"""
		update `tabContact Phone`
		set phone = concat('0', substring(phone, 4))
		where phone like '+62%%'
		"""
	)

	frappe.db.commit()

	after = frappe.db.count("Contact", {"mobile_no": ["like", "+62%"]})
	print(
		f"[convert_contact_mobile_no_to_local_format] converted {before - after} "
		f"contact(s) from +62 to local 0 format ({after} still starting with +62)"
	)
