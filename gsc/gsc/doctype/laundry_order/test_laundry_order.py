# Copyright (c) 2026, Hicom System and Contributors
# See license.txt

import unittest

import frappe
from frappe.tests import IntegrationTestCase

from gsc.utils import get_service_item_groups


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

	def make_backlog_invoice(self, paid_amount):
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
		inv.append("items", {"item_code": self.service_item, "qty": 1, "rate": 100000})
		inv.set_missing_values()
		inv.run_method("calculate_taxes_and_totals")
		inv.append("payments", {"mode_of_payment": self.mop, "amount": paid_amount})
		return inv

	def test_migration_entry_fully_paid_creates_laundry_order(self):
		"""Scenario 1: already paid off historically, item not yet collected."""
		inv = self.make_backlog_invoice(paid_amount=100000)
		inv.insert()
		inv.submit()

		self.assertEqual(str(inv.posting_date), "2026-07-20", "backdated posting_date must survive submit")
		self.assertEqual(inv.outstanding_amount, 0)
		self.assertEqual(inv.status, "Paid")

		# Never part of the live POS cash-drawer session: is_created_using_pos
		# deliberately left unset (see gsc/overrides/sales_invoice.py docstring
		# for why -- it drags in POS Opening Entry / full-payment validation).
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
