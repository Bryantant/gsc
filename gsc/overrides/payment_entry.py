# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Keeps Laundry Order.status in step with its Sales Invoice's live status.

Laundry Order.status is a `fetch_from: sales_invoice.status` field, and Frappe
resolves fetch_from at the *fetching* document's save time (see
frappe/model/base_document.py::set_fetch_from_value, run during link
validation) -- it is a snapshot, not a live view. That was invisible while
every POS sale was paid in full at drop-off: the snapshot was always "Paid".

Credit sales ("Hutang (Bayar Nanti)", see
gsc/patches/v1_3/add_credit_mode_of_payment.py) break that assumption. The
Laundry Order is created on submit with status "Unpaid" and would keep
displaying "Unpaid" forever, because settling the invoice later touches the
Payment Entry and the Sales Invoice -- never the Laundry Order. Two visible
consequences: the Laundry Order list view / standard filter lies, and
gsc/public/js/laundry_order.js keeps offering its "Payment" button on an
already-settled order (it gates on frm.doc.status).

Note the Laundry Order Summary report is NOT affected -- it selects si.status
through a live LEFT JOIN (see laundry_order_summary.py) rather than reading
the snapshot -- and the Kanban board keys off fulfillment_status, not status.

db.set_value with update_modified=False is deliberate: this mirrors a derived
value, so it should not look like a user edit or bump the Laundry Order's
version history on every payment.
"""

import frappe


def sync_from_payment_entry(doc, method=None):
	"""doc_events on_submit/on_cancel hook for Payment Entry."""
	invoice_names = {
		ref.reference_name
		for ref in doc.get("references") or []
		if ref.reference_doctype == "Sales Invoice" and ref.reference_name
	}
	for invoice_name in invoice_names:
		sync_laundry_order_status(invoice_name)


def sync_from_sales_invoice(doc, method=None):
	"""doc_events on_update_after_submit hook for Sales Invoice.

	Covers status changes that don't go through a Payment Entry at all --
	e.g. an accountant writing off the balance, or set_status() flipping
	Unpaid -> Overdue.
	"""
	sync_laundry_order_status(doc.name, status=doc.status)


def sync_laundry_order_status(sales_invoice, status=None):
	"""Copy the invoice's current status onto its Laundry Order, if any."""
	laundry_order = frappe.db.get_value("Laundry Order", {"sales_invoice": sales_invoice}, "name")
	if not laundry_order:
		return

	if status is None:
		status = frappe.db.get_value("Sales Invoice", sales_invoice, "status")

	frappe.db.set_value("Laundry Order", laundry_order, "status", status, update_modified=False)
