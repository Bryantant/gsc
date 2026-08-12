# Copyright (c) 2026, Hicom System and Contributors
# See license.txt

"""Server-side guards for the customized POS screen.

Covers the three behaviours the POS page now depends on that core does NOT
allow out of the box, all of which are enforced on the server and would
otherwise fail only at the moment a cashier presses submit:

  * submitting a POS-screen invoice with NO POS Opening Entry
    (gsc.overrides.sales_invoice.GSCSalesInvoice)
  * back-dating a POS-screen invoice
  * submitting one with nothing paid, i.e. a credit / "Hutang" sale
    (POS Profile.allow_partial_payment, set by the v1_3 patch)

plus the Laundry Order status sync that credit sales made necessary, and the
idempotency of the v1_3 patch itself.

Skips rather than fails when the site lacks the fixtures these need (a
Customer, a Services-group Item, an enabled POS Profile), matching
test_laundry_order.py.
"""

import unittest

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, flt, today

from gsc.patches.v1_3.add_credit_mode_of_payment import CREDIT_MODE_OF_PAYMENT
from gsc.utils import get_service_item_groups


class IntegrationTestPOSScreen(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()

		cls.pos_profile = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not cls.pos_profile:
			raise unittest.SkipTest("Site has no enabled POS Profile")

		cls.company = frappe.db.get_value("POS Profile", cls.pos_profile, "company")
		cls.customer = frappe.db.get_value("Customer", {}, "name")

		service_groups = get_service_item_groups()
		cls.service_item = frappe.db.get_value("Item", {"item_group": ["in", service_groups]}, "name")

		if not (cls.company and cls.customer and cls.service_item):
			raise unittest.SkipTest(
				"Site is missing a Customer/Company/Services-group Item fixture needed for this test"
			)

		# The whole POS customization assumes Sales Invoice mode; under
		# "POS Invoice" core's validate_created_using_pos throws outright.
		if frappe.db.get_single_value("POS Settings", "invoice_type") == "POS Invoice":
			raise unittest.SkipTest("POS Settings.invoice_type is 'POS Invoice'; these tests assume Sales Invoice")

	def make_pos_invoice(self, posting_date=None, paid=True):
		"""Build (not insert) an invoice shaped exactly like the POS screen's.

		Mirrors pos_controller.js make_invoice_frm: is_pos + is_created_using_pos
		+ pos_profile, with the payments table populated from the profile by
		set_missing_values() the same way set_pos_data does on the client.
		"""
		inv = frappe.new_doc("Sales Invoice")
		inv.customer = self.customer
		inv.company = self.company
		inv.is_pos = 1
		inv.is_created_using_pos = 1
		inv.pos_profile = self.pos_profile

		if posting_date:
			# Without set_posting_time, validate_posting_time() silently rewrites
			# posting_date back to today -- the same trap the "Tanggal Transaksi"
			# control has to work around client-side.
			inv.set_posting_time = 1
			inv.posting_date = posting_date

		inv.append("items", {"item_code": self.service_item, "qty": 1, "rate": 100000})
		inv.set_missing_values()
		inv.run_method("calculate_taxes_and_totals")

		total = flt(inv.rounded_total) or flt(inv.grand_total)
		for row in inv.payments:
			row.amount = 0
		if paid and inv.payments:
			inv.payments[0].amount = total

		inv.run_method("calculate_taxes_and_totals")
		return inv

	def void_open_shifts(self):
		"""Guarantee core would have thrown, so these tests stay meaningful.

		A site that still has an Open POS Opening Entry from before this change
		(or one created by hand) would satisfy core's validation anyway, and
		every assertion below would pass without the override doing anything.
		IntegrationTestCase rolls the transaction back, so this only ever
		affects the test.
		"""
		open_entries = frappe.get_all(
			"POS Opening Entry", filters={"pos_profile": self.pos_profile, "status": "Open"}, pluck="name"
		)
		for name in open_entries:
			frappe.db.set_value("POS Opening Entry", name, "status", "Closed", update_modified=False)

		self.assertEqual(
			frappe.db.count("POS Opening Entry", {"pos_profile": self.pos_profile, "status": "Open"}), 0
		)

	def test_pos_invoice_submits_without_pos_opening_entry(self):
		"""Core throws 'POS Opening Entry Missing' here; GSCSalesInvoice doesn't."""
		self.void_open_shifts()

		inv = self.make_pos_invoice()
		inv.insert()
		inv.submit()

		self.assertEqual(inv.docstatus, 1)
		self.assertFalse(inv.pos_closing_entry)
		self.assertTrue(
			frappe.db.exists("Laundry Order", {"sales_invoice": inv.name}),
			"a POS-screen sale must still auto-create its Laundry Order",
		)

	def test_backdated_pos_invoice_keeps_posting_date(self):
		"""The other half of removing the shift check: core's
		validate_pos_opening_entry required an Open entry dated TODAY, which
		transitively pinned every POS invoice to today's posting_date."""
		self.void_open_shifts()

		backdated = add_days(today(), -3)
		inv = self.make_pos_invoice(posting_date=backdated)
		inv.insert()
		inv.submit()

		self.assertEqual(str(inv.posting_date), str(backdated))
		self.assertEqual(inv.set_posting_time, 1)

	def test_credit_sale_leaves_full_outstanding_and_writes_no_payment_gl(self):
		"""Tapping "Hutang (Bayar Nanti)" zeroes every payment row client-side;
		this is the server-side result of that."""
		self.void_open_shifts()

		inv = self.make_pos_invoice(paid=False)
		inv.insert()
		inv.submit()

		total = flt(inv.rounded_total) or flt(inv.grand_total)
		self.assertEqual(flt(inv.paid_amount), 0)
		self.assertEqual(flt(inv.outstanding_amount), total)
		self.assertIn(inv.status, ("Unpaid", "Overdue"))

		# make_pos_gl_entries guards each payment row with `if
		# payment_mode.base_amount:`, so a zeroed credit row must post nothing --
		# the receivable comes from the invoice's own debit_to as usual.
		credit_account = frappe.db.get_value(
			"Mode of Payment Account",
			{"parent": CREDIT_MODE_OF_PAYMENT, "company": self.company},
			"default_account",
		)
		if credit_account:
			payment_gl = frappe.db.count(
				"GL Entry",
				{"voucher_no": inv.name, "account": credit_account, "credit": [">", 0]},
			)
			self.assertEqual(payment_gl, 0, "a zero-amount credit payment row must not post a GL entry")

	def test_laundry_order_status_follows_invoice_after_payment(self):
		"""Laundry Order.status is a fetch_from SNAPSHOT, taken when the Laundry
		Order is saved. Credit sales are the first case where the invoice's
		status moves afterwards, so gsc.overrides.payment_entry has to push it."""
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		self.void_open_shifts()

		inv = self.make_pos_invoice(paid=False)
		inv.insert()
		inv.submit()

		laundry_order = frappe.db.get_value("Laundry Order", {"sales_invoice": inv.name}, "name")
		self.assertTrue(laundry_order)
		self.assertIn(frappe.db.get_value("Laundry Order", laundry_order, "status"), ("Unpaid", "Overdue"))

		payment_entry = get_payment_entry("Sales Invoice", inv.name)
		payment_entry.reference_no = "GSC-TEST"
		payment_entry.reference_date = today()
		payment_entry.insert()
		payment_entry.submit()

		inv.reload()
		self.assertEqual(inv.status, "Paid")
		self.assertEqual(
			frappe.db.get_value("Laundry Order", laundry_order, "status"),
			"Paid",
			"settling the invoice must refresh the Laundry Order's payment status snapshot",
		)

	def test_credit_mode_of_payment_patch_is_idempotent(self):
		"""Runs on every `bench migrate`, so re-running must not duplicate rows."""
		from gsc.patches.v1_3.add_credit_mode_of_payment import execute

		execute()
		execute()

		self.assertEqual(frappe.db.count("Mode of Payment", {"name": CREDIT_MODE_OF_PAYMENT}), 1)
		self.assertLessEqual(
			frappe.db.count(
				"Mode of Payment Account",
				{"parent": CREDIT_MODE_OF_PAYMENT, "company": self.company},
			),
			1,
		)
		self.assertEqual(
			frappe.db.count(
				"POS Payment Method",
				{
					"parent": self.pos_profile,
					"parenttype": "POS Profile",
					"mode_of_payment": CREDIT_MODE_OF_PAYMENT,
				},
			),
			1,
		)
		self.assertTrue(frappe.db.get_value("POS Profile", self.pos_profile, "allow_partial_payment"))
