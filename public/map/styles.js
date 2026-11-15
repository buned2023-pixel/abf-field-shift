/*
 * Reusable visual styles for Field Shift: risk overlay layers, labeled pins and
 * the glow pulse. Used now for fields; risk and fire styles are ready for later stages.
 */
(function () {
  'use strict';

  const COLORS = { navy: '#0A1020', blue: '#2F4BFF', lime: '#D4F20C' };

  // Risk palette for later stages (always paired with a label or icon, never colour alone)
  const RISK = {
    drought: { color: '#ff9f1c', glow: '#ffb84d', label: 'Drought' }, // orange
    heat: { color: '#ff3b4f', glow: '#ff6b7a', label: 'Heat' },       // red
    fire: { color: '#ff5a1f', glow: '#ffb347', label: 'Fire' },       // glowing orange-red
    field: { color: COLORS.lime, glow: COLORS.lime, label: 'Field' },
  };

  /**
   * Layer specs for a glowing overlay on any polygon source: soft fill, blurred glow, crisp outline.
   * Usage later: FSStyles.riskLayers('droughtZones', 'drought').forEach((l) => map.addLayer(l));
   */
  function riskLayers(sourceId, kind, idPrefix) {
    const r = RISK[kind] || RISK.field;
    const id = idPrefix || (kind + '-' + sourceId);
    const fire = kind === 'fire';
    return [
      { id: id + '-fill', type: 'fill', source: sourceId, paint: { 'fill-color': r.color, 'fill-opacity': fire ? 0.28 : 0.18 } },
      { id: id + '-glow', type: 'line', source: sourceId, layout: { 'line-join': 'round' }, paint: { 'line-color': r.glow, 'line-width': fire ? 14 : 10, 'line-blur': fire ? 12 : 8, 'line-opacity': 0.6 } },
      { id: id + '-line', type: 'line', source: sourceId, layout: { 'line-join': 'round' }, paint: { 'line-color': r.color, 'line-width': 2 } },
    ];
  }

  /** Circle layer specs for glowing point markers (e.g. FIRMS hot spots) on a point source. */
  function riskPoints(sourceId, kind, idPrefix) {
    const r = RISK[kind] || RISK.fire;
    const id = idPrefix || (kind + '-' + sourceId);
    return [
      { id: id + '-halo', type: 'circle', source: sourceId, paint: { 'circle-color': r.glow, 'circle-radius': 14, 'circle-blur': 1, 'circle-opacity': 0.55 } },
      { id: id + '-dot', type: 'circle', source: sourceId, paint: { 'circle-color': r.color, 'circle-radius': 4.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } },
    ];
  }

  /**
   * Labeled pin: glowing dot + thin stem + label card (title and a short second line).
   * Returns an element for maplibregl.Marker({ element, anchor: 'bottom', offset: [0, 5] }).
   * Kinds: 'field' (lime), 'fire', 'heat', 'drought'.
   */
  function createPin(opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'pin pin-' + (o.kind || 'field');
    el.innerHTML = '<div class="pin-card"><b class="pin-title"></b><span class="pin-sub"></span></div><div class="pin-stem"></div><div class="pin-dot"></div>';
    updatePin(el, { title: o.title || '', sub: o.sub || '' });
    return el;
  }
  function updatePin(el, o) {
    if (o.title != null) el.querySelector('.pin-title').textContent = o.title;
    if (o.sub != null) { const s = el.querySelector('.pin-sub'); s.textContent = o.sub; s.hidden = !o.sub; }
  }

  /** Slow glow pulse on a line layer. Does nothing if the user prefers reduced motion. */
  function pulse(map, layerId, opts) {
    const o = Object.assign({ period: 3200, opacity: [0.35, 0.8], width: [8, 13], active: function () { return true; } }, opts || {});
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return function () {};
    const timer = setInterval(function () {
      if (document.hidden || !map.getLayer(layerId) || !o.active() || map.isMoving()) return;
      const t = (Math.sin((performance.now() / o.period) * 2 * Math.PI) + 1) / 2;
      map.setPaintProperty(layerId, 'line-opacity', o.opacity[0] + (o.opacity[1] - o.opacity[0]) * t);
      map.setPaintProperty(layerId, 'line-width', o.width[0] + (o.width[1] - o.width[0]) * t);
    }, 120);
    return function () { clearInterval(timer); };
  }

  window.FSStyles = { COLORS: COLORS, RISK: RISK, riskLayers: riskLayers, riskPoints: riskPoints, createPin: createPin, updatePin: updatePin, pulse: pulse };
})();
