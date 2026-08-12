// gsc/public/js/point_of_sale.js
//
// GSC's customizations of ERPNext's native Point of Sale page. Loaded via
// hooks.py `page_js = {"point-of-sale": "public/js/point_of_sale.js"}`.
//
// What's customized:
//   - "Create New Customer" button beside the customer search field, opening
//     a bespoke fast-entry dialog (name/mobile/gender only) instead of core's
//     shared Customer Quick Entry
//   - "WhatsApp Receipt" / "Bayar Sisa" buttons on the order summary, and a
//     Fulfillment Status control for the linked Laundry Order
//   - "Fulfillment Pending" option on the Recent Orders status filter
//   - NO POS Opening/Closing Entry (GSC runs no cashier shifts)
//   - "Tanggal Transaksi" (posting date) control in the customer section
//   - "Estimasi Waktu Selesai" control in the customer section, required
//     before an order can be submitted
//   - % / Rp toggle on both the cart and item-level discount
//   - "Hutang (Bayar Nanti)" payment mode that zeroes the paid amount
//
// HOW THE PATCHING WORKS (see gsc.pos.patch_all at the bottom of this file):
//
// Frappe appends this file to core's point_of_sale.js and evaluates both
// BEFORE calling on_page_load (page.py::load_assets, then pageview.js
// trigger_page_event) - so at eval time none of the erpnext.PointOfSale.*
// classes exist yet; they come from a lazily-required bundle.
//
// We therefore WRAP frappe.pages["point-of-sale"].on_page_load and patch
// inside our own frappe.require() callback, before handing off to core's.
// This has to be deterministic rather than a poll/retry loop, because
// Controller's constructor calls check_opening_entry() SYNCHRONOUSLY
// (pos_controller.js) - by the time any timer fired, the shift dialog would
// already be on screen and unrecoverable (prepare_app_defaults never ran, so
// there'd be no POS DOM to repair). Since frappe.require is idempotent
// (assets.js load_asset short-circuits on frappe.assets._executed), core's
// own require() call resolves from cache without a second fetch.
//
// Consequence worth knowing when adding patches here: window.cur_pos is
// guaranteed to be undefined at patch time (core assigns it inside the
// require callback we precede), so no "backfill the live instance" step is
// ever needed - patching the prototype is enough.

frappe.provide("erpnext.PointOfSale");
frappe.provide("gsc.pos");

// A BESPOKE dialog, deliberately NOT frappe.ui.form.make_quick_entry(). Core's
// Customer quick entry is a single class - frappe.ui.form.CustomerQuickEntryForm
// (erpnext/public/js/utils/customer_quick_entry.js) - shared by EVERY place in
// the system that quick-creates a Customer (Sales Order's own "+", Quotation,
// etc.), and it always injects "Primary Contact Details" / "Primary Address
// Details" sections (contact_address_quick_entry.js::get_variant_fields()).
// The counter wants a fast 3-field form with none of that - but only from
// THIS button. Overriding the shared class would strip those sections
// everywhere Customer is quick-created, well beyond the POS screen. A
// standalone dialog gets the fast form here without touching that shared
// behavior at all.
gsc.pos.open_new_customer_dialog = function (item_cart) {
	frappe.model.with_doctype("Customer", () => {
		// Reuses the Custom Field's own options string (see
		// gsc/patches/v1_4/add_customer_gender_field.py) rather than
		// hardcoding it a second time here, so the two can't drift apart.
		const gender_field = frappe.meta.get_docfield("Customer", "custom_gender");

		const dialog = new frappe.ui.Dialog({
			title: __("Pelanggan Baru"),
			fields: [
				{
					fieldname: "customer_name",
					fieldtype: "Data",
					label: __("Nama Pelanggan"),
					reqd: 1,
				},
				{
					// autoname on Customer is field:mobile_no (see the site's own
					// Property Setter) - this IS the document's name, not just a
					// contact detail. A duplicate number throws a normal
					// DuplicateEntryError on insert, which frappe.call already
					// surfaces to the cashier; the dialog stays open to retry.
					fieldname: "mobile_no",
					fieldtype: "Data",
					options: "Phone",
					label: __("No. HP"),
					reqd: 1,
				},
				{
					fieldname: "custom_gender",
					fieldtype: "Select",
					label: __("Gender"),
					options: (gender_field && gender_field.options) || "\nPria\nWanita\n-",
					reqd: 1,
				},
			],
			primary_action_label: __("Simpan"),
			primary_action: (values) => {
				frappe
					.call({
						method: "frappe.client.insert",
						args: {
							doc: {
								doctype: "Customer",
								// Not exposed in the dialog: POS walk-ins are always
								// Individual, and "Company" would need a second set of
								// fields (Company Name vs First/Last Name) this fast
								// form isn't meant to grow into.
								customer_type: "Individual",
								customer_name: values.customer_name,
								mobile_no: values.mobile_no,
								custom_gender: values.custom_gender,
							},
						},
						freeze: true,
						freeze_message: __("Menyimpan pelanggan..."),
					})
					.then((r) => {
						if (!r || !r.message) return;
						dialog.hide();
						// item_cart.customer_field IS the cart's own Link control, so
						// this fires the identical onchange chain core's Link
						// -> new_doc() would have: frappe.model.set_value ->
						// script_manager.trigger("customer") -> fetch_customer_details
						// -> customer_details_updated -> update_customer_section ->
						// update_totals_section.
						item_cart.customer_field.set_value(r.message.name);
					});
			},
		});

		dialog.show();
	});
};

gsc.pos.add_new_customer_button = function (item_cart) {
	const $customer_field = item_cart.$customer_section.find(".customer-field");

	// make_customer_selector() can rerun (e.g. reset_customer_selector()),
	// so guard against stacking up duplicate buttons on re-render.
	$customer_field.find(".gsc-new-customer-btn").remove();

	const $btn = $(`
		<button
			type="button"
			class="btn btn-default btn-sm gsc-new-customer-btn"
			title="${__("Create a New Customer")}"
			style="margin-left: var(--margin-sm); display: flex; align-items: center;"
		>
			${frappe.utils.icon("add", "xs")}
		</button>
	`);

	$btn.on("click", function () {
		gsc.pos.open_new_customer_dialog(item_cart);
	});

	$customer_field.append($btn);
};

gsc.pos.patch_item_cart_customer_selector = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.ItemCart)) {
		return;
	}

	const proto = erpnext.PointOfSale.ItemCart.prototype;

	if (!proto.__gsc_customer_btn_patched) {
		const original_make_customer_selector = proto.make_customer_selector;

		proto.make_customer_selector = function () {
			const result = original_make_customer_selector.apply(this, arguments);
			// Posting date goes first: ensure_posting_date_control() PREPENDS,
			// so calling it before add_new_customer_button() is what keeps the
			// date control above .customer-field, not the other way round.
			// ensure_estimasi_waktu_control() anchors on .customer-field itself
			// (via .after()), so its position relative to the other two calls
			// here doesn't matter.
			gsc.pos.ensure_posting_date_control(this);
			gsc.pos.add_new_customer_button(this);
			gsc.pos.ensure_estimasi_waktu_control(this);
			return result;
		};

		proto.__gsc_customer_btn_patched = true;
	}

	if (!proto.__gsc_customer_section_extras_patched) {
		// update_customer_section() is the OTHER thing that replaces
		// $customer_section's entire innerHTML - with the "customer selected"
		// card (no .customer-field at all) once a customer is picked - so both
		// controls built above get destroyed right along with it. Have to be
		// rebuilt here too, or they vanish the moment a customer is chosen.
		const original_update_customer_section = proto.update_customer_section;

		proto.update_customer_section = function () {
			const result = original_update_customer_section.apply(this, arguments);
			gsc.pos.ensure_posting_date_control(this);
			gsc.pos.ensure_estimasi_waktu_control(this);
			return result;
		};

		proto.__gsc_customer_section_extras_patched = true;
	}
};

