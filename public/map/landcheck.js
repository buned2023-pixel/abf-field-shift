/*
 * Land rules for Field Shift: fields may only cover farmland, orchards, meadows,
 * grass, scrub, bare land and mountain slopes — never water, settlements,
 * buildings, roads or airports. Data: OpenStreetMap via our /api/landcheck proxy.
 */
(function () {
  'use strict';

  const BLOCK_THRESHOLD = 0.05; // >5 % of the field on blocked land → reject
  const CELL = 0.05;            // no-draw zone tiles, degrees
  const MIN_ZONE_ZOOM = 12;

  const LABELS = {
    river: 'a river', canal: 'a canal', water: 'a lake or reservoir', wetland: 'a wetland',
    settlement: 'a village or town', built: 'a built-up area', cemetery: 'a cemetery',
    airport: 'an airport', building: 'buildings', road: 'a road',
  };
  const SHORT = {
    river: 'River', canal: 'Canal', water: 'Water', wetland: 'Wetland', settlement: 'Village / town',
    built: 'Built-up area', cemetery: 'Cemetery', airport: 'Airport', building: 'Building', road: 'Road',
    farmland: 'Farmland', farmyard: 'Farmyard', orchard: 'Orchard', vineyard: 'Vineyard', meadow: 'Meadow',
    grass: 'Grass', scrub: 'Scrub', grassland: 'Grassland', bare_rock: 'Bare rock', scree: 'Scree', heath: 'Heath',
  };

  const joinList = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);

  // Roads and rivers come as centre lines: turn them into polygons of their real width
  function toAreas(features) {
    const out = [];
    features.forEach((f) => {
      if (f.properties.kind === 'line') {
        try {
          const b = turf.buffer(f, f.properties.width / 2, { units: 'meters' });
          if (b) { b.properties = f.properties; out.push(b); }
        } catch (_) { /* skip broken geometry */ }
      } else out.push(f);
    });
    return out;
  }

  const bboxHit = (a, b) => !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);

  function overlapWith(feature, areas) {
    const fb = turf.bbox(feature);
    const pieces = [];
    areas.forEach((a) => {
      if (!bboxHit(fb, a.bbox || (a.bbox = turf.bbox(a)))) return;
      let inter = null;
      try { inter = turf.intersect(turf.featureCollection([feature, a])); } catch (_) { return; }
      if (inter && turf.area(inter) > 0.5) { inter.properties = { cls: a.properties.cls }; pieces.push(inter); }
    });
    let union = null;
    pieces.forEach((p) => {
      try { union = union ? turf.union(turf.featureCollection([union, p])) || union : p; } catch (_) { /* keep going */ }
    });
    return { pieces, union, area: union ? turf.area(union) : 0 };
  }

  /** Check a field polygon. Resolves a land report; never throws. */
  async function checkField(feature) {
    let data;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 40000);
      const r = await fetch('/api/landcheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: feature.geometry }), signal: ctl.signal,
      });
      clearTimeout(timer);
      data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (err) {
      return { status: 'unverified', reason: String(err.message || err) };
    }
    if (data.status !== 'ok') return { status: 'unverified', reason: data.reason || 'unavailable' };

    const fieldArea = turf.area(feature);
    const blocked = overlapWith(feature, toAreas(data.blocked.features));
    const allowed = overlapWith(feature, data.allowed.features);
    const share = Math.min(1, blocked.area / fieldArea);
    const classes = share < 0.001 || blocked.area < 5 ? [] : [...new Set(blocked.pieces.map((p) => p.properties.cls))];
    const allowedClasses = [...new Set(allowed.pieces.map((p) => p.properties.cls))];
    // Ignore slivers (< 0.1 % or < 5 m²): rounding after a trim leaves centimetre-wide edges
    const negligible = share < 0.001 || blocked.area < 5;
    return {
      status: negligible ? 'ok' : share <= BLOCK_THRESHOLD ? 'minor' : 'blocked',
      share,
      overlapM2: blocked.area,
      classes,
      allowedShare: Math.min(1, allowed.area / fieldArea),
      allowedClasses,
      pieces: turf.featureCollection(blocked.pieces),
      union: blocked.union,
      source: data.source,
    };
  }

  function rejectMessage(report) {
    const what = joinList(report.classes.map((c) => LABELS[c] || c));
    return `This field overlaps ${what || 'land where farming is not allowed'}. Move it onto farmland.`;
  }

  // Cut the blocked parts out; keep the largest remaining piece
  function trim(feature, union) {
    let diff;
    try { diff = turf.difference(turf.featureCollection([feature, union])); } catch (_) { return null; }
    if (!diff) return null;
    const polys = diff.geometry.type === 'Polygon' ? [diff.geometry.coordinates] : diff.geometry.coordinates;
    let best = null, bestArea = 0;
    polys.forEach((p) => {
      const a = turf.area(turf.polygon(p));
      if (a > bestArea) { best = p; bestArea = a; }
    });
    if (!best) return null;
    const rounded = best.map((ring) => {
      const r = [];
      ring.forEach((c) => {
        const p = [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7];
        const last = r[r.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) r.push(p);
      });
      if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0].slice());
      return r;
    }).filter((r) => r.length >= 4);
    return rounded.length ? { type: 'Polygon', coordinates: rounded } : null;
  }

  // ── No-draw zones layer: fetched per 0.05° cell around the view ──
  const cells = new Map(); // key → { status, features (display), areas (hit test) }

  function cellsForView(map) {
    const c = map.getCenter();
    const b = map.getBounds();
    // At 65° pitch the bounds reach the horizon; only cover ~5 km around the centre
    const w = Math.max(b.getWest(), c.lng - 0.05), e = Math.min(b.getEast(), c.lng + 0.05);
    const s = Math.max(b.getSouth(), c.lat - 0.04), n = Math.min(b.getNorth(), c.lat + 0.04);
    const keys = [];
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
      for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) keys.push(`${x},${y}`);
    }
    return keys;
  }

  async function loadCell(key) {
    const [x, y] = key.split(',').map(Number);
    const bbox = [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL].map((v) => +v.toFixed(5));
    cells.set(key, { status: 'loading', features: [], areas: [] });
    try {
      const r = await fetch(`/api/landzones?bbox=${bbox.join(',')}`);
      const d = await r.json();
      if (d.status !== 'ok') throw new Error(d.reason || 'unavailable');
      const feats = d.blocked.features;
      const areas = toAreas(feats);
      areas.forEach((a) => { a.bbox = turf.bbox(a); });
      cells.set(key, { status: 'ok', features: feats, areas });
    } catch (_) {
      cells.set(key, { status: 'error', features: [], areas: [], failedAt: Date.now() });
    }
  }

  /** Make sure the zones around the view are loaded. onUpdate(fc) is called as cells arrive. */
  async function ensureZones(map, onUpdate) {
    if (map.getZoom() < MIN_ZONE_ZOOM) return 'zoom';
    const keys = cellsForView(map).filter((k) => {
      const c = cells.get(k);
      return !c || (c.status === 'error' && Date.now() - c.failedAt > 60000);
    });
    await Promise.all(keys.map((k) => loadCell(k).then(() => onUpdate(zonesGeoJSON()))));
    return 'ok';
  }

  function zonesGeoJSON() {
    const seen = new Set();
    const features = [];
    cells.forEach((c) => c.features.forEach((f) => {
      if (seen.has(f.properties.osm)) return;
      seen.add(f.properties.osm);
      features.push(f);
    }));
    return { type: 'FeatureCollection', features };
  }

  /** What is under this point? → { state: 'blocked'|'allowed'|'unknown', cls } */
  function hitTest(lngLat) {
    const key = `${Math.floor(lngLat.lng / CELL)},${Math.floor(lngLat.lat / CELL)}`;
    const cell = cells.get(key);
    if (!cell || cell.status !== 'ok') return { state: 'unknown' };
    const pt = turf.point([lngLat.lng, lngLat.lat]);
    for (const a of cell.areas) {
      const b = a.bbox;
      if (lngLat.lng < b[0] || lngLat.lng > b[2] || lngLat.lat < b[1] || lngLat.lat > b[3]) continue;
      if (turf.booleanPointInPolygon(pt, a)) return { state: 'blocked', cls: a.properties.cls };
    }
    return { state: 'allowed' };
  }

  window.FieldLand = {
    BLOCK_THRESHOLD, MIN_ZONE_ZOOM, LABELS, SHORT,
    checkField, rejectMessage, trim, ensureZones, zonesGeoJSON, hitTest,
  };
})();
