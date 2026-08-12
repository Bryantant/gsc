# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

"""Server API for the "Papan Kerja Laundry" page (gsc/gsc/page/laundry_workboard).

The board is item-level: each card is one `Laundry Order Item` row, dragged
between In Progress -> Ready (a rack slot) -> Completed.
"""

import frappe
from frappe import _
from frappe.utils import today

from gsc.api import normalize_phone

ITEM_STATUSES = ("In Progress", "Ready", "Completed")

# WhatsApp komplain number, part of the fixed message template below -- not a
# site setting, since it's Bry's own literal template text, not configuration.
KOMPLAIN_PHONE_DISPLAY = "081903010001"

# Completed items are only a drop target -- without a cap this query would grow
# unbounded as the shop accumulates history, so only today's are shown.
COMPLETED_LIMIT = 50

_ITEM_FIELDS = """
	loi.name, loi.parent, loi.idx, loi.item, loi.item_status, loi.rack_location,
	loi.item_name, loi.product_name, loi.brand, loi.color_material,
	loi.size_type, loi.size, loi.photo_count, loi.notes,
	lo.customer, lo.customer_name, lo.status as payment_status,
	lo.fulfillment_status, lo.target_ready_date, lo.received_at,
	cust.mobile_no
"""

# LEFT join: a Laundry Order can outlive its Customer record (or point at one
# the current user can't read), and losing the whole card over a missing phone
# number would be worse than showing it without one.
_ITEM_FROM = """
	from `tabLaundry Order Item` loi
	inner join `tabLaundry Order` lo on lo.name = loi.parent
	left join `tabCustomer` cust on cust.name = lo.customer
"""


@frappe.whitelist()
def get_board_data(customer: str | None = None) -> dict:
	"""Every Laundry Order Item that belongs on the board, pre-sorted, each with
	one thumbnail URL.

	Sort: orders with a target date first (earliest first), then orders without
	one ordered by longest-waiting. `target_ready_date` is unset on most orders
	in practice, so without the explicit NULL bucket the ordering would be
	arbitrary for nearly every row.
	"""
	frappe.has_permission("Laundry Order", "read", throw=True)

	values = {"today": today()}
	customer_clause = ""
	if customer:
		customer_clause = " and lo.customer = %(customer)s"
		values["customer"] = customer

	open_items = frappe.db.sql(
		f"""
		select {_ITEM_FIELDS}
		{_ITEM_FROM}
		where loi.item_status in ('In Progress', 'Ready'){customer_clause}
		order by
			(lo.target_ready_date is null),
			lo.target_ready_date asc,
			lo.received_at asc,
			loi.idx asc
		""",
		values,
		as_dict=True,
	)

	done_items = frappe.db.sql(
		f"""
		select {_ITEM_FIELDS}
		{_ITEM_FROM}
		where loi.item_status = 'Completed'
			and lo.modified >= %(today)s{customer_clause}
		order by lo.modified desc, loi.idx asc
		limit {COMPLETED_LIMIT}
		""",
		values,
		as_dict=True,
	)

	items = open_items + done_items
	_attach_thumbnails(items)
	_attach_whatsapp(items)

	return {"items": items, "completed_limit": COMPLETED_LIMIT}


def _attach_thumbnails(items: list[dict]) -> None:
	"""Sets `thumbnail` (first photo, oldest first) on each row in place.

	One batched File query for the whole board rather than per-card -- same
	filter shape the Laundry Order form's gallery uses.
	"""
	names = [item.name for item in items]
	if not names:
		return

	files = frappe.get_all(
		"File",
		filters={
			"attached_to_doctype": "Laundry Order Item",
			"attached_to_name": ["in", names],
			"is_folder": 0,
		},
		fields=["file_url", "attached_to_name"],
		order_by="creation asc",
	)

	first_photo = {}
	for f in files:
		first_photo.setdefault(f.attached_to_name, f.file_url)

	for item in items:
		item.thumbnail = first_photo.get(item.name)