// ---------------------------------------------------------------------------
// "WhatsApp Receipt" button on the order-summary / checkout screen
// ---------------------------------------------------------------------------
//
// erpnext.PointOfSale.PastOrderSummary renders its footer buttons from
// get_condition_btn_map(), and add_summary_btns() derives each button's CSS
// class from the FIRST WORD OF THE UNTRANSLATED LABEL
// (`b.split(" ")[0].toLowerCase()`), applying __() only to the visible text.
// So injecting the literal label "WhatsApp Receipt" yields a .whatsapp-btn
// element for free, in any UI language, with no template changes.
//
// bind_events() attaches DELEGATED handlers to $summary_container, which is
// created once in the constructor and never replaced - so a delegated
// .whatsapp-btn handler survives every add_summary_btns() re-render.

gsc.pos.WHATSAPP_LABEL = "WhatsApp Receipt";

gsc.pos.inject_whatsapp_btn = function (map) {
	// Never mutate the caller's arrays in place.
	return (map || []).map((entry) => {
		const btns = (entry.visible_btns || []).slice();
		const email_index = btns.indexOf("Email Receipt");
		if (email_index !== -1 && btns.indexOf(gsc.pos.WHATSAPP_LABEL) === -1) {
			btns.splice(email_index + 1, 0, gsc.pos.WHATSAPP_LABEL);
		}
		return Object.assign({}, entry, { visible_btns: btns });
	});
};

gsc.pos.fetch_whatsapp_payload = function (summary) {
	return frappe
		.call({
			method: "gsc.api.get_invoice_whatsapp_link",
			args: { doctype: summary.doc.doctype, name: summary.doc.name },
		})
		.then((r) => {
			if (!r || !r.message || !r.message.phone) {
				return Promise.reject(new Error("gsc: empty whatsapp payload"));
			}
			return r.message;
		});
};

gsc.pos.build_wa_url = function (payload) {
	// wa.me needs digits only, no "+", no separators - the server guarantees
	// that. encodeURIComponent handles the newlines in the message body.
	return `https://wa.me/${payload.phone}?text=${encodeURIComponent(payload.message)}`;
};

// Prefetch on summary load so the click handler can stay fully synchronous.
// This is the primary popup-blocker defence: window.open() called directly
// inside the click gesture is never blocked, whereas window.open() called
// from a promise continuation routinely is.
gsc.pos.prefetch_whatsapp_payload = function (summary) {
	if (!summary || !summary.doc || !summary.doc.name) return;

	const invoice = summary.doc.name;
	if (summary.__gsc_wa_cache && summary.__gsc_wa_cache.invoice === invoice) return;

	summary.__gsc_wa_cache = { invoice: invoice, payload: null };

	gsc.pos
		.fetch_whatsapp_payload(summary)
		.then((payload) => {
			// A newer invoice may have loaded while this was in flight.
			if (summary.__gsc_wa_cache && summary.__gsc_wa_cache.invoice === invoice) {
				summary.__gsc_wa_cache.payload = payload;
			}
		})
		.catch(() => {
			// Silent: prefetch is opportunistic. The click path retries and
			// reports the real error to the cashier.
			if (summary.__gsc_wa_cache && summary.__gsc_wa_cache.invoice === invoice) {
				summary.__gsc_wa_cache = null;
			}
		});
};

gsc.pos.show_whatsapp_fallback_dialog = function (payload) {
	const url = gsc.pos.build_wa_url(payload);
	new frappe.ui.Dialog({
		title: "Kirim Struk via WhatsApp",
		fields: [
			{
				fieldtype: "HTML",
				options: `
					<p>Ketuk tombol di bawah untuk membuka WhatsApp ke
					<b>${frappe.utils.escape_html(payload.phone_display)}</b>.</p>
					<p><a class="btn btn-primary btn-lg btn-block"
						  href="${frappe.utils.escape_html(url)}"
						  target="_blank" rel="noopener">Buka WhatsApp</a></p>
					<p class="text-muted small" style="margin-top: var(--margin-md)">
						Tautan struk berlaku sampai ${frappe.utils.escape_html(payload.expires_on)}.
					</p>`,
			},
		],
	}).show();
};

gsc.pos.open_whatsapp = function (payload, placeholder_window) {
	const url = gsc.pos.build_wa_url(payload);

	if (placeholder_window && !placeholder_window.closed) {
		// Reuse the window opened synchronously inside the gesture.
		// replace() keeps about:blank out of the tablet's back stack.
		placeholder_window.location.replace(url);
		return;
	}

	const win = window.open(url, "_blank", "noopener");
	if (!win) {
		// Popup blocked (or no gesture credit left) - hand the cashier a link
		// they can tap themselves, which always carries a fresh gesture.
		gsc.pos.show_whatsapp_fallback_dialog(payload);
	}
};

// Pull the server's frappe.throw() text out of a rejected frappe.call.
// frappe.call rejects with the jqXHR object, whose responseJSON._server_messages
// is a JSON string containing an array of JSON strings.
gsc.pos.extract_server_message = function (err) {
	try {
		const raw = err && err.responseJSON && err.responseJSON._server_messages;
		if (!raw) return null;
		const messages = JSON.parse(raw)
			.map((m) => {
				try {
					return JSON.parse(m).message;
				} catch (e) {
					return m;
				}
			})
			.filter(Boolean);
		return messages.length ? messages.join(" ") : null;
	} catch (e) {
		return null;
	}
};

gsc.pos.report_whatsapp_error = function (err) {
	// frappe.call already msgprints anything in _server_messages, so our own
	// frappe.throw() text (which names the customer whose number needs fixing)
	// is on screen already - adding it again would just duplicate it. Only
	// speak up when the failure carried no server message at all, e.g. a
	// network drop or a 500 with an empty body.
	if (gsc.pos.extract_server_message(err)) {
		return;
	}
	frappe.msgprint({
		title: "Struk WhatsApp Gagal",
		indicator: "red",
		message: "Gagal menyiapkan struk WhatsApp. Silakan coba lagi.",
	});
};

gsc.pos.handle_whatsapp_click = function (summary) {
	if (!summary || !summary.doc || !summary.doc.name) return;

	const cache = summary.__gsc_wa_cache;
	if (cache && cache.invoice === summary.doc.name && cache.payload) {
		// Fast path: still inside the click gesture, so window.open is allowed.
		gsc.pos.open_whatsapp(cache.payload);
		return;
	}

	// Slow path: prefetch missed or is still in flight. Claim a window NOW,
	// while the gesture is live, and point it at wa.me once the URL arrives.
	let placeholder = null;
	try {
		placeholder = window.open("about:blank", "_blank");
	} catch (e) {
		placeholder = null;
	}

	frappe.dom.freeze("Menyiapkan struk...");

	gsc.pos
		.fetch_whatsapp_payload(summary)
		.then((payload) => {
			frappe.dom.unfreeze();
			summary.__gsc_wa_cache = { invoice: summary.doc.name, payload: payload };
			gsc.pos.open_whatsapp(payload, placeholder);
		})
		.catch((err) => {
			frappe.dom.unfreeze();
			if (placeholder && !placeholder.closed) placeholder.close();
			// frappe.call rejects with the jqXHR, so the server's own Indonesian
			// frappe.throw() text lives in responseJSON._server_messages (a
			// JSON-encoded array of JSON-encoded objects). Surface that verbatim
			// - it tells the cashier WHICH customer record to fix - and fall
			// back to a generic line only for genuinely opaque failures.
			gsc.pos.report_whatsapp_error(err);
			console.error("gsc: whatsapp receipt failed", err);
		});
};

// Namespaced, and .off() first, so binding twice (patched bind_events AND the
// live-instance backfill) can never double-fire the handler.
gsc.pos.bind_whatsapp_handler = function (summary) {
	if (!summary || !summary.$summary_container) return;
	summary.$summary_container
		.off("click.gsc_wa", ".whatsapp-btn")
		.on("click.gsc_wa", ".whatsapp-btn", () => gsc.pos.handle_whatsapp_click(summary));
};

// ---------------------------------------------------------------------------
// "Bayar Sisa" button - create a Payment Entry for a Partly Paid/Unpaid/
// Overdue invoice directly from the Recent Orders summary, without detouring
// through "Open in Form View" -> Sales Invoice form -> Create > Payment.
// ---------------------------------------------------------------------------
//
// get_condition_btn_map() only puts "Open in Form View" in the branch for
// {Partly Paid, Overdue, Unpaid} status, so injecting next to that label
// (instead of "Email Receipt", like the WhatsApp button) naturally confines
// this to invoices that actually have something outstanding to collect.
//
// Reuses core's own whitelisted mapper method - the exact one core's Sales
// Invoice "Create > Payment" button calls (see get_method_for_payment() in
// erpnext/public/js/controllers/transaction.js) - so behavior (party
// account resolution, over-billing checks, etc.) matches the form exactly.
// No new server code needed.

