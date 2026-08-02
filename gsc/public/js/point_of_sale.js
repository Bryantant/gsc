// gsc/public/js/point_of_sale.js
//
// Adds a "Create New Customer" button beside the POS customer search field.
// Loaded via hooks.py `page_js = {"point-of-sale": "public/js/point_of_sale.js"}`.
//
// This file is concatenated onto the end of ERPNext's core point_of_sale.js
// and evaluated when the POS route opens - BEFORE point-of-sale.bundle.js
// (which defines erpnext.PointOfSale.ItemCart) has been fetched, and well
// before ItemCart is actually constructed (that happens only after
// PointOfSale.Controller's async check_opening_entry() flow resolves). We
// poll until ItemCart exists, then patch its prototype. Because the current
// cart instance (if any) may already have rendered its customer field before
// our patch lands, we also backfill the button directly onto it.

frappe.provide("erpnext.PointOfSale");
frappe.provide("gsc.pos");

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
		// Mirrors frappe/public/js/frappe/form/controls/link.js -> new_doc():
		//   frappe.ui.form.make_quick_entry(doctype, (doc) => me.set_value(doc.name));
		// item_cart.customer_field IS the same Link control instance ("me" in
		// core's new_doc()), so calling set_value() on it fires the identical
		// onchange chain: frappe.model.set_value -> script_manager.trigger("customer")
		// -> fetch_customer_details -> customer_details_updated -> update_customer_section
		// -> update_totals_section.
		frappe.ui.form.make_quick_entry("Customer", (doc) => {
			return item_cart.customer_field.set_value(doc.name);
		});
	});

	$customer_field.append($btn);
};

gsc.pos.patch_item_cart_customer_selector = function () {
	if (!(erpnext.PointOfSale && erpnext.PointOfSale.ItemCart)) {
		return;
	}

	if (!erpnext.PointOfSale.ItemCart.prototype.__gsc_customer_btn_patched) {
		const original_make_customer_selector =
			erpnext.PointOfSale.ItemCart.prototype.make_customer_selector;

		erpnext.PointOfSale.ItemCart.prototype.make_customer_selector = function () {
			const result = original_make_customer_selector.apply(this, arguments);
			gsc.pos.add_new_customer_button(this);
			return result;
		};

		erpnext.PointOfSale.ItemCart.prototype.__gsc_customer_btn_patched = true;
	}

	// Backfill: a cart instance may already have been constructed (and already
	// called the original make_customer_selector once) before this patch
	// landed, so the wrapped version above won't run again on its own. Add the
	// button directly to the currently-live cart, if there is one.
	if (window.cur_pos && cur_pos.cart && cur_pos.cart.$customer_section) {
		gsc.pos.add_new_customer_button(cur_pos.cart);
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
			return gsc.pos.filter_hidden_btns(with_whatsapp);
		};

		const original_bind_events = proto.bind_events;
		proto.bind_events = function () {
			const result = original_bind_events.apply(this, arguments);
			gsc.pos.bind_whatsapp_handler(this);
			return result;
		};

		const original_load_summary_of = proto.load_summary_of;
		proto.load_summary_of = function (doc, after_submission = false) {
			const result = original_load_summary_of.apply(this, arguments);
			// Remembered so the backfill below can re-render the button row for
			// a summary that was already on screen when the patch landed.
			this.__gsc_after_submission = after_submission;
			gsc.pos.prefetch_whatsapp_payload(this);
			gsc.pos.ensure_fulfillment_container(this);
			gsc.pos.attach_fulfillment_control(this, doc, after_submission);
			return result;
		};

		proto.__gsc_whatsapp_btn_patched = true;
	}

	// Backfill the already-constructed instance. cur_pos.order_summary is set
	// in pos_controller.js init_order_summary(), in the same synchronous block
	// that builds cur_pos.cart.
	const summary = window.cur_pos && cur_pos.order_summary;
	if (summary && !summary.__gsc_wa_bound) {
		gsc.pos.bind_whatsapp_handler(summary);
		summary.__gsc_wa_bound = true;

		// If a summary is already displayed, its buttons were rendered by the
		// UNpatched get_condition_btn_map, so re-render them once.
		if (summary.doc && summary.$summary_btns && summary.$summary_btns.children().length) {
			summary.add_summary_btns(
				summary.get_condition_btn_map(summary.__gsc_after_submission || false)
			);
			gsc.pos.prefetch_whatsapp_payload(summary);
			gsc.pos.ensure_fulfillment_container(summary);
			gsc.pos.attach_fulfillment_control(summary, summary.doc, summary.__gsc_after_submission || false);
		}
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

	// Backfill: cur_pos.recent_order_list is built in pos_controller.js
	// init_recent_order_list(), which may have already run (with the
	// UNpatched options) before this patch landed.
	const order_list = window.cur_pos && cur_pos.recent_order_list;
	if (order_list && order_list.status_field && !order_list.__gsc_status_options_applied) {
		gsc.pos.apply_status_field_options(order_list.status_field);
		order_list.__gsc_status_options_applied = true;
	}
};

// One polling loop drives all patches. page_js is concatenated onto core's
// point_of_sale.js and evaluated BEFORE point-of-sale.bundle.js is fetched,
// so none of ItemCart/PastOrderSummary/PastOrderList exist yet at this point.
// 200 x 300ms = 60s.
(function poll_until_patched(retries_left) {
	gsc.pos.patch_item_cart_customer_selector();
	gsc.pos.patch_past_order_summary();
	gsc.pos.patch_past_order_list();

	const ns = erpnext.PointOfSale;
	const cart_done = ns && ns.ItemCart && ns.ItemCart.prototype.__gsc_customer_btn_patched;
	const summary_done =
		ns && ns.PastOrderSummary && ns.PastOrderSummary.prototype.__gsc_whatsapp_btn_patched;
	const list_done = ns && ns.PastOrderList && ns.PastOrderList.prototype.__gsc_status_options_patched;

	if (cart_done && summary_done && list_done) {
		return;
	}
	if (retries_left > 0) {
		setTimeout(() => poll_until_patched(retries_left - 1), 300);
	} else {
		console.warn(
			"gsc: gave up waiting for erpnext.PointOfSale classes;",
			"customer button patched:",
			!!cart_done,
			"whatsapp button patched:",
			!!summary_done,
			"status filter patched:",
			!!list_done
		);
	}
})(200);