def _attach_whatsapp(items: list[dict]) -> None:
	"""Sets `wa_phone` (normalized, or None if unusable) and `wa_message` on
	each row in place.

	Precomputed here rather than on demand from the client's "Kirim WhatsApp"
	click so the click handler can call window.open() synchronously (no fetch
	in between) -- an async gap between a click and window.open() is exactly
	what triggers popup blockers, the same problem gsc.pos.handle_whatsapp_click
	works around with a placeholder window. Precomputing sidesteps needing that
	whole placeholder-window dance, since there's no per-invoice PDF/share-key
	step here -- just a phone number and a static message.
	"""
	for item in items:
		item.wa_phone = normalize_phone(item.mobile_no)
		item.wa_message = _build_whatsapp_message(item.customer_name or item.customer)


def _build_whatsapp_message(customer_name: str) -> str:
	"""WhatsApp follow-up for an item that has reached the Ready rack.

	Intentionally NOT wrapped in _() -- same reasoning as api.py's own
	_build_message(): this is read by the customer, so it must stay Indonesian
	regardless of staff's own UI language. Text is verbatim from Bry's real
	message template -- do not reword it.
	"""
	return (
		f"Halo {customer_name}, kami mau menginformasikan bahwa item yang dikerjakan sudah selesai diproses ya.\n"
		"\n"
		"Jangan lupa ada garansi kebersihan selama 24 jam. Jika sepatu kurang bersih, silakan balas chat ini "
		"langsung untuk klaim garansi 😁🙏🏻\n"
		"\n"
		"Namun, jika ada komplain terkait pelayanan staf kami, silakan hubungi nomor khusus komplain di: "
		f"{KOMPLAIN_PHONE_DISPLAY}.\n"
		"\n"
		"Dapatkan diskon 30% untuk transaksi berikutnya! Cukup berikan review di Google melalui link ini:\n"
		"https://share.google/NVBWVpgXLYOj3FGvO\n"
		"(Catatan: Promo ini hanya bisa diklaim 1x)\n"
		"\n"
		"Thank you for always trusting us ✨"
	)


@frappe.whitelist()
def move_items(items, item_status: str, rack_location: str | None = None) -> dict:
	"""Move the given Laundry Order Item rows to `item_status`.

	`items` is a JSON list of child row names, potentially spanning several
	parent orders (a per-order drag sends every row of that order).

	Rows are grouped by parent so each Laundry Order is loaded and saved ONCE,
	no matter how many of its rows moved. Saving the parent is load-bearing,
	not incidental: it is what fires LaundryOrder.validate() ->
	set_fulfillment_status(), which re-derives fulfillment_status from the
	children and stamps ready_at/completed_at. A db_set on the child row would
	skip all of that and leave the order's status stale.
	"""
	items = frappe.parse_json(items)
	if not items:
		return {}

	if item_status not in ITEM_STATUSES:
		frappe.throw(_("Status barang tidak dikenal: {0}").format(item_status))

	# A rack slot only means anything while the item is on the rack. Moving it
	# back to In Progress or handing it over (Completed) takes it off the rack,
	# so a leftover slot code would point staff at an empty slot.
	rack_location = (rack_location or "") if item_status == "Ready" else ""

	rows_by_parent = {}
	for row in frappe.db.sql(
		"""
		select name, parent
		from `tabLaundry Order Item`
		where name in %(names)s
		""",
		{"names": tuple(items)},
		as_dict=True,
	):
		rows_by_parent.setdefault(row.parent, set()).add(row.name)

	updated = {}
	for parent, row_names in rows_by_parent.items():
		doc = frappe.get_doc("Laundry Order", parent)
		doc.check_permission("write")

		changed = False
		for row in doc.laundry_items:
			if row.name not in row_names:
				continue
			if row.item_status != item_status or (row.rack_location or "") != rack_location:
				row.item_status = item_status
				row.rack_location = rack_location
				changed = True

		if changed:
			doc.save()

		updated[parent] = {
			"fulfillment_status": doc.fulfillment_status,
			"ready_at": doc.ready_at,
			"completed_at": doc.completed_at,
		}

	return updated