gsc.pos.PAY_REMAINING_LABEL = "Bayar Sisa";

gsc.pos.inject_pay_remaining_btn = function (map) {
	return (map || []).map((entry) => {
		const btns = (entry.visible_btns || []).slice();
		const form_view_index = btns.indexOf("Open in Form View");
		if (form_view_index !== -1 && btns.indexOf(gsc.pos.PAY_REMAINING_LABEL) === -1) {
			btns.splice(form_view_index, 0, gsc.pos.PAY_REMAINING_LABEL);
		}
		return Object.assign({}, entry, { visible_btns: btns });
	});
};

gsc.pos.handle_pay_remaining_click = function (summary) {
	if (!summary || !summary.doc || !summary.doc.name) return;

	frappe
		.call({
			method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
			args: { dt: summary.doc.doctype, dn: summary.doc.name },
			freeze: true,
			freeze_message: __("Menyiapkan Payment Entry..."),
		})
		.then((r) => {
			if (!r || !r.message) return;
			// Same as core's make_mapped_payment_entry(): sync the new unsaved
			// Payment Entry into the client-side model cache, then navigate to
			// it - this leaves the POS single-page app, same as "Open in Form
			// View" already does today.
			const doclist = frappe.model.sync(r.message);
			frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
		})
		.catch((err) => {
			frappe.msgprint({
				title: __("Gagal Membuat Payment Entry"),
				indicator: "red",
				message: __("Tidak dapat membuat Payment Entry untuk faktur ini."),
			});
			console.error("gsc: pay remaining failed", err);
		});
};

gsc.pos.bind_pay_remaining_handler = function (summary) {
	if (!summary || !summary.$summary_container) return;
	summary.$summary_container
		.off("click.gsc_pay", ".bayar-btn")
		.on("click.gsc_pay", ".bayar-btn", () => gsc.pos.handle_pay_remaining_click(summary));
};

// ---------------------------------------------------------------------------
// Hide "Print Receipt" / "Email Receipt" on the order-summary screen
// ---------------------------------------------------------------------------
//
// Chained onto get_condition_btn_map AFTER inject_whatsapp_btn, so it strips
// these two regardless of which condition branch produced them (after
// submission vs Recent Orders vs Partly Paid/etc).

gsc.pos.HIDDEN_SUMMARY_BTN_LABELS = ["Print Receipt", "Email Receipt"];

gsc.pos.filter_hidden_btns = function (map) {
	return (map || []).map((entry) => {
		const btns = (entry.visible_btns || []).filter(
			(b) => !gsc.pos.HIDDEN_SUMMARY_BTN_LABELS.includes(b)
		);
		return Object.assign({}, entry, { visible_btns: btns });
	});
};

// ---------------------------------------------------------------------------
// Fulfillment Status control on the Recent Orders summary (after_submission=false)
// ---------------------------------------------------------------------------
//
// Laundry Order is a standalone doctype, one per Sales Invoice, auto-created
// on submit (see gsc.overrides.sales_invoice.create_laundry_order) so staff
// can track wash/pickup/delivery progress over the following days. This lets
// staff update that status directly from the POS "Recent Orders" screen
// instead of opening the Laundry Order's own desk form. Only shown when
// browsing a past order (after_submission=false) - right after a fresh sale
// there's nothing to update yet.

gsc.pos.ensure_fulfillment_container = function (summary) {
	if (summary.$gsc_fulfillment_container) return;
	summary.$gsc_fulfillment_container = $('<div class="gsc-fulfillment-container"></div>');
	summary.$upper_section.after(summary.$gsc_fulfillment_container);
};

gsc.pos.render_fulfillment_control = function ($container, laundry_order, options) {
	const options_html = options
		.map((opt) => {
			const selected = opt === laundry_order.fulfillment_status ? "selected" : "";
			return `<option value="${frappe.utils.escape_html(opt)}" ${selected}>${__(opt)}</option>`;
		})
		.join("");

	$container.html(`
		<div class="gsc-fulfillment-row" style="display:flex;align-items:center;gap:var(--margin-sm);padding:var(--padding-sm) 0;">
			<label style="margin:0;font-weight:600;">${__("Fulfillment Status")}</label>
			<select class="form-control gsc-fulfillment-select" style="width:auto;">
				${options_html}
			</select>
		</div>
	`);

	$container.find(".gsc-fulfillment-select").on("change", function () {
		const new_status = $(this).val();
		frappe
			.call({
				method: "frappe.client.set_value",
				args: {
					doctype: "Laundry Order",
					name: laundry_order.name,
					fieldname: "fulfillment_status",
					value: new_status,
				},
			})
			.then(() => {
				frappe.show_alert({
					message: __("Fulfillment Status updated to {0}", [__(new_status)]),
					indicator: "green",
				});
			})
			.catch((err) => {
				frappe.msgprint({
					title: __("Update Failed"),
					indicator: "red",
					message: __("Could not update Fulfillment Status."),
				});
				console.error("gsc: fulfillment status update failed", err);
			});
	});
};

gsc.pos.attach_fulfillment_control = function (summary, doc, after_submission) {
	if (!summary.$gsc_fulfillment_container) return;

	if (after_submission) {
		summary.$gsc_fulfillment_container.empty().hide();
		return;
	}

	frappe
		.call({
			method: "frappe.client.get_value",
			args: {
				doctype: "Laundry Order",
				filters: { sales_invoice: doc.name },
				fieldname: ["name", "fulfillment_status"],
			},
		})
		.then((r) => {
			// Stale-response guard: cashier may have switched to a different
			// invoice while this call was in flight.
			if (!summary.doc || summary.doc.name !== doc.name) return;

			if (!r || !r.message || !r.message.name) {
				summary.$gsc_fulfillment_container.empty().hide();
				return;
			}

			frappe.model.with_doctype("Laundry Order", () => {
				if (!summary.doc || summary.doc.name !== doc.name) return;

				const df = frappe.meta.get_docfield("Laundry Order", "fulfillment_status");
				const options = ((df && df.options) || "").split("\n").filter(Boolean);
				summary.$gsc_fulfillment_container.show();
				gsc.pos.render_fulfillment_control(
					summary.$gsc_fulfillment_container,
					r.message,
					options
				);
			});
		});
};

gsc.pos.patch_past_order_summary = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.PastOrderSummary)) {
		return;
	}

	const proto = erpnext.PointOfSale.PastOrderSummary.prototype;

	if (!proto.__gsc_whatsapp_btn_patched) {
		const original_get_condition_btn_map = proto.get_condition_btn_map;
		proto.get_condition_btn_map = function () {
			const with_whatsapp = gsc.pos.inject_whatsapp_btn(
				original_get_condition_btn_map.apply(this, arguments)
			);
			const with_payment = gsc.pos.inject_pay_remaining_btn(with_whatsapp);
			return gsc.pos.filter_hidden_btns(with_payment);
		};

		const original_bind_events = proto.bind_events;
		proto.bind_events = function () {
			const result = original_bind_events.apply(this, arguments);
			gsc.pos.bind_whatsapp_handler(this);
			gsc.pos.bind_pay_remaining_handler(this);
			return result;
		};

		const original_load_summary_of = proto.load_summary_of;
		proto.load_summary_of = function (doc, after_submission = false) {
			const result = original_load_summary_of.apply(this, arguments);
			gsc.pos.prefetch_whatsapp_payload(this);
			gsc.pos.ensure_fulfillment_container(this);
			gsc.pos.attach_fulfillment_control(this, doc, after_submission);
			return result;
		};

		proto.__gsc_whatsapp_btn_patched = true;
	}
};

