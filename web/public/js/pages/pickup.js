/*
 * pages/pickup.js
 *
 * What:  Drives the Pickup surface (views/partials/pickup.ejs):
 *          • Reads the server-rendered restaurant cards (rating / name /
 *            eta / image …) and plots each one on a LOCAL time-ring panel:
 *            the customer sits at the centre and every restaurant sits on
 *            the ring for its pickup ETA. No street tiles, nothing
 *            external (CSP-safe), and no dependence on branch coordinates
 *            — which are unreliable in the live data (see "TIME RINGS").
 *          • Marker tap → popup card over the map + cross-highlights the
 *            matching list card (and scrolls it into view). Popup / card
 *            tap → opens that restaurant (the <a> href does the nav).
 *          • Hide-list / Map toggles flip between split and full-map.
 * Why:   Pickup is a "how soon can I collect this" decision, so the panel
 *        answers exactly that. An earlier geographic version collapsed to
 *        a single dot whenever one branch carried a placeholder lat/lng.
 * Used:  Loaded only on the pickup page (SiteController sets extra_js).
 */

(function () {
    'use strict';

    // ── Sidebar / bottom-sheet filters on Pickup ──────────────────────
    // home.js (which turns the filter state into a URL on delivery) isn't
    // loaded here, so we listen for the SAME `eatndeal:filters-changed`
    // event the sidebar/sheet dispatch and full-reload to a pickup URL.
    function pickupFiltersToQuery(s) {
        s = s || {};
        var q = new URLSearchParams();
        q.set('mode', 'pickup');
        if (s.cuisine) { q.set('cuisine', String(s.cuisine).toLowerCase()); }
        if (s.sort && s.sort !== 'relevance') { q.set('sort', s.sort); }
        if (s.rating) { var n = parseFloat(String(s.rating).replace(/^rating-/, '')); if (isFinite(n) && n > 0) { q.set('rating', String(n)); } }
        if (s.deliveryBuckets && s.deliveryBuckets.length) {
            var keys = s.deliveryBuckets.filter(function (k) { return /^(15|30|45|60)$/.test(k); });
            if (keys.length) { q.set('delivery', keys.join(',')); }
        }
        if (s.distance) { var km = parseInt(String(s.distance).replace(/^dist-/, ''), 10); if (isFinite(km) && km > 0) { q.set('max_km', String(km)); } }
        if (s.price) { var b = String(s.price).replace(/^price-/, ''); if (b === 'low' || b === 'mid' || b === 'high') { q.set('price', b); } }
        if ((s.trust || []).indexOf('trust-pure-veg') !== -1) { q.set('veg', '1'); }
        if ((s.offers || []).indexOf('offer-discount') !== -1) { q.set('offer', '1'); }
        if ((s.availability || []).indexOf('avail-open-now') !== -1) { q.set('open_now', '1'); }
        return q;
    }
    document.addEventListener('eatndeal:filters-changed', function (ev) {
        window.location.href = '/?' + pickupFiltersToQuery(ev.detail || {}).toString();
    });
    // Filter controls (home.js owns these on delivery; replicated here since
    // home.js isn't loaded on pickup — WITHOUT this the mobile Filters button
    // did nothing on pickup):
    //   • open-filters   (mobile search-row button) → open the sidebar overlay
    //   • toggle-filters → mobile: close the overlay; desktop: collapse column
    //   • filters-apply  → mobile: close the overlay (the sidebar then
    //                      broadcasts eatndeal:filters-changed → we reload)
    function isDesktopFilters() {
        return window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
    }
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        if (t.closest('[data-action="open-filters"]')) {
            ev.preventDefault();
            document.body.classList.add('is-mobile-filters-open');
            return;
        }
        if (t.closest('[data-action="toggle-filters"]')) {
            ev.preventDefault();
            if (!isDesktopFilters()) {
                document.body.classList.remove('is-mobile-filters-open');
                return;
            }
            var shell = document.querySelector('.home-shell');
            if (shell) { shell.classList.toggle('is-filters-collapsed'); }
            return;
        }
        if (!isDesktopFilters() && t.closest('[data-action="filters-apply"]')) {
            document.body.classList.remove('is-mobile-filters-open');
        }
    });

    var PAD = 48;   // keep markers off the panel edges (px)

    // Markers closer together than this on screen get nudged apart so each
    // one stays tappable (they'd otherwise stack into a single pin).
    var MIN_MARKER_GAP_PX = 34;

    /*
     * TIME RINGS — what this panel plots.
     *
     * It is deliberately NOT a geographic map. Branch coordinates in the live
     * data are unreliable (placeholder values like 123456 are common), and a
     * single bad point used to collapse every marker onto one pixel, which is
     * what made the old map look empty and its zoom look broken.
     *
     * What a customer choosing pickup actually wants to know is "how soon can
     * I collect this", so the panel answers that directly: they sit at the
     * centre, and each restaurant is placed on the ring for its pickup ETA.
     * The bands match the Pickup Time filter in the sidebar exactly, so the
     * picture and the filters tell the same story.
     */
    var RINGS = [
        { max: 15,       label: 'Up to 15 min' },
        { max: 30,       label: '15 – 30 min'  },
        { max: 45,       label: '30 – 45 min'  },
        { max: Infinity, label: '45+ min'      },
    ];

    /**
     * etaMinutes
     *
     * What:  "30 min" / "1 hour" / "45-60 min" → a number of minutes. Reads
     *        the FIRST number and scales it when the label says hours; a
     *        range takes its lower bound (the soonest you could collect).
     *        Unparseable → null.
     * Type:  READ (pure).
     */
    function etaMinutes(eta) {
        var s = String(eta || '').toLowerCase();
        var m = s.match(/(\d+(?:\.\d+)?)/);
        if (!m) { return null; }
        var n = parseFloat(m[1]);
        if (!isFinite(n)) { return null; }
        return /hour|hr/.test(s) ? Math.round(n * 60) : Math.round(n);
    }

    /**
     * bandFor — index into RINGS for one ETA. An unknown ETA goes to the
     * outermost band rather than pretending it is fast.
     * Type: READ (pure).
     */
    function bandFor(eta) {
        var mins = etaMinutes(eta);
        if (mins == null) { return RINGS.length - 1; }
        for (var i = 0; i < RINGS.length; i += 1) {
            if (mins <= RINGS[i].max) { return i; }
        }
        return RINGS.length - 1;
    }

    /**
     * drawRings
     *
     * What:  Paints the concentric band circles + their labels under the
     *        markers. Rebuilt on every layout so zoom and pan move them with
     *        the markers.
     * Type:  WRITE (DOM).
     */
    function drawRings(cx, cy, step) {
        var old = q('.pickup-rings', planeEl);
        if (old) { old.remove(); }

        var wrap = document.createElement('div');
        wrap.className = 'pickup-rings';
        wrap.setAttribute('aria-hidden', 'true');

        RINGS.forEach(function (ring, i) {
            var r = step * (i + 1);
            var c = document.createElement('div');
            c.className = 'pickup-ring';
            c.style.left   = (cx - r) + 'px';
            c.style.top    = (cy - r) + 'px';
            c.style.width  = (r * 2) + 'px';
            c.style.height = (r * 2) + 'px';
            wrap.appendChild(c);

            var lab = document.createElement('span');
            lab.className = 'pickup-ring__label';
            lab.textContent = ring.label;
            lab.style.left = cx + 'px';
            lab.style.top  = (cy - r) + 'px';
            wrap.appendChild(lab);
        });

        // Behind the markers — insertBefore keeps the DOM order honest
        // instead of relying on z-index alone.
        planeEl.insertBefore(wrap, planeEl.firstChild);
    }

    /**
     * spreadOverlaps
     *
     * What:  Pushes markers that landed on top of each other into a small
     *        ring around their shared spot, so two restaurants at the same
     *        postcode are both clickable instead of one hiding the other.
     *        Positions move by a few px only — the geography still reads
     *        correctly.
     * Type:  WRITE (mutates m.x / m.y).
     */
    function spreadOverlaps(pts) {
        for (var i = 0; i < pts.length; i += 1) {
            var clash = [];
            for (var j = 0; j < pts.length; j += 1) {
                if (j === i) { continue; }
                var dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
                if (Math.sqrt(dx * dx + dy * dy) < MIN_MARKER_GAP_PX) { clash.push(j); }
            }
            if (!clash.length) { continue; }
            // Fan this marker and its clashing neighbours around the point.
            var group = [i].concat(clash).sort(function (a, b) { return a - b; });
            if (group[0] !== i) { continue; }          // handled by the first of the group
            var r = MIN_MARKER_GAP_PX * 0.7;
            group.forEach(function (idx, k) {
                if (k === 0) { return; }               // leave the first where it is
                var a = (2 * Math.PI * k) / group.length;
                pts[idx].x += Math.cos(a) * r;
                pts[idx].y += Math.sin(a) * r;
            });
        }
    }

    var root, listEl, mapEl, planeEl, popupEl;
    var markers = [];        // { card, marker, x, y, data }
    var activeKey = null;
    // View transform: zoom multiplies the fit-to-screen scale; pan is a
    // pixel offset applied to every marker + the "you" dot (drag to move).
    var zoom = 1, panX = 0, panY = 0;
    var baseScale = 1;       // fit-to-screen scale at zoom = 1 (set in layout)
    var ZOOM_MIN = 0.4, ZOOM_MAX = 8, ZOOM_STEP = 1.4, ZOOM_STEP_WHEEL = 1.15;

    function q(sel, ctx) { return (ctx || document).querySelector(sel); }
    var qa = (window.EatNDealDom && window.EatNDealDom.queryAll) || function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

    var escHtml = (window.EatNDealFormat && window.EatNDealFormat.esc) || function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    };

    var STAR = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    // Map-pin glyph for the distance markers (km from the user).
    var PIN = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>';

    /**
     * readCards
     *
     * What:  Pulls the restaurant data off each server-rendered list
     *        card into a plain object. Only cards with a real lat/lng
     *        can be mapped; the rest stay in the list but get no marker.
     */
    function readCards() {
        return qa('.pickup-card', listEl).map(function (card) {
            return {
                card:    card,
                id:      card.getAttribute('data-id') || '',
                slug:    card.getAttribute('data-slug') || '',
                rating:  card.getAttribute('data-rating') || '',
                name:    card.getAttribute('data-name') || '',
                eta:     card.getAttribute('data-eta') || '',
                dist:    card.getAttribute('data-dist') || '',
                image:   card.getAttribute('data-image') || '',
                tint:    card.getAttribute('data-tint') || '',
                initial: card.getAttribute('data-initial') || '',
            };
        });
    }

    /**
     * layout
     *
     * What:  (Re)projects every restaurant onto the plane and positions
     *        the markers + the "you" dot. Equirectangular projection
     *        scaled uniformly so the real geography (and thus the km
     *        ordering) is preserved; a single scale keeps aspect ratio.
     *        Safe to call on first paint, after a toggle, and on resize.
     */
    function layout() {
        if (!planeEl) { return; }
        var w = planeEl.clientWidth;
        var h = planeEl.clientHeight;
        if (w < 20 || h < 20) { return; }   // map hidden (e.g. mobile list view)

        var pts = markers;
        if (!pts.length) { return; }

        // Ring radius at zoom 1: the outermost band sits just inside the
        // padded box, so every restaurant is always on screen before the
        // user zooms.
        baseScale = (Math.min(w, h) / 2 - PAD) / RINGS.length;
        if (!isFinite(baseScale) || baseScale <= 0) { baseScale = 1; }
        var ringStep = baseScale * zoom;

        var cx = w / 2 + panX, cy = h / 2 + panY;

        // Group by band first so each band can fan its own restaurants
        // evenly around the circle instead of them bunching at one angle.
        var byBand = {};
        pts.forEach(function (m) {
            var b = bandFor(m.data.eta);
            if (!byBand[b]) { byBand[b] = []; }
            byBand[b].push(m);
        });

        Object.keys(byBand).forEach(function (bandIdx) {
            var group = byBand[bandIdx];
            var r = ringStep * (Number(bandIdx) + 1);
            group.forEach(function (m, i) {
                // Offset each band's starting angle so neighbouring rings
                // don't line their markers up along the same spoke.
                var a = ((2 * Math.PI * i) / group.length) - (Math.PI / 2)
                      + (Number(bandIdx) * 0.5);
                m.x = cx + Math.cos(a) * r;
                m.y = cy + Math.sin(a) * r;
            });
        });

        // Two restaurants on the same ring with the same ETA can still land
        // close together — fan them apart so each stays tappable.
        spreadOverlaps(pts);
        pts.forEach(function (m) {
            m.marker.style.left = m.x + 'px';
            m.marker.style.top  = m.y + 'px';
        });

        drawRings(cx, cy, ringStep);

        // "You are here" dot — always drawn now: the centre IS the user in a
        // time-based view, no coordinates needed.
        var you = q('.pickup-map__you', planeEl);
        if (!you) {
            you = document.createElement('div');
            you.className = 'pickup-map__you';
            you.title = 'You are here';
            planeEl.appendChild(you);
        }
        you.style.left = cx + 'px';
        you.style.top  = cy + 'px';

        // Keep an open popup glued to its marker.
        if (activeKey) {
            var act = markers.filter(function (m) { return m.id === activeKey; })[0];
            if (act) { positionPopup(act); }
        }
    }

    /**
     * buildMarkers
     *
     * What:  Creates one .pickup-marker per mappable restaurant and wires
     *        its tap → openPopup. Markers live inside the plane.
     */
    function buildMarkers() {
        var data = readCards();
        markers = [];
        // EVERY restaurant gets a marker now. Placement is by pickup ETA, not
        // by coordinates, so a branch with missing or placeholder lat/lng is
        // no longer silently dropped from the panel.
        data.forEach(function (d) {
            var marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'pickup-marker';
            marker.setAttribute('data-key', d.id);
            // Show the TIME estimate. Distance in km is deliberately not
            // surfaced anywhere in the UI.
            var label = d.eta || '·';
            marker.innerHTML = '<span class="pickup-marker__pill">' + PIN + escHtml(label) + '</span>';
            marker.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openPopup(d.id);
            });
            planeEl.appendChild(marker);
            markers.push({ id: d.id, data: d, marker: marker });
        });
    }

    /**
     * openPopup / closePopup
     *
     * What:  Show a small card over the map for the tapped marker (image,
     *        name, rating, eta·dist) that links to the restaurant. Also
     *        cross-highlights the matching list card + scrolls it into
     *        view. Closing clears the highlight.
     */
    function openPopup(key) {
        var m = markers.filter(function (x) { return x.id === key; })[0];
        if (!m || !popupEl) { return; }
        activeKey = key;

        var d = m.data;
        var href = '/?restaurant=' + encodeURIComponent(d.slug || d.id) + '&mode=pickup';
        var media = d.image
            ? '<img src="' + escHtml(d.image) + '" alt="" data-img-fallback>'
            : '<span class="pickup-popup__initial" data-tint="' + escHtml(d.tint) + '">' + escHtml(d.initial) + '</span>';
        var meta = [];
        if (d.eta)  { meta.push(escHtml(d.eta)); }

        popupEl.innerHTML =
            '<button type="button" class="pickup-popup__close" data-action="pickup-popup-close" aria-label="Close">&times;</button>' +
            '<a class="pickup-popup__link" href="' + href + '">' +
              '<span class="pickup-popup__img">' + media + '</span>' +
              '<span class="pickup-popup__body">' +
                '<span class="pickup-popup__row">' +
                  '<span class="pickup-popup__name">' + escHtml(d.name) + '</span>' +
                  (d.rating ? ('<span class="pickup-popup__rating">' + STAR + escHtml(d.rating) + '</span>') : '') +
                '</span>' +
                (meta.length ? '<span class="pickup-popup__meta">' + meta.join(' · ') + '</span>' : '') +
              '</span>' +
            '</a>';
        popupEl.hidden = false;
        applyTints(popupEl);

        // Marker + card highlight.
        markers.forEach(function (x) { x.marker.classList.toggle('is-active', x.id === key); });
        qa('.pickup-card', listEl).forEach(function (c) {
            c.classList.toggle('is-active', c.getAttribute('data-id') === key);
        });
        var card = q('.pickup-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]', listEl);
        if (card && card.scrollIntoView) {
            try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* noop */ }
        }
        positionPopup(m);
    }

    function closePopup() {
        if (popupEl) { popupEl.hidden = true; popupEl.innerHTML = ''; }
        markers.forEach(function (x) { x.marker.classList.remove('is-active'); });
        qa('.pickup-card.is-active', listEl).forEach(function (c) { c.classList.remove('is-active'); });
        activeKey = null;
    }

    /**
     * positionPopup
     *
     * What:  Places the popup centred above its marker, clamped inside
     *        the plane. Flips below the marker when there isn't room
     *        above.
     */
    function positionPopup(m) {
        if (!popupEl || popupEl.hidden) { return; }
        var w = planeEl.clientWidth, h = planeEl.clientHeight;
        var pw = popupEl.offsetWidth || 248;
        var ph = popupEl.offsetHeight || 180;
        var left = (m.x || w / 2) - pw / 2;
        var top  = (m.y || h / 2) - ph - 16;             // above the marker
        if (top < 8) { top = (m.y || h / 2) + 16; }       // not enough room → below
        left = Math.max(8, Math.min(left, w - pw - 8));
        top  = Math.max(8, Math.min(top, h - ph - 8));
        popupEl.style.left = left + 'px';
        popupEl.style.top  = top + 'px';
    }

    /**
     * applyTints
     *
     * What:  Paints the data-tint placeholders (card media + popup
     *        initial) — same trick home.js uses, kept here because
     *        home.js isn't loaded on the pickup page.
     */
    function applyTints(scope) {
        qa('[data-tint]', scope || document).forEach(function (el) {
            var t = el.getAttribute('data-tint');
            if (t) { el.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.45), transparent 60%), ' + t; }
        });
    }

    /**
     * bindImageFallback
     *
     * What:  Hides any <img data-img-fallback> that fails to load so the
     *        tinted placeholder shows through (home.js owns this on the
     *        delivery feed; pickup needs its own copy).
     */
    function bindImageFallback() {
        document.addEventListener('error', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'IMG' && t.hasAttribute('data-img-fallback')) { t.style.display = 'none'; }
        }, true);
    }

    function isMobile() {
        return window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
    }

    /**
     * setZoom
     *
     * What:  Multiplies the current zoom by `factor` (clamped) and
     *        re-projects. Zoom is centred on the current view centre
     *        (the user dot's screen position), so + spreads the markers
     *        out and − clusters them back.
     */
    function setZoom(factor) {
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
        layout();
    }

    /**
     * zoomAt
     *
     * What:  Zooms by `factor` while keeping the point under the cursor
     *        (mx, my, in plane-relative px) fixed — the natural
     *        "scroll-wheel zooms toward the pointer" behaviour. Adjusts
     *        pan so the world point beneath the cursor doesn't drift.
     */
    function zoomAt(factor, mx, my) {
        var w = planeEl.clientWidth, h = planeEl.clientHeight;
        var cx = w / 2 + panX, cy = h / 2 + panY;
        var oldScale = baseScale * zoom;
        var newZoom  = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
        if (newZoom === zoom) { return; }
        var newScale = baseScale * newZoom;
        if (oldScale > 0) {
            // World offset of the cursor from the current centre, kept
            // invariant across the scale change → solve for new centre.
            var ox = (mx - cx) / oldScale;
            var oy = (my - cy) / oldScale;
            panX = (mx - ox * newScale) - w / 2;
            panY = (my - oy * newScale) - h / 2;
        }
        zoom = newZoom;
        layout();
    }

    /**
     * bindPan
     *
     * What:  Drag the map to pan when zoomed in. Pointer drags on empty
     *        map space update panX/panY (markers + you-dot follow);
     *        drags that start on a marker / popup / control are ignored
     *        so those keep working.
     * Type:  WRITE (pan offset + DOM cursor class).
     */
    function bindPan() {
        if (!planeEl) { return; }
        var dragging = false, sx = 0, sy = 0;
        planeEl.addEventListener('pointerdown', function (e) {
            if (e.target.closest && e.target.closest('.pickup-marker, .pickup-map__popup, .pickup-map__toggle, .pickup-map__zoom')) { return; }
            dragging = true; sx = e.clientX; sy = e.clientY;
            planeEl.classList.add('is-grabbing');
            if (planeEl.setPointerCapture) { try { planeEl.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } }
        });
        planeEl.addEventListener('pointermove', function (e) {
            if (!dragging) { return; }
            panX += (e.clientX - sx);
            panY += (e.clientY - sy);
            sx = e.clientX; sy = e.clientY;
            layout();
        });
        function end() { dragging = false; planeEl.classList.remove('is-grabbing'); }
        planeEl.addEventListener('pointerup', end);
        planeEl.addEventListener('pointercancel', end);

        // Mouse-wheel / trackpad zoom, anchored at the cursor. Scroll
        // up = zoom in, down = zoom out. preventDefault stops the page
        // scrolling while the pointer is over the map.
        planeEl.addEventListener('wheel', function (e) {
            e.preventDefault();
            var rect   = planeEl.getBoundingClientRect();
            var mx     = e.clientX - rect.left;
            var my     = e.clientY - rect.top;
            var factor = e.deltaY < 0 ? ZOOM_STEP_WHEEL : (1 / ZOOM_STEP_WHEEL);
            zoomAt(factor, mx, my);
        }, { passive: false });
    }

    /**
     * bindToggles
     *
     * What:  The list/map switches.
     *          • "Map" (mobile, in list) → open the full-screen map.
     *          • map toggle → mobile: close the map; desktop: hide/show
     *            the list (full-width map). Relayouts after either, since
     *            the map's size changes.
     */
    function bindToggles() {
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            if (t.closest('[data-action="pickup-zoom-in"]'))  { ev.preventDefault(); setZoom(ZOOM_STEP);     return; }
            if (t.closest('[data-action="pickup-zoom-out"]')) { ev.preventDefault(); setZoom(1 / ZOOM_STEP); return; }

            if (t.closest('[data-action="pickup-open-map"]')) {
                ev.preventDefault();
                root.classList.add('is-map-only');
                requestAnimationFrame(layout);
                return;
            }
            if (t.closest('[data-action="pickup-popup-close"]')) {
                ev.preventDefault();
                closePopup();
                return;
            }
            if (t.closest('[data-action="pickup-toggle"]')) {
                ev.preventDefault();
                if (isMobile()) {
                    root.classList.remove('is-map-only');
                } else {
                    root.classList.toggle('is-list-collapsed');
                }
                updateToggleLabel();
                requestAnimationFrame(layout);
                return;
            }
        });

        // Tapping empty map space closes an open popup.
        if (mapEl) {
            mapEl.addEventListener('click', function (ev) {
                if (ev.target === mapEl || ev.target === planeEl) { closePopup(); }
            });
        }
    }

    function updateToggleLabel() {
        var label = q('[data-toggle-label]', mapEl);
        if (!label) { return; }
        if (isMobile())                                  { label.textContent = 'View list'; }
        else if (root.classList.contains('is-list-collapsed')) { label.textContent = 'Show list'; }
        else                                             { label.textContent = 'Hide list'; }
    }

    /**
     * bindRailArrows
     *
     * What:  Minimal prev/next scroll for the cuisine rail (home.js owns
     *        this on the delivery feed; pickup needs its own copy).
     */
    function bindRailArrows() {
        qa('[data-rail-wrap]').forEach(function (wrap) {
            var rail = q('[data-rail]', wrap);
            var prev = q('[data-rail-prev]', wrap);
            var next = q('[data-rail-next]', wrap);
            if (!rail) { return; }
            function refresh() {
                var over = rail.scrollWidth - rail.clientWidth > 4;
                var max  = rail.scrollWidth - rail.clientWidth - 2;
                if (prev) { prev.hidden = !over || rail.scrollLeft <= 2; }
                if (next) { next.hidden = !over || rail.scrollLeft >= max; }
            }
            if (prev) { prev.addEventListener('click', function () { rail.scrollBy({ left: -Math.max(200, rail.clientWidth * 0.8), behavior: 'smooth' }); }); }
            if (next) { next.addEventListener('click', function () { rail.scrollBy({ left:  Math.max(200, rail.clientWidth * 0.8), behavior: 'smooth' }); }); }
            rail.addEventListener('scroll', refresh, { passive: true });
            window.addEventListener('resize', refresh);
            refresh();
            window.setTimeout(refresh, 250);
        });
    }

    function onReady() {
        root = q('[data-pickup]');
        if (!root) { return; }
        listEl  = q('[data-pickup-list]', root);
        mapEl   = q('[data-pickup-map]', root);
        planeEl = q('[data-map-plane]', root);
        popupEl = q('[data-map-popup]', root);

        bindImageFallback();
        applyTints(root);

        buildMarkers();
        layout();
        updateToggleLabel();
        bindToggles();
        bindPan();
        bindRailArrows();

        // Re-project on resize (debounced via rAF).
        var pending = false;
        window.addEventListener('resize', function () {
            if (pending) { return; }
            pending = true;
            requestAnimationFrame(function () { pending = false; layout(); });
        });
        // Fonts/images can shift the plane size a beat later.
        window.setTimeout(layout, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
