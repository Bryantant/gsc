// Copyright (c) 2026, Hicom System and contributors
// For license information, please see license.txt

const MAX_ITEM_PHOTOS = 8;
const LAUNDRY_GALLERY_STYLE_ID = "laundry-order-gallery-style";

frappe.ui.form.on("Laundry Order", {
	refresh(frm) {
		// Rows only ever come from the Sales Invoice submit hook -- staff edit
		// existing rows (brand/size/photos/etc) but never add their own.
		frm.get_field("laundry_items").grid.cannot_add_rows = true;
		frm.get_field("laundry_items").grid.refresh();

		render_item_gallery(frm);
	},

	laundry_items_remove(frm) {
		render_item_gallery(frm);
	},
});

frappe.ui.form.on("Laundry Order Item", {
	manage_photos(frm, cdt, cdn) {
		const row = locals[cdt][cdn];

		if (!row.name || row.name.startsWith("new-")) {
			frappe.msgprint(__("Simpan pesanan terlebih dahulu sebelum menambahkan foto."));
			return;
		}

		frappe.call({
			method: "frappe.client.get_count",
			args: {
				doctype: "File",
				filters: {
					attached_to_doctype: "Laundry Order Item",
					attached_to_name: row.name,
				},
			},
		}).then((r) => {
			const existing = r.message || 0;
			const remaining = MAX_ITEM_PHOTOS - existing;

			if (remaining <= 0) {
				frappe.msgprint(__("Sudah mencapai batas maksimal {0} foto untuk barang ini.", [MAX_ITEM_PHOTOS]));
				return;
			}

			new frappe.ui.FileUploader({
				doctype: "Laundry Order Item",
				docname: row.name,
				folder: "Home/Attachments",
				allow_multiple: true,
				restrictions: {
					max_number_of_files: remaining,
					allowed_file_types: ["image/*"],
				},
				on_success() {
					refresh_photo_count(frm, cdt, cdn);
				},
			});
		});
	},

	view_in_gallery(frm, cdt, cdn) {
		const row = locals[cdt][cdn];

		if (!row.name || row.name.startsWith("new-")) {
			frappe.msgprint(__("Simpan pesanan terlebih dahulu untuk melihat galeri."));
			return;
		}

		const target = document.getElementById(gallery_item_id(row.name));
		if (!target) {
			frappe.msgprint(__("Galeri belum tersedia untuk barang ini."));
			return;
		}

		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.classList.add("laundry-gallery-item-highlight");
		setTimeout(() => target.classList.remove("laundry-gallery-item-highlight"), 1500);
	},
});

function refresh_photo_count(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	frappe.call({
		method: "frappe.client.get_count",
		args: {
			doctype: "File",
			filters: {
				attached_to_doctype: "Laundry Order Item",
				attached_to_name: row.name,
			},
		},
	}).then((r) => {
		frappe.model.set_value(cdt, cdn, "photo_count", r.message || 0);
		render_item_gallery(frm);
	});
}

function render_item_gallery(frm) {
	const wrapper = frm.get_field("item_gallery_html");
	if (!wrapper) return;

	ensure_gallery_style();

	const rows = (frm.doc.laundry_items || []).filter((row) => row.name && !row.name.startsWith("new-"));

	if (!rows.length) {
		wrapper.$wrapper.html(`<p class="text-muted">${__("Belum ada barang.")}</p>`);
		return;
	}

	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "File",
			filters: {
				attached_to_doctype: "Laundry Order Item",
				attached_to_name: ["in", rows.map((row) => row.name)],
				is_folder: 0,
			},
			fields: ["file_url", "attached_to_name"],
			limit_page_length: 0,
			order_by: "creation asc",
		},
	}).then((r) => {
		const photos_by_row = {};
		(r.message || []).forEach((file) => {
			photos_by_row[file.attached_to_name] = photos_by_row[file.attached_to_name] || [];
			photos_by_row[file.attached_to_name].push(file.file_url);
		});

		const blocks = rows
			.map((row) => build_item_gallery_block(row, photos_by_row[row.name] || []))
			.join("");

		wrapper.$wrapper.html(`<div class="laundry-gallery">${blocks}</div>`);

		wrapper.$wrapper.find(".laundry-gallery-thumb").on("click", function () {
			open_photo_preview($(this).attr("data-full"));
		});
	});
}