// ---------------------------------------------------------------------------
// "Fulfillment Pending" option on the Recent Orders status filter
// ---------------------------------------------------------------------------
//
// Replaces "Consolidated" (a POS Invoice Merge Log concept that doesn't apply
// here - this site's POS Settings.invoice_type is "Sales Invoice") with
// "Fulfillment Pending": invoices linked to a Laundry Order whose
// fulfillment_status isn't yet Completed. The dropdown is a plain
// frappe.ui.form Select control (ControlSelect.set_options() re-reads
// this.df.options), and the actual filtering logic lives server-side in
// gsc.overrides.point_of_sale.get_past_order_list (wired over
// erpnext...get_past_order_list via override_whitelisted_methods in
// hooks.py) - this patch only needs to change what's offered in the dropdown.

gsc.pos.STATUS_FIELD_OPTIONS = ["Draft", "Paid", "Fulfillment Pending", "Return", "Partly Paid"];

gsc.pos.apply_status_field_options = function (status_field) {
	if (!status_field) return;
	status_field.df.options = gsc.pos.STATUS_FIELD_OPTIONS.join("\n");
	status_field.set_options();
};

gsc.pos.patch_past_order_list = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.PastOrderList)) {
		return;
	}

	const proto = erpnext.PointOfSale.PastOrderList.prototype;

	if (!proto.__gsc_status_options_patched) {
		const original_make_filter_section = proto.make_filter_section;
		proto.make_filter_section = function () {
			const result = original_make_filter_section.apply(this, arguments);
			gsc.pos.apply_status_field_options(this.status_field);
			return result;
		};

		proto.__gsc_status_options_patched = true;
	}
};

// ---------------------------------------------------------------------------
// No shift tracking: skip POS Opening Entry / POS Closing Entry entirely
// ---------------------------------------------------------------------------
//
// GSC's counter doesn't reconcile a cash drawer per cashier shift, so the
// "Create POS Opening Entry" dialog is pure friction - and core's matching
// server validation (Sales Invoice.validate_pos_opening_entry, which demands
// an Open entry whose period_start_date is TODAY) is also exactly what makes
// back-dating impossible. Both halves come out: this patch client-side, and
// gsc.overrides.sales_invoice.GSCSalesInvoice server-side.
//
// prepare_app_defaults() only ever reads four keys off the opening entry
// (name, company, pos_profile, period_start_date), so a synthetic record is
// enough. company/pos_profile come from gsc.overrides.point_of_sale
// .get_pos_context, which reuses the same resolver Sales Invoice's own
// set_pos_fields() uses - so the screen always configures itself with the
// profile the server would have picked anyway.

gsc.pos.SYNTHETIC_OPENING_NAME = "GSC-NO-SHIFT";

gsc.pos.patch_controller_shift_bypass = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.Controller)) {
		return;
	}

	const proto = erpnext.PointOfSale.Controller.prototype;
	if (proto.__gsc_shift_bypass_patched) return;

	proto.check_opening_entry = function () {
		return frappe
			.call({ method: "gsc.overrides.point_of_sale.get_pos_context" })
			.then((r) => {
				// No message means the server already frappe.throw()'d a readable
				// reason (no POS Profile for this user) and frappe.call has
				// msgprinted it - don't paper over it with a blank screen.
				if (!r || !r.message) return;

				return this.prepare_app_defaults({
					name: gsc.pos.SYNTHETIC_OPENING_NAME,
					company: r.message.company,
					pos_profile: r.message.pos_profile,
					// Only consumed by check_outdated_pos_opening_entry (no-op'd
					// below); kept honest so it stays harmless if that patch is
					// ever dropped.
					period_start_date: frappe.datetime.now_datetime(),
				});
			});
	};

	// No POS Opening Entry means no `poe_<name>` realtime room to listen on.
	proto.setup_listener_for_pos_closing = function () {};

	// No shift, so a shift can never be "outdated" - this is the warning that
	// used to fire on any POS tab left open past midnight.
	proto.check_outdated_pos_opening_entry = function () {};

	// REPLACED rather than wrapped: page.add_menu_item(label, fn, standard,
	// shortcut) also registers a GLOBAL frappe.ui.keys shortcut, and
	// page.clear_menu() only clears the DOM. Calling core's version first and
	// then stripping the menu entry would leave Shift+Ctrl+C still bound to
	// close_pos.
	proto.prepare_menu = function () {
		this.page.clear_menu();
		this.page.add_menu_item(__("Open Form View"), this.open_form_view.bind(this), false, "Ctrl+F");
	};

	// Belt and braces: if that shortcut ever gets re-registered by something
	// else, core's close_pos would build a POS Closing Entry pointing at
	// pos_opening_entry = "GSC-NO-SHIFT", a document that doesn't exist.
	proto.close_pos = function () {
		frappe.show_alert({
			message: __("Fitur tutup kasir (POS Closing Entry) tidak digunakan."),
			indicator: "orange",
		});
	};

	proto.__gsc_shift_bypass_patched = true;
};

// ---------------------------------------------------------------------------
// "Tanggal Transaksi" (posting date) control in the customer section
// ---------------------------------------------------------------------------
//
// Lets staff post an order to the day it was actually dropped off, rather
// than the day it got typed in. Only possible now that the shift check is
// gone (see above) - core's validate_pos_opening_entry required an open
// entry dated today, which transitively pinned posting_date to today.
//
// Lives inside .customer-section, right after the customer field/details, so
// it's visible and settable from an empty cart, before a customer is even
// chosen - unlike .add-discount-wrapper (display:none until the cart has
// items), which is why this couldn't just piggyback on that widget's
// container.
//
// .customer-section has exactly two mutually-exclusive states, and BOTH
// replace its entire innerHTML wholesale: make_customer_selector() (no
// customer picked yet - shows .customer-field) and update_customer_section()
// (a customer picked - shows .customer-details). ensure_posting_date_control()
// is rebuilt from scratch on every call rather than patched in once, because
// there is no DOM that survives either of those replacements to patch into -
// see the wraps on both methods in patch_item_cart_customer_selector().
//
// Runs BEFORE ensure_estimasi_waktu_control() in both of those wraps, and
// that control anchors on THIS one (.gsc-posting-date-container) rather than
// on the customer field/details directly - see its own comment - so the
// on-screen order ends up customer field -> posting date -> estimasi waktu.

gsc.pos.MAX_BACKDATE_DAYS = 7;

gsc.pos.get_earliest_posting_date = function () {
	return frappe.datetime.add_days(frappe.datetime.get_today(), -gsc.pos.MAX_BACKDATE_DAYS);
};

// Clamp to [today - MAX_BACKDATE_DAYS, today]. Back-dating writes Stock Ledger
// Entries at a past datetime when POS Profile.update_stock is on, which
// triggers a Repost Item Valuation and can hard-throw against
// Stock Settings.stock_frozen_upto / Accounts Settings.acc_frozen_upto. A
// bounded window keeps a typo'd year from reaching any of that.
gsc.pos.clamp_posting_date = function (value) {
	const today = frappe.datetime.get_today();
	const earliest = gsc.pos.get_earliest_posting_date();
	if (!value) return today;
	if (value > today) return today;
	if (value < earliest) return earliest;
	return value;
};

