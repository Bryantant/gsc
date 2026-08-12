// Copyright (c) 2026, Hicom System and contributors
// For license information, please see license.txt

/**
 * Papan Kerja Laundry -- item-level drag & drop workstation.
 *
 * Each card is one `Laundry Order Item` row (its `name` doubles as the
 * card's key -- there is no per-order card anymore). Staff drag between
 * three zones: In Progress (list) -> Ready (the racks, one drop target per
 * slot/tier) -> Completed (handover at the counter). Holding Shift while
 * clicking selects multiple cards; dragging any selected card moves the
 * whole selection together.
 *
 * Persistence goes through gsc.workboard.move_items, which saves the PARENT
 * Laundry Order so its derived fulfillment_status recomputes. Never write
 * item_status via a direct db write -- see gsc/workboard.py.
 */

frappe.provide("gsc.workboard");

// Rack 1 -- the freestanding grid: 3 columns x 5 rows = 15 slots, unlimited
// items per slot. Slot codes are row-letter + column-number ("A-01".."E-03").
const RACK_ROWS = ["A", "B", "C", "D", "E"];
const RACK_COLS = 3;

// Rack 2 -- the wall rack: 3 open shelves, items sit side by side on each.
// Codes are prefixed "RD" (Rak Dinding) so they can never collide with the
// grid's A-E rows. These two constants are the only place rack layout lives.
const WALL_TIERS = [
	{ code: "RD-1", label: __("Tingkat 1 (atas)") },
	{ code: "RD-2", label: __("Tingkat 2") },
	{ code: "RD-3", label: __("Tingkat 3 (bawah)") },
];

const ZONE_STATUS = {
	"in-progress": "In Progress",
	rack: "Ready",
	completed: "Completed",
};

frappe.pages["laundry-workboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Papan Kerja Laundry"),
		single_column: true,
	});
	wrapper.workboard = new gsc.workboard.Workboard(page);
};

frappe.pages["laundry-workboard"].on_page_show = function (wrapper) {
	// Items also move from the Laundry Order form / POS, so re-read on every
	// re-entry rather than trusting the state from when the page first loaded.
	wrapper.workboard && wrapper.workboard.refresh();
};

