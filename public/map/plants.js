/*
 * Crop rows for Field Shift: thin 3D strips inside the user's drawn fields.
 * (Trees are a separate GPU layer: see trees.js.)
 *
 * Rendering: a MapLibre fill-extrusion layer. MapLibre places each extruded polygon at the
 * terrain height of its own centre, so short row segments sit on the ground.
 * Rows show from zoom 14, follow the "My fields" toggle, and use the shared quality setting.
 */
(function () {
  'use strict';

  const QUALITY = { low: { segs: 1500 }, medium: { segs: 4000 }, high: { segs: 8000 } }; // max row pieces in view
  const MIN_ZOOM = 14;
  const M_LAT = 110540; // metres per degree of latitude
  const EMPTY = { type: 'FeatureCollection', features: [] };

  let map = null, opts = null;
  let quality = 'medium', lastKey = '', moveTimer = null, fieldTimer = null;
  const stats = { rowSegs: 0 };

  const $ = (id) => document.getElementById(id);
  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r7 = (v) => Math.round(v * 1e7) / 1e7;
  const bboxHit = (a, b) => !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
  function hash2(i, j) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const prism = (ring, b, h, c) => ({ type: 'Feature', properties: { b: +b.toFixed(2), h: +h.toFixed(2), c }, geometry: { type: 'Polygon', coordinates: [ring] } });

  function viewRect() {
    const c = map.getCenter(), zoom = map.getZoom();
    const kx = 111320 * Math.cos(rad(c.lat));
    const mpp = (40075016.686 * Math.cos(rad(c.lat))) / (512 * Math.pow(2, zoom));
    const R = clamp((mpp * map.getCanvas().clientWidth) / 2 * 1.15, 150, 2600); // half-size in metres
    return { c, zoom, R, kx, bbox: [c.lng - R / kx, c.lat - R / M_LAT, c.lng + R / kx, c.lat + R / M_LAT] };
  }

  // Crop rows: thin strips running along the field's slope direction, cut into short
  // segments so every piece sits on the ground even on a slope.
  function buildRows(view) {
    const all = opts.getFields().filter((f) => f.feature);
    const fields = all.filter((f) => bboxHit(turf.bbox(f.feature), view.bbox));
    const feats = [];
    if (!fields.length) return { type: 'FeatureCollection', features: feats };
    const budget = Math.floor(QUALITY[quality].segs / fields.length);
    fields.forEach((fld) => {
      const ring = fld.feature.geometry.coordinates[0];
      let cLon = 0, cLat = 0;
      for (let i = 0; i < ring.length - 1; i++) { cLon += ring[i][0]; cLat += ring[i][1]; }
      cLon /= ring.length - 1; cLat /= ring.length - 1;
      const kx = 111320 * Math.cos(rad(cLat));
      const xy = ring.map((p) => [(p[0] - cLon) * kx, (p[1] - cLat) * M_LAT]);
      // Row direction: downslope (terrain aspect); on flat or mixed ground, along the longest edge
      let bearing = fld.terrain && typeof fld.terrain.aspectDeg === 'number' ? fld.terrain.aspectDeg : null;
      if (bearing == null) {
        let best = 0;
        for (let i = 0; i < xy.length - 1; i++) {
          const dx = xy[i + 1][0] - xy[i][0], dy = xy[i + 1][1] - xy[i][1], len = Math.hypot(dx, dy);
          if (len > best) { best = len; bearing = (Math.atan2(dx, dy) * 180) / Math.PI; }
        }
      }
      const th = rad(bearing || 0), cs = Math.cos(th), sn = Math.sin(th);
      const pts = xy.map((p) => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs]); // [across, along]
      let area = 0;
      for (let i = 0; i < pts.length - 1; i++) area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
      area = Math.abs(area) / 2;
      const slope = fld.terrain && fld.terrain.meanSlope != null ? fld.terrain.meanSlope : 3;
      const crop = fld.crop || {};
      const baseH = clamp(crop.height || 1.0, 0.5, 1.5), color = crop.color || '#6fbf4a', color2 = crop.color2 || '#5fae3e';
      const segLen = clamp(0.4 / Math.tan(rad(Math.max(slope, 0.5))), 5, 30); // keeps steps under ~0.4 m
      const spacing = Math.max(1.5, area / (segLen * Math.max(1, budget)));
      const width = Math.min(1.2, spacing * 0.45);
      let vMin = Infinity, vMax = -Infinity;
      pts.forEach((p) => { if (p[0] < vMin) vMin = p[0]; if (p[0] > vMax) vMax = p[0]; });
      const toLL = (v, u) => [r7(cLon + (v * cs + u * sn) / kx), r7(cLat + (-v * sn + u * cs) / M_LAT)];
      let row = 0;
      for (let v = vMin + spacing / 2; v < vMax; v += spacing, row++) {
        const us = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          if ((p[0] > v) !== (q[0] > v)) us.push(p[1] + ((v - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
        }
        us.sort((a, b) => a - b);
        const h = baseH * (0.88 + 0.24 * ((hash2(row, 7) % 100) / 100));
        for (let s = 0; s + 1 < us.length; s += 2) {
          const u0 = us[s] + 0.6, u1 = us[s + 1] - 0.6;
          if (u1 - u0 < 2) continue;
          const n = Math.ceil((u1 - u0) / segLen), L = (u1 - u0) / n;
          for (let m = 0; m < n; m++) {
            const a = u0 + m * L, b = a + L;
            const ringLL = [toLL(v - width / 2, a), toLL(v + width / 2, a), toLL(v + width / 2, b), toLL(v - width / 2, b)];
            ringLL.push(ringLL[0]);
            feats.push(prism(ringLL, 0, h, row % 2 ? color2 : color));
          }
        }
      }
    });
    return { type: 'FeatureCollection', features: feats };
  }

  function refresh(force) {
    if (!map || !map.getSource('cropRows')) return;
    const shown = !$('lyrFields') || $('lyrFields').checked;
    if (!shown || map.getZoom() < MIN_ZOOM) {
      if (stats.rowSegs) map.getSource('cropRows').setData(EMPTY);
      stats.rowSegs = 0; lastKey = '';
      return;
    }
    const view = viewRect();
    // Skip the rebuild if the view hardly changed
    const key = [quality, Math.floor(view.zoom * 2), Math.round((view.c.lng * view.kx) / (view.R * 0.2)), Math.round((view.c.lat * M_LAT) / (view.R * 0.2))].join('|');
    if (!force && key === lastKey) return;
    const rows = buildRows(view);
    map.getSource('cropRows').setData(rows);
    stats.rowSegs = rows.features.length;
    lastKey = key;
  }

  function setQuality(q) {
    if (!QUALITY[q]) return;
    quality = q;
    refresh(true);
  }

  function init(m, options) {
    map = m; opts = options;
    quality = options.mobile ? 'low' : 'medium';
    // tolerance 0: keep metre-sized shapes exact (the default simplification would collapse them)
    map.addSource('cropRows', { type: 'geojson', data: EMPTY, tolerance: 0, maxzoom: 17 });
    map.addLayer({
      id: 'crop-rows-3d', type: 'fill-extrusion', source: 'cropRows', minzoom: MIN_ZOOM,
      paint: {
        'fill-extrusion-color': ['get', 'c'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => refresh(false), 250); });
    if ($('lyrFields')) $('lyrFields').addEventListener('change', () => refresh(true));
    refresh(true);
  }

  // Called whenever fields are added, edited or removed
  function fieldsChanged() {
    if (!map) return;
    clearTimeout(fieldTimer);
    fieldTimer = setTimeout(() => refresh(true), 500);
  }

  window.FieldPlants = { init, refresh, fieldsChanged, setQuality, stats, QUALITY };
})();