gsc.pos.ensure_posting_date_control = function (cart) {
	// Defensive only: the two callers above already replaced $customer_section's
	// entire innerHTML via .html() before calling this, so there is nothing
	// left to remove in practice - this just protects against a future third
	// caller that isn't a full re-render.
	cart.$customer_section.find(".gsc-posting-date-container").remove();

	const $container = $(
		`<div class="gsc-posting-date-container">
			<div class="gsc-posting-date-label">${__("Tanggal Transaksi")}</div>
			<div class="gsc-posting-date-field"></div>
		</div>`
	);

	// Anchor on whichever of .customer-field / .customer-details core just
	// rendered, same as ensure_estimasi_waktu_control below - the two never
	// coexist, so "after the customer field" has to mean one or the other.
	const $anchor = cart.$customer_section.children(".customer-field, .customer-details").first();
	if ($anchor.length) {
		$anchor.after($container);
	} else {
		cart.$customer_section.prepend($container);
	}

	const me = cart;

	cart.gsc_posting_date_field = frappe.ui.form.make_control({
		df: {
			label: __("Tanggal Transaksi"),
			fieldtype: "Date",
			input_class: "input-xs",
			onchange: function () {
				const frm = me.events.get_frm();
				if (!frm || !frm.doc) return;

				const clamped = gsc.pos.clamp_posting_date(this.value);

				if (clamped !== this.value) {
					frappe.show_alert({
						message: __("Tanggal transaksi hanya boleh antara {0} dan hari ini.", [
							frappe.datetime.str_to_user(gsc.pos.get_earliest_posting_date()),
						]),
						indicator: "orange",
					});
					// Re-entrant, but terminates: the clamped value is in range,
					// so the next pass falls straight through to the guard below.
					return this.set_value(clamped);
				}

				// Also the reset path: load_invoice sets this control to the new
				// doc's posting_date, and there's nothing to write when they
				// already agree. Without this, every new order would needlessly
				// flip set_posting_time on.
				if (frm.doc.posting_date === clamped) return;

				// set_posting_time FIRST, or the date gets silently reverted
				// twice over:
				//   server - validate() -> validate_auto_set_posting_time() ->
				//     validate_posting_time() rewrites posting_date/time to now
				//     unless set_posting_time is truthy;
				//   client - transaction.js validate() ->
				//     confirm_posting_date_change() resets posting_date to today
				//     before savesubmit(), returning early only when
				//     set_posting_time is set.
				//
				// frappe.model.set_value (not frm.doc.x = y) is load-bearing: it
				// is what routes through Form.watch_model_updates ->
				// script_manager -> transaction.js posting_date(), which recomputes
				// due_date via erpnext.accounts.party.get_due_date. A plain
				// assignment would leave a back-dated invoice with today's
				// due_date. (frm.set_value would work too, but also tries to
				// refresh fields_dict, which is empty on the POS's headless frm.)
				return frappe.model
					.set_value(frm.doc.doctype, frm.doc.name, "set_posting_time", 1)
					.then(() =>
						frappe.model.set_value(frm.doc.doctype, frm.doc.name, "posting_date", clamped)
					)
					.then(() => {
						// Estimasi Waktu Selesai must never end up before posting_date
						// (see gsc.pos.clamp_estimasi_waktu). Its own onchange only
						// catches this when THAT field is edited - moving posting_date
						// PAST an already-set estimasi date needs this reverse check,
						// or the invariant would silently go stale.
						const existing_estimasi = frm.doc.custom_estimasi_waktu_pengerjaan;
						if (
							me.gsc_estimasi_waktu_field &&
							existing_estimasi &&
							existing_estimasi < clamped
						) {
							frappe.show_alert({
								message: __(
									"{0} disesuaikan mengikuti Tanggal Transaksi yang baru.",
									[gsc.pos.ESTIMASI_WAKTU_LABEL]
								),
								indicator: "orange",
							});
							// set_value() re-fires this field's own onchange, which
							// writes custom_estimasi_waktu_pengerjaan via frappe.model
							// .set_value - no need to set it directly here too.
							me.gsc_estimasi_waktu_field.set_value(clamped);
						}
					});
			},
		},
		parent: cart.$customer_section.find(".gsc-posting-date-field"),
		render_input: true,
	});

	cart.gsc_posting_date_field.toggle_label(false);

	gsc.pos.sync_posting_date_control(cart);
};

gsc.pos.sync_posting_date_control = function (cart) {
	if (!cart.gsc_posting_date_field) return;

	const frm = cart.events.get_frm();
	// Falls back to {} (see ItemCart's events.get_frm in pos_controller.js) the
	// very first time this runs: init_item_cart() constructs ItemCart (and so
	// calls make_customer_selector(), which calls this) BEFORE
	// Controller.make_new_invoice() has set this.frm. Nothing to sync yet in
	// that case - make_new_invoice()'s own load_invoice() -> update_customer_
	// section() rebuilds the control again moments later, this time with a
	// real frm.
	if (!frm || !frm.doc) return;

	// Read-only once the order is submitted (browsing a past order) - the date
	// is history at that point, not an input.
	cart.gsc_posting_date_field.df.read_only = frm.doc.docstatus === 1 ? 1 : 0;
	cart.gsc_posting_date_field.refresh();

	// A brand-new invoice carries posting_date = today and set_posting_time = 0
	// from the DocType defaults, so back-dating never leaks between orders and
	// no explicit reset of set_posting_time is needed here.
	cart.gsc_posting_date_field.set_value(frm.doc.posting_date || frappe.datetime.get_today());
};

// ---------------------------------------------------------------------------
// "Estimasi Waktu Selesai" - estimated ready-for-pickup date
// ---------------------------------------------------------------------------
//
// Placed right after the customer field/details, per the same rebuild-on-
// every-.customer-section-re-render pattern as the posting-date control
// above (see the wraps in patch_item_cart_customer_selector) - both DOM
// states .customer-section can be in replace its entire innerHTML, so
// there's no element to patch into once and leave alone.
//
// Unlike posting_date, this ALWAYS starts blank on a brand-new order (the
// backing field - Sales Invoice.custom_estimasi_waktu_pengerjaan, see
// gsc/patches/v1_4/add_estimasi_waktu_pengerjaan_field.py - has no DocType
// default), and mandatory-ness is enforced only at submit time, not as the
// cashier types - see gsc.pos.patch_payment_estimasi_waktu_required below.
//
// Must never be BEFORE posting_date (equal is fine - a same-day job is
// normal). Enforced from both sides, since either field can move after the
// other has already been set:
//   - here, on this control's own onchange (gsc.pos.clamp_estimasi_waktu);
//   - and in ensure_posting_date_control()'s onchange above, which re-checks
//     and bumps this field forward if a later posting_date edit would
//     otherwise leave it stranded before the new posting_date.
// The field's own fieldname keeps "pengerjaan" - this is a display-label
// rename only, not a schema rename (which would mean a much bigger patch
// touching the Sales Invoice/Laundry Order fieldnames and every fetch_from/
// reference to them).

gsc.pos.ESTIMASI_WAKTU_LABEL = "Estimasi Waktu Selesai";

// Rejects (and reports) any value earlier than posting_date; equal is fine.
// Returns the value to actually use, clamped up to posting_date if needed -
// mirrors gsc.pos.clamp_posting_date's "notify, then use the closest valid
// value" pattern rather than silently blanking the field.
gsc.pos.clamp_estimasi_waktu = function (frm, value) {
	if (!value || !frm.doc.posting_date || value >= frm.doc.posting_date) return value;

	frappe.show_alert({
		message: __("{0} tidak boleh sebelum Tanggal Transaksi ({1}).", [
			gsc.pos.ESTIMASI_WAKTU_LABEL,
			frappe.datetime.str_to_user(frm.doc.posting_date),
		]),
		indicator: "orange",
	});

	return frm.doc.posting_date;
};

gsc.pos.ensure_estimasi_waktu_control = function (cart) {
	// Defensive only, matching ensure_posting_date_control - see its comment.
	cart.$customer_section.find(".gsc-estimasi-waktu-container").remove();

	const $container = $(
		`<div class="gsc-estimasi-waktu-container">
			<div class="gsc-estimasi-waktu-label">${__(gsc.pos.ESTIMASI_WAKTU_LABEL)}</div>
			<div class="gsc-estimasi-waktu-field"></div>
		</div>`
	);

	// Anchored on .gsc-posting-date-container, not the customer field/details
	// directly, so the on-screen order is customer field -> posting date ->
	// estimasi waktu. ensure_posting_date_control() always runs first in both
	// callers (see patch_item_cart_customer_selector), so that container
	// already exists by the time this runs; the customer-field/details anchor
	// is only a fallback for if this were ever called on its own.
	let $anchor = cart.$customer_section.children(".gsc-posting-date-container").first();
	if (!$anchor.length) {
		$anchor = cart.$customer_section.children(".customer-field, .customer-details").first();
	}
	if ($anchor.length) {
		$anchor.after($container);
	} else {
		cart.$customer_section.append($container);
	}

	cart.gsc_estimasi_waktu_field = frappe.ui.form.make_control({
		df: {
			label: __(gsc.pos.ESTIMASI_WAKTU_LABEL),
			fieldtype: "Date",
			input_class: "input-xs",
			onchange: function () {
				const frm = cart.events.get_frm();
				if (!frm || !frm.doc) return;

				const clamped = gsc.pos.clamp_estimasi_waktu(frm, this.value);
				if (clamped !== this.value) {
					// Re-entrant, but terminates: the clamped value passes the
					// >= posting_date check above on the next pass, same as
					// clamp_posting_date's own re-entrant set_value call.
					return this.set_value(clamped);
				}

				frappe.model.set_value(
					frm.doc.doctype,
					frm.doc.name,
					"custom_estimasi_waktu_pengerjaan",
					clamped
				);
			},
		},
		parent: $container.find(".gsc-estimasi-waktu-field"),
		render_input: true,
	});

	cart.gsc_estimasi_waktu_field.toggle_label(false);

	gsc.pos.sync_estimasi_waktu_control(cart);
};