gsc.workboard.Workboard = class Workboard {
	constructor(page) {
		this.page = page;
		this.search_text = "";
		this.selected = new Set();
		this.items = [];
		this.sortables = [];

		this.setup_header();
		this.setup_layout();
		this.refresh();
	}

	setup_header() {
		// A plain free-text filter, deliberately NOT a Link field: staff need
		// to find a customer by typing part of a NAME or a PHONE NUMBER and
		// see every matching item at once, the way the "ID" quick-filter on
		// the Laundry Order list view works -- one person can have several
		// phone numbers on file here, which a Link (must resolve to one exact
		// Customer record) can't surface in a single search. Filtering runs
		// entirely client-side against the already-loaded board, so it's
		// instant and never waits on a round trip.
		this.search_field = this.page.add_field({
			fieldname: "customer_search",
			label: __("Pelanggan"),
			fieldtype: "Data",
			placeholder: __("Cari nama atau no. HP..."),
		});

		let debounce;
		this.search_field.$input.on("input", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				this.search_text = (this.search_field.$input.val() || "").trim().toLowerCase();
				this.render();
			}, 150);
		});

		this.page.set_primary_action(__("Muat Ulang"), () => this.refresh(), "refresh");
	}

	setup_layout() {
		this.$board = $(`
			<div class="gsc-workboard">
				<section class="gsc-wb-col gsc-wb-col-progress">
					<div class="gsc-wb-col-head">
						<span class="gsc-wb-col-title">${__("Dikerjakan")}</span>
						<span class="gsc-wb-count" data-count="in-progress">0</span>
					</div>
					<div class="gsc-wb-drop gsc-wb-list" data-zone="in-progress"></div>
				</section>

				<section class="gsc-wb-col gsc-wb-col-rack">
					<div class="gsc-wb-col-head">
						<span class="gsc-wb-col-title">${__("Siap / Di Rak")}</span>
						<span class="gsc-wb-count" data-count="rack">0</span>
					</div>
					<div class="gsc-wb-unplaced-wrap">
						<div class="gsc-wb-unplaced-label">${__("Belum ditempatkan")}</div>
						<div class="gsc-wb-drop gsc-wb-unplaced" data-zone="rack" data-slot=""></div>
					</div>
					<div class="gsc-wb-rack"></div>
					<div class="gsc-wb-wall">
						<div class="gsc-wb-wall-title">${__("Rak Dinding (3 Tingkat)")}</div>
						${WALL_TIERS.map(
							(tier) => `
							<div class="gsc-wb-shelf">
								<div class="gsc-wb-shelf-label">${tier.label}</div>
								<div class="gsc-wb-drop gsc-wb-shelf-items" data-zone="rack" data-slot="${tier.code}"></div>
								<div class="gsc-wb-shelf-board"></div>
							</div>`
						).join("")}
					</div>
				</section>

				<section class="gsc-wb-col gsc-wb-col-done">
					<div class="gsc-wb-col-head">
						<span class="gsc-wb-col-title">${__("Selesai")}</span>
						<span class="gsc-wb-count" data-count="completed">0</span>
					</div>
					<div class="gsc-wb-drop gsc-wb-list" data-zone="completed"></div>
					<div class="gsc-wb-hint">${__("Hanya menampilkan yang selesai hari ini")}</div>
				</section>
			</div>
		`).appendTo(this.page.main);

		this.$board.find(".gsc-wb-rack").html(
			RACK_ROWS.map(
				(row) => `
			<div class="gsc-wb-rack-row">
				${Array.from({ length: RACK_COLS }, (_, i) => {
					const slot = `${row}-${String(i + 1).padStart(2, "0")}`;
					return `
					<div class="gsc-wb-slot">
						<div class="gsc-wb-slot-label">${slot}</div>
						<div class="gsc-wb-drop gsc-wb-slot-items" data-zone="rack" data-slot="${slot}"></div>
					</div>`;
				}).join("")}
			</div>`
			).join("")
		);

		// Delegated so everything survives every re-render. Shift+click always
		// means "toggle selection", on ANY part of the card -- so the thumb
		// and WhatsApp button only intercept a plain click and let a Shift
		// one bubble up to the card-level handler below.
		this.$board.on("click", ".gsc-wb-thumb", (e) => {
			if (e.shiftKey) return;
			e.stopPropagation();
			this.open_photos($(e.currentTarget).closest(".gsc-wb-card").attr("data-key"));
		});

		this.$board.on("click", ".gsc-wb-wa-btn", (e) => {
			if (e.shiftKey) return;
			e.stopPropagation();
			e.preventDefault();
			this.send_whatsapp($(e.currentTarget));
		});

		this.$board.on("click", ".gsc-wb-card", (e) => {
			const $card = $(e.currentTarget);
			const key = $card.attr("data-key");
			if (e.shiftKey) {
				this.toggle_selection(key);
				return;
			}
			const order = $card.attr("data-order");
			if (order) frappe.set_route("Form", "Laundry Order", order);
		});
	}

	refresh() {
		return frappe.xcall("gsc.workboard.get_board_data").then((r) => {
			this.items = (r && r.items) || [];
			this.render();
		});
	}

	// ------------------------------------------------------------ selection

	toggle_selection(key) {
		if (this.selected.has(key)) {
			this.selected.delete(key);
		} else {
			this.selected.add(key);
		}
		this.render();
	}

	// ---------------------------------------------------------------- render

	render() {
		this.destroy_sortables();

		let cards = this.build_item_cards();
		if (this.search_text) {
			cards = cards.filter((card) => card.search_blob.includes(this.search_text));
		}

		const buckets = { "in-progress": [], rack: {}, unplaced: [], completed: [] };
		cards.forEach((card) => {
			if (card.zone === "completed") {
				buckets.completed.push(card);
			} else if (card.zone === "rack") {
				if (card.slot) {
					(buckets.rack[card.slot] = buckets.rack[card.slot] || []).push(card);
				} else {
					buckets.unplaced.push(card);
				}
			} else {
				buckets["in-progress"].push(card);
			}
		});

		this.paint(this.$board.find('[data-zone="in-progress"]'), buckets["in-progress"]);
		this.paint(this.$board.find(".gsc-wb-unplaced"), buckets.unplaced);
		this.paint(this.$board.find('[data-zone="completed"]'), buckets.completed);

		// Covers both racks -- every drop zone carrying a non-empty slot code.
		this.$board.find('[data-zone="rack"]').each((_, el) => {
			const $el = $(el);
			const slot = $el.attr("data-slot") || "";
			if (!slot) return; // the unplaced holding area, painted above
			this.paint($el, buckets.rack[slot] || []);
		});

		this.$board.find('[data-count="in-progress"]').text(buckets["in-progress"].length);
		this.$board
			.find('[data-count="rack"]')
			.text(
				buckets.unplaced.length +
					Object.values(buckets.rack).reduce((sum, list) => sum + list.length, 0)
			);
		this.$board.find('[data-count="completed"]').text(buckets.completed.length);

		this.make_sortables();
	}

	paint($zone, cards) {
		$zone.html(cards.map((card) => this.card_html(card)).join(""));
	}

	/**
	 * Drops a value that carries no actual information. Some rows have a bare
	 * "-" stored as the size, which would otherwise render as "hoka-putih--".
	 */
	static meaningful(value) {
		const text = (value || "").trim();
		return /[a-z0-9]/i.test(text) ? text : "";
	}

	/** One card per Laundry Order Item row -- the only card shape now. */
	build_item_cards() {
		const clean = gsc.workboard.Workboard.meaningful;

		return this.items.map((item) => {
			const size = `${clean(item.size_type)}${clean(item.size)}`;
			const title =
				[clean(item.brand), clean(item.color_material), size].filter(Boolean).join("-") ||
				clean(item.product_name) ||
				item.item_name ||
				item.item;

			// Dedup: on most records the Customer's id IS the phone number, so
			// name and mobile_no can be the same string.
			const subtitle = [item.customer_name, item.mobile_no]
				.filter(Boolean)
				.filter((value, i, all) => all.indexOf(value) === i)
				.join(" · ");

			return {
				key: item.name,
				order: item.parent,
				zone: this.zone_for_status(item.item_status),
				slot: item.rack_location || "",
				title: title,
				subtitle: subtitle,
				meta: [item.product_name, item.item_name].filter(Boolean).join(" · "),
				photo_count: item.photo_count || 0,
				thumbnail: item.thumbnail,
				target_ready_date: item.target_ready_date,
				wa_phone: item.wa_phone,
				wa_message: item.wa_message,
				search_blob: [item.customer_name, item.mobile_no, item.customer]
					.filter(Boolean)
					.join(" ")
					.toLowerCase(),
			};
		});
	}

	zone_for_status(status) {
		if (status === "Completed") return "completed";
		if (status === "Ready") return "rack";
		return "in-progress";
	}

	card_html(card) {
		const esc = frappe.utils.escape_html;
		const thumb = card.thumbnail
			? `<img class="gsc-wb-thumb" src="${encodeURI(card.thumbnail)}" loading="lazy">`
			: `<div class="gsc-wb-thumb gsc-wb-thumb-empty">${esc(__("Tanpa foto"))}</div>`;

		let date_badge = "";
		if (card.target_ready_date) {
			const overdue = frappe.datetime.get_diff(card.target_ready_date, frappe.datetime.get_today()) < 0;
			date_badge = `<span class="gsc-wb-date ${overdue ? "is-overdue" : ""}">${esc(
				frappe.datetime.str_to_user(card.target_ready_date)
			)}</span>`;
		}

		// Only in the Ready zone -- the point staff actually notify the
		// customer is once the item is sitting on a rack, not before.
		const wa_button =
			card.zone === "rack"
				? `<button type="button" class="btn gsc-wb-wa-btn"
					data-wa-phone="${esc(card.wa_phone || "")}" data-wa-message="${esc(card.wa_message || "")}"
					title="${esc(__("Kirim WhatsApp ke pelanggan"))}">${__("WA")}</button>`
				: "";

		const selected_cls = this.selected.has(card.key) ? " gsc-wb-card-selected" : "";

		return `
			<div class="gsc-wb-card${selected_cls}" data-key="${esc(card.key)}" data-order="${esc(card.order || "")}"
				title="${esc(__("Klik untuk buka order · Shift+klik untuk pilih beberapa"))}">
				${thumb}
				<div class="gsc-wb-card-body">
					<div class="gsc-wb-card-title">${esc(card.title || "")}</div>
					<div class="gsc-wb-card-sub">${esc(card.subtitle || "")}</div>
					<div class="gsc-wb-card-meta">
						${card.meta ? `<span>${esc(card.meta)}</span>` : ""}
						${card.photo_count ? `<span class="gsc-wb-photos">${card.photo_count} 📷</span>` : ""}
						${date_badge}
					</div>
					${wa_button}
				</div>
			</div>
		`;
	}

	// ------------------------------------------------------------ drag & drop

	destroy_sortables() {
		this.sortables.forEach((s) => {
			try {
				s.destroy();
			} catch (e) {
				// already detached with the DOM it was bound to
			}
		});
		this.sortables = [];
	}

	make_sortables() {
		// Sortable is a desk-wide global (frappe libs.bundle.js) -- no require.
		this.$board.find(".gsc-wb-drop").each((_, el) => {
			this.sortables.push(
				Sortable.create(el, {
					group: "gsc-laundry-items",
					animation: 150,
					draggable: ".gsc-wb-card",
					ghostClass: "gsc-wb-card-ghost",
					onEnd: (evt) => this.handle_drop(evt),
				})
			);
		});
	}

	handle_drop(evt) {
		const $to = $(evt.to);
		const $from = $(evt.from);
		const zone = $to.attr("data-zone");
		const slot = $to.attr("data-slot") || "";
		const item_status = ZONE_STATUS[zone];

		if (!item_status) return;

		// Same container -> pure reordering, nothing to persist (the board has
		// no manual sort order of its own).
		if (evt.from === evt.to) return;
		if ($from.attr("data-zone") === zone && ($from.attr("data-slot") || "") === slot) return;

		const dragged_key = $(evt.item).attr("data-key");
		if (!dragged_key) return;

		// Dragging a card that's part of a multi-selection moves the whole
		// selection together; otherwise it's just that one card.
		const rows =
			this.selected.has(dragged_key) && this.selected.size > 1
				? this.items.filter((item) => this.selected.has(item.name)).map((item) => item.name)
				: [dragged_key];

		frappe.dom.freeze(__("Memindahkan..."));
		frappe
			.xcall("gsc.workboard.move_items", {
				items: rows,
				item_status: item_status,
				rack_location: slot,
			})
			.then((updated) => {
				this.apply_local_move(rows, item_status, slot, updated);
				this.selected.clear();
				this.render();
				frappe.show_alert({ message: __("Tersimpan"), indicator: "green" });
			})
			.catch(() => {
				// The card was already moved optimistically by Sortable; a full
				// reload is the simplest way to put the board back on truth.
				this.refresh();
			})
			.finally(() => frappe.dom.unfreeze());
	}

	apply_local_move(rows, item_status, slot, updated) {
		const moved = new Set(rows);
		this.items.forEach((item) => {
			if (moved.has(item.name)) {
				item.item_status = item_status;
				item.rack_location = item_status === "Ready" ? slot : "";
			}
			const parent_update = updated && updated[item.parent];
			if (parent_update) {
				item.fulfillment_status = parent_update.fulfillment_status;
			}
		});
	}

	// --------------------------------------------------------------- photos

	open_photos(key) {
		frappe
			.xcall("frappe.client.get_list", {
				doctype: "File",
				filters: {
					attached_to_doctype: "Laundry Order Item",
					attached_to_name: ["in", [key]],
					is_folder: 0,
				},
				fields: ["file_url"],
				limit_page_length: 0,
				order_by: "creation asc",
			})
			.then((files) => {
				const dialog = new frappe.ui.Dialog({
					title: __("Foto Barang"),
					size: "large",
				});
				const html = (files || []).length
					? `<div class="gsc-wb-gallery">${files
							.map(
								(f) =>
									`<img src="${encodeURI(f.file_url)}" class="gsc-wb-gallery-img">`
							)
							.join("")}</div>`
					: `<p class="text-muted">${__("Belum ada foto untuk barang ini.")}</p>`;
				$(dialog.body).html(html);
				dialog.show();
			});
	}

	// ------------------------------------------------------------ whatsapp

	send_whatsapp($btn) {
		const phone = $btn.attr("data-wa-phone");
		const message = $btn.attr("data-wa-message");

		if (!phone) {
			frappe.msgprint(__("Pelanggan ini belum memiliki nomor HP yang valid untuk WhatsApp."));
			return;
		}

		// phone/message are precomputed server-side and already sitting in the
		// DOM from the last render -- no fetch between the click and
		// window.open(), so there's no async gap for a popup blocker to catch.
		const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
		window.open(url, "_blank", "noopener");
	}
};
