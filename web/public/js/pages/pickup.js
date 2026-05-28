/*
 * pages/pickup.js
 *
 * What:  Drives the Pickup surface (views/partials/pickup.ejs):
 *          • Reads the server-rendered restaurant cards (which carry
 *            data-lat / data-lng / rating / name / eta / dist / image …)
 *            and plots each one as a marker on the LOCAL stylized map,
 *            positioned by its REAL offset from the user — no street
 *            tiles, nothing external (CSP-safe).
 *          • Marker tap → popup card over the map + cross-highlights the
 *            matching list card (and scrolls it into view). Popup / card
 *            tap → opens that restaurant (the <a> href does the nav).
 *          • Hide-list / Map toggles flip between split and full-map.
 * Why:   The user asked for Uber-Eats-style Pickup: restaurants on a map
 *        by distance, tap a marker to see the restaurant, tap through to
 *        open it. The projection keeps the relative geography so the
 *        "km-wise" placement is real.
 * Used:  Loaded only on the pickup page (SiteController sets extra_js).
 */

(function () {
    'use strict';

    var DEG2RAD = Math.PI / 180;
    var PAD = 48;   // keep markers off the panel edges (px)

    var root, listEl, mapEl, planeEl, popupEl;
    var markers = [];        // { card, marker, x, y, data }
    var activeKey = null;
    // View transform: zoom multiplies the fit-to-screen scale; pan is a
    // pixel offset applied to every marker + the "you" dot (drag to move).
    var zoom = 1, panX = 0, panY = 0;
    var baseScale = 1;       // fit-to-screen scale at zoom = 1 (set in layout)
    var ZOOM_MIN = 0.4, ZOOM_MAX = 8, ZOOM_STEP = 1.4, ZOOM_STEP_WHEEL = 1.15;

    function q(sel, ctx) { return (ctx || document).querySelector(sel); }
    function qa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

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
            var lat = parseFloat(card.getAttribute('data-lat'));
            var lng = parseFloat(card.getAttribute('data-lng'));
            return {
                card:    card,
                id:      card.getAttribute('data-id') || '',
                slug:    card.getAttribute('data-slug') || '',
                lat:     isFinite(lat) ? lat : null,
                lng:     isFinite(lng) ? lng : null,
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
     * getCenter
     *
     * What:  The map's centre lat/lng — the user's saved location when
     *        we have it (data-center-* / window.boot), else the centroid
     *        of the plotted restaurants so the cluster still centres
     *        nicely. Returns { lat, lng, hasUser }.
     */
    function getCenter(points) {
        var cLat = parseFloat(mapEl.getAttribute('data-center-lat'));
        var cLng = parseFloat(mapEl.getAttribute('data-center-lng'));
        if (!isFinite(cLat) && window.boot && isFinite(window.boot.lat)) { cLat = window.boot.lat; }
        if (!isFinite(cLng) && window.boot && isFinite(window.boot.lng)) { cLng = window.boot.lng; }
        if (isFinite(cLat) && isFinite(cLng)) { return { lat: cLat, lng: cLng, hasUser: true }; }
        // Fallback: centroid of the points.
        var sum = points.reduce(function (a, p) { return { lat: a.lat + p.lat, lng: a.lng + p.lng }; }, { lat: 0, lng: 0 });
        var n = points.length || 1;
        return { lat: sum.lat / n, lng: sum.lng / n, hasUser: false };
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

        var pts = markers.filter(function (m) { return m.data.lat != null && m.data.lng != null; });
        if (!pts.length) { return; }

        var center = getCenter(pts.map(function (m) { return m.data; }));
        var cosLat = Math.cos(center.lat * DEG2RAD) || 1;

        // Offsets in a flat plane (east = +x, north = +y).
        var maxX = 0.0001, maxY = 0.0001;
        pts.forEach(function (m) {
            m.dx = (m.data.lng - center.lng) * cosLat;
            m.dy = (m.data.lat - center.lat);
            maxX = Math.max(maxX, Math.abs(m.dx));
            maxY = Math.max(maxY, Math.abs(m.dy));
        });
        // Uniform fit scale (zoom = 1 fits the farthest marker inside
        // the padded box); zoom spreads/clusters from there. Pan shifts
        // the centre so a zoomed-in map can be dragged around.
        baseScale = Math.min((w / 2 - PAD) / maxX, (h / 2 - PAD) / maxY);
        if (!isFinite(baseScale) || baseScale <= 0) { baseScale = 1; }
        var scale = baseScale * zoom;

        var cx = w / 2 + panX, cy = h / 2 + panY;
        pts.forEach(function (m) {
            m.x = cx + m.dx * scale;
            m.y = cy - m.dy * scale;   // screen y grows downward → invert
            m.marker.style.left = m.x + 'px';
            m.marker.style.top  = m.y + 'px';
        });

        // "You are here" dot at the centre (only when we know the user).
        var you = q('.pickup-map__you', planeEl);
        if (center.hasUser) {
            if (!you) {
                you = document.createElement('div');
                you.className = 'pickup-map__you';
                you.title = 'You are here';
                planeEl.appendChild(you);
            }
            you.style.left = cx + 'px';
            you.style.top  = cy + 'px';
        } else if (you) {
            you.remove();
        }

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
        data.forEach(function (d) {
            if (d.lat == null || d.lng == null) { return; }   // unmappable — list only
            var marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'pickup-marker';
            marker.setAttribute('data-key', d.id);
            // Show DISTANCE (km from the user), not the rating — the
            // user wants to see how far each pickup spot is. Falls back
            // to the time estimate, then a dot, when distance is unknown.
            var label = d.dist ? (d.dist + ' km') : (d.eta || '·');
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
        if (d.dist) { meta.push(escHtml(d.dist) + ' km'); }

        popupEl.innerHTML =
            '<button type="button" class="pickup-popup__close" data-action="pickup-popup-close" aria-label="Close">&times;</button>' +
            '<a class="pickup-popup__link" href="' + href + '">' +
              '<span class="pickup-popup__img">' + media + '</span>' +
              '<span class="pickup-popup__body">' +
                '<span class="pickup-popup__row">' +
                  '<span class="pickup-popup__name">' + escHtml(d.name) + '</span>' +
                  '<span class="pickup-popup__rating">' + STAR + escHtml(d.rating) + '</span>' +
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
