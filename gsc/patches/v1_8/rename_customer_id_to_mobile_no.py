# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""One-time bulk rename: makes every Customer's document ID (`name`) match
its mobile_no, the same as clicking "Rename" from the desk UI (via
frappe.rename_doc, so every Link field pointing at the Customer - Sales
Invoice, Contact, Address, Payment Entry, etc. - gets updated too, not just
the tabCustomer row).

Renamed to LOCAL format ("0812...") to match this site's existing Customer
naming convention: Customer.autoname is field:mobile_no, and every
Customer created through that convention so far has ended up with a local-
format name - none of the 2537 existing Customers has a "+"-prefixed name.
Customer.mobile_no itself, however, is a mix of "+62..." (E.164) and local
"0..." values (this field was never touched by the earlier Contact-focused
patches, v1_6/v1_7), so the E.164 ones are converted to local format for
the rename target; local-format mobile_no values are used as-is.

Customers are skipped, not renamed, when:
  - mobile_no is blank (per instruction - nothing to rename to)
  - name already equals the target (no-op)
  - mobile_no is shared by more than one Customer (renaming both to the
    same ID is impossible; Bry confirmed: skip these rather than guess
    which one "wins")
  - the target name is already taken by a DIFFERENT existing Customer even
    though the raw mobile_no strings differ (e.g. one Customer stored
    "+6285150562520" and another already has the local-format ID
    "085150562520" - same phone, different format, same collision)

Idempotent: already-renamed Customers have name == mobile_no and are
skipped on re-run.
"""

import frappe
from frappe.utils.global_search import rebuild_for_doctype


def _to_local(mobile_no: str) -> str:
	if mobile_no.startswith("+62"):
		return "0" + mobile_no[3:]
	return mobile_no


def execute():
	candidates = frappe.db.sql(
		"""
		select name, mobile_no from tabCustomer
		where mobile_no is not null and mobile_no != '' and mobile_no != name
		""",
		as_dict=True,
	)

	dupe_mobile_nos = {
		row.mobile_no
		for row in frappe.db.sql(
			"""
			select mobile_no from tabCustomer
			where mobile_no is not null and mobile_no != '' and mobile_no != name
			group by mobile_no having count(*) > 1
			""",
			as_dict=True,
		)
	}

	existing_names = set(frappe.db.sql("select name from tabCustomer", pluck="name"))

	to_rename = []
	skipped_duplicate = []
	skipped_collision = []

	for row in candidates:
		if row.mobile_no in dupe_mobile_nos:
			skipped_duplicate.append(row.name)
			continue

		target = _to_local(row.mobile_no)
		if target != row.name and target in existing_names:
			skipped_collision.append((row.name, target))
			continue

		to_rename.append((row.name, target))

	renamed = []
	failed = []

	for old, new in to_rename:
		try:
			frappe.rename_doc(
				"Customer",
				old,
				new,
				rebuild_search=False,
				show_alert=False,
			)
			renamed.append((old, new))
		except Exception as e:
			failed.append((old, new, str(e)))

	rebuild_for_doctype("Customer")
	frappe.db.commit()

	print(f"[rename_customer_id_to_mobile_no] renamed {len(renamed)} customer(s)")
	print(
		f"[rename_customer_id_to_mobile_no] skipped {len(skipped_duplicate)} "
		f"(shared mobile_no across multiple customers)"
	)
	print(
		f"[rename_customer_id_to_mobile_no] skipped {len(skipped_collision)} "
		f"(target already taken by a different existing customer): {skipped_collision}"
	)
	if failed:
		print(f"[rename_customer_id_to_mobile_no] FAILED {len(failed)} rename(s):")
		for old, new, err in failed:
			print(f"  {old} -> {new}: {err}")
