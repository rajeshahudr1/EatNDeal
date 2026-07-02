/*
 * common/gmap.js — Google Maps Embed helper (shared, no dependencies).
 *
 * What:  Builds a CSP-safe <iframe> via the Google Maps Embed API and drops it
 *        into a container, for the location-modal / pickup / order maps.
 * Why:   One place to build the map URL + iframe so every page renders the same
 *        real map. The browser API key comes from <body data-gmaps-key> (set by
 *        the layout from GOOGLE_MAPS_BROWSER_KEY) — never hardcoded.
 * How:   GMap.embed(container, lat, lng, opts) replaces the container's content
 *        with the map. If the key or coords are missing it returns false and
 *        leaves the existing placeholder untouched (graceful fallback).
 *
 * Public: window.GMap = { key, embedUrl, embed }.
 */
(function (w, d) {
    'use strict';

    // Browser key, read once from the <body> data attribute.
    function key() {
        return (d.body && d.body.getAttribute('data-gmaps-key')) || '';
    }

    function hasCoord(v) {
        return v !== null && v !== undefined && v !== '' && !isNaN(Number(v));
    }

    // Build the Embed API "place" URL (drops a marker at the point). Returns ''
    // when we can't render (missing key / coords) so callers can fall back.
    function embedUrl(lat, lng, opts) {
        opts = opts || {};
        var k = key();
        if (!k || !hasCoord(lat) || !hasCoord(lng)) { return ''; }
        var q = encodeURIComponent(Number(lat) + ',' + Number(lng));
        return 'https://www.google.com/maps/embed/v1/place'
            + '?key=' + encodeURIComponent(k)
            + '&q=' + q
            + '&zoom=' + (opts.zoom || 15);
    }

    // Replace `container`'s contents with a map iframe. Returns true on success.
    function embed(container, lat, lng, opts) {
        if (!container) { return false; }
        opts = opts || {};
        var url = embedUrl(lat, lng, opts);
        if (!url) { return false; }
        var ifr = d.createElement('iframe');
        ifr.src = url;
        ifr.loading = 'lazy';
        ifr.referrerPolicy = 'no-referrer-when-downgrade';
        ifr.setAttribute('allowfullscreen', '');
        ifr.title = opts.title || 'Map';
        ifr.className = 'gmap-frame' + (opts.className ? (' ' + opts.className) : '');
        ifr.style.cssText = 'width:100%;height:100%;min-height:inherit;border:0;display:block;';
        container.innerHTML = '';
        container.appendChild(ifr);
        container.classList.add('has-gmap');
        return true;
    }

    // Build a Google Static Maps image URL. markers = [{lat,lng,color,label}].
    // With markers and no center/zoom, Google auto-fits the view to them.
    // CSP-safe (an <img>, no inline styles) — unlike the interactive JS API.
    function staticUrl(opts) {
        opts = opts || {};
        var k = key();
        if (!k) { return ''; }
        var parts = [
            'https://maps.googleapis.com/maps/api/staticmap?key=' + encodeURIComponent(k),
            'size=' + (opts.size || '640x400'),
            'scale=' + (opts.scale || 2),
            'maptype=' + (opts.maptype || 'roadmap'),
        ];
        if (opts.center) { parts.push('center=' + encodeURIComponent(opts.center)); }
        if (opts.zoom)   { parts.push('zoom=' + opts.zoom); }
        (opts.markers || []).forEach(function (m) {
            if (!hasCoord(m.lat) || !hasCoord(m.lng)) { return; }
            var bits = [];
            if (m.color) { bits.push('color:' + m.color); }
            if (m.label) { bits.push('label:' + m.label); }
            if (m.size)  { bits.push('size:' + m.size); }
            bits.push(Number(m.lat) + ',' + Number(m.lng));
            parts.push('markers=' + encodeURIComponent(bits.join('|')));
        });
        return parts.join('&');
    }

    w.GMap = { key: key, embedUrl: embedUrl, embed: embed, staticUrl: staticUrl };
})(window, document);
