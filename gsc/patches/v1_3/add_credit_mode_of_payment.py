# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Add a "Hutang (Bayar Nanti)" payment method to the POS screen.

Lets the counter hand over the laundry and collect later: tapping this mode
zeroes every payment row (see gsc/public/js/point_of_sale.js), so the invoice
submits with paid_amount 0 and outstanding = grand total, landing on Unpaid /
Overdue. The existing "Bayar Sisa" button on the POS order summary then
settles it via a normal Payment Entry -- no new settlement flow needed.

Idempotent at every step, so re-running on migrate is a no-op.

Three non-obvious requirements, each of which breaks the POS if skipped:

1. `type` must NOT be "Cash". POS Closing Entry and the cash-drawer reports
   bucket by Mode of Payment.type, and this mode never receives money.
   "General" is the honest label.

2. A Mode of Payment Account row per company is MANDATORY, not optional.
   get_mode_of_payments_info (erpnext .../sales_invoice.py) only returns modes
   that have an account row for the invoice's company; misses land in
   `invalid_modes` and update_multi_mode_option throws "Missing Account" -- on
   *every* new POS invoice, not just credit ones. default_receivable_account
   (Debtors) is used because it never actually posts: make_pos_gl_entries
   guards each row with `if payment_mode.base_amount:` and this row is always
   0, so the receivable comes from the invoice's own debit_to as usual.

3. The POS Profile row must have default=0. focus_on_default_mop
   (pos_payment.js) auto-clicks the default mode on every checkout, which
   would silently turn every sale into a credit sale.

POS Profile.allow_partial_payment is also switched on here, because it is the
single flag both submit gates read: the client one in pos_payment.js (via
get_pos_profile_data -> settings.allow_partial_payment) and the server one,
SalesInvoice.validate_full_payment. Without it a 0-payment invoice cannot be
submitted at all.
"""

import frappe

CREDIT_MODE_OF_PAYMENT = "Hutang (Bayar Nanti)"


def execute():
	_create_mode_of_payment()

	pos_profiles = frappe.get_all("POS Profile", filters={"disabled": 0}, pluck="name")
	if not pos_profiles:
		return

	companies = {frappe.db.get_value("POS Profile", name, "company") for name in pos_profiles}
	for company in companies:
		if company:
			_ensure_company_account(company)

	for name in pos_profiles:
		_add_to_pos_profile(name)


def _create_mode_of_payment():
	if frappe.db.exists("Mode of Payment", CREDIT_MODE_OF_PAYMENT):
		return

	# autoname is field:mode_of_payment, so name == CREDIT_MODE_OF_PAYMENT.
	frappe.get_doc(
		{
			"doctype": "Mode of Payment",
			"mode_of_payment": CREDIT_MODE_OF_PAYMENT,
			"type": "General",
			"enabled": 1,
		}
	).insert(ignore_permissions=True)


def _ensure_company_account(company):
	"""Attach the company's receivable account to the mode, once."""
	mode = frappe.get_doc("Mode of Payment", CREDIT_MODE_OF_PAYMENT)
	if any(row.company == company for row in mode.accounts):
		return

	account = frappe.db.get_value("Company", company, "default_receivable_account")
	if not account:
		frappe.log_error(
			title="GSC: credit Mode of Payment not configured",
			message=(
				f"Company {company} has no default_receivable_account, so "
				f"'{CREDIT_MODE_OF_PAYMENT}' could not be given an account row. "
				"Set one and re-run gsc.patches.v1_3.add_credit_mode_of_payment, "
				"otherwise every new POS invoice will throw 'Missing Account'."
			),
		)
		return

	mode.append("accounts", {"company": company, "default_account": account})
	mode.flags.ignore_permissions = True
	mode.save()


def _add_to_pos_profile(pos_profile):
	profile = frappe.get_doc("POS Profile", pos_profile)

	changed = False

	if not any(row.mode_of_payment == CREDIT_MODE_OF_PAYMENT for row in profile.payments):
		# default=0: focus_on_default_mop would otherwise preselect credit on
		# every checkout. allow_in_returns=0: you cannot refund into a debt.
		profile.append(
			"payments",
			{"mode_of_payment": CREDIT_MODE_OF_PAYMENT, "default": 0, "allow_in_returns": 0},
		)
		changed = True

	if not profile.allow_partial_payment:
		profile.allow_partial_payment = 1
		changed = True

	if changed:
		profile.flags.ignore_permissions = True
		profile.save()
