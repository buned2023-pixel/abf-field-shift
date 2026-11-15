/*
 * Nearest water for a field: river, canal, stream (or ditch/drain) or lake from OpenStreetMap
 * (/api/water-near), distance measured with Turf from the field boundary, and a thin line from the
 * field to that water on the 3D map. If the data can't be loaded the result is "unknown".
 *
 * Access rule: "Easy" within EASY_M, "Hard" beyond HARD_M, otherwise "Moderate".
 */
(function () {
  'use strict';

  const SEARCH_M = 4000, EASY_M = 500, HARD_M = 2000;
  const results = new Map();   // field key → { status: 'loading'|'ok'|'none'|'unknown', type, distanceM, line }
  let map = null, opts = {}, selectedKey = null;

  const keyOf = (id, field) => `${id}|${field.geo.centroid[0].toFixed(5)},${field.geo.centroid[1].toFixed(5)}|${field.geo.areaHa.toFixed(3)}`;

  // Closest point on a water feature to the field, and the matching point on the field boundary
  function measure(fieldFeature, water) {
    const fieldLine = turf.polygonToLine(fieldFeature);
    const fieldLines = fieldLine.type === 'FeatureCollection' ? fieldLine.features : [fieldLine];
    const c = turf.centroid(fieldFeature);
    let best = null;
    water.features.forEach((f) => {
      let lines;
      try {
        if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') lines = [f];
        else {
          if (turf.booleanIntersects(f, fieldFeature)) { best = { d: 0, f, wp: c.geometry.coordinates, fp: c.geometry.coordinates }; return; }
          const pl = turf.polygonToLine(f);
          lines = pl.type === 'FeatureCollection' ? pl.features : [pl];
        }
        lines.forEach((ln) => {
          if (best && best.d === 0) return;
          const wp = turf.nearestPointOnLine(ln, c, { units: 'meters' });           // water point nearest the field centre
          fieldLines.forEach((fl) => {
            const fp = turf.nearestPointOnLine(fl, wp, { units: 'meters' });        // field edge nearest that water point
            const inside = turf.booleanPointInPolygon(wp, fieldFeature);
            const d = inside ? 0 : fp.properties.dist;
            if (!best || d < best.d) best = { d, f, wp: wp.geometry.coordinates, fp: fp.geometry.coordinates };
          });
        });
      } catch (_) { /* skip a broken geometry */ }
    });
    return best;
  }

  async function load(key, fieldFeature, centroid) {
    results.set(key, { status: 'loading' });
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(`/api/water-near?lat=${centroid[1].toFixed(5)}&lon=${centroid[0].toFixed(5)}&r=${SEARCH_M}`, { signal: ctl.signal });
      clearTimeout(timer);
      const water = await r.json();
      if (!r.ok || !water.features) throw new Error('unavailable');
      const best = measure(fieldFeature, water);
      if (!best) results.set(key, { status: 'none' });
      else {
        results.set(key, {
          status: 'ok', type: best.f.properties.type, name: best.f.properties.name, distanceM: best.d,
          line: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [best.fp, best.wp] } },
        });
      }
    } catch (_) {
      results.set(key, { status: 'unknown' });
    }
    if (key === selectedKey) drawLine();
    if (opts.rerender) opts.rerender();
  }

  function drawLine() {
    if (!map || !map.getSource('waterLink')) return;
    const r = selectedKey && results.get(selectedKey);
    const feats = r && r.status === 'ok' && r.distanceM > 0 ? [r.line] : [];
    map.getSource('waterLink').setData({ type: 'FeatureCollection', features: feats });
  }

  /** Called with the selected field ({ id, feature, geo }) or null. */
  function setField(field) {
    if (!field || !field.feature || !field.geo) { selectedKey = null; drawLine(); return; }
    const key = keyOf(field.id, field);
    selectedKey = key;
    if (!results.has(key)) load(key, field.feature, field.geo.centroid);
    drawLine();
  }

  /** Result for a field: { status, type, distanceM, access } */
  function info(id, field) {
    if (!field || !field.geo) return { status: 'unknown' };
    const r = results.get(keyOf(id, field));
    if (!r) return { status: 'loading' };
    if (r.status !== 'ok') return r;
    return { ...r, access: r.distanceM <= EASY_M ? 'Easy' : r.distanceM > HARD_M ? 'Hard' : 'Moderate' };
  }

  function init(m, options) {
    map = m; opts = options || {};
    map.addSource('waterLink', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Thin line from the field to the nearest water (draped on the terrain)
    map.addLayer({ id: 'water-link-halo', type: 'line', source: 'waterLink', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0A1020', 'line-width': 4, 'line-opacity': 0.5 } });
    map.addLayer({ id: 'water-link', type: 'line', source: 'waterLink', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#9fd4ff', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  }

  window.FieldWater = { init, setField, info, SEARCH_M, EASY_M, HARD_M };
})();
