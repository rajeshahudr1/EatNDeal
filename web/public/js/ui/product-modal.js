/*
 * ui/product-modal.js
 *
 * What:  Fullscreen product detail popup that replaces the standalone
 *        /?rest=X&item=Y page for in-app navigation.
 *
 *          • Triggered by [data-action="open-product"] (set on every
 *            product card across the home dish rail + restaurant menu
 *            + related rail) — the element carries data-rest + data-item
 *            slugs (or data-id) the modal feeds to GET /product/json.
 *          • Image header + name + price + description + option-group
 *            cards. Each group card is a "Customise" button that opens
 *            the NESTED group sheet (radios for single-choice / check
 *            boxes for multi).
 *          • Selected options bubble back into the main sheet's order
 *            summary as a "Name: choice" line and roll into the live
 *            total. Quantity stepper + Add to cart use the existing
 *            /cart/add endpoint via the global cart.js bumpCartBadge
 *            so the badge animation + branch-conflict dialog still fire.
 *
 * Why:   Customers shouldn't lose the restaurant scroll position when
 *        opening an item. The modal keeps them in place AND lets us
 *        present required options one at a time on small screens.
 *
 * Mobile + desktop: fullscreen sheet on phones / tablets; centred
 * card on desktop (≥ 900px). Both share the same DOM — CSS handles
 * the layout switch.
 */
