# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import cint

from gsc.utils import get_service_item_groups


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def laundry_item_query(doctype, txt, searchfield, start, page_len, filters):
	"""Link query for Laundry Order Item.item.

	Restricts the picker to items under the Services item-group tree, so
	staff can't accidentally attach a retail/product item to a Laundry Order.
	"""
	service_groups = get_service_item_groups()

	return frappe.db.sql(
		"""
		SELECT name, item_name
		FROM `tabItem`
		WHERE disabled = 0
		  AND item_group IN %(service_groups)s
		  AND (name LIKE %(txt)s OR item_name LIKE %(txt)s)
		ORDER BY idx DESC, name
		LIMIT %(page_len)s OFFSET %(start)s
		""",
		{
			"service_groups": service_groups,
			"txt": f"%{txt}%",
			"start": cint(start),
			"page_len": cint(page_len),
		},
	)