gsc.pos.sync_estimasi_waktu_control = function (cart) {
	if (!cart.gsc_estimasi_waktu_field) return;

	const frm = cart.events.get_frm();
	// See sync_posting_date_control's comment - {} on the very first call,
	// before Controller.make_new_invoice() has set this.frm.
	if (!frm || !frm.doc) return;

	// Read-only once the order is submitted - history at that point, and the
	// value has already been copied onto the Laundry Order by then anyway
	// (fetch_from, resolved when create_laundry_order's on_submit hook
	// inserts it).
	cart.gsc_estimasi_waktu_field.df.read_only = frm.doc.docstatus === 1 ? 1 : 0;
	cart.gsc_estimasi_waktu_field.refresh();

	// Blank on a brand-new order - there is no fallback-to-today the way
	// posting_date has, by design (the field has no DocType default). A
	// loaded draft or return carries forward whatever was set previously.
	cart.gsc_estimasi_waktu_field.set_value(frm.doc.custom_estimasi_waktu_pengerjaan || "");
};

// ---------------------------------------------------------------------------
// Require "Estimasi Waktu Selesai" before the order can be submitted
// ---------------------------------------------------------------------------
//
// pos_payment.js's "Complete Order" click handler and its Ctrl+Enter
// shortcut (attach_shortcuts() just triggers a .click() on the same button)
// both funnel through Payment.prototype.validate_reqd_invoice_fields() before
// calling events.submit_invoice() - the exact choke point core itself uses
// for its own optional-required-fields dialog. Wrapping it here reuses that
// same gate instead of duplicating the submit-click/shortcut plumbing.

gsc.pos.validate_estimasi_waktu_before_submit = function (payment) {
	const frm = payment.events.get_frm();
	if (frm && frm.doc && frm.doc.custom_estimasi_waktu_pengerjaan) return true;

	frappe.show_alert({
		indicator: "red",
		message: __("Isi {0} sebelum menyelesaikan pesanan.", [gsc.pos.ESTIMASI_WAKTU_LABEL]),
	});
	frappe.utils.play_sound("error");

	// Best-effort focus only: Payment has no direct reference to ItemCart
	// (the field lives there), so this reaches it via window.cur_pos. Safe
	// here specifically because this only ever runs from a live click/
	// keyboard event, long after the controller exists - unlike the file
	// header's note about cur_pos being undefined at PATCH time.
	if (window.cur_pos && cur_pos.cart && cur_pos.cart.gsc_estimasi_waktu_field) {
		cur_pos.cart.gsc_estimasi_waktu_field.set_focus();
	}

	return false;
};

gsc.pos.patch_payment_estimasi_waktu_required = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.Payment)) {
		return;
	}

	const proto = erpnext.PointOfSale.Payment.prototype;
	if (proto.__gsc_estimasi_waktu_required_patched) return;

	const original_validate_reqd_invoice_fields = proto.validate_reqd_invoice_fields;
	proto.validate_reqd_invoice_fields = function () {
		if (!original_validate_reqd_invoice_fields.apply(this, arguments)) return false;
		return gsc.pos.validate_estimasi_waktu_before_submit(this);
	};

	proto.__gsc_estimasi_waktu_required_patched = true;
};

// ---------------------------------------------------------------------------
// Discount: % / Rp toggle, on the cart total and on each item
// ---------------------------------------------------------------------------
//
// Core only ever exposes the percentage side (additional_discount_percentage
// on the invoice, discount_percentage on the item), but staff quote flat
// rupiah discounts. Both flat fields already exist and are fully wired
// client-side - Sales Invoice.discount_amount via transaction.js, and
// Sales Invoice Item.discount_amount via sales_common.js - so this is purely
// a UI gap. In particular the two fields already zero each other out on the
// item side, which is why the item form below needs no clearing logic.

gsc.pos.DISCOUNT_MODES = { PERCENT: "percent", AMOUNT: "amount" };

gsc.pos.get_discount_mode = function (percent, amount) {
	return flt(amount) && !flt(percent)
		? gsc.pos.DISCOUNT_MODES.AMOUNT
		: gsc.pos.DISCOUNT_MODES.PERCENT;
};

gsc.pos.discount_toggle_html = function (mode) {
	const btn = (value, label) =>
		`<button type="button" class="gsc-discount-mode-btn ${
			mode === value ? "active" : ""
		}" data-mode="${value}">${label}</button>`;
	return `<div class="gsc-discount-mode-toggle">
			${btn(gsc.pos.DISCOUNT_MODES.PERCENT, "%")}${btn(gsc.pos.DISCOUNT_MODES.AMOUNT, "Rp")}
		</div>`;
};

// Writes the chosen discount, clearing the other field FIRST.
//
// That clearing step is not redundant: frappe.model.set_value only fires its
// triggers when the value actually changes, so going from "Rp 5.000" to "0%"
// would set additional_discount_percentage = 0 over an existing 0, fire
// nothing, and silently leave the Rp 5.000 in place. Clearing first makes
// every transition converge. Core's own handlers (transaction.js
// additional_discount_percentage / discount_amount) do the recalculation.
gsc.pos.apply_cart_discount = function (frm, mode, value) {
	const dt = frm.doc.doctype;
	const dn = frm.doc.name;
	const set = (field, v) => frappe.model.set_value(dt, dn, field, v);

	if (mode === gsc.pos.DISCOUNT_MODES.AMOUNT) {
		return Promise.resolve()
			.then(() => (flt(frm.doc.additional_discount_percentage) ? set("additional_discount_percentage", 0) : null))
			.then(() => (flt(frm.doc.discount_amount) !== value ? set("discount_amount", value) : null));
	}

	return Promise.resolve()
		.then(() => (flt(frm.doc.discount_amount) ? set("discount_amount", 0) : null))
		.then(() =>
			flt(frm.doc.additional_discount_percentage) !== value
				? set("additional_discount_percentage", value)
				: null
		);
};

gsc.pos.validate_cart_discount = function (frm, mode, value) {
	if (mode === gsc.pos.DISCOUNT_MODES.PERCENT) {
		if (value > 100) {
			frappe.msgprint({
				title: __("Invalid Discount"),
				indicator: "red",
				message: __("Discount cannot be greater than 100%."),
			});
			return 0;
		}
		return value;
	}

	// apply_discount_on is "Grand Total" or "Net Total"; scrub() turns it into
	// the matching doc fieldname, same as transaction.js does.
	const base = flt(frm.doc[frappe.model.scrub(frm.doc.apply_discount_on || "Grand Total")]);
	if (base && value > base) {
		frappe.msgprint({
			title: __("Invalid Discount"),
			indicator: "red",
			message: __("Discount cannot be greater than {0}.", [format_currency(base, frm.doc.currency)]),
		});
		return 0;
	}
	return value;
};

