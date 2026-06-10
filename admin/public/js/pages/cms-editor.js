/*
 * pages/cms-editor.js
 *
 * What:  Review CMS Pages editor — tabbed (one tab per review/share type),
 *        each tab a custom local rich-text editor (contenteditable + a
 *        Summernote-like toolbar: style, bold/italic/underline/strike, colour,
 *        lists, align, link, image-by-URL, clear, HTML code view). Each tab is
 *        saved on its own via fetch(FormData) so you stay on the tab. The
 *        description HTML is sanitised server-side before storage.
 * Used:  extra_js for loyalty/cms-pages.ejs.
 */
(function () {
    'use strict';

    function toast(type, msg) { if (window.AdminUi && window.AdminUi.showToast) { window.AdminUi.showToast(type, msg); } }
    function ec(cmd, val) { try { return document.execCommand(cmd, false, val); } catch (e) { return false; } }

    /* ── One rich-text editor instance ───────────────────────────────── */
    function initEditor(root) {
        if (!root || root.__cms) { return; }
        root.__cms = true;
        var toolbar = root.querySelector('[data-toolbar]');
        var area = root.querySelector('[data-editable]');
        var hidden = root.querySelector('[data-editor-input]');
        if (!toolbar || !area || !hidden) { return; }
        var codeMode = false;
        var savedRange = null;

        function sync() { hidden.value = codeMode ? area.textContent : area.innerHTML; }
        function placeholder() {
            var empty = !codeMode && area.textContent.trim() === '' && !area.querySelector('img');
            area.classList.toggle('is-empty', empty);
        }
        function saveSel() {
            var sel = window.getSelection();
            if (sel && sel.rangeCount && area.contains(sel.anchorNode)) { savedRange = sel.getRangeAt(0).cloneRange(); }
        }
        function restoreSel() {
            area.focus();
            if (savedRange) { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
        }
        root.__sync = sync;

        function toggleCode() {
            codeMode = !codeMode;
            if (codeMode) { area.textContent = area.innerHTML; area.classList.add('is-code'); }
            else { area.innerHTML = area.textContent; area.classList.remove('is-code'); }
            Array.prototype.forEach.call(toolbar.querySelectorAll('[data-cmd]'), function (el) {
                if (el.getAttribute('data-cmd') !== 'toggleCode') { el.disabled = codeMode; }
            });
            var tg = toolbar.querySelector('[data-cmd="toggleCode"]'); if (tg) { tg.classList.toggle('is-on', codeMode); }
            sync(); placeholder();
        }

        function run(cmd, val) {
            if (cmd === 'toggleCode') { toggleCode(); return; }
            if (codeMode) { return; }
            restoreSel();
            if (cmd === 'createLink') {
                var url = window.prompt('Link URL', 'https://'); if (!url) { return; }
                ec('createLink', url);
            } else if (cmd === 'insertImage') {
                var src = window.prompt('Image URL', 'https://'); if (!src) { return; }
                ec('insertImage', src);
            } else if (cmd === 'formatBlock') {
                ec('formatBlock', /^h\d|blockquote/i.test(val) ? val : 'p');
            } else if (cmd === 'foreColor') {
                ec('foreColor', val);
            } else {
                ec(cmd);
            }
            sync(); saveSel(); placeholder();
        }

        // Keep the caret/selection while clicking a toolbar button.
        toolbar.addEventListener('mousedown', function (e) { if (e.target.closest('button[data-cmd]')) { e.preventDefault(); } });
        toolbar.addEventListener('click', function (e) { var b = e.target.closest('button[data-cmd]'); if (b && !b.disabled) { run(b.getAttribute('data-cmd')); } });
        toolbar.addEventListener('change', function (e) {
            var t = e.target;
            if (t.matches('select[data-cmd]')) { run('formatBlock', t.value); }
        });
        toolbar.addEventListener('input', function (e) { var t = e.target; if (t.matches('input[type="color"][data-cmd]')) { run('foreColor', t.value); } });

        area.addEventListener('keyup', saveSel);
        area.addEventListener('mouseup', saveSel);
        area.addEventListener('input', function () { saveSel(); sync(); placeholder(); });
        area.addEventListener('blur', saveSel);

        // Normalise an "empty" editable so the CSS placeholder shows.
        if (area.innerHTML.replace(/<br\s*\/?>|&nbsp;|\s/gi, '') === '') { area.innerHTML = ''; }
        sync(); placeholder();
    }

    function syncForm(form) {
        var ed = form.querySelector('[data-editor]');
        if (ed && ed.__sync) { ed.__sync(); }
    }

    /* ── Tabs (+ horizontal scroll slider) ────────────────────────────── */
    function showTab(slug) {
        var active = null;
        Array.prototype.forEach.call(document.querySelectorAll('[data-cms-tab]'), function (t) { var on = t.getAttribute('data-cms-tab') === slug; t.classList.toggle('is-on', on); if (on) { active = t; } });
        Array.prototype.forEach.call(document.querySelectorAll('[data-cms-panel]'), function (p) { p.classList.toggle('is-hidden', p.getAttribute('data-cms-panel') !== slug); });
        if (active && active.scrollIntoView) { active.scrollIntoView({ inline: 'center', block: 'nearest' }); }
    }

    function initTabsSlider() {
        var strip = document.querySelector('[data-cms-tabs]');
        if (!strip) { return; }
        var prev = document.querySelector('[data-tabs-prev]');
        var next = document.querySelector('[data-tabs-next]');
        function update() {
            var atStart = strip.scrollLeft <= 1;
            var atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
            var overflow = strip.scrollWidth > strip.clientWidth + 1;
            if (prev) { prev.hidden = !overflow || atStart; }
            if (next) { next.hidden = !overflow || atEnd; }
        }
        function scrollBy(dir) { strip.scrollBy({ left: dir * Math.max(160, strip.clientWidth * 0.6), behavior: 'smooth' }); }
        if (prev) { prev.addEventListener('click', function () { scrollBy(-1); }); }
        if (next) { next.addEventListener('click', function () { scrollBy(1); }); }
        strip.addEventListener('scroll', update);
        // Mouse wheel → horizontal scroll over the strip (desktop convenience).
        strip.addEventListener('wheel', function (e) { if (e.deltaY && strip.scrollWidth > strip.clientWidth) { e.preventDefault(); strip.scrollLeft += e.deltaY; } }, { passive: false });
        window.addEventListener('resize', update);
        // The tab widths settle only after web fonts load, so the first overflow
        // check can be wrong (no arrow). Re-check on load, after the fonts are
        // ready, via a ResizeObserver, and with a short fallback timer.
        window.addEventListener('load', update);
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(update); }
        if (window.ResizeObserver) { try { new ResizeObserver(update).observe(strip); } catch (e) { /* ignore */ } }
        window.setTimeout(update, 300);
        update();
    }

    /* ── Per-tab save (fetch + FormData) ──────────────────────────────── */
    function saveForm(form) {
        syncForm(form);
        var title = form.querySelector('input[name="title"]');
        if (title && title.value.trim() === '') { toast('error', 'Title is required.'); title.focus(); return; }
        var hint = form.querySelector('[data-save-hint]');
        var btn = form.querySelector('[data-cms-save]');
        if (btn) { btn.disabled = true; }
        if (hint) { hint.textContent = 'Saving…'; hint.className = 'cms-foot__hint'; }
        fetch(form.getAttribute('action'), {
            method: 'POST',
            body: new FormData(form),
            headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' },
        })
            .then(function (r) { return r.json().catch(function () { return { status: 0, msg: 'Bad response.' }; }); })
            .then(function (res) {
                if (btn) { btn.disabled = false; }
                if (res && res.status === 200) {
                    toast('success', res.msg || 'Saved.');
                    if (hint) { hint.textContent = 'Saved ✓'; hint.className = 'cms-foot__hint is-ok'; }
                    // Clear the file input so the same screenshot isn't re-sent next save.
                    var f = form.querySelector('[data-shot-input]'); if (f) { f.value = ''; }
                } else {
                    toast('error', (res && res.msg) || 'Could not save.');
                    if (hint) { hint.textContent = ''; }
                }
            })
            .catch(function () {
                if (btn) { btn.disabled = false; }
                if (hint) { hint.textContent = ''; }
                toast('error', 'Could not reach the server.');
            });
    }

    /* ── Screenshot preview ───────────────────────────────────────────── */
    function previewShot(inp) {
        var file = inp.files && inp.files[0];
        if (!file) { return; }
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { toast('error', 'Choose a PNG, JPG, WEBP or GIF.'); inp.value = ''; return; }
        if (file.size > 3 * 1024 * 1024) { toast('error', 'Image must be under 3 MB.'); inp.value = ''; return; }
        var shot = inp.closest('.cms-shot');
        var prev = shot && shot.querySelector('[data-shot-preview]');
        if (!prev) { return; }
        var img = prev.querySelector('[data-shot-img]');
        if (!img) { var ph = prev.querySelector('[data-shot-ph]'); if (ph) { ph.parentNode.removeChild(ph); } img = document.createElement('img'); img.setAttribute('data-shot-img', ''); img.setAttribute('data-lightbox', ''); img.alt = ''; prev.appendChild(img); }
        if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
    }

    /* ── Wire-up ──────────────────────────────────────────────────────── */
    document.addEventListener('click', function (e) {
        if (!e.target.closest) { return; }
        var tab = e.target.closest('[data-cms-tab]');
        if (tab) { showTab(tab.getAttribute('data-cms-tab')); return; }
    });
    document.addEventListener('submit', function (e) {
        var form = e.target.closest && e.target.closest('[data-cms-form]');
        if (!form) { return; }
        e.preventDefault();
        saveForm(form);
    });
    document.addEventListener('change', function (e) {
        var inp = e.target.closest && e.target.closest('[data-shot-input]');
        if (inp) { previewShot(inp); }
    });

    document.addEventListener('DOMContentLoaded', function () {
        Array.prototype.forEach.call(document.querySelectorAll('[data-editor]'), initEditor);
        initTabsSlider();
    });
})();
