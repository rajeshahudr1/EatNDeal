/*
 * app.js
 *
 * What:  Global admin bindings that run on every page:
 *          • Registers the service worker (PWA) — skipped on localhost so
 *            a stale cache never masks a code change during development.
 *          • Off-canvas sidebar open / close (mobile) via the topbar
 *            hamburger and the dim scrim.
 * Why:   One place for app-wide behaviour; per-page logic lives in
 *        pages/*.js (Conventions rule #6 — no inline JS).
 * Used:  Loaded last (after boot-reader + toast) in views/_layout.ejs.
 */
(function () {
    'use strict';

    // ── Service worker (PWA) ────────────────────────────────────────
    // Register at root scope so the SW controls the whole origin. On
    // localhost we deliberately DO NOT register (and unregister any
    // existing one) so active development never fights a cached shell.
    if ('serviceWorker' in navigator) {
        var host = location.hostname;
        var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
        if (isLocal) {
            navigator.serviceWorker.getRegistrations().then(function (regs) {
                regs.forEach(function (r) { r.unregister(); });
            }).catch(function () {});
        } else {
            window.addEventListener('load', function () {
                navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(function () {});
            });
        }
    }

    // ── Sidebar off-canvas (mobile) ─────────────────────────────────
    function openSidebar()  { document.body.classList.add('sidebar-open'); }
    function closeSidebar() { document.body.classList.remove('sidebar-open'); }

    // ── Sidebar collapse (desktop) — hide/show the rail, remembered. ─
    function isDesktop() { return window.matchMedia('(min-width: 900px)').matches; }
    try { if (localStorage.getItem('admin_sidebar_collapsed') === '1') { document.body.classList.add('sidebar-collapsed'); } } catch (e) { /* ignore */ }
    // Enable collapse transitions only after the first frame (no load flash).
    if (window.requestAnimationFrame) { requestAnimationFrame(function () { document.body.classList.add('anim-ready'); }); } else { document.body.classList.add('anim-ready'); }
    function toggleSidebarCollapsed() {
        var on = !document.body.classList.contains('sidebar-collapsed');
        document.body.classList.toggle('sidebar-collapsed', on);
        try { localStorage.setItem('admin_sidebar_collapsed', on ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    // ── Company switcher (super admin) — searchable dropdown ────────
    function companySwitch() { return document.querySelector('[data-company-switch]'); }

    function closeCompany() {
        var sw = companySwitch();
        if (!sw) { return; }
        var panel = sw.querySelector('[data-company-panel]');
        var btn = sw.querySelector('[data-action="company-open"]');
        if (panel) { panel.hidden = true; }
        if (btn) { btn.setAttribute('aria-expanded', 'false'); }
    }

    function filterCompanies(q) {
        var sw = companySwitch();
        if (!sw) { return; }
        q = (q || '').trim().toLowerCase();
        var opts = sw.querySelectorAll('[data-company-list] .admin-company__opt');
        var shown = 0;
        for (var i = 0; i < opts.length; i++) {
            var li = opts[i].parentNode;
            var match = opts[i].textContent.toLowerCase().indexOf(q) !== -1;
            li.style.display = match ? '' : 'none';
            if (match) { shown++; }
        }
        var empty = sw.querySelector('[data-company-empty]');
        if (empty) { empty.hidden = shown > 0; }
    }

    function openCompany() {
        var sw = companySwitch();
        if (!sw) { return; }
        var panel = sw.querySelector('[data-company-panel]');
        var btn = sw.querySelector('[data-action="company-open"]');
        var search = sw.querySelector('[data-company-search]');
        if (panel) { panel.hidden = false; }
        if (btn) { btn.setAttribute('aria-expanded', 'true'); }
        if (search) { search.value = ''; filterCompanies(''); window.setTimeout(function () { search.focus(); }, 0); }
    }

    // ── Admin account menu (topbar dropdown) ────────────────────────
    function adminMenu() { return document.querySelector('[data-admin-menu]'); }
    function closeAdminMenu() {
        var m = adminMenu();
        if (!m) { return; }
        var panel = m.querySelector('[data-admin-menu-panel]');
        var btn = m.querySelector('[data-action="admin-menu-open"]');
        if (panel) { panel.hidden = true; }
        if (btn) { btn.setAttribute('aria-expanded', 'false'); }
    }

    // ── Mobile filters sheet (shared by every list page) ────────────
    function openFilters(on) {
        var sheet = document.querySelector('[data-filters]');
        var back = document.querySelector('[data-filter-backdrop]');
        if (sheet) { sheet.classList.toggle('is-open', !!on); }
        if (back) { back.hidden = !on; }
        // Own scroll-lock class (NOT pr-modal-open) so a modal closing elsewhere
        // can never unlock the sheet, and vice-versa.
        document.body.classList.toggle('filters-open', !!on);
    }

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }
        // The burger opens the off-canvas drawer on mobile, and collapses /
        // expands the fixed rail on desktop.
        if (t.closest('[data-action="open-sidebar"]'))  { ev.preventDefault(); if (isDesktop()) { toggleSidebarCollapsed(); } else { openSidebar(); } return; }
        if (t.closest('[data-action="close-sidebar"]')) { ev.preventDefault(); closeSidebar(); return; }

        // Filters bottom/full sheet (products + categories lists).
        if (t.closest('[data-filter-toggle]')) { ev.preventDefault(); openFilters(true); return; }
        if (t.closest('[data-filter-close]') || t.closest('[data-filter-backdrop]')) { ev.preventDefault(); openFilters(false); return; }

        // Admin account menu: toggle, or close on outside click.
        if (t.closest('[data-action="admin-menu-open"]')) {
            ev.preventDefault();
            var m = adminMenu();
            var panel = m && m.querySelector('[data-admin-menu-panel]');
            var btn = m && m.querySelector('[data-action="admin-menu-open"]');
            if (panel) {
                var willOpen = panel.hidden;
                panel.hidden = !willOpen;
                if (btn) { btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); }
            }
            return;
        }
        if (adminMenu() && !t.closest('[data-admin-menu]')) { closeAdminMenu(); }

        // Company switcher: toggle, pick an option, or close on outside click.
        if (t.closest('[data-action="company-open"]')) {
            ev.preventDefault();
            var sw = companySwitch();
            var panel = sw && sw.querySelector('[data-company-panel]');
            if (panel && panel.hidden) { openCompany(); } else { closeCompany(); }
            return;
        }
        var opt = t.closest('.admin-company__opt');
        if (opt) {
            ev.preventDefault();
            var sw2 = companySwitch();
            var input = sw2 && sw2.querySelector('[data-company-input]');
            var form  = sw2 && sw2.querySelector('[data-company-form]');
            if (input) { input.value = opt.getAttribute('data-company-id') || ''; }
            if (form) { form.submit(); }
            return;
        }
        if (companySwitch() && !t.closest('[data-company-switch]')) { closeCompany(); }

        // Tapping a nav link closes the mobile drawer so the destination shows.
        if (t.closest('.admin-nav__item') && document.body.classList.contains('sidebar-open')) {
            closeSidebar();
        }
    });

    document.addEventListener('input', function (ev) {
        if (ev.target && ev.target.matches && ev.target.matches('[data-company-search]')) {
            filterCompanies(ev.target.value);
        }
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { closeSidebar(); closeCompany(); closeAdminMenu(); openFilters(false); }
    });

    // ── Global loader — a thin top progress bar shown during every AJAX call
    // (CRUD on the list pages) and every page navigation (links + form
    // submits, incl. live-search reloads). Ref-counted so overlapping calls
    // keep it on until the last one finishes. ───────────────────────────────
    var loaderEl = null;
    var loaderCount = 0;
    function ensureLoader() {
        if (loaderEl) { return loaderEl; }
        loaderEl = document.createElement('div');
        loaderEl.id = 'admin-loader';
        loaderEl.setAttribute('aria-hidden', 'true');
        loaderEl.innerHTML = '<span class="admin-loader__bar"></span>';
        document.body.appendChild(loaderEl);
        return loaderEl;
    }
    function showLoader() { loaderCount++; ensureLoader().classList.add('is-on'); }
    function hideLoader(force) {
        loaderCount = force ? 0 : Math.max(0, loaderCount - 1);
        if (loaderCount === 0 && loaderEl) { loaderEl.classList.remove('is-on'); }
    }
    window.AdminUi = window.AdminUi || {};
    window.AdminUi.loader = { show: showLoader, hide: hideLoader };

    // Wrap fetch so every AJAX request flips the loader automatically.
    if (window.fetch) {
        var nativeFetch = window.fetch.bind(window);
        window.fetch = function () {
            showLoader();
            return nativeFetch.apply(null, arguments).then(
                function (r) { hideLoader(); return r; },
                function (e) { hideLoader(); throw e; }
            );
        };
    }
    // Any navigation (link click, form submit, programmatic submit) → loader.
    window.addEventListener('beforeunload', function () { showLoader(); });
    // A fresh page (incl. back/forward cache restore) clears it.
    window.addEventListener('pageshow', function () { hideLoader(true); });

    // ── Global live search — any input[data-live-search] submits its form a
    // short moment after typing stops, and the caret is restored afterwards. ─
    var liveTimer = null;
    document.addEventListener('input', function (ev) {
        var el = ev.target;
        if (!el || !el.matches || !el.matches('[data-live-search]')) { return; }
        var form = el.form || (el.closest && el.closest('form'));
        if (!form) { return; }
        if (liveTimer) { window.clearTimeout(liveTimer); }
        try { sessionStorage.setItem('admin_live_focus', '1'); } catch (e) { /* ignore */ }
        liveTimer = window.setTimeout(function () { form.submit(); }, 450);
    });
    document.addEventListener('DOMContentLoaded', function () {
        try {
            if (sessionStorage.getItem('admin_live_focus') === '1') {
                sessionStorage.removeItem('admin_live_focus');
                var inp = document.querySelector('[data-live-search]');
                if (inp) { var v = inp.value; inp.focus(); if (inp.setSelectionRange) { inp.setSelectionRange(v.length, v.length); } }
            }
        } catch (e) { /* sessionStorage unavailable */ }
    });

    // ── Infinite scroll (mobile) — on phones, the bottom pager is hidden and
    // the next page of a `.pr-list[data-total-pages]` is fetched + appended as
    // the user nears the end. Works for any list page (products, categories).
    // Desktop keeps the classic pager. ─────────────────────────────────────
    function initInfiniteScroll() {
        var mq = window.matchMedia('(max-width: 720px)');
        if (!mq.matches) { return; }                      // desktop = keep the pager
        var list = document.querySelector('.pr-list[data-total-pages]');
        if (!list) { return; }
        var page = Number(list.getAttribute('data-page')) || 1;
        var totalPages = Number(list.getAttribute('data-total-pages')) || 1;
        if (totalPages <= 1 || page >= totalPages) { return; }
        if (!('IntersectionObserver' in window) || !window.DOMParser) { return; }

        // A sentinel below the list; when it scrolls into view we load more.
        var sentinel = document.createElement('div');
        sentinel.className = 'pr-infinite';
        sentinel.setAttribute('data-infinite', '');
        sentinel.innerHTML = '<span class="pr-infinite__spin" aria-hidden="true"></span>';
        list.parentNode.insertBefore(sentinel, list.nextSibling);

        var loading = false;
        function stop(msg) {
            try { io.disconnect(); } catch (e) { /* ignore */ }
            sentinel.innerHTML = msg ? ('<span class="pr-infinite__end">' + msg + '</span>') : '';
        }
        function loadNext() {
            if (loading || page >= totalPages) { return; }
            loading = true;
            sentinel.classList.add('is-loading');
            var url = new URL(window.location.href);
            url.searchParams.set('page', String(page + 1));
            fetch(url.toString(), { headers: { 'X-Requested-With': 'fetch' } })
                .then(function (r) { return r.text(); })
                .then(function (html) {
                    var doc = new DOMParser().parseFromString(html, 'text/html');
                    var newList = doc.querySelector('.pr-list');
                    var items = newList ? newList.querySelectorAll('.pr-item') : [];
                    if (!items.length) { stop(''); return; }
                    for (var i = 0; i < items.length; i++) {
                        var node = document.importNode(items[i], true);
                        // Carry the inline status select's revert baseline.
                        var sel = node.querySelector('.pr-status, .mpc-status');
                        if (sel) { sel.setAttribute('data-prev', sel.value); }
                        list.appendChild(node);
                    }
                    page += 1;
                    list.setAttribute('data-page', String(page));
                    loading = false;
                    sentinel.classList.remove('is-loading');
                    if (page >= totalPages) { stop(''); }
                })
                .catch(function () { loading = false; sentinel.classList.remove('is-loading'); });
        }
        var io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) { if (entries[i].isIntersecting) { loadNext(); } }
        }, { rootMargin: '300px 0px' });
        io.observe(sentinel);
    }
    document.addEventListener('DOMContentLoaded', initInfiniteScroll);

    // ── Image lightbox — click any [data-lightbox] (its src, or data-lightbox-
    // src) to view it full-screen. Reused by review screenshots, CMS previews. ─
    var lightbox = null;
    function openLightbox(src) {
        if (!src) { return; }
        if (!lightbox) {
            lightbox = document.createElement('div');
            lightbox.className = 'admin-lightbox';
            lightbox.innerHTML = '<button type="button" class="admin-lightbox__x" aria-label="Close">✕</button><img class="admin-lightbox__img" alt="">';
            lightbox.addEventListener('click', function (e) { if (e.target === lightbox || e.target.closest('.admin-lightbox__x')) { closeLightbox(); } });
            document.body.appendChild(lightbox);
        }
        lightbox.querySelector('.admin-lightbox__img').src = src;
        lightbox.classList.add('is-on');
        document.body.classList.add('pr-modal-open');
    }
    function closeLightbox() {
        if (lightbox) { lightbox.classList.remove('is-on'); lightbox.querySelector('.admin-lightbox__img').src = ''; }
        document.body.classList.remove('pr-modal-open');
    }
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest && e.target.closest('[data-lightbox]');
        if (!t) { return; }
        e.preventDefault();
        var src = t.getAttribute('data-lightbox-src') || (t.tagName === 'IMG' ? t.src : (t.querySelector('img') && t.querySelector('img').src));
        openLightbox(src);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeLightbox(); } });
})();