gsc.pos.patch_item_cart_discount = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.ItemCart)) {
		return;
	}

	const proto = erpnext.PointOfSale.ItemCart.prototype;
	if (proto.__gsc_discount_toggle_patched) return;

	// REPLACED, not wrapped: the control has to be built with our onchange.
	// Two things are deliberately kept identical to core - the control lives on
	// this.discount_field, and it stays a Data control - because the Escape
	// shortcut calls this.discount_field.set_value(0) and the click-to-reopen
	// handler tests `!this.discount_field`.
	proto.show_discount_control = function () {
		const me = this;
		const frm = this.events.get_frm();

		this.__gsc_discount_mode = gsc.pos.get_discount_mode(
			frm.doc.additional_discount_percentage,
			frm.doc.discount_amount
		);

		this.$add_discount_elem.css({ padding: "0px", border: "none" });
		this.$add_discount_elem.html(
			// .add-discount-field must stay a DIRECT child of
			// .add-discount-wrapper - point-of-sale.scss styles it with a
			// direct-child selector, and nesting it silently kills its width.
			`${gsc.pos.discount_toggle_html(this.__gsc_discount_mode)}<div class="add-discount-field"></div>`
		);

		this.discount_field = frappe.ui.form.make_control({
			df: {
				label: __("Discount"),
				fieldtype: "Data",
				placeholder: gsc.pos.discount_placeholder(frm, this.__gsc_discount_mode),
				input_class: "input-xs",
				onchange: function () {
					// Reads the mode as of when the input was edited. Clicking the
					// other toggle button blurs the input first (blur precedes
					// click), so this still sees the mode the value was typed in.
					const mode = me.__gsc_discount_mode;
					this.value = flt(this.value);
					this.value = gsc.pos.validate_cart_discount(frm, mode, this.value);
					const applied = this.value;
					return gsc.pos
						.apply_cart_discount(frm, mode, applied)
						.then(() => me.hide_discount_control());
				},
			},
			parent: this.$add_discount_elem.find(".add-discount-field"),
			render_input: true,
		});

		this.discount_field.toggle_label(false);
		this.discount_field.set_focus();

		this.$add_discount_elem.find(".gsc-discount-mode-btn").on("click", function (e) {
			// The wrapper has a delegated click handler that can re-render this
			// widget; stop the bubble so switching units doesn't rebuild it.
			e.stopPropagation();

			const mode = $(this).attr("data-mode");
			if (mode === me.__gsc_discount_mode) return;

			me.__gsc_discount_mode = mode;
			me.$add_discount_elem.find(".gsc-discount-mode-btn").removeClass("active");
			$(this).addClass("active");

			// Cleared rather than converted: the previous mode's value was
			// already committed on blur, and showing a converted number here
			// would look like a second, pending discount.
			me.discount_field.df.placeholder = gsc.pos.discount_placeholder(frm, mode);
			me.discount_field.value = "";
			me.discount_field.$input && me.discount_field.$input.val("").attr("placeholder", me.discount_field.df.placeholder);
			me.discount_field.set_focus();
		});
	};

	// REPLACED, and the `discount` argument is deliberately IGNORED: the state
	// is re-derived from frm.doc instead. That's what makes core's own call in
	// load_invoice - hide_discount_control(frm.doc.additional_discount_percentage)
	// - render an Rp-mode discount correctly with no change to load_invoice.
	proto.hide_discount_control = function () {
		const frm = this.events.get_frm();
		const percent = flt(frm.doc.additional_discount_percentage);
		const amount = flt(frm.doc.discount_amount);

		if (!percent && !amount) {
			this.$add_discount_elem.css({
				border: "1px dashed var(--gray-500)",
				padding: "var(--padding-sm) var(--padding-md)",
			});
			this.$add_discount_elem.html(`${this.get_discount_icon()} ${__("Add Discount")}`);
			this.discount_field = undefined;
			return;
		}

		// transaction.js guarantees exactly one of the two is non-zero: its
		// percentage handler recomputes discount_amount, and its amount handler
		// zeroes additional_discount_percentage.
		const applied = percent
			? `${String(percent).bold()}%`
			: format_currency(amount, frm.doc.currency).bold();

		this.$add_discount_elem.css({
			border: "1px dashed var(--dark-green-500)",
			padding: "var(--padding-sm) var(--padding-md)",
		});
		// .edit-discount-btn is what core's click-to-edit and Ctrl+D look for.
		this.$add_discount_elem.html(
			`<div class="edit-discount-btn">
				${this.get_discount_icon()} ${__("Additional")}&nbsp;${applied} ${__("discount applied")}
			</div>`
		);
		this.discount_field = undefined;
	};

	proto.__gsc_discount_toggle_patched = true;
};

gsc.pos.discount_placeholder = function (frm, mode) {
	if (mode === gsc.pos.DISCOUNT_MODES.AMOUNT) {
		const current = flt(frm.doc.discount_amount);
		return current ? format_currency(current, frm.doc.currency) : __("Masukkan nominal diskon.");
	}
	const current = flt(frm.doc.additional_discount_percentage);
	return current ? `${current}%` : __("Enter discount percentage.");
};

// --- item-level -------------------------------------------------------------

gsc.pos.render_item_discount_toggle = function (details) {
	const $percent = details.$form_container.find(".discount_percentage-control");
	const $amount = details.$form_container.find(".discount_amount-control");
	if (!$percent.length || !$amount.length) return;

	// render_form() empties $form_container before each render, so this is
	// belt-and-braces against any other caller.
	details.$form_container.find(".gsc-discount-mode-toggle").remove();
	$percent.before(gsc.pos.discount_toggle_html(details.__gsc_discount_mode));

	gsc.pos.apply_item_discount_mode(details);

	// A live unit toggle over two read-only inputs just reads as broken. Done
	// here rather than in bind_custom_control_change_event (where core applies
	// the matching read_only flags) because core calls that from INSIDE
	// render_form, i.e. before this toggle exists.
	if (!details.allow_discount_change) {
		details.$form_container.find(".gsc-discount-mode-toggle").hide();
	}

	if (!details.__gsc_item_discount_bound) {
		// Delegated on $form_container, which prepare_dom() creates once and
		// render_form() only empties - so this survives every re-render.
		details.$form_container.on("click", ".gsc-discount-mode-btn", function () {
			details.__gsc_discount_mode = $(this).attr("data-mode");
			gsc.pos.apply_item_discount_mode(details);
			const active =
				details.__gsc_discount_mode === gsc.pos.DISCOUNT_MODES.AMOUNT
					? details.discount_amount_control
					: details.discount_percentage_control;
			active && active.set_focus();
		});
		details.__gsc_item_discount_bound = true;
	}
};

gsc.pos.apply_item_discount_mode = function (details) {
	const is_amount = details.__gsc_discount_mode === gsc.pos.DISCOUNT_MODES.AMOUNT;
	details.$form_container.find(".discount_percentage-control").toggle(!is_amount);
	details.$form_container.find(".discount_amount-control").toggle(is_amount);
	details.$form_container
		.find(".gsc-discount-mode-btn")
		.removeClass("active")
		.filter(`[data-mode="${details.__gsc_discount_mode}"]`)
		.addClass("active");
};

gsc.pos.patch_item_details_discount = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.ItemDetails)) {
		return;
	}

	const proto = erpnext.PointOfSale.ItemDetails.prototype;
	if (proto.__gsc_item_discount_patched) return;

	const original_get_form_fields = proto.get_form_fields;
	proto.get_form_fields = function () {
		const fields = original_get_form_fields.apply(this, arguments);
		const index = fields.indexOf("discount_percentage");
		if (index !== -1 && !fields.includes("discount_amount")) {
			fields.splice(index + 1, 0, "discount_amount");
		}
		return fields;
	};

	const original_render_form = proto.render_form;
	proto.render_form = function (item) {
		const result = original_render_form.apply(this, arguments);

		if (this.discount_amount_control) {
			// Set the label on the CONTROL's df, never on the meta docfield.
			// render_form builds each control from a shallow copy
			// ({...field_meta, onchange}) so control.df is private, whereas
			// field_meta is the live object from frappe.get_meta(...).fields.
			// Core mutates that shared object for discount_percentage, which
			// permanently renames the field session-wide including desk grids;
			// that's a pre-existing upstream bug - just don't add a second one.
			this.discount_amount_control.df.label = __("Discount (Rp)");
			this.discount_amount_control.refresh();
		}

		this.__gsc_discount_mode = gsc.pos.get_discount_mode(
			item.discount_percentage,
			item.discount_amount
		);
		gsc.pos.render_item_discount_toggle(this);

		return result;
	};

	const original_bind_custom_control_change_event = proto.bind_custom_control_change_event;
	proto.bind_custom_control_change_event = function () {
		const result = original_bind_custom_control_change_event.apply(this, arguments);

		// Mirrors what core does for discount_percentage. (Hiding the unit
		// toggle in the same case is handled in render_item_discount_toggle -
		// core calls this from inside render_form, before the toggle exists.)
		if (this.discount_amount_control && !this.allow_discount_change) {
			this.discount_amount_control.df.read_only = 1;
			this.discount_amount_control.refresh();
		}

		return result;
	};

	// In Rp mode taxes_and_totals.js back-fills discount_percentage as
	// 100 * discount_amount / rate_with_margin - typically a long float that
	// core prints raw into the "N% off" badge.
	const original_render_discount_dom = proto.render_discount_dom;
	proto.render_discount_dom = function (item) {
		if (item && item.discount_percentage) {
			item = Object.assign({}, item, {
				discount_percentage: flt(item.discount_percentage, 2),
			});
		}
		return original_render_discount_dom.call(this, item);
	};

	proto.__gsc_item_discount_patched = true;
};

