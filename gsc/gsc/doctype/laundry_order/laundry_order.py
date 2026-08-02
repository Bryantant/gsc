# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class LaundryOrder(Document):
	def validate(self):
		self.set_total_items()
		self.validate_conditional_photos()

	def set_total_items(self):
		"""Row count of laundry_items, not a qty sum -- one row is already one
		physical item (see gsc.overrides.sales_invoice._build_laundry_item_rows),
		so counting rows is correct even though the child table itself carries
		no qty field. Recomputed on every save, so it self-heals on Kanban-drag
		updates too (those go through frappe.client.set_value -> doc.save()).
		"""
		self.total_items = len(self.laundry_items or [])

	def validate_conditional_photos(self):
		"""mandatory_depends_on in the doctype JSON only enforces this in the
		Desk form (client-side) -- it's not checked by core's
		_get_missing_mandatory_fields(), which only looks at static reqd=1.
		Any other entry point (API, Kanban drag-driven set_value, etc.) would
		silently skip it without this explicit check.
		"""
		if self.is_pickup and not self.pickup_proof_photo:
			frappe.throw(_("Pickup Proof Photo is required when Pickup is checked"))

		if self.is_delivery and not self.delivery_proof_photo:
			frappe.throw(_("Delivery Proof Photo is required when Delivery is checked"))
