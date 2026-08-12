# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""One-time fix for Contact.mobile_no values that aren't a phone number.

Some legacy Contacts (auto-created alongside a Customer) ended up with their
primary mobile row set to the Customer's legacy member-id/name instead of an
actual number, or to a local "08..." number never normalised to E.164 - see
gsc.api.normalize_phone's docstring for the shapes handled. Contact.mobile_no
is a read-only cache recomputed from the `phone_nos` child table on save (see
frappe.contacts.doctype.contact.contact.Contact.set_primary), so this patches
the primary phone_nos row and re-saves each doc rather than poking the cached
field directly, which would just get overwritten by the next edit.

Prefers the linked Customer.mobile_no (same precedence as
gsc.api._resolve_customer_phone) since that field is mandatory and kept clean
on this site; falls back to the Contact's own value for those with no
Customer link. Contacts where neither candidate normalises to a real number
(e.g. test/junk data) are left untouched and listed for manual review.

Idempotent: contacts already holding a clean "+62..." (or other E.164) number
don't match the WHERE clause and are skipped entirely.
"""

import frappe

from gsc.api import normalize_phone


def execute():
	contacts = frappe.db.sql(
		"""
		select name, mobile_no
		from `tabContact`
		where mobile_no is not null and mobile_no != ''
		and (mobile_no not like '+%%' or length(mobile_no) < 10)
		""",
		as_dict=True,
	)

	fixed = []
	skipped = []

	for row in contacts:
		customer_mobile = frappe.db.get_value(
			"Customer", {"customer_primary_contact": row.name}, "mobile_no"
		)

		normalised = None
		for candidate in (customer_mobile, row.mobile_no):
			normalised = normalize_phone(candidate)
			if normalised:
				break

		if not normalised:
			skipped.append(row.name)
			continue

		new_value = "+" + normalised
		if new_value == row.mobile_no:
			continue

		contact = frappe.get_doc("Contact", row.name)

		primary_row = next((p for p in contact.phone_nos if p.is_primary_mobile_no), None)
		if primary_row:
			primary_row.phone = new_value
		elif contact.phone_nos:
			contact.phone_nos[0].phone = new_value
			contact.phone_nos[0].is_primary_mobile_no = 1
		else:
			contact.append("phone_nos", {"phone": new_value, "is_primary_mobile_no": 1})

		contact.save(ignore_permissions=True)
		fixed.append((row.name, row.mobile_no, new_value))

	frappe.db.commit()

	print(f"[fix_contact_mobile_no_from_customer] fixed {len(fixed)} contact(s):")
	for name, old, new in fixed:
		print(f"  {name}: {old!r} -> {new!r}")

	if skipped:
		print(
			f"[fix_contact_mobile_no_from_customer] skipped {len(skipped)} contact(s) "
			f"with no recoverable number (manual review needed): {skipped}"
		)