gsc.pos.patch_controller_numpad_discount = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.Controller)) {
		return;
	}

	const proto = erpnext.PointOfSale.Controller.prototype;
	if (proto.__gsc_numpad_discount_patched) return;

	// The cart numpad's "Discount" key is hard-wired to discount_percentage
	// (ItemCart fieldnames_map), so in Rp mode it would set_focus() a control
	// that's currently hidden. on_numpad_event's allow_discount_change check
	// keys off the button value, which is unchanged, so only this needs fixing.
	const original_update_item_field = proto.update_item_field;
	proto.update_item_field = function (value, field_or_action) {
		if (
			field_or_action === "discount_percentage" &&
			this.item_details &&
			this.item_details.__gsc_discount_mode === gsc.pos.DISCOUNT_MODES.AMOUNT
		) {
			field_or_action = "discount_amount";
		}
		return original_update_item_field.call(this, value, field_or_action);
	};

	proto.__gsc_numpad_discount_patched = true;
};

// ---------------------------------------------------------------------------
// "Hutang (Bayar Nanti)" - pay-later / credit payment mode
// ---------------------------------------------------------------------------
//
// A real Mode of Payment on the POS Profile (created by
// gsc/patches/v1_3/add_credit_mode_of_payment.py), so it renders as an
// ordinary tile. The only behavioural difference: selecting it zeroes every
// payment row instead of auto-filling the balance, so the invoice submits
// with paid_amount 0 and outstanding = grand total, landing on Unpaid (or
// Overdue the next day, or immediately if back-dated). No GL entry is written
// for it - make_pos_gl_entries skips rows with a zero base_amount - so the
// receivable comes from the invoice's own debit_to exactly as usual.
//
// Settling it later needs no new code: the "Bayar Sisa" button above already
// shows for {Partly Paid, Overdue, Unpaid} and creates the Payment Entry.

gsc.pos.CREDIT_MODE_OF_PAYMENT = "Hutang (Bayar Nanti)";

gsc.pos.get_credit_control = function (payment) {
	const mode = payment.sanitize_mode_of_payment(gsc.pos.CREDIT_MODE_OF_PAYMENT);
	return { mode: mode, control: payment[`${mode}_control`] };
};

gsc.pos.zero_all_payments = function (payment, credit_mode) {
	const frm = payment.events.get_frm();
	const rows = (frm.doc.payments || []).filter((p) => flt(p.amount));

	return frappe
		.run_serially(rows.map((p) => () => frappe.model.set_value(p.doctype, p.name, "amount", 0)))
		.then(() => {
			(frm.doc.payments || []).forEach((p) => {
				const mode = payment.sanitize_mode_of_payment(p.mode_of_payment);
				// set_value short-circuits on an unchanged value, so this can't
				// re-enter the control's own onchange.
				payment[`${mode}_control`] && payment[`${mode}_control`].set_value(0);
			});

			// Blanks the "0" now showing on every tile...
			payment.hide_zero_amount();
			// ...then puts an explicit zero back on the credit tile, so it reads
			// as a deliberate "nothing paid" rather than an untouched mode.
			const $amount = payment.$payment_modes.find(`.${credit_mode}-amount`);
			$amount.length && $amount.html(format_currency(0, frm.doc.currency));

			// Release the keyboard. pos_payment.js binds a GLOBAL
			// $(document).on("keydown") that pipes every keystroke into
			// on_numpad_clicked whenever selected_mode is truthy - leaving credit
			// "selected" would let a stray digit type a paid_amount into it.
			//
			// .border-primary is deliberately LEFT ON: Ctrl+Enter (submit) and
			// Tab (cycle modes) both test for it, and it doubles as the visual
			// cue that credit is active. Side effect: core's click-away
			// deselector won't strip it, since that is gated on selected_mode.
			payment.selected_mode = "";

			payment.update_totals_section();
		});
};

gsc.pos.patch_payment_credit_mode = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.Payment)) {
		return;
	}

	const proto = erpnext.PointOfSale.Payment.prototype;
	if (proto.__gsc_credit_mode_patched) return;

	const original_auto_set_remaining_amount = proto.auto_set_remaining_amount;
	proto.auto_set_remaining_amount = function () {
		const { mode, control } = gsc.pos.get_credit_control(this);
		if (control && this.selected_mode === control) {
			return gsc.pos.zero_all_payments(this, mode);
		}
		return original_auto_set_remaining_amount.apply(this, arguments);
	};

	// focus_on_default_mop clicks the POS Profile's default mode inside a 500ms
	// setTimeout. Without this guard, a cashier who taps Hutang inside that
	// window would have the balance silently refilled into Cash.
	const original_focus_on_default_mop = proto.focus_on_default_mop;
	proto.focus_on_default_mop = function () {
		if (this.selected_mode) return;
		return original_focus_on_default_mop.apply(this, arguments);
	};

	proto.__gsc_credit_mode_patched = true;
};

// ---------------------------------------------------------------------------
// Lock the posting date once checkout starts
// ---------------------------------------------------------------------------
//
// The control itself is (re)built by ensure_posting_date_control(), called
// from the make_customer_selector()/update_customer_section() wraps above -
// this only handles read-only state as the cart moves in and out of the
// payment screen, which is orthogonal to which of those two DOM states
// .customer-section happens to be in.

gsc.pos.patch_item_cart_checkout_lock = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.ItemCart)) {
		return;
	}

	const proto = erpnext.PointOfSale.ItemCart.prototype;
	if (proto.__gsc_checkout_lock_patched) return;

	// show_checkout=true means the cart is editable; false means the payment
	// screen has taken over, where the date should no longer move.
	const original_toggle_checkout_btn = proto.toggle_checkout_btn;
	proto.toggle_checkout_btn = function (show_checkout) {
		const result = original_toggle_checkout_btn.apply(this, arguments);
		if (this.gsc_posting_date_field) {
			this.gsc_posting_date_field.df.read_only = show_checkout ? 0 : 1;
			this.gsc_posting_date_field.refresh();
		}
		return result;
	};

	proto.__gsc_checkout_lock_patched = true;
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

gsc.pos.patch_all = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.Controller)) {
		// Should be impossible - we run inside a resolved frappe.require for
		// the bundle, and pos_controller.js is its last import.
		console.error("gsc: point-of-sale bundle loaded but erpnext.PointOfSale.Controller is missing");
		return;
	}

	gsc.pos.patch_controller_shift_bypass();
	gsc.pos.patch_controller_numpad_discount();
	gsc.pos.patch_item_cart_customer_selector();
	gsc.pos.patch_item_cart_checkout_lock();
	gsc.pos.patch_item_cart_discount();
	gsc.pos.patch_item_details_discount();
	gsc.pos.patch_payment_credit_mode();
	gsc.pos.patch_payment_estimasi_waktu_required();
	gsc.pos.patch_past_order_summary();
	gsc.pos.patch_past_order_list();
};

(function () {
	const core_on_page_load = frappe.pages["point-of-sale"].on_page_load;

	// See the "HOW THE PATCHING WORKS" note at the top of this file. The
	// require() here is what makes the patches land BEFORE core constructs the
	// Controller (whose constructor synchronously calls check_opening_entry);
	// core's own require() then resolves from frappe.assets._executed without
	// re-fetching.
	frappe.pages["point-of-sale"].on_page_load = function (wrapper) {
		frappe.require("point-of-sale.bundle.js", function () {
			gsc.pos.patch_all();
			core_on_page_load(wrapper);
		});
	};
})();
