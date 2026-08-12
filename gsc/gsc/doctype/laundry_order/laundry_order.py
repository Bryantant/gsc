# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

from frappe.model.document import Document
from frappe.utils import now_datetime


class LaundryOrder(Document):
	def before_insert(self):
		if not self.received_at:
			self.received_at = now_datetime()

	def validate(self):
		self.set_total_items()
		self.set_fulfillment_status()

	def set_total_items(self):
		"""Row count of laundry_items, not a qty sum -- one row is already one
		physical item (see gsc.overrides.sales_invoice._build_laundry_item_rows),
		so counting rows is correct even though the child table itself carries
		no qty field. Recomputed on every save, so it self-heals on Kanban-drag
		updates too (those go through frappe.client.set_value -> doc.save()).
		"""
		self.total_items = len(self.laundry_items or [])

	def set_fulfillment_status(self):
		"""fulfillment_status is derived, not staff-editable (field is
		read_only) -- Laundry Order Item.item_status is the sole source of
		truth for each physical item's progress. Recomputed on every save so
		it self-heals regardless of entry point (desk form, API).

		item_status has 3 states: In Progress -> Ready -> Completed (the last
		one meaning the item has physically been handed back to the customer,
		by whatever means). Deliberately independent of the is_pickup/
		is_delivery logistics fields -- those stay purely informational, they
		no longer gate the status: any item still In Progress -> order In
		Progress; none In Progress but not all Completed -> Ready to Collect;
		every item Completed -> order Completed.

		ready_at is stamped the first time no item is left In Progress, and
		completed_at the first time every item is Completed (same "stamp once"
		convention as before_insert's received_at) -- but each is cleared again
		if the order moves BACKWARDS past that milestone. An item can regress
		legitimately (mis-drag on the workboard, or a finished shoe sent back
		for rework), and leaving a stale "Waktu Barang Siap" on an order that
		is demonstrably not ready would misreport the shop's turnaround times.
		"""
		items = self.laundry_items or []
		if not items:
			return

		statuses = [row.item_status for row in items]

		if any(status == "In Progress" for status in statuses):
			self.fulfillment_status = "In Progress"
			self.ready_at = None
			self.completed_at = None
			return

		if not self.ready_at:
			self.ready_at = now_datetime()

		if all(status == "Completed" for status in statuses):
			self.fulfillment_status = "Completed"
			if not self.completed_at:
				self.completed_at = now_datetime()
		else:
			self.fulfillment_status = "Ready to Collect"
			self.completed_at = None
