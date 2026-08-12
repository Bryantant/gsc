# Copyright (c) 2026, Hicom System and Contributors
# See license.txt

import json
import unittest

import frappe
from frappe.tests import IntegrationTestCase

from gsc.utils import get_service_item_groups
from gsc.workboard import move_items


# On IntegrationTestCase, the doctype test records and all
# link-field test record dependencies are recursively loaded
# Use these module variables to add/remove to/from that list
EXTRA_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]
IGNORE_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]


class IntegrationTestLaundryOrder(IntegrationTestCase):
	"""
	Integration tests for LaundryOrder.
	Use this class for testing interactions between multiple components.
	"""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.customer = frappe.db.get_value("Customer", {}, "name")
		cls.company = frappe.db.get_value("Company", {}, "name")
		cls.mop = frappe.db.get_value("Mode of Payment Account", {"company": cls.company}, "parent") or "Cash"
		service_groups = get_service_item_groups()
		cls.service_item = frappe.db.get_value("Item", {"item_group": ["in", service_groups]}, "name")
		if not (cls.customer and cls.company and cls.service_item):
			raise unittest.SkipTest(
				"Site is missing a Customer/Company/Services-group Item fixture needed for this test"
			)

	def make_backlog_invoice(self, paid_amount, qty=1):
		"""Build (but don't insert) a migration-entry Sales Invoice: is_pos + the
		custom_is_backlog_entry opt-in, backdated posting_date -- mirrors what the
		'New Migration Order' Workspace shortcut pre-fills, per
		gsc/patches/v1_2/add_backlog_sales_invoice_field.py.
		"""
		inv = frappe.new_doc("Sales Invoice")
		inv.customer = self.customer
		inv.company = self.company
		inv.is_pos = 1
		inv.custom_is_backlog_entry = 1
		inv.posting_date = "2026-07-20"
		# Required for the backdated posting_date to actually stick -- otherwise
		# core's TransactionBase.validate_posting_time() silently resets it to
		# today, since Sales Invoice ships with "Edit Posting Date and Time"
		# defaulting to unchecked. This tripped me up during manual verification;
		# asserted explicitly below so a regression here fails loudly.
		inv.set_posting_time = 1
		inv.append("items", {"item_code": self.service_item, "qty": qty, "rate": 100000})
		inv.set_missing_values()
		inv.run_method("calculate_taxes_and_totals")
		inv.append("payments", {"mode_of_payment": self.mop, "amount": paid_amount})
		return inv

	def make_laundry_order(self, item_count=2):
		"""Submit a backlog invoice with `item_count` physical items (one row
		per unit, see gsc.overrides.sales_invoice._build_laundry_item_rows) and
		return the resulting Laundry Order doc, freshly loaded."""
		inv = self.make_backlog_invoice(paid_amount=100000 * item_count, qty=item_count)
		inv.insert()
		inv.submit()
		name = frappe.db.get_value("Laundry Order", {"sales_invoice": inv.name}, "name")
		return frappe.get_doc("Laundry Order", name)

	def test_migration_entry_fully_paid_creates_laundry_order(self):
		"""Scenario 1: already paid off historically, item not yet collected."""
		inv = self.make_backlog_invoice(paid_amount=100000)
		inv.insert()
		inv.submit()

		self.assertEqual(str(inv.posting_date), "2026-07-20", "backdated posting_date must survive submit")
		self.assertEqual(inv.outstanding_amount, 0)
		self.assertEqual(inv.status, "Paid")

		# Migration entries stay off the POS screen's "Recent Orders" list, which
		# filters on is_created_using_pos. (That flag no longer drags in POS
		# Opening Entry / full-payment validation -- see
		# gsc/overrides/sales_invoice.py::GSCSalesInvoice -- but keeping cutover
		# data distinguishable is still worth its own flag.)
		self.assertFalse(inv.is_created_using_pos)
		self.assertFalse(inv.pos_closing_entry)

		laundry_order = frappe.db.get_value(
			"Laundry Order", {"sales_invoice": inv.name}, ["name", "fulfillment_status"], as_dict=True
		)
		self.assertIsNotNone(laundry_order, "submitting a migration entry must auto-create a Laundry Order")
		self.assertEqual(laundry_order.fulfillment_status, "In Progress")

	def test_migration_entry_partial_payment_leaves_outstanding_balance(self):
		"""Scenario 2: not fully paid, item not yet collected."""
		inv = self.make_backlog_invoice(paid_amount=40000)
		inv.insert()
		inv.submit()

		self.assertEqual(inv.outstanding_amount, 60000)
		self.assertNotEqual(inv.status, "Paid")

		laundry_order = frappe.db.exists("Laundry Order", {"sales_invoice": inv.name})
		self.assertTrue(laundry_order, "a Laundry Order must still be created even when unpaid")

	def test_pickup_and_delivery_proof_photos_are_optional(self):
		"""Pickup/Delivery Proof Photo used to be mandatory-if-checked (JSON
		mandatory_depends_on + validate_conditional_photos() both enforced it).
		Both were removed -- staff can now tick Pickup/Delivery without a photo
		on hand yet. Regression guard: this must save without frappe.throw."""
		inv = self.make_backlog_invoice(paid_amount=100000)
		inv.insert()
		inv.submit()

		laundry_order_name = frappe.db.get_value("Laundry Order", {"sales_invoice": inv.name}, "name")
		laundry_order = frappe.get_doc("Laundry Order", laundry_order_name)
		laundry_order.is_pickup = 1
		laundry_order.is_delivery = 1
		laundry_order.save()

		laundry_order.reload()
		self.assertEqual(laundry_order.is_pickup, 1)
		self.assertEqual(laundry_order.is_delivery, 1)
		self.assertFalse(laundry_order.pickup_proof_photo)
		self.assertFalse(laundry_order.delivery_proof_photo)

	def test_new_laundry_order_items_default_to_in_progress(self):
		"""item_status on a freshly auto-created row must default In Progress
		(the Select field's own default, applied by Frappe on row creation) so
		the order-level status derivation has something sane to start from."""
		laundry_order = self.make_laundry_order(item_count=2)
		self.assertEqual(laundry_order.fulfillment_status, "In Progress")
		self.assertIsNotNone(laundry_order.received_at, "received_at must be stamped on insert")
		for row in laundry_order.laundry_items:
			self.assertEqual(row.item_status, "In Progress")

	def test_mixed_item_status_keeps_order_in_progress(self):
		"""One item Ready, one still In Progress -> order must stay In Progress
		(any non-Ready item blocks the aggregate status)."""
		laundry_order = self.make_laundry_order(item_count=2)
		laundry_order.laundry_items[0].item_status = "Ready"
		laundry_order.save()

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "In Progress")
		self.assertIsNone(laundry_order.ready_at)

	def test_all_items_ready_stays_ready_to_collect(self):
		"""All items Ready (not yet Completed) -> Ready to Collect. Independent
		of is_pickup/is_delivery -- those are informational-only now and must
		NOT influence the derivation, even when left completely unset."""
		laundry_order = self.make_laundry_order(item_count=2)
		for row in laundry_order.laundry_items:
			row.item_status = "Ready"
		laundry_order.save()

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Ready to Collect")
		self.assertIsNotNone(laundry_order.ready_at)
		self.assertIsNone(laundry_order.completed_at)

	def test_mixed_ready_and_completed_stays_ready_to_collect(self):
		"""One item handed over (Completed), one only Ready -- not everyone has
		been handed their item yet, so the order must stay Ready to Collect."""
		laundry_order = self.make_laundry_order(item_count=2)
		laundry_order.laundry_items[0].item_status = "Completed"
		laundry_order.laundry_items[1].item_status = "Ready"
		laundry_order.save()

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Ready to Collect")
		self.assertIsNone(laundry_order.completed_at)

	def test_all_items_completed_marks_order_completed_without_delivery(self):
		"""Every item Completed (handed over to the customer) -> order
		Completed, with no is_pickup/is_delivery/proof-photo involved at all --
		this is the per-item signal that replaced the old delivery-photo gate."""
		laundry_order = self.make_laundry_order(item_count=2)
		for row in laundry_order.laundry_items:
			row.item_status = "Completed"
		laundry_order.save()

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Completed")
		self.assertIsNotNone(laundry_order.ready_at)
		self.assertIsNotNone(laundry_order.completed_at)
		self.assertFalse(laundry_order.is_delivery)
		self.assertFalse(laundry_order.delivery_proof_photo)

	def test_workboard_move_to_ready_sets_rack_and_derives_parent_status(self):
		"""The workboard's move endpoint must save the PARENT so the derived
		fulfillment_status recomputes -- a direct child write would leave the
		order stale. Moving every item to Ready + a rack slot must land the
		order on Ready to Collect and stamp ready_at."""
		laundry_order = self.make_laundry_order(item_count=2)
		rows = [row.name for row in laundry_order.laundry_items]

		updated = move_items(json.dumps(rows), "Ready", "B-02")

		self.assertEqual(updated[laundry_order.name]["fulfillment_status"], "Ready to Collect")

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Ready to Collect")
		self.assertIsNotNone(laundry_order.ready_at)
		for row in laundry_order.laundry_items:
			self.assertEqual(row.item_status, "Ready")
			self.assertEqual(row.rack_location, "B-02")

	def test_workboard_partial_move_keeps_order_in_progress(self):
		"""Moving only some of an order's items must not advance the order."""
		laundry_order = self.make_laundry_order(item_count=2)
		first_row = laundry_order.laundry_items[0].name

		move_items(json.dumps([first_row]), "Ready", "A-01")

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "In Progress")
		self.assertEqual(laundry_order.laundry_items[0].item_status, "Ready")
		self.assertEqual(laundry_order.laundry_items[0].rack_location, "A-01")
		self.assertEqual(laundry_order.laundry_items[1].item_status, "In Progress")

	def test_workboard_move_to_completed_clears_rack_location(self):
		"""Handover takes the item off the rack, so its slot must be released --
		a leftover slot code would send staff to an empty slot."""
		laundry_order = self.make_laundry_order(item_count=1)
		rows = [row.name for row in laundry_order.laundry_items]

		move_items(json.dumps(rows), "Ready", "C-03")
		laundry_order.reload()
		self.assertEqual(laundry_order.laundry_items[0].rack_location, "C-03")

		move_items(json.dumps(rows), "Completed")

		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Completed")
		self.assertIsNotNone(laundry_order.completed_at)
		self.assertEqual(laundry_order.laundry_items[0].item_status, "Completed")
		self.assertFalse(laundry_order.laundry_items[0].rack_location)

	def test_moving_backwards_clears_stale_milestone_timestamps(self):
		"""An item can regress (mis-drag on the workboard, or a finished shoe
		sent back for rework). The milestone timestamps must follow it back
		down, otherwise an order that is demonstrably not ready still reports a
		'Waktu Barang Siap' and the turnaround figures are wrong."""
		laundry_order = self.make_laundry_order(item_count=1)
		rows = [row.name for row in laundry_order.laundry_items]

		move_items(json.dumps(rows), "Completed")
		laundry_order.reload()
		self.assertIsNotNone(laundry_order.ready_at)
		self.assertIsNotNone(laundry_order.completed_at)

		# Completed -> Ready to Collect: only completed_at is no longer true.
		move_items(json.dumps(rows), "Ready", "A-01")
		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "Ready to Collect")
		self.assertIsNotNone(laundry_order.ready_at)
		self.assertIsNone(laundry_order.completed_at)

		# Back to In Progress: neither milestone has been reached.
		move_items(json.dumps(rows), "In Progress")
		laundry_order.reload()
		self.assertEqual(laundry_order.fulfillment_status, "In Progress")
		self.assertIsNone(laundry_order.ready_at)
		self.assertIsNone(laundry_order.completed_at)

	def test_workboard_rejects_unknown_item_status(self):
		"""Guard against a stale/renamed zone in the page JS silently writing
		garbage into item_status."""
		laundry_order = self.make_laundry_order(item_count=1)
		rows = [row.name for row in laundry_order.laundry_items]

		with self.assertRaises(frappe.ValidationError):
			move_items(json.dumps(rows), "Bogus Status")

	def test_ordinary_invoice_does_not_create_laundry_order(self):
		"""Guard on the on_submit hook's gate: neither is_created_using_pos nor
		custom_is_backlog_entry set -- e.g. a normal desk-created credit sale --
		must NOT auto-create a Laundry Order."""
		inv = frappe.new_doc("Sales Invoice")
		inv.customer = self.customer
		inv.company = self.company
		inv.append("items", {"item_code": self.service_item, "qty": 1, "rate": 100000})
		inv.set_missing_values()
		inv.insert()
		inv.submit()

		self.assertFalse(frappe.db.exists("Laundry Order", {"sales_invoice": inv.name}))
