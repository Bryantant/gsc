# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Public helpers for the GSC customisations.

get_invoice_whatsapp_link() backs the "WhatsApp Receipt" button that
gsc/public/js/point_of_sale.js injects into the POS order-summary screen.
It mints (or reuses) a Document Share Key for the invoice and returns a
guest-readable PDF URL together with a ready-to-send Indonesian message.
"""

import re
from urllib.parse import urlencode

import frappe
from frappe import _
from frappe.utils import add_days, escape_html, fmt_money, formatdate, get_url, getdate

# Doctypes the POS can produce a receipt for. Anything else must not be able
# to mint a share key through this endpoint.
ALLOWED_DOCTYPES = ("Sales Invoice", "POS Invoice")

# How long a freshly minted link stays valid.
SHARE_KEY_VALIDITY_DAYS = 30

# Reuse an existing key when it still has at least this many days left.
# Document.get_document_share_key() only reuses a row when expires_on matches
# EXACTLY, so calling it with a freshly computed "today + 30" would insert a
# brand new Document Share Key row every calendar day for every invoice.
SHARE_KEY_MIN_REMAINING_DAYS = 7

# wa.me needs digits-only E.164 without the leading "+".
MIN_PHONE_DIGITS = 8
MAX_PHONE_DIGITS = 15

# Indonesian mobile written without country code or leading zero, e.g.
# "81234567890". Only this shape gets an implicit 62.
ID_BARE_MOBILE = re.compile(r"^8\d{7,11}$")


@frappe.whitelist()
def get_invoice_whatsapp_link(doctype: str, name: str) -> dict:
	"""Return the WhatsApp payload for an invoice.

	{phone, phone_display, customer_name, invoice_no, pdf_url, expires_on, message}
	"""
	if doctype not in ALLOWED_DOCTYPES:
		frappe.throw(
			_("Struk WhatsApp tidak tersedia untuk dokumen {0}.").format(doctype),
			title=_("Tidak Didukung"),
		)

	doc = frappe.get_doc(doctype, name)

	# Minting a Document Share Key makes this PDF readable by anyone holding
	# the URL, so gate it on the same right the desk requires to print the
	# document. Note "read" alone is not a gate here: the `All` role has
	# read=1 on Sales Invoice, so every logged-in user would pass it.
	frappe.has_permission(doctype, "read", doc=doc, throw=True)
	if not frappe.has_permission(doctype, "print", doc=doc):
		frappe.throw(
			_("Anda tidak memiliki izin untuk mencetak faktur ini."),
			frappe.PermissionError,
		)

	if doc.docstatus != 1:
		frappe.throw(
			_("Faktur belum disubmit, struk belum bisa dikirim."),
			title=_("Faktur Belum Final"),
		)

	phone = _resolve_customer_phone(doc)
	key, expires_on = _get_or_create_share_key(doc)
	pdf_url = _build_pdf_url(doc, key)

	return {
		"phone": phone,
		"phone_display": "+" + phone,
		"customer_name": doc.get("customer_name") or doc.get("customer"),
		"invoice_no": doc.name,
		"pdf_url": pdf_url,
		"expires_on": formatdate(expires_on, "dd-MM-yyyy"),
		"message": _build_message(doc, pdf_url, expires_on),
	}


# ---------------------------------------------------------------------------
# phone
# ---------------------------------------------------------------------------


def _resolve_customer_phone(doc) -> str:
	"""Read the customer's mobile number and normalise it for wa.me.

	Customer.mobile_no is the primary source (mandatory on this site via
	Property Setter). Legacy imported rows can still have it blank, so fall
	back to the linked primary Contact, whose mobile_no is clean E.164.

	Never derive the number from doc.customer / Customer.name: although
	Customer.autoname is field:mobile_no, legacy rows are named after a
	member id (e.g. 27965704) instead of a phone number.
	"""
	customer = doc.get("customer")
	if not customer:
		frappe.throw(_("Faktur ini tidak memiliki pelanggan."), title=_("Data Tidak Lengkap"))

	values = (
		frappe.db.get_value(
			"Customer",
			customer,
			["mobile_no", "customer_primary_contact", "customer_name"],
			as_dict=True,
		)
		or frappe._dict()
	)

	candidates = [values.get("mobile_no")]

	if values.get("customer_primary_contact"):
		contact = (
			frappe.db.get_value(
				"Contact",
				values.get("customer_primary_contact"),
				["mobile_no", "phone"],
				as_dict=True,
			)
			or frappe._dict()
		)
		candidates += [contact.get("mobile_no"), contact.get("phone")]

	for raw in candidates:
		normalised = normalize_phone(raw)
		if normalised:
			return normalised

	label = values.get("customer_name") or customer

	# Distinguish "no number at all" from "number present but unusable", so
	# the cashier knows whether to add a number or fix an existing one.
	if any((raw or "").strip() for raw in candidates):
		frappe.throw(
			_("Nomor HP pelanggan {0} tidak valid: {1}. Mohon perbaiki di data pelanggan.").format(
				label, escape_html((candidates[0] or "").strip())
			),
			title=_("Nomor Tidak Valid"),
		)

	frappe.throw(
		_("Pelanggan {0} belum memiliki nomor HP. Mohon lengkapi data pelanggan terlebih dahulu.").format(
			label
		),
		title=_("Nomor HP Kosong"),
	)


def normalize_phone(raw: str | None) -> str | None:
	"""Return digits-only E.164 without '+', or None if unusable.

	  '+62 812-3456-7890' -> '6281234567890'   strip +, keep country code
	  '081234567890'      -> '6281234567890'   local 0 -> 62
	  '006281234567890'   -> '6281234567890'   00 international prefix
	  '6281234567890'     -> '6281234567890'   already E.164
	  '81234567890'       -> '6281234567890'   bare ID mobile
	  '+6596452149'       -> '6596452149'      Singapore, NOT re-prefixed
	  '+16469384323'      -> '16469384323'     US, NOT re-prefixed
	  '778'               -> None              junk, rejected
	"""
	if not raw:
		return None

	value = str(raw).strip()
	if not value:
		return None

	# A leading + is the only reliable "already carries a country code"
	# marker, so capture it before stripping punctuation.
	has_plus = value.startswith("+")
	digits = re.sub(r"\D", "", value)
	if not digits:
		return None

	if has_plus:
		# Explicit country code: trust it verbatim, whatever country it is.
		pass
	elif digits.startswith("00"):
		digits = digits[2:]
	elif digits.startswith("0"):
		digits = "62" + digits[1:]
	elif digits.startswith("62"):
		pass
	elif ID_BARE_MOBILE.match(digits):
		digits = "62" + digits
	else:
		# No country code and not an Indonesian mobile shape. Refuse rather
		# than guess and message a stranger.
		return None

	if not (MIN_PHONE_DIGITS <= len(digits) <= MAX_PHONE_DIGITS):
		return None

	return digits


# ---------------------------------------------------------------------------
# share key + url
# ---------------------------------------------------------------------------


def _get_or_create_share_key(doc):
	"""Return (key, expires_on), reusing a still-comfortably-valid key."""
	today = getdate()

	existing = frappe.get_all(
		"Document Share Key",
		filters={
			"reference_doctype": doc.doctype,
			"reference_docname": doc.name,
			"expires_on": (">=", add_days(today, SHARE_KEY_MIN_REMAINING_DAYS)),
		},
		fields=["key", "expires_on"],
		order_by="expires_on desc",
		limit=1,
	)
	if existing:
		return existing[0].key, existing[0].expires_on

	expires_on = add_days(today, SHARE_KEY_VALIDITY_DAYS)
	# get_document_share_key() inserts with ignore_permissions=True.
	return doc.get_document_share_key(expires_on=expires_on), expires_on


def _get_print_format() -> str | None:
	"""Print format for the shared PDF.

	Deliberately NOT the POS Profile receipt format: POS formats are narrow
	thermal-printer strips and look broken as an A4 PDF. Returning None makes
	printview fall back to Sales Invoice.default_print_format (set to
	"Sales Invoice with Item Image" on this site via Property Setter), else
	"Standard".

	Override per-site in site_config.json:
	    "gsc_whatsapp_print_format": "GSC Invoice A4"
	"""
	return frappe.conf.get("gsc_whatsapp_print_format") or None


def _build_pdf_url(doc, key: str) -> str:
	"""Guest-readable PDF URL.

	frappe.utils.print_format.download_pdf is @frappe.whitelist(allow_guest=True);
	its gate is validate_print_permission(), which accepts a ?key= matching a
	Document Share Key row for this document.
	"""
	params = {
		"doctype": doc.doctype,
		"name": doc.name,
		"format": _get_print_format(),
		"key": key,
	}
	query = urlencode({k: v for k, v in params.items() if v})
	return get_url("/api/method/frappe.utils.print_format.download_pdf") + "?" + query


# ---------------------------------------------------------------------------
# message
# ---------------------------------------------------------------------------


def _build_message(doc, pdf_url: str, expires_on) -> str:
	"""Build the WhatsApp body.

	Intentionally NOT wrapped in _(): the message must be Indonesian for the
	customer regardless of the cashier's own UI language.
	"""
	company = doc.get("company") or ""
	total = fmt_money(doc.get("grand_total") or 0, currency=doc.get("currency"))

	lines = [
		f"Halo {doc.get('customer_name') or doc.get('customer')},",
		"",
		f"Terima kasih telah berbelanja di {company}." if company else "Terima kasih telah berbelanja.",
		"Berikut struk pembelian Anda:",
		"",
		f"No. Faktur : {doc.name}",
		f"Tanggal    : {formatdate(doc.get('posting_date'), 'dd-MM-yyyy')}",
		f"Total      : {total}",
		"",
		"Unduh struk (PDF):",
		pdf_url,
		"",
		f"Tautan berlaku sampai {formatdate(expires_on, 'dd-MM-yyyy')}.",
	]
	return "\n".join(lines)