function gallery_item_id(row_name) {
	return `laundry-gallery-item-${row_name}`;
}

function build_item_gallery_block(row, photos) {
	const main_title = frappe.utils.escape_html(
		[row.product_name, row.brand].filter(Boolean).join(" · ") ||
			row.item_name ||
			row.item ||
			__("Barang")
	);
	const sub_title = frappe.utils.escape_html(
		[row.item_name, row.size_type, row.size].filter(Boolean).join(" · ")
	);
	const title_html = `
		<div class="laundry-gallery-item-title">
			<div class="laundry-gallery-item-title-main">${main_title}</div>
			${sub_title ? `<div class="laundry-gallery-item-title-sub">${sub_title}</div>` : ""}
		</div>
	`;

	if (!photos.length) {
		return `
			<div class="laundry-gallery-item" id="${gallery_item_id(row.name)}">
				${title_html}
				<p class="text-muted laundry-gallery-empty">${__("Belum ada foto")}</p>
			</div>
		`;
	}

	const [first, ...rest] = photos;
	const small_photos = rest
		.map(
			(url) =>
				`<img class="laundry-gallery-thumb laundry-gallery-thumb-sm" src="${url}" data-full="${url}">`
		)
		.join("");

	return `
		<div class="laundry-gallery-item" id="${gallery_item_id(row.name)}">
			${title_html}
			<div class="laundry-gallery-photos">
				<img class="laundry-gallery-thumb laundry-gallery-thumb-lg" src="${first}" data-full="${first}">
				${small_photos ? `<div class="laundry-gallery-thumb-wrap">${small_photos}</div>` : ""}
			</div>
		</div>
	`;
}

function open_photo_preview(url) {
	const dialog = new frappe.ui.Dialog({
		title: __("Foto"),
		size: "large",
	});
	$(dialog.body).html(
		`<img src="${url}" style="max-width:100%;height:auto;display:block;margin:0 auto;">`
	);
	dialog.show();
}

function ensure_gallery_style() {
	if (document.getElementById(LAUNDRY_GALLERY_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = LAUNDRY_GALLERY_STYLE_ID;
	style.textContent = `
		.laundry-gallery-item {
			margin-bottom: 16px;
			padding-bottom: 16px;
			border-bottom: 1px solid var(--border-color);
		}
		.laundry-gallery-item:last-child {
			border-bottom: none;
		}
		.laundry-gallery-item-title {
			margin-bottom: 8px;
		}
		.laundry-gallery-item-title-main {
			font-weight: 600;
		}
		.laundry-gallery-item-title-sub {
			color: var(--text-muted);
			font-size: var(--text-sm, 12px);
		}
		.laundry-gallery-item-highlight {
			animation: laundry-gallery-flash 1.5s ease;
		}
		@keyframes laundry-gallery-flash {
			0%, 100% { background-color: transparent; }
			25% { background-color: var(--bg-yellow, #fff3cd); }
		}
		/* Laundry Order Item grid: row-selection checkboxes aren't needed here --
		   rows only ever come from the Sales Invoice hook, never bulk-managed.
		   .row-index ("No.") is sticky-positioned at a hardcoded left:31px in
		   core CSS, assuming .row-check is visible and occupies that space --
		   with it hidden, .row-index must be re-pinned to left:0 or it renders
		   31px right of its natural position and its opaque sticky background
		   masks/clips the start of the next column's content underneath it. */
		[data-fieldname="laundry_items"] .row-check {
			display: none !important;
		}
		[data-fieldname="laundry_items"] .row-index {
			left: 0 !important;
		}
		.laundry-gallery-photos {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			align-items: flex-start;
		}
		.laundry-gallery-thumb {
			object-fit: cover;
			border-radius: var(--border-radius-md, 6px);
			cursor: pointer;
			border: 1px solid var(--border-color);
		}
		.laundry-gallery-thumb-lg {
			width: 220px;
			height: 220px;
		}
		.laundry-gallery-thumb-wrap {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			max-width: 220px;
		}
		.laundry-gallery-thumb-sm {
			width: 70px;
			height: 70px;
		}
		.laundry-gallery-empty {
			margin: 0;
		}
	`;
	document.head.appendChild(style);
}