(function () {
    'use strict';

    // ── DOM refs (cached on first open) ─────────────────────────────
    var modal, sheet, body, content, loading, errorEl, foot;
    var heroPane;
    var qtyEl, totalEl, addLabelEl;
    var groupModal, groupBody, groupTitle, groupHint;
    var cached = false;

    // ── State (per-open) ────────────────────────────────────────────
    var product   = null;       // raw JSON from /product/json
    var groups    = [];         // top-level option groups
    var selections = {};        // { [groupId]: [optionId, optionId] }
    var qty       = 1;
    // Group sheet navigation. Level-1 (top-level) groups render inline
    // inside the main modal; the popup is now reserved for level-2+
    // linked sub-groups. `chain` holds the linked-group ids being walked
    // and `cursorIdx` points at the rendered one. `openedFromLinkedId`
    // remembers the original linked id so when the chain finishes we
    // can repaint the right parent section's summary.
    var chain      = [];
    var cursorIdx  = 0;
    var openedFromLinkedId = null;
    var lastFocused = null;

    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    }); }
    function toast(type, msg) {
        if (window.EatNDealUi && window.EatNDealUi.showToast) {
            window.EatNDealUi.showToast(type, msg);
        }
    }
    function currencySymbol() {
        return (window.boot && window.boot.currencySymbol) || '£';
    }
    function money(n) {
        var v = Number(n) || 0;
        return currencySymbol() + v.toFixed(2);
    }

    function cacheRefs() {
        if (cached) { return; }
        modal      = $('#product-modal');
        if (!modal) { return; }
        sheet      = $('.pm__sheet',  modal);
        body       = $('[data-pm-body]', modal);
        content    = $('[data-pm-content]', modal);
        loading    = $('[data-pm-loading]', modal);
        errorEl    = $('[data-pm-error]', modal);
        foot       = $('[data-pm-foot]', modal);
        heroPane   = $('[data-pm-hero]', modal);
        qtyEl      = $('[data-pm-qty]', modal);
        totalEl    = $('[data-pm-total]', modal);
        addLabelEl = $('[data-pm-add-label]', modal);
        groupModal = $('[data-pm-group]', modal);
        groupBody  = $('[data-pm-group-body]', modal);
        groupTitle = $('[data-pm-group-title]', modal);
        groupHint  = $('[data-pm-group-hint]', modal);
        cached     = true;

        // One delegated change listener inside the modal handles every
        // inline top-level option toggle. (Click delegates already live
        // on `document` — change events don't bubble in older browsers
        // when bound on document, so we anchor it on the modal.)
        modal.addEventListener('change', function (ev) {
            var t = ev.target;
            if (!t) { return; }
            if (t.hasAttribute && t.hasAttribute('data-pm-grp-id') && t.hasAttribute('data-pm-opt-id')) {
                onTopLevelChange(t);
            }
        });
    }

    // ── Open / close ────────────────────────────────────────────────
    function open(params) {
        cacheRefs();
        if (!modal) { return; }
        // Reset any leftover state from a previous open — defends
        // against window.EatNDealUi.productModal.open being called
        // while a group sheet from the prior product is still up.
        closeGroup(true);
        chain = []; cursorIdx = 0;
        lastFocused = document.activeElement;
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        showLoading();
        fetchProduct(params);
    }

    function close() {
        if (!modal || modal.hidden) { return; }
        closeGroup(true);
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        modal.removeAttribute('aria-label');
        document.body.style.overflow = '';
        product = null;
        groups = [];
        selections = {};
        chain = []; cursorIdx = 0;
        openedFromLinkedId = null;
        qty = 1;
        if (content)  { content.innerHTML = ''; content.hidden = true; }
        if (heroPane) { heroPane.innerHTML = '<span class="pm__hero-placeholder" aria-hidden="true"></span>'; }
        if (foot)     { foot.hidden = true; }
        if (loading)  { loading.hidden = false; }
        if (errorEl)  { errorEl.hidden = true; errorEl.textContent = ''; }
        if (lastFocused && typeof lastFocused.focus === 'function') {
            try { lastFocused.focus(); } catch (e) { /* ignore */ }
        }
    }

    function showLoading() {
        if (loading) { loading.hidden = false; }
        if (errorEl) { errorEl.hidden = true; }
        if (content) { content.hidden = true; }
        if (foot)    { foot.hidden = true; }
    }
    function showError(msg) {
        if (loading) { loading.hidden = true; }
        if (content) { content.hidden = true; }
        if (foot)    { foot.hidden = true; }
        if (errorEl) { errorEl.textContent = msg || 'Could not load the item.'; errorEl.hidden = false; }
    }

    function fetchProduct(params) {
        var qs = new URLSearchParams();
        if (params.id)   { qs.set('id',   params.id); }
        if (params.rest) { qs.set('rest', params.rest); }
        if (params.item) { qs.set('item', params.item); }
        fetch('/product/json?' + qs.toString(), {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (!env || env.status !== 200 || !env.data || !env.data.product) {
                  showError((env && env.msg) || 'We couldn\'t find that item.');
                  return;
              }
              product = env.data.product;
              groups  = env.data.groups || [];
              selections = {};
              qty = 1;
              seedDefaults();
              renderMain();
          })
          .catch(function () { showError('Could not reach the server.'); });
    }

    // Pre-tick is_default options so the legacy parity holds (Single
    // groups can have a default; multi groups may also have defaults).
    // Walks linked sub-groups too so a default-picked Chilli Sauce can
    // also pre-tick its default Spice Level.
    function seedDefaults() {
        function seed(g) {
            var ids = [];
            (g.options || []).forEach(function (o) {
                if (o.isDefault) { ids.push(String(o.id)); }
            });
            if (g.type === 'single' && ids.length > 1) { ids = [ids[0]]; }
            selections[String(g.id)] = ids;
            (g.options || []).forEach(function (o) {
                if (o.linkedGroup && ids.indexOf(String(o.id)) !== -1) {
                    seed(o.linkedGroup);
                }
            });
        }
        groups.forEach(seed);
    }

    // ── Main sheet rendering ────────────────────────────────────────
    function renderMain() {
        if (!content) { return; }
        // Update the dialog's accessible label so screen readers
        // announce the product name without needing a duplicate visible
        // H2 in the header.
        if (modal) { modal.setAttribute('aria-label', product.name || 'Item'); }
        if (heroPane) { heroPane.innerHTML = buildHeroHtml(); }
        content.innerHTML = buildContentHtml();
        if (loading) { loading.hidden = true; }
        content.hidden = false;
        if (foot) { foot.hidden = false; }
        updateTotals();
    }

    function buildHeroHtml() {
        var p = product;
        var img = (p.images && p.images[0]) || p.image || '';
        // When there's NO image we render a fixed-size tile (not full
        // pane) so the placeholder doesn't visually swallow the left
        // column. The pm-hero pane keeps the soft background; the tile
        // sits centred inside.
        if (img) {
            return '<img src="' + esc(img) + '" alt="' + esc(p.name) + '" data-img-fallback>';
        }
        return '<span class="pm-hero__tile" data-tint="' + esc(p.tint || '') + '">' +
                    '<span class="pm-hero__initial">' + esc(p.initial || '?') + '</span>' +
               '</span>';
    }

    function buildContentHtml() {
        var p = product;
        // Availability badge — status-driven (no stock). Sold out /
        // Unavailable today / Available from <date> show greyed.
        var av = p.availability || { available: (p.available !== false), soldOut: false, label: 'Available' };
        var stockLine = '';
        if (av.soldOut) {
            stockLine = '<p class="pm-stock pm-stock--out">Sold out</p>';
        } else if (av.available === false) {
            stockLine = '<p class="pm-stock pm-stock--out">' + esc(av.label || 'Unavailable') + '</p>';
        }
        var desc = p.description ? '<p class="pm-desc">' + esc(p.description) + '</p>' : '';
        var groupSections = groups.map(buildGroupSection).join('');

        // Veg / non-veg surfaced as a subtle text badge under the
        // price line — keeps the H1 clean.
        var vegBadge = '<span class="pm-veg pm-veg--' + (p.veg ? 'veg' : 'nonveg') + '">' +
                       '<span class="pm-veg__dot" aria-hidden="true"></span>' +
                       (p.veg ? 'Vegetarian' : 'Non-vegetarian') +
                       '</span>';

        return '' +
            '<div class="pm-info">' +
                '<h1 class="pm-name">' + esc(p.name) + '</h1>' +
                '<p class="pm-price" data-pm-price>' + money(p.basePrice) + '</p>' +
                vegBadge +
                stockLine +
                desc +
            '</div>' +
            (groupSections
                ? '<div class="pm-groups">' + groupSections + '</div>'
                : '') +
            '<div class="pm-note">' +
                '<label for="pm-note-input" class="pm-note__label">Special instructions (optional)</label>' +
                '<textarea id="pm-note-input" class="pm-note__input" data-pm-note maxlength="120" rows="2" placeholder="Add any special instructions…"></textarea>' +
            '</div>';
    }

    // Level-1 group rendered INLINE in the main modal — options shown
    // directly (radios for single, checkboxes for multi). Level-2
    // linked sub-groups still open in the popup (handled separately).
    function buildGroupSection(g) {
        var single = g.type === 'single';
        var sel = selections[String(g.id)] || [];
        var selSet = {};
        sel.forEach(function (id) { selSet[String(id)] = true; });

        var hint = g.required ? 'Required' : 'Optional';
        if (single) { hint += ' · Select 1'; }
        else if (g.max > 0) { hint += ' · Up to ' + g.max; }

        var inputName = 'pm-main-grp-' + g.id;
        // Each option is wrapped in `.pm-opt-wrap` so a picked option
        // with a linkedGroup can carry its summary chip INSIDE its own
        // row (rather than dumping all linked chips at the bottom of
        // the group). The wrap also owns the row divider — the chip
        // pushes the divider down, so the visual border still encloses
        // the option AND its linked summary together.
        var optsHtml = (g.options || []).map(function (o) {
            var checked = selSet[String(o.id)] ? ' checked' : '';
            var priceTag = (Number(o.price) > 0)
                ? '<span class="pm-opt__price">+' + money(o.price) + '</span>'
                : '';
            var optHtml = '<label class="pm-opt">' +
                              '<input type="' + (single ? 'radio' : 'checkbox') + '" name="' + esc(inputName) + '" value="' + esc(o.id) + '" data-pm-grp-id="' + esc(g.id) + '" data-pm-opt-id="' + esc(o.id) + '"' + checked + '>' +
                              '<span class="pm-opt__mark" aria-hidden="true"></span>' +
                              '<span class="pm-opt__name">' + esc(o.name) + '</span>' +
                              priceTag +
                          '</label>';

            var linkedHtml = '';
            if (o.linkedGroup && selSet[String(o.id)]) {
                var subSel  = selections[String(o.linkedGroup.id)] || [];
                var subText = summariseGroup(o.linkedGroup, subSel);
                var stateClass = subText ? ' pm-linked--filled' : '';
                var label = subText || 'Choose ' + (o.linkedGroup.name || 'options');
                var btn   = subText ? 'Edit' : 'Choose';
                linkedHtml =
                    '<div class="pm-linked' + stateClass + '">' +
                        '<div class="pm-linked__info">' +
                            '<span class="pm-linked__name">' + esc(o.linkedGroup.name) + '</span>' +
                            '<span class="pm-linked__sel">' + esc(label) + '</span>' +
                        '</div>' +
                        '<button type="button" class="pm-linked__edit" data-action="pm-edit-linked" data-pm-linked-id="' + esc(o.linkedGroup.id) + '">' + btn + '</button>' +
                    '</div>';
            }

            return '<div class="pm-opt-wrap">' + optHtml + linkedHtml + '</div>';
        }).join('');

        return '<section class="pm-grp" data-pm-grp="' + esc(g.id) + '">' +
                  '<header class="pm-grp__head">' +
                      '<h3 class="pm-grp__name">' + esc(g.name) + '</h3>' +
                      '<span class="pm-grp__hint">' + esc(hint) + '</span>' +
                  '</header>' +
                  '<div class="pm-grp__opts">' + optsHtml + '</div>' +
               '</section>';
    }

    function repaintGroupSection(g) {
        if (!content) { return; }
        var section = content.querySelector('[data-pm-grp="' + g.id + '"]');
        if (!section) { return; }
        var tmp = document.createElement('div');
        tmp.innerHTML = buildGroupSection(g);
        section.parentNode.replaceChild(tmp.firstChild, section);
    }

    function findParentOfLinked(linkedGroupId) {
        var lid = String(linkedGroupId);
        for (var i = 0; i < groups.length; i++) {
            var opts = groups[i].options || [];
            for (var j = 0; j < opts.length; j++) {
                if (opts[j].linkedGroup && String(opts[j].linkedGroup.id) === lid) {
                    return groups[i];
                }
            }
        }
        return null;
    }

    function summariseGroup(g, sel) {
        if (!sel || !sel.length) { return ''; }
        var byId = {};
        (g.options || []).forEach(function (o) { byId[String(o.id)] = o; });
        // For each picked option, append its linked-sub-group's picks so
        // the customer sees "Chilli Sauce → Hot" (not just "Chilli Sauce")
        // on the root group card after the chain finishes.
        return sel.map(function (id) {
            var o = byId[String(id)];
            if (!o) { return ''; }
            var label = o.name;
            if (o.linkedGroup) {
                var subSel = selections[String(o.linkedGroup.id)] || [];
                var subLbl = summariseGroup(o.linkedGroup, subSel);
                if (subLbl) { label += ' → ' + subLbl; }
            }
            return label;
        }).filter(Boolean).join(', ');
    }


    // ── Group nested sheet ──────────────────────────────────────────
    // Walk the linked-group chain via `chain`+`cursorIdx`. Top-level
    // groups start the chain; selecting an option with `linkedGroup`
    // queues that sub-group; applying advances to the next one. Back
    // / Cancel pops the stack one level.

    // Look up a group object by id — checks the top-level list AND
    // every option's `linkedGroup` so chained sub-groups resolve.
    function findGroup(gid) {
        gid = String(gid);
        for (var i = 0; i < groups.length; i++) {
            if (String(groups[i].id) === gid) { return groups[i]; }
            var opts = groups[i].options || [];
            for (var j = 0; j < opts.length; j++) {
                if (opts[j].linkedGroup && String(opts[j].linkedGroup.id) === gid) {
                    return opts[j].linkedGroup;
                }
            }
        }
        return null;
    }

    function openGroup(groupId) {
        openedFromLinkedId = String(groupId);
        chain = [String(groupId)];
        cursorIdx = 0;
        renderCurrent();
    }

    function renderCurrent() {
        if (cursorIdx < 0 || cursorIdx >= chain.length) { closeGroup(); return; }
        var gid = chain[cursorIdx];
        var g = findGroup(gid);
        if (!g) { chain.splice(cursorIdx, 1); renderCurrent(); return; }

        if (groupTitle) { groupTitle.textContent = g.name || 'Choose'; }
        if (groupHint) {
            var hint = g.required ? 'Required' : 'Optional';
            if (g.type === 'single') { hint += ' · Select 1'; }
            else if (g.max > 0)      { hint += ' · Up to ' + g.max; }
            groupHint.textContent = hint;
        }
        groupBody.innerHTML = buildGroupBody(g);
        groupModal.hidden = false;
        groupModal.setAttribute('aria-hidden', 'false');
    }

    function buildGroupBody(g) {
        var single = g.type === 'single';
        var sel = selections[String(g.id)] || [];
        var selSet = {};
        sel.forEach(function (id) { selSet[String(id)] = true; });
        var items = (g.options || []).map(function (o) {
            var checked = selSet[String(o.id)] ? ' checked' : '';
            var priceTag = (Number(o.price) > 0)
                ? '<span class="pm-opt__price">+' + money(o.price) + '</span>'
                : '';
            return '' +
                '<label class="pm-opt">' +
                    '<input type="' + (single ? 'radio' : 'checkbox') + '" name="pm-grp" value="' + esc(o.id) + '"' + checked + '>' +
                    '<span class="pm-opt__mark" aria-hidden="true"></span>' +
                    '<span class="pm-opt__name">' + esc(o.name) + '</span>' +
                    priceTag +
                '</label>';
        }).join('');
        return items || '<p class="pm-group__empty">No choices available.</p>';
    }

    function closeGroup(silent) {
        if (!groupModal || groupModal.hidden) { return; }
        groupModal.hidden = true;
        groupModal.setAttribute('aria-hidden', 'true');
        if (!silent) { chain = []; cursorIdx = 0; }
    }

    // Back / Cancel: step back one level in the chain. From the root
    // (cursorIdx === 0) it closes the sheet entirely. After applying a
    // parent group and walking into a sub-group, the parent stays at
    // chain[cursorIdx-1] so Back returns to it with prior picks intact.
    function cancelGroup() {
        if (cursorIdx > 0) {
            cursorIdx--;
            renderCurrent();
        } else {
            chain = []; cursorIdx = 0;
            closeGroup();
        }
    }

    function applyGroup() {
        if (cursorIdx < 0 || cursorIdx >= chain.length) { return; }
        var gid = chain[cursorIdx];
        var g   = findGroup(gid);
        if (!g) { closeGroup(); return; }

        var picks = $$('input[name="pm-grp"]:checked', groupBody).map(function (i) { return i.value; });
        if (g.max > 0 && g.type !== 'single' && picks.length > g.max) {
            toast('error', 'You can pick at most ' + g.max + '.');
            return;
        }
        if (g.required && picks.length < (g.min || 1)) {
            toast('error', 'Please choose ' + (g.min || 1) + '.');
            return;
        }
        selections[String(g.id)] = picks;

        // For options NOT picked anymore, prune any linked-sub-group
        // selections they had — otherwise a "Chilli Sauce → Hot" choice
        // would linger after switching back to "Garlic Sauce".
        (g.options || []).forEach(function (o) {
            if (!o.linkedGroup) { return; }
            if (picks.indexOf(String(o.id)) === -1) {
                delete selections[String(o.linkedGroup.id)];
            }
        });

        // Replace anything downstream of THIS group in the chain with
        // this apply's freshly-queued linked sub-groups (in selection
        // order). Picking a different option on a re-visit invalidates
        // the previous downstream walk — we re-walk from here.
        var linked = [];
        (g.options || []).forEach(function (o) {
            if (o.linkedGroup && picks.indexOf(String(o.id)) !== -1) {
                linked.push(String(o.linkedGroup.id));
            }
        });
        if (linked.length) {
            chain.splice(cursorIdx + 1);
            linked.forEach(function (id) { chain.push(id); });
        }

        if (cursorIdx + 1 < chain.length) {
            cursorIdx++;
            renderCurrent();
            return;
        }

        // Chain finished — repaint the parent group section so the
        // linked summary chip updates, then close the popup.
        var parent = findParentOfLinked(openedFromLinkedId);
        if (parent) { repaintGroupSection(parent); }
        openedFromLinkedId = null;
        updateTotals();
        chain = []; cursorIdx = 0;
        closeGroup();
    }

    // ── Totals ─────────────────────────────────────────────────────
    // Walks the FULL chain: each top-level group, plus any linked
    // sub-groups attached to picked options. Without the recursion a
    // "+£0.50 spicy" sub-pick wouldn't roll into the line total.
    function lineUnitPrice() {
        var base = Number(product && product.basePrice) || 0;
        function sumGroup(g) {
            var sel = selections[String(g.id)] || [];
            var byId = {};
            (g.options || []).forEach(function (o) { byId[String(o.id)] = o; });
            sel.forEach(function (id) {
                var o = byId[String(id)];
                if (!o) { return; }
                base += Number(o.price) || 0;
                if (o.linkedGroup) { sumGroup(o.linkedGroup); }
            });
        }
        groups.forEach(sumGroup);
        return base;
    }
    function updateTotals() {
        var unit = lineUnitPrice();
        var total = unit * qty;
        if (qtyEl)      { qtyEl.textContent = String(qty); }
        if (totalEl)    { totalEl.textContent = money(total); }
        if (addLabelEl) { addLabelEl.textContent = 'Add ' + qty + ' to order'; }
    }

    function step(delta) {
        var next = qty + delta;
        if (next < 1) { next = 1; }
        // Soft per-line cap (no stock counting).
        if (next > 99) { return; }
        qty = next;
        updateTotals();
    }

    // ── Add to cart ────────────────────────────────────────────────
    // Walks the full chain — a required linked sub-group still blocks
    // checkout if it wasn't completed.
    function firstMissingRequiredGroup() {
        function check(g) {
            if (g.required) {
                var sel = selections[String(g.id)] || [];
                if (sel.length < (g.min || 1)) { return g; }
            }
            var sel2 = selections[String(g.id)] || [];
            var picks = {};
            sel2.forEach(function (id) { picks[String(id)] = true; });
            var opts = g.options || [];
            for (var i = 0; i < opts.length; i++) {
                if (opts[i].linkedGroup && picks[String(opts[i].id)]) {
                    var miss = check(opts[i].linkedGroup);
                    if (miss) { return miss; }
                }
            }
            return null;
        }
        for (var i = 0; i < groups.length; i++) {
            var miss = check(groups[i]);
            if (miss) { return miss; }
        }
        return null;
    }

    function addToCart(btn) {
        if (!product) { return; }
        var av = product.availability || { available: (product.available !== false), soldOut: false };
        if (av.available === false) { toast('error', av.soldOut ? 'This item is sold out.' : 'This item is currently unavailable.'); return; }
        var miss = firstMissingRequiredGroup();
        if (miss) {
            toast('error', 'Please choose: ' + miss.name + '.');
            openGroup(miss.id);
            return;
        }
        // Walk the chain to collect every selected (group, option) pair
        // — top-level AND linked sub-groups — flattened for the API.
        // The API prefixes group ids with "m" (legacy modifier
        // convention from ProductsController.buildGroup), but the
        // cart-add validator only accepts numeric ids. Strip the
        // leading letter — matches the legacy product page's stripper
        // (`rawGroup.replace(/^[a-z]/, '')` in ui/cart.js).
        function stripPrefix(id) { return String(id).replace(/^[a-z]/i, ''); }
        var options = [];
        function collect(g) {
            var sel = selections[String(g.id)] || [];
            sel.forEach(function (oid) {
                options.push({ groupId: stripPrefix(g.id), optionId: String(oid) });
                var byId = {};
                (g.options || []).forEach(function (o) { byId[String(o.id)] = o; });
                var picked = byId[String(oid)];
                if (picked && picked.linkedGroup) { collect(picked.linkedGroup); }
            });
        }
        groups.forEach(collect);
        var note = (content.querySelector('[data-pm-note]') || {}).value || '';
        var body = {
            product_id: product.id,
            qty:        qty,
            options:    options,
            remark:     String(note).trim().slice(0, 120),
        };

        if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
        fetch('/cart/add', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
              if (!env) { toast('error', 'Could not reach the server.'); return; }
              if (env.status === 401) {
                  window.location.href = '/signin?next=' + encodeURIComponent(window.location.pathname + window.location.search);
                  return;
              }
              if (env.status === 409 && env.data && env.data.code === 'branch.conflict') {
                  var dlg = (window.EatNDealUi && window.EatNDealUi.confirmDialog)
                      ? window.EatNDealUi.confirmDialog
                      : function (o) { return Promise.resolve(window.confirm(o.message || '')); };
                  dlg({
                      title:    'Switch restaurant?',
                      message:  env.msg || 'Your cart has items from another restaurant. Clearing it will start a new cart at this one.',
                      okLabel:  'Clear and add',
                      cancelLabel: 'Keep current cart',
                  }).then(function (ok) {
                      if (!ok) { return; }
                      body.replace_cart = true;
                      // Re-fire with replace flag — no flyToCart on
                      // first call so the visual still happens AFTER
                      // the cart actually changes.
                      fetch('/cart/add', {
                          method: 'POST', credentials: 'same-origin',
                          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                          body: JSON.stringify(body),
                      }).then(function (r2) { return r2.json().catch(function () { return null; }); })
                        .then(handleAddSuccess)
                        .catch(function () { toast('error', 'Could not add to cart.'); });
                  });
                  return;
              }
              if (env.status !== 200) { toast('error', env.msg || 'Could not add to cart.'); return; }
              handleAddSuccess(env);
          })
          .catch(function () {
              if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
              toast('error', 'Could not add to cart.');
          });
    }

    // ── Share ──────────────────────────────────────────────────────
    // Uses the Web Share API where available (most mobile browsers +
    // Safari desktop). Falls back to copying the deep-link URL to the
    // clipboard with a toast so the customer still has a path to share.
    function share() {
        if (!product) { return; }
        var rest  = product.restaurant && product.restaurant.slug;
        var slug  = product.slug || '';
        var url   = window.location.origin
            + (rest && slug ? '/?rest=' + encodeURIComponent(rest) + '&item=' + encodeURIComponent(slug)
                            : window.location.pathname);
        var title = product.name || 'Item';
        if (navigator.share) {
            navigator.share({ title: title, url: url }).catch(function () { /* user-cancelled is fine */ });
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
                toast('success', 'Link copied to clipboard.');
            }).catch(function () {
                toast('info', url);
            });
            return;
        }
        toast('info', url);
    }

    function handleAddSuccess(env) {
        if (!env || env.status !== 200) {
            toast('error', (env && env.msg) || 'Could not add to cart.');
            return;
        }
        // Reuse the cart module's badge updater so the count is one
        // canonical writer — no DOM-state drift across modules.
        var cartGlobal = window.EatNDealCart;
        if (cartGlobal && typeof cartGlobal.bumpCartBadge === 'function') {
            cartGlobal.bumpCartBadge(env.data && env.data.cart);
        }
        toast('success', (product && product.name ? product.name : 'Item') + ' added to cart');
        close();
    }

    // ── Inline top-level group: option change ─────────────────────
    function onTopLevelChange(inp) {
        var gid = inp.getAttribute('data-pm-grp-id');
        var oid = inp.getAttribute('data-pm-opt-id');
        if (!gid || !oid) { return; }
        var g = findGroup(gid);
        if (!g) { return; }

        if (g.type === 'single') {
            // Radio — replace any prior selection. Clear linked sub-
            // group selections for the other options so a switched-away
            // chain doesn't leak (e.g. "Garlic → Spice=Hot" lingering
            // after switching to "Chilli").
            selections[String(gid)] = [String(oid)];
            (g.options || []).forEach(function (o) {
                if (o.linkedGroup && String(o.id) !== String(oid)) {
                    delete selections[String(o.linkedGroup.id)];
                }
            });
        } else {
            // Checkbox — toggle, honour `max`. Falls back to the prior
            // state if max would be exceeded.
            var arr = selections[String(gid)] = selections[String(gid)] || [];
            if (inp.checked) {
                if (g.max > 0 && arr.length >= g.max) {
                    inp.checked = false;
                    toast('error', 'You can pick at most ' + g.max + '.');
                    return;
                }
                if (arr.indexOf(String(oid)) === -1) { arr.push(String(oid)); }
            } else {
                var idx = arr.indexOf(String(oid));
                if (idx !== -1) { arr.splice(idx, 1); }
                // Picked option deselected: drop its linked sub-group
                // selections too.
                var unpicked = (g.options || []).filter(function (o) { return String(o.id) === String(oid); })[0];
                if (unpicked && unpicked.linkedGroup) {
                    delete selections[String(unpicked.linkedGroup.id)];
                }
            }
        }

        updateTotals();

        // If the option that was JUST CHECKED carries a linked sub-
        // group, open the popup for it so the customer doesn't have
        // to hunt for an Edit button. Always repaint the section so
        // the linked summary chip reflects the new state.
        var pickedOpt = null;
        (g.options || []).forEach(function (o) {
            if (String(o.id) === String(oid)) { pickedOpt = o; }
        });
        repaintGroupSection(g);
        if (inp.checked && pickedOpt && pickedOpt.linkedGroup) {
            openGroup(pickedOpt.linkedGroup.id);
        }
    }

    // ── Document delegate ──────────────────────────────────────────
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        // Opening triggers — set on every product card across surfaces.
        var opener = t.closest('[data-action="open-product"]');
        if (opener) {
            ev.preventDefault();
            open({
                rest: opener.getAttribute('data-rest') || '',
                item: opener.getAttribute('data-item') || '',
                id:   opener.getAttribute('data-id')   || '',
            });
            return;
        }

        // Inside the modal: close / nested group / qty / add.
        if (!modal || modal.hidden) { return; }

        if (t.closest('[data-action="pm-close"]'))         { ev.preventDefault(); close(); return; }
        if (t.closest('[data-action="pm-share"]'))         { ev.preventDefault(); share(); return; }
        if (t.closest('[data-action="pm-qty-inc"]'))       { ev.preventDefault(); step(+1); return; }
        if (t.closest('[data-action="pm-qty-dec"]'))       { ev.preventDefault(); step(-1); return; }
        var addBtn = t.closest('[data-action="pm-add"]');
        if (addBtn) { ev.preventDefault(); addToCart(addBtn); return; }

        // Edit a linked sub-group from its inline summary chip.
        var linkEdit = t.closest('[data-action="pm-edit-linked"]');
        if (linkEdit) { ev.preventDefault(); openGroup(linkEdit.getAttribute('data-pm-linked-id')); return; }

        if (t.closest('[data-action="pm-group-cancel"]')) { ev.preventDefault(); cancelGroup(); return; }
        if (t.closest('[data-action="pm-group-apply"]'))  { ev.preventDefault(); applyGroup(); return; }
    });

    // Escape closes the topmost open layer.
    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') { return; }
        if (groupModal && !groupModal.hidden) { closeGroup(); return; }
        if (modal && !modal.hidden) { close(); return; }
    });

    // Expose for any other module that needs to drive it programmatically.
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.productModal = { open: open, close: close };
})();
