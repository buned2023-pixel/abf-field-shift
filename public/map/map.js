/* Field Shift 3D — Stage 1: 3D terrain map + field drawing */
(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────
  const DUSHANBE = { lat: 38.56, lon: 68.77, name: 'Dushanbe' };
  const FIELD_COLOR = '#D4F20C';   // lime
  const SELECT_COLOR = '#2F4BFF';  // electric blue
  const BLOCK_COLOR = '#ff3b4f';
  const PITCH_3D = 65;
  const BEARING_3D = -20;
  const MIN_FIELD_HA = 0.05;
  const MAX_FIELD_HA = 500;
  const MOBILE = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  // Highest Terrarium zoom is 15; phones get 13 to keep frame rate and memory in check
  const DEM_MAXZOOM = MOBILE ? 13 : 15;
  // Terrarium DEM (s3.amazonaws.com/elevation-tiles-prod), proxied + cached by our backend
  const TERRARIUM = `${location.origin}/tiles/terrarium/{z}/{x}/{y}.png`;
  const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ESRI_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
  const SLOPE_CLASSES = [
    { key: 'flat', color: '#ffe2b0' },
    { key: 'gentle', color: '#ffc56b' },
    { key: 'moderate', color: '#f08a24' },
    { key: 'steep', color: '#b4500f' },
  ];
  const I18N = window.FSi18n, t = I18N.t;
  const slopeLabel = (i) => t('ov.slope.' + SLOPE_CLASSES[i].key);
  const aspectName = (a) => t('ov.aspect.' + a);

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = I18N.fmt;
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

  let toastTimer;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }
  // Status line and hint remember how they were made, so a language switch can redraw them
  let statusFn = null, hintFn = null;
  const status = (fn) => { statusFn = typeof fn === 'function' ? fn : null; $('statusLine').textContent = statusFn ? statusFn() : (fn || ''); };
  function hint(html) { const el = $('hint'); el.innerHTML = html || ''; el.hidden = !html; if (!html) hintFn = null; }
  function hintBy(fn) { hint(fn()); hintFn = fn; }

  async function getJson(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // Colour look at intensity 1.0 — change these numbers to retune the map
  const COLOR_BASE = { saturation: 0.4, contrast: 0.2, tint: 0.3, tintNoImagery: 0.95 };

  // ─── Map ───────────────────────────────────────────────────────────────────
  // Contour lines generated in the browser from the same DEM (maplibre-contour)
  let contourUrl = null;
  try {
    const demSource = new mlcontour.DemSource({ url: TERRARIUM, encoding: 'terrarium', maxzoom: 12, worker: true, cacheSize: MOBILE ? 50 : 100 });
    demSource.setupMaplibre(maplibregl);
    contourUrl = demSource.contourProtocolUrl({
      thresholds: { 11: [100, 500], 12: [100, 500], 13: [100, 500], 14: [100, 500], 15: [100, 500] },
      elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
    });
  } catch (err) { console.warn('[contours] unavailable', err); }

  const style = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19,
        attribution: 'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
      },
      labels: { type: 'raster', tiles: [ESRI_LABELS], tileSize: 256, maxzoom: 19 },
      terrainDem: {
        type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAXZOOM,
        attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (AWS Open Data)</a>',
      },
      // Separate DEM source for hillshade (recommended by MapLibre for quality)
      hillshadeDem: { type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAXZOOM },
      // OpenStreetMap vector tiles (OpenFreeMap via our proxy) for rivers, canals and lakes
      osm: {
        type: 'vector', tiles: [`${location.origin}/tiles/osm/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
      },
      nodraw: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      blockedParts: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      fieldGlow: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      ...(contourUrl ? { contours: { type: 'vector', tiles: [contourUrl], maxzoom: 15, attribution: 'Contours from Terrarium DEM' } } : {}),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0A1020' } },
      // Fuller colours: deeper greens, warmer rock, clean white snow, with a very slight warm tint
      // (hue shifted a few degrees toward yellow). Scaled by the "Colour intensity" slider.
      { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-saturation': COLOR_BASE.saturation, 'raster-contrast': COLOR_BASE.contrast, 'raster-brightness-min': 0.05, 'raster-brightness-max': 1, 'raster-hue-rotate': -4 } },
      {
        // Height tint over the imagery: green valleys → golden-ochre mid slopes → grey-brown rock → snow above ~3500 m
        id: 'height-tint', type: 'color-relief', source: 'hillshadeDem',
        paint: {
          'color-relief-opacity': COLOR_BASE.tintNoImagery, // imagery is off by default: the tint is the ground colour
          'color-relief-color': ['interpolate', ['linear'], ['elevation'],
            // Muted, earthy: sage valleys → tan mid slopes → warm brown → grey-brown rock → snow
            300, '#8a9670', 900, '#949675', 1500, '#a39373', 2200, '#9a8268',
            2800, '#887766', 3300, '#9b928a', 3500, '#eef0f2', 4500, '#ffffff'],
        },
      },
      {
        // Hillshade 1 (strong): sun from the north-west for ridge depth.
        // Warm highlights on lit slopes, cool deep-blue shadows on the far side.
        id: 'hillshade', type: 'hillshade', source: 'hillshadeDem',
        paint: {
          'hillshade-exaggeration': 0.72,
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-anchor': 'map',
          'hillshade-shadow-color': 'rgba(8, 18, 82, 0.72)',
          'hillshade-highlight-color': 'rgba(255, 212, 138, 0.3)',
          'hillshade-accent-color': 'rgba(8, 18, 82, 0.24)',
        },
      },
      {
        // Hillshade 2 (soft): fill light from the south-west so shadowed slopes keep some shape
        id: 'hillshade-soft', type: 'hillshade', source: 'hillshadeDem',
        paint: {
          'hillshade-exaggeration': 0.3,
          'hillshade-illumination-direction': 200,
          'hillshade-illumination-anchor': 'map',
          'hillshade-shadow-color': 'rgba(20, 30, 80, 0.3)',
          'hillshade-highlight-color': 'rgba(255, 240, 210, 0.1)',
          'hillshade-accent-color': 'rgba(0, 0, 0, 0)',
        },
      },
      {
        // Slope shading (toggle): only the "accent" term is used, which MapLibre scales by
        // steepness, not by sun direction. Steep slopes get a darker tint; flat land is untouched.
        id: 'slope-shade', type: 'hillshade', source: 'hillshadeDem',
        paint: {
          'hillshade-exaggeration': 1,
          'hillshade-shadow-color': 'rgba(0, 0, 0, 0)',
          'hillshade-highlight-color': 'rgba(0, 0, 0, 0)',
          'hillshade-accent-color': 'rgba(8, 14, 40, 0.5)',
        },
      },
      // ── Water. Fill and line layers are draped onto the 3D terrain (drawn into the terrain's own
      // texture), so they sit exactly on the ground and cannot flicker when the view rotates.
      // Lakes and reservoirs: flat clean blue with a lighter shoreline.
      {
        id: 'water-fill', type: 'fill', source: 'osm', 'source-layer': 'water',
        filter: ['!=', ['get', 'class'], 'swimming_pool'],
        paint: { 'fill-color': '#4a8fca', 'fill-opacity': 0.95, 'fill-antialias': true },
      },
      {
        id: 'water-shore', type: 'line', source: 'osm', 'source-layer': 'water', minzoom: 11,
        filter: ['!=', ['get', 'class'], 'swimming_pool'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#8cc0e6', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 2], 'line-opacity': 0.8 },
      },
      // Rivers > canals > streams/ditches. Width grows with zoom: thin at 10, wider from 14.
      // Three passes: soft darker edge, clean blue body, lighter centre line.
      ...[['waterway-edge', '#2f6fa6', 1.6, 1.2, 0.85], ['waterway', '#4a90cc', 1, 0, 1], ['waterway-center', '#a6d0f0', 0.32, 0, 0.9]].map(([id, color, k, blur, opacity]) => ({
        id, type: 'line', source: 'osm', 'source-layer': 'waterway', minzoom: 10,
        filter: ['all', ['match', ['get', 'class'], ['river', 'canal', 'stream', 'ditch', 'drain'], true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': color, 'line-blur': blur, 'line-opacity': opacity,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'],
            10, ['*', k, ['match', ['get', 'class'], 'river', 1.2, 'canal', 0.7, 0.4]],
            14, ['*', k, ['match', ['get', 'class'], 'river', 5, 'canal', 2.6, 1.4]],
            17, ['*', k, ['match', ['get', 'class'], 'river', 16, 'canal', 8, 4]]],
        },
      })),
      ...(contourUrl ? [
        {
          id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11,
          layout: { visibility: 'none', 'line-join': 'round' },
          paint: {
            'line-color': 'rgba(255, 255, 255, 0.55)',
            'line-width': ['match', ['get', 'level'], 1, 1.4, 0.6],
            'line-opacity': ['match', ['get', 'level'], 1, 0.9, 0.55],
          },
        },
        {
          id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 11,
          filter: ['>', ['get', 'level'], 0],
          layout: {
            visibility: 'none', 'symbol-placement': 'line', 'text-size': 11, 'text-font': ['Open Sans Semibold'],
            'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-max-angle': 30,
          },
          paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10, 16, 32, 0.85)', 'text-halo-width': 1.4 },
        },
      ] : []),
      { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.9 } },
      // No-draw zones: translucent red + hatch, roads/rivers drawn at their real width
      { id: 'nodraw-fill', type: 'fill', source: 'nodraw', minzoom: 12, filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' }, paint: { 'fill-color': BLOCK_COLOR, 'fill-opacity': 0.18 } },
      { id: 'nodraw-hatch', type: 'fill', source: 'nodraw', minzoom: 12, filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' }, paint: { 'fill-pattern': 'hatch', 'fill-opacity': 0.7 } },
      { id: 'nodraw-outline', type: 'line', source: 'nodraw', minzoom: 12, filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' }, paint: { 'line-color': BLOCK_COLOR, 'line-width': 1, 'line-opacity': 0.8 } },
      {
        id: 'nodraw-lines', type: 'line', source: 'nodraw', minzoom: 12, filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BLOCK_COLOR, 'line-opacity': 0.45,
          // metres → pixels (≈30 m/px at z12, ≈0.47 m/px at z18 at Tajik latitudes)
          'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, ['*', ['get', 'width'], 0.033], 18, ['*', ['get', 'width'], 2.1]],
        },
      },
      // Lime glow under the drawn fields (Terra Draw draws the crisp outline on top)
      { id: 'field-glow', type: 'line', source: 'fieldGlow', paint: { 'line-color': FIELD_COLOR, 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } },
      // Blocked parts of the field being checked
      { id: 'blocked-fill', type: 'fill', source: 'blockedParts', paint: { 'fill-color': BLOCK_COLOR, 'fill-opacity': 0.55 } },
      { id: 'blocked-line', type: 'line', source: 'blockedParts', paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [2, 1.5] } },
    ],
    terrain: { source: 'terrainDem', exaggeration: 1.5 },
    sky: {
      // Afternoon gradient: deep blue overhead → warm pale haze at the horizon; fog fades distant terrain
      'sky-color': '#1b3fa8',
      'horizon-color': '#c9d8ee',
      'fog-color': '#cdd6e2',
      'sky-horizon-blend': 0.8,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.68,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
    },
    // Low afternoon sun from the west-south-west (lights 3D objects such as trees and crop rows)
    light: { anchor: 'map', position: [1.15, 250, 68], color: '#ffe9c4', intensity: 0.5 },
  };

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: [DUSHANBE.lon, DUSHANBE.lat],
    zoom: 11.5,
    pitch: PITCH_3D,
    bearing: BEARING_3D,
    maxPitch: 85,
    maxZoom: 19,
    attributionControl: { compact: true }, // an (i) button, so the credits never cover the panels
    // Performance on phones: smaller tile cache (and lower DEM zoom, above).
    // Note: don't override pixelRatio — with 3D terrain, a pixel ratio different from the
    // screen's makes MapLibre read its terrain depth buffer at the wrong pixel, so clicks land off.
    maxTileCacheSize: MOBILE ? 60 : null,
  });
  // Diagonal red hatch for no-draw zones (registered once the style is ready)
  function addHatch() {
    if (map.hasImage('hatch')) return;
    const s = 12, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.strokeStyle = BLOCK_COLOR; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, s); g.lineTo(s, 0); g.moveTo(-s / 2, s / 2); g.lineTo(s / 2, -s / 2); g.moveTo(s / 2, s * 1.5); g.lineTo(s * 1.5, s / 2); g.stroke();
    map.addImage('hatch', g.getImageData(0, 0, s, s));
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
  map.on('error', (e) => { if (e && e.error) console.warn('[map]', e.error.message); });

  // ─── View controls (2D/3D, exaggeration, layers) ──────────────────────────
  const view = { is3D: true, exaggeration: 1.5 };

  function set3D(on) {
    view.is3D = on;
    $('view3d').classList.toggle('on', on);
    $('view2d').classList.toggle('on', !on);
    $('exaggeration').disabled = !on;
    if (on) {
      map.setTerrain({ source: 'terrainDem', exaggeration: view.exaggeration });
      map.easeTo({ pitch: PITCH_3D, bearing: map.getBearing() || BEARING_3D, duration: 900 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
    }
  }

  function setLayerVisible(id, on) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  function setFieldsVisible(on) {
    (map.getStyle().layers || []).forEach((l) => { if (l.id.startsWith('td-')) setLayerVisible(l.id, on); });
    labels.forEach((m) => { m.getElement().style.display = on ? '' : 'none'; });
  }

  function bindViewControls() {
    $('view2d').addEventListener('click', () => set3D(false));
    $('view3d').addEventListener('click', () => set3D(true));
    $('exaggeration').addEventListener('input', (e) => {
      view.exaggeration = parseFloat(e.target.value);
      $('exagValue').textContent = `${view.exaggeration.toFixed(1)}×`;
      if (view.is3D) map.setTerrain({ source: 'terrainDem', exaggeration: view.exaggeration });
    });
    $('lyrSatellite').addEventListener('change', (e) => {
      setLayerVisible('satellite', e.target.checked);
      // Without imagery the height tint becomes the ground colour; with imagery it is a light overlay
      const k = parseFloat($('colorIntensity').value) || 1;
      map.setPaintProperty('height-tint', 'color-relief-opacity', e.target.checked ? Math.min(0.5, COLOR_BASE.tint * k) : COLOR_BASE.tintNoImagery);
    });
    $('lyrHillshade').addEventListener('change', (e) => { setLayerVisible('hillshade', e.target.checked); setLayerVisible('hillshade-soft', e.target.checked); });
    $('lyrSlope').addEventListener('change', (e) => setLayerVisible('slope-shade', e.target.checked));
    $('lyrRelief').addEventListener('change', (e) => setLayerVisible('height-tint', e.target.checked));
    // Colour intensity 0.5–1.5: scales imagery saturation and contrast, and the height tint
    $('colorIntensity').addEventListener('input', (e) => {
      const k = parseFloat(e.target.value);
      $('colorValue').textContent = `${k.toFixed(1)}×`;
      map.setPaintProperty('satellite', 'raster-saturation', Math.min(0.9, COLOR_BASE.saturation * k));
      map.setPaintProperty('satellite', 'raster-contrast', Math.min(0.6, COLOR_BASE.contrast * k));
      if ($('lyrSatellite').checked) map.setPaintProperty('height-tint', 'color-relief-opacity', Math.min(0.5, COLOR_BASE.tint * k));
    });
    $('lyrLabels').addEventListener('change', (e) => setLayerVisible('labels', e.target.checked));
    $('lyrFields').addEventListener('change', (e) => setFieldsVisible(e.target.checked));
    $('lyrContours').addEventListener('change', (e) => { setLayerVisible('contours', e.target.checked); setLayerVisible('contour-labels', e.target.checked); });
    $('lyrZones').addEventListener('change', () => updateZonesVisibility());
    if (!contourUrl) { $('lyrContours').disabled = true; $('lyrContours').closest('label').title = t('layers.contoursOff'); }
    // Rivers, canals and lakes on/off
    $('lyrWater').addEventListener('change', (e) => ['water-fill', 'water-shore', 'waterway-edge', 'waterway', 'waterway-center'].forEach((l) => setLayerVisible(l, e.target.checked)));
    // Panel open/close is handled by ui.js (one click, remembered, one sheet at a time on phones)
  }

  // ─── Location & search ─────────────────────────────────────────────────────
  function flyTo(lon, lat, zoom = 13) {
    // Smooth, cinematic arc: zooms out a little, travels, then settles into the 3D view
    map.flyTo({
      center: [lon, lat], zoom,
      pitch: view.is3D ? PITCH_3D : 0, bearing: view.is3D ? BEARING_3D : 0,
      speed: 0.7, curve: 1.5, essential: true,
      easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    });
  }

  function browserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  async function startLocation() {
    status(() => t('status.finding'));
    try {
      const d = await getJson('/api/location');
      flyTo(d.lon, d.lat, 12.5);
      status(() => t('status.byIp', { place: [d.city, d.country].filter(Boolean).join(', ') }));
      return;
    } catch (_) { /* fall back to browser geolocation */ }
    try {
      const p = await browserLocation();
      flyTo(p.lon, p.lat, 14);
      status(() => t('status.byGps'));
      return;
    } catch (_) { /* fall back to search */ }
    status(() => t('status.dushanbe'));
    $('searchInput').focus();
  }

  async function myLocation() {
    status(() => t('status.finding'));
    try {
      const p = await browserLocation();
      flyTo(p.lon, p.lat, 15);
      status(() => t('status.byGps'));
    } catch (_) {
      try {
        const d = await getJson('/api/location');
        flyTo(d.lon, d.lat, 12.5);
        status(() => t('status.ipFallback', { place: d.city || '' }));
      } catch (__) {
        status(() => t('status.noLocation'));
      }
    }
  }

  async function doSearch(q) {
    const list = $('searchResults');
    if (!q.trim()) { list.hidden = true; return; }
    list.innerHTML = `<li class="empty">${esc(t('search.searching'))}</li>`;
    list.hidden = false;
    try {
      const { results } = await getJson(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!results.length) { list.innerHTML = `<li class="empty">${esc(t('search.none'))}</li>`; return; }
      list.innerHTML = '';
      results.forEach((r) => {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.innerHTML = `${esc(r.city)}<small>${esc([r.admin, r.country].filter(Boolean).join(', '))}</small>`;
        const pick = () => {
          list.hidden = true;
          $('searchInput').value = r.city;
          flyTo(r.lon, r.lat, 13);
          status(`${r.city}${r.country ? ', ' + r.country : ''}`);
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
        list.appendChild(li);
      });
    } catch (_) {
      list.innerHTML = `<li class="empty">${esc(t('search.error'))}</li>`;
    }
  }

  function bindSearch() {
    $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('searchInput').value); });
    document.addEventListener('click', (e) => { if (!$('searchForm').contains(e.target)) $('searchResults').hidden = true; });
    $('locateBtn').addEventListener('click', myLocation);
  }

  // ─── Fields (Terra Draw) ───────────────────────────────────────────────────
  const fields = new Map();  // id → { name, createdAt, geo, terrain, terrainError }
  const labels = new Map();  // id → maplibregl.Marker
  let draw = null;
  let selectedId = null;

  // Shape rules checked the moment a field is closed or an edit is committed
  function shapeProblem(feature) {
    if (window.terraDraw.ValidateNotSelfIntersecting(feature).valid === false) return t('shape.cross');
    const ha = turf.area(feature) / 10000;
    if (ha < MIN_FIELD_HA) return t('shape.small', { ha: fmt(ha, 3), min: fmt(MIN_FIELD_HA, 2) });
    if (ha > MAX_FIELD_HA) return t('shape.large', { ha: fmt(ha, 0), max: fmt(MAX_FIELD_HA) });
    return null;
  }

  function setupDraw() {
    const TD = window.terraDraw;
    // In-progress ("provisional") shapes may cross while the user is still clicking
    let lastWarned = 0;
    // 'commit' fires for every corner added (the shape is still open, so its area is ~0):
    // only crossing edges are checked then. Size limits apply on 'finish' (shape closed);
    // select-mode edits are size-checked in onFieldEdited.
    const validation = (feature, ctx) => {
      const type = ctx && ctx.updateType;
      if (type === 'provisional') return { valid: true };
      if (type !== 'finish') {
        const ok = TD.ValidateNotSelfIntersecting(feature);
        return ok.valid === false ? ok : { valid: true };
      }
      const problem = shapeProblem(feature);
      if (problem) {
        if (Date.now() - lastWarned > 1500) { toast(problem, true); lastWarned = Date.now(); }
        return { valid: false, reason: problem };
      }
      return { valid: true };
    };
    // Live colour while drawing: red over a no-draw zone, lime/green over allowed land
    const liveColor = () => (live.state === 'blocked' ? BLOCK_COLOR : live.state === 'allowed' ? '#7CFF6B' : FIELD_COLOR);
    const polygonMode = new TD.TerraDrawPolygonMode({
      validation,
      styles: {
        fillColor: liveColor, fillOpacity: 0.22, outlineColor: liveColor, outlineWidth: 3,
        closingPointColor: '#ffffff', closingPointOutlineColor: liveColor, closingPointWidth: 6, closingPointOutlineWidth: 2,
        editedPointColor: '#ffffff', editedPointOutlineColor: FIELD_COLOR, editedPointWidth: 5,
      },
    });
    const selectMode = new TD.TerraDrawSelectMode({
      // Terra Draw's own Delete shortcut removed polygons behind the app's back (the list and
      // storage kept them, so they came back after reload). The app handles Delete itself.
      keyEvents: { deselect: 'Escape', delete: null, rotate: null, scale: null },
      flags: {
        polygon: {
          feature: {
            draggable: true,
            coordinates: { midpoints: true, draggable: true, deletable: true },
          },
        },
      },
      styles: {
        selectedPolygonColor: FIELD_COLOR, selectedPolygonFillOpacity: 0.3,
        selectedPolygonOutlineColor: '#ffffff', selectedPolygonOutlineWidth: 3,
        selectionPointColor: '#ffffff', selectionPointOutlineColor: SELECT_COLOR, selectionPointWidth: 6, selectionPointOutlineWidth: 2,
        midPointColor: SELECT_COLOR, midPointOutlineColor: '#ffffff', midPointWidth: 4, midPointOutlineWidth: 1,
      },
    });

    draw = new TD.TerraDraw({
      adapter: new window.terraDrawMaplibreGlAdapter.TerraDrawMapLibreGLAdapter({ map }),
      modes: [polygonMode, selectMode],
    });
    draw.start();
    draw.setMode('select');

    draw.on('finish', (id, ctx) => {
      if (ctx && ctx.mode === 'polygon' && ctx.action === 'draw') onFieldDrawn(id);
      else if (fields.has(id)) onFieldEdited(id); // drag / reshape committed in select mode
    });
    draw.on('change', (ids, type) => {
      if (type === 'update') ids.forEach((id) => { if (fields.has(id)) scheduleRecompute(id); });
      // Safety net: if a polygon disappears from Terra Draw by any route, drop it from the app too
      if (type === 'delete') ids.forEach((id) => { if (fields.has(id) && !deleting.has(id)) forgetField(id); });
    });
    draw.on('select', (id) => { selectedId = fields.has(id) ? id : null; render(); });
    draw.on('deselect', () => { selectedId = null; render(); });
  }

  function featureOf(id) {
    const f = draw.getSnapshotFeature ? draw.getSnapshotFeature(id) : draw.getSnapshot().find((x) => x.id === id);
    return f && f.geometry && f.geometry.type === 'Polygon' ? f : null;
  }

  // ── Stats ──
  function geometryStats(f) {
    const centroid = turf.centroid(f).geometry.coordinates;
    return {
      areaHa: turf.area(f) / 10000,
      perimeterKm: turf.length(turf.polygonToLine(f), { units: 'kilometers' }),
      centroid,
    };
  }

  const terrainTokens = new Map();
  async function computeTerrain(id) {
    const f = featureOf(id);
    const field = fields.get(id);
    if (!f || !field) return;
    const token = (terrainTokens.get(id) || 0) + 1;
    terrainTokens.set(id, token);
    field.terrain = null;
    field.terrainError = false;
    render();
    try {
      const t = await window.FieldDEM.analyzeTerrain(f);
      if (terrainTokens.get(id) !== token || !fields.has(id)) return;
      field.terrain = t;
    } catch (err) {
      if (terrainTokens.get(id) !== token) return;
      console.warn('[terrain]', err);
      field.terrainError = true;
    }
    save();
    render();
  }

  function recompute(id) {
    const f = featureOf(id);
    const field = fields.get(id);
    if (!f || !field) return;
    field.geo = geometryStats(f);
    updateLabel(id);
    computeTerrain(id);
  }

  const recomputeTimers = new Map();
  function scheduleRecompute(id) {
    const f = featureOf(id);
    const field = fields.get(id);
    if (f && field) { field.geo = geometryStats(f); updateLabel(id); updateGlow(); render(); } // live area while dragging
    clearTimeout(recomputeTimers.get(id));
    recomputeTimers.set(id, setTimeout(() => { computeTerrain(id); save(); }, 600));
  }

  // ── Lifecycle ──
  function nextName() {
    let n = fields.size + 1;
    const names = new Set([...fields.values()].map((f) => f.name));
    while (names.has(t('field.name', { num: n }))) n++;
    return t('field.name', { num: n });
  }

  function onFieldDrawn(id) {
    const f = featureOf(id);
    fields.set(id, { name: nextName(), createdAt: new Date().toISOString(), geo: null, terrain: null, land: { status: 'checking' }, lastGood: f && f.geometry });
    recompute(id);
    save();
    setDrawing(false);
    draw.selectFeature(id);
    toast(t('toast.checking', { name: fields.get(id).name, ha: fmt(fields.get(id).geo.areaHa, 2) }));
    runLandCheck(id, { isNew: true });
  }

  function onFieldEdited(id) {
    const field = fields.get(id);
    const f = featureOf(id);
    if (!field || !f) return;
    const problem = shapeProblem(f);
    if (problem && field.lastGood) {
      draw.updateFeatureGeometry(id, field.lastGood);
      recompute(id);
      save();
      render();
      toast(`${problem} ${t('toast.undone')}`, true);
      return;
    }
    runLandCheck(id, { prevGeometry: field.lastGood });
  }

  // ── Land check (OpenStreetMap) ──
  const landParts = new Map(); // id → last report with blocked pieces (for trim + red overlay)
  const landTokens = new Map();
  let overlayOwner = null;

  function showBlocked(pieces, ownerId) {
    overlayOwner = ownerId || null;
    map.getSource('blockedParts').setData(pieces || { type: 'FeatureCollection', features: [] });
  }
  function clearBlocked(ownerId) {
    if (ownerId === undefined || overlayOwner === ownerId) showBlocked(null, null);
  }

  const landSummary = (rep) => ({
    status: rep.status, share: rep.share, classes: rep.classes || [],
    allowedShare: rep.allowedShare, allowedClasses: rep.allowedClasses || [], checkedAt: new Date().toISOString(),
  });

  async function runLandCheck(id, { isNew = false, prevGeometry = null } = {}) {
    const f = featureOf(id);
    const field = fields.get(id);
    if (!f || !field) return;
    const token = (landTokens.get(id) || 0) + 1;
    landTokens.set(id, token);
    const prevLand = field.land;
    field.land = { status: 'checking' };
    render();

    const rep = await window.FieldLand.checkField(f);
    if (landTokens.get(id) !== token || !fields.has(id)) return;
    const pct = rep.share != null ? fmt(rep.share * 100, rep.share < 0.1 ? 1 : 0) : null;

    if (rep.status === 'blocked') {
      const msg = window.FieldLand.rejectMessage(rep);
      showBlocked(rep.pieces, id);
      if (isNew) {
        // Reject: the field is not kept; the red parts stay visible so the user sees why
        await removeField(id, { quiet: true });
        showBlocked(rep.pieces, null);
        const again = await window.FSDialog.confirm({
          title: t('dlg.notAllowed'),
          message: `${msg} ${t('dlg.notAllowedPct', { pct })}`,
          okText: t('dlg.drawAgain'), cancelText: t('dlg.close'),
        });
        if (again) setDrawing(true);
        return;
      }
      if (prevGeometry) {
        // An edit pushed the field onto blocked land: undo the edit
        draw.updateFeatureGeometry(id, prevGeometry);
        field.land = prevLand && prevLand.status !== 'checking' ? prevLand : { status: 'unverified' };
        recompute(id);
        save();
        render();
        toast(`${msg} ${t('toast.undone')}`, true);
        return;
      }
      // Imported / restored field: keep it but flag it clearly
      field.land = landSummary(rep);
      landParts.set(id, rep);
      toast(`${field.name}: ${msg}`, true);
    } else if (rep.status === 'minor') {
      field.land = landSummary(rep);
      landParts.set(id, rep);
      showBlocked(rep.pieces, id);
      field.lastGood = f.geometry;
      toast(t('toast.touches', { name: field.name, what: window.FieldLand.whatList(rep), pct }));
    } else if (rep.status === 'ok') {
      field.land = landSummary(rep);
      landParts.delete(id);
      clearBlocked(id);
      field.lastGood = f.geometry;
      if (isNew) toast(t('toast.saved', { name: field.name, ha: fmt(field.geo.areaHa, 2) }));
    } else {
      field.land = { status: 'unverified', checkedAt: new Date().toISOString() };
      field.lastGood = f.geometry;
      toast(t('land.unverifiedToast'), true);
    }
    save();
    render();
  }

  async function trimField(id) {
    const rep = landParts.get(id);
    const f = featureOf(id);
    if (!rep || !rep.union || !f) return;
    const geom = window.FieldLand.trim(f, rep.union);
    const problem = geom ? shapeProblem({ type: 'Feature', properties: {}, geometry: geom }) : t('toast.trimNothing');
    if (problem) { toast(t('toast.cantTrim', { problem }), true); return; }
    const before = fields.get(id).geo.areaHa;
    draw.updateFeatureGeometry(id, geom);
    recompute(id);
    clearBlocked(id);
    const after = fields.get(id).geo.areaHa;
    toast(t('toast.trimmed', { ha: fmt(before - after, 2) }));
    runLandCheck(id);
  }

  // ── Delete ──
  const deleting = new Set();

  // Remove a field everywhere: map polygon, label, glow, list, overview, storage
  function forgetField(id) {
    fields.delete(id);
    if (labels.has(id)) { labels.get(id).remove(); labels.delete(id); }
    landParts.delete(id);
    landTokens.delete(id);
    terrainTokens.delete(id);
    clearTimeout(recomputeTimers.get(id));
    recomputeTimers.delete(id);
    clearBlocked(id);
    if (selectedId === id) selectedId = null;
    save();
    render();
  }

  async function removeField(id) {
    deleting.add(id);
    try {
      if (draw.getMode() === 'select') { try { draw.deselectFeature(id); } catch (_) { /* not selected */ } }
      if (draw.getSnapshotFeature(id)) draw.removeFeatures([id]);
    } finally {
      deleting.delete(id);
    }
    forgetField(id);
  }

  async function deleteField(id) {
    if (!id || !fields.has(id)) return;
    const name = fields.get(id).name;
    const ok = await window.FSDialog.confirm({
      title: t('dlg.deleteOne'),
      message: t('dlg.deleteOneMsg', { name }),
      okText: t('dlg.delete'), cancelText: t('dlg.keep'), danger: true,
    });
    if (!ok || !fields.has(id)) return;
    await removeField(id);
    toast(t('toast.deleted', { name }));
  }

  async function deleteAllFields() {
    const n = fields.size;
    if (!n) return;
    const ok = await window.FSDialog.confirm({
      title: t('dlg.deleteAll', { n }),
      message: t('dlg.deleteAllMsg'),
      okText: t('dlg.deleteAllOk'), cancelText: t('dlg.keep'), danger: true,
    });
    if (!ok) return;
    for (const id of [...fields.keys()]) await removeField(id);
    clearBlocked();
    toast(t('toast.deletedN', { n }));
  }

  async function renameField(id) {
    const field = fields.get(id);
    if (!field) return;
    const v = await window.FSDialog.prompt({ title: t('dlg.rename'), value: field.name, okText: t('dlg.save'), cancelText: t('dlg.cancel') });
    if (!v || !fields.has(id)) return;
    field.name = v.slice(0, 60);
    updateLabel(id);
    save();
    render();
  }

  function selectField(id, fly = true) {
    if (!fields.has(id)) return;
    if (draw.getMode() !== 'select') setDrawing(false);
    try { draw.selectFeature(id); } catch (_) { /* already selected */ }
    selectedId = id;
    render();
    if (fly) zoomToField(id);
  }

  function zoomToField(id) {
    const f = featureOf(id);
    if (!f) return;
    const b = turf.bbox(f);
    const pad = isMobile() ? { top: 90, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 80, bottom: 120, left: 290, right: 400 };
    const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, maxZoom: 17 });
    // cameraForBounds frames a flat view; a tilted 3D camera needs to back off a little more
    if (cam) map.easeTo({ ...cam, zoom: Math.min(cam.zoom - (view.is3D ? 0.7 : 0), 17), pitch: view.is3D ? 50 : 0, duration: 1200 });
  }

  function updateLabel(id) {
    const field = fields.get(id);
    if (!field || !field.geo) return;
    let m = labels.get(id);
    if (!m) {
      // Labeled pin: glowing dot on the field, thin stem, card with name + area
      const el = window.FSStyles.createPin({ kind: 'field' });
      // opacityWhenCovered: MapLibre misjudges pins sitting on the terrain surface as hidden and fades them
      m = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 5], opacityWhenCovered: '1' }).setLngLat(field.geo.centroid).addTo(map);
      if (!$('lyrFields').checked) el.style.display = 'none';
      labels.set(id, m);
    }
    m.setLngLat(field.geo.centroid);
    window.FSStyles.updatePin(m.getElement(), { title: field.name, sub: `${fmt(field.geo.areaHa, field.geo.areaHa < 10 ? 2 : 1)} ${t('unit.ha')}` });
  }

  // ── No-draw zones + live feedback while drawing ──
  const live = { state: 'unknown', cls: null };
  const isDrawing = () => !!draw && draw.getMode() === 'polygon';

  function updateZonesVisibility() {
    const on = $('lyrZones').checked || isDrawing();
    ['nodraw-fill', 'nodraw-hatch', 'nodraw-outline', 'nodraw-lines'].forEach((l) => setLayerVisible(l, on));
    if (on) refreshZones();
  }

  let zonesTimer = null;
  function refreshZones() {
    clearTimeout(zonesTimer);
    zonesTimer = setTimeout(async () => {
      if (!($('lyrZones').checked || isDrawing())) return;
      const r = await window.FieldLand.ensureZones(map, (fc) => map.getSource('nodraw').setData(fc));
      if (isDrawing()) drawingHint(r === 'zoom');
    }, 400);
  }

  function drawingHint(needZoom) {
    hintBy(() => esc(t('hint.draw')).replace('{esc}', '<kbd>Esc</kbd>') +
      (needZoom ? `<br><span class="hint-sub">${esc(t('hint.zoomZones'))}</span>` : ''));
  }

  function updateCursorTip(e) {
    const tip = $('cursorTip');
    if (!isDrawing() || !e) { tip.hidden = true; live.state = 'unknown'; return; }
    const r = map.getZoom() >= window.FieldLand.MIN_ZONE_ZOOM ? window.FieldLand.hitTest(e.lngLat) : { state: 'unknown' };
    live.state = r.state; live.cls = r.cls;
    tip.className = `cursor-tip ${r.state}`;
    tip.textContent = r.state === 'blocked' ? `✕ ${t('tip.noDraw', { what: window.FieldLand.shortName(r.cls) })}`
      : r.state === 'allowed' ? `✓ ${t('tip.allowed')}` : t('tip.unknown');
    tip.style.transform = `translate(${e.point.x + 16}px, ${e.point.y + 16}px)`;
    tip.hidden = false;
    map.getCanvas().style.cursor = r.state === 'blocked' ? 'not-allowed' : 'crosshair';
  }

  // ── Drawing mode ──
  function setDrawing(on) {
    if (!draw) return;
    if (on) {
      if (selectedId) { try { draw.deselectFeature(selectedId); } catch (_) { /* ignore */ } }
      draw.setMode('polygon');
      clearBlocked();
      drawingHint(map.getZoom() < window.FieldLand.MIN_ZONE_ZOOM);
    } else {
      draw.setMode('select');
      hint('');
      updateCursorTip(null);
      map.getCanvas().style.cursor = '';
    }
    updateZonesVisibility();
    $('drawBtn').classList.toggle('active', on);
    drawBtnText(on);
    $('editBtn').classList.remove('active');
  }

  function startEdit() {
    if (!fields.size) { toast(t('toast.drawFirst')); return; }
    setDrawing(false);
    if (!selectedId && fields.size === 1) selectField(fields.keys().next().value, false);
    $('editBtn').classList.add('active');
    startEditHintOnly();
  }

  // ─── Storage, export, import ───────────────────────────────────────────────
  function toGeoJSON(forExport) {
    const features = [];
    fields.forEach((field, id) => {
      const f = featureOf(id);
      if (!f) return;
      const t = field.terrain;
      const props = {
        name: field.name,
        created_at: field.createdAt,
        area_ha: field.geo ? +field.geo.areaHa.toFixed(4) : null,
        perimeter_km: field.geo ? +field.geo.perimeterKm.toFixed(4) : null,
        centroid_lon: field.geo ? +field.geo.centroid[0].toFixed(6) : null,
        centroid_lat: field.geo ? +field.geo.centroid[1].toFixed(6) : null,
        mean_elevation_m: t ? +t.meanElevation.toFixed(1) : null,
        min_elevation_m: t ? +t.minElevation.toFixed(1) : null,
        max_elevation_m: t ? +t.maxElevation.toFixed(1) : null,
        mean_slope_deg: t ? +t.meanSlope.toFixed(2) : null,
        aspect: t ? t.aspect : null,
        aspect_deg: t && t.aspectDeg != null ? +t.aspectDeg.toFixed(1) : null,
        land_status: field.land && field.land.status !== 'checking' ? field.land.status : null,
        land_blocked_pct: field.land && field.land.share != null ? +(field.land.share * 100).toFixed(2) : null,
        land_blocked_types: field.land && field.land.classes ? field.land.classes.join(',') : null,
      };
      if (!forExport && t) props._terrain = t;
      if (!forExport && field.land && field.land.status !== 'checking') props._land = field.land;
      features.push({ type: 'Feature', id, geometry: f.geometry, properties: props });
    });
    return { type: 'FeatureCollection', features };
  }

  function save() {
    const gj = toGeoJSON(false);
    updateGlow(gj);
    try { window.FSStore.saveFields(gj); } // the user's account when signed in, otherwise this browser
    catch (_) { toast(t('toast.storage'), true); }
  }

  // Lime glow around every field (fed from the same snapshot that is saved)
  function updateGlow(gj) {
    const src = map.getSource('fieldGlow');
    if (src) src.setData(gj || toGeoJSON(true));
    if (window.FieldPlants) window.FieldPlants.fieldsChanged(); // crop rows follow the fields
    if (window.FieldTrees) window.FieldTrees.fieldsChanged();   // trees stay out of the fields
  }

  // Normalise any GeoJSON into Terra Draw-ready polygons
  function extractPolygons(gj) {
    const out = [];
    const pushPoly = (coords, props, srcId) => {
      if (!Array.isArray(coords) || !coords.length) return;
      const rings = coords.map((ring) => {
        const r = ring.map((c) => [+(+c[0]).toFixed(9), +(+c[1]).toFixed(9)]); // 2D, Terra Draw precision
        const a = r[0], b = r[r.length - 1];
        if (a && b && (a[0] !== b[0] || a[1] !== b[1])) r.push([a[0], a[1]]);
        return r;
      }).filter((r) => r.length >= 4 && r.every((c) => isFinite(c[0]) && isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90));
      if (rings.length) out.push({ rings, props: props || {}, srcId });
    };
    const walk = (obj, props, srcId) => {
      if (!obj) return;
      if (obj.type === 'FeatureCollection') obj.features.forEach((f) => walk(f));
      else if (obj.type === 'Feature') walk(obj.geometry, obj.properties, obj.id);
      else if (obj.type === 'Polygon') pushPoly(obj.coordinates, props, srcId);
      else if (obj.type === 'MultiPolygon') {
        const base = nameFromProps(props);
        obj.coordinates.forEach((p, i) => pushPoly(p, { ...(props || {}), name: base ? `${base} (${i + 1})` : undefined }, null));
      }
      else if (obj.type === 'GeometryCollection') obj.geometries.forEach((g) => walk(g, props));
    };
    walk(gj);
    return out;
  }

  function nameFromProps(p) {
    if (!p) return '';
    const v = p.name || p.Name || p.NAME || p.title || p.label;
    return v == null ? '' : String(v).trim();
  }

  const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function addPolygons(polys, { fromStorage = false } = {}) {
    let added = 0, rejected = 0;
    const addedIds = [];
    polys.forEach((p) => {
      let id = typeof p.srcId === 'string' && UUID_RE.test(p.srcId) && !fields.has(p.srcId) ? p.srcId : uuid();
      // Reject self-intersecting ("bow-tie") shapes: their area and terrain stats are meaningless
      try {
        const poly = turf.polygon(p.rings);
        if (turf.kinks(poly).features.length) { rejected++; return; }
        const ha = turf.area(poly) / 10000;
        if (!fromStorage && (ha < MIN_FIELD_HA || ha > MAX_FIELD_HA)) { rejected++; return; }
      } catch (_) { rejected++; return; }
      const res = draw.addFeatures([{ id, type: 'Feature', geometry: { type: 'Polygon', coordinates: p.rings }, properties: { mode: 'polygon' } }]);
      const ok = Array.isArray(res) ? res[0] && res[0].valid !== false : true;
      if (!ok) { rejected++; return; }
      const props = p.props || {};
      const name = nameFromProps(props) || nextName();
      fields.set(id, {
        name: String(name).slice(0, 60),
        createdAt: props.created_at || new Date().toISOString(),
        geo: null,
        terrain: fromStorage && props._terrain ? props._terrain : null,
        land: fromStorage && props._land ? props._land : null,
      });
      const f = featureOf(id);
      fields.get(id).geo = geometryStats(f);
      fields.get(id).lastGood = f.geometry;
      updateLabel(id);
      if (!fields.get(id).terrain) computeTerrain(id);
      added++; addedIds.push(id);
    });
    // Land check for imported fields and for saved ones that could not be verified before
    addedIds.forEach((id) => {
      const land = fields.get(id).land;
      if (!land || land.status === 'unverified') runLandCheck(id);
    });
    return { added, rejected, addedIds };
  }

  function loadSaved() {
    let raw = null;
    try { raw = window.FSStore.loadFields(); } catch (_) { return; }
    if (!raw) return;
    try {
      const { added } = addPolygons(extractPolygons(raw), { fromStorage: true });
      if (added) toast(t('toast.loaded', { n: added }));
    } catch (err) { console.warn('[storage]', err); }
  }

  // Branded file header: GeoJSON allows extra top-level members, which GIS tools ignore
  async function exportHeader() {
    let logo = '/img/abf-mark.svg';
    try {
      const svg = await (await fetch('/img/abf-mark.svg')).text();
      logo = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    } catch (_) { /* keep the path */ }
    return {
      name: 'ABF Field Shift: field export',
      generator: 'ABF Field Shift',
      exported_at: new Date().toISOString(),
      logo,
      credits: 'Powered by NASA data · Space Apps Challenge 2026',
    };
  }

  async function exportFields() {
    if (!fields.size) { toast(t('toast.noExport')); return; }
    const gj = toGeoJSON(true);
    const header = await exportHeader();
    const blob = new Blob([JSON.stringify({ type: gj.type, ...header, features: gj.features }, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `field-shift-fields-${new Date().toISOString().slice(0, 10)}.geojson`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t('toast.exported', { n: fields.size }));
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast(t('toast.tooBig'), true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const polys = extractPolygons(JSON.parse(reader.result));
        if (!polys.length) { toast(t('toast.noPolys'), true); return; }
        setDrawing(false);
        const { added, rejected, addedIds } = addPolygons(polys);
        save();
        render();
        if (addedIds.length) {
          const all = turf.featureCollection(addedIds.map(featureOf).filter(Boolean));
          const b = turf.bbox(all);
          map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 16, duration: 1200 });
        }
        toast(t('toast.imported', { n: added }) + (rejected ? ` · ${t('toast.skipped', { n: rejected, min: fmt(MIN_FIELD_HA, 2), max: fmt(MAX_FIELD_HA) })}` : ''), !added);
      } catch (_) {
        toast(t('toast.badFile'), true);
      }
    };
    reader.readAsText(file);
  }

  // ─── Overview panel ────────────────────────────────────────────────────────
  function compassSvg(deg) {
    const arrow = deg == null ? '' :
      `<g transform="rotate(${deg} 22 22)"><path d="M22 8 L27 24 L22 21 L17 24 Z" fill="${FIELD_COLOR}"/></g>`;
    return `<svg class="compass" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="19" fill="rgba(255,255,255,0.04)" stroke="rgba(150,170,255,0.35)"/>
      <text x="22" y="9" text-anchor="middle" font-size="7" fill="#a8b2d4" font-family="Inter">${esc(t('ov.compassN'))}</text>
      ${arrow}${deg == null ? '<circle cx="22" cy="22" r="3" fill="#a8b2d4"/>' : ''}
    </svg>`;
  }

  function metric(k, v, sub, wide) {
    return `<div class="metric${wide ? ' wide' : ''}"><div class="k">${k}</div><div class="v${v == null ? ' loading' : ''}">${v == null ? esc(t('ov.analyzing')) : v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  const LAND_BADGE = {
    ok: { cls: 'ok', icon: '✓' },
    minor: { cls: 'minor', icon: '!' },
    blocked: { cls: 'blocked', icon: '✕' },
    unverified: { cls: 'unverified', icon: '⚠' },
    checking: { cls: 'checking', icon: '…' },
  };
  function landBadge(land, compact) {
    const st = (land && land.status) || 'unverified';
    const b = { ...LAND_BADGE[st], text: t('land.badge.' + st) };
    return `<span class="land-badge ${b.cls}" title="${esc(b.text)}">${b.icon}${compact ? '' : ` ${esc(b.text)}`}</span>`;
  }

  function landHtml(id, field) {
    const land = field.land || { status: 'unverified' };
    const S = window.FieldLand.shortName;
    let detail = '';
    if (land.status === 'ok') {
      detail = land.allowedClasses && land.allowedClasses.length
        ? t('land.okMapped', { types: land.allowedClasses.map((c) => S(c)).join(', ').toLowerCase(), pct: fmt(land.allowedShare * 100) })
        : t('land.okNone');
    } else if (land.status === 'minor' || land.status === 'blocked') {
      detail = t('land.overlaps', { pct: fmt(land.share * 100, 1), types: land.classes.map((c) => S(c).toLowerCase()).join(', ') });
    } else if (land.status === 'unverified') {
      detail = t('land.unverified');
    } else detail = t('land.checkingOsm');
    const canTrim = (land.status === 'minor' || land.status === 'blocked') && landParts.has(id);
    const canRetry = land.status === 'unverified';
    return `<div class="metric wide land-row ${LAND_BADGE[land.status] ? LAND_BADGE[land.status].cls : ''}">
        <div class="k">${esc(t('land.question'))}</div>
        <div class="land-line">${landBadge(land)}</div>
        <div class="sub">${esc(detail)}</div>
        ${canTrim ? `<button class="btn-sm trim-btn" id="trimBtn" type="button">${esc(t('land.trim'))}</button>` : ''}
        ${canRetry ? `<button class="btn-sm" id="recheckBtn" type="button">${esc(t('land.recheck'))}</button>` : ''}
      </div>`;
  }

  function renderDetail() {
    const el = $('fieldDetail');
    const field = selectedId && fields.get(selectedId);
    if (!field) {
      el.innerHTML = fields.size
        ? `<p class="empty-state">${esc(t('ov.selectHint'))}</p>`
        : `<div class="empty-state"><b>${esc(t('ov.firstTitle'))}</b><ol>
             <li>${esc(t('ov.first1'))}</li>
             <li>${esc(t('ov.first2'))}</li>
             <li>${esc(t('ov.first3'))}</li></ol></div>`;
      return;
    }
    const g = field.geo || {};
    const tr = field.terrain;
    const k = (key) => esc(t(key));
    let terrainHtml;
    if (field.terrainError) {
      terrainHtml = `<div class="metric wide"><div class="k">${k('ov.terrain')}</div><div class="sub">${k('ov.terrainErr')}</div></div>`;
    } else if (!tr) {
      terrainHtml = metric(k('ov.height'), null) + metric(k('ov.avgSlope'), null) + metric(k('ov.faces'), null, null, true);
    } else {
      const bars = tr.slopeShare.map((s, i) => s > 0 ? `<span style="flex:${s};background:${SLOPE_CLASSES[i].color}" title="${esc(slopeLabel(i))}: ${fmt(s * 100)}%"></span>` : '').join('');
      const legend = tr.slopeShare.map((s, i) => s >= 0.005 ? `<span><i style="background:${SLOPE_CLASSES[i].color}"></i>${esc(slopeLabel(i))} ${fmt(s * 100)}%</span>` : '').join('');
      const aspectSub = tr.aspect === 'flat' ? t('ov.aspectFlat') : tr.aspect === 'mixed' ? t('ov.aspectMixed') : t('ov.aspectDeg', { deg: fmt(tr.aspectDeg) });
      terrainHtml =
        metric(k('ov.height'), `${fmt(tr.meanElevation)}<small>${k('unit.m')}</small>`, esc(t('ov.heightRange', { min: fmt(tr.minElevation), max: fmt(tr.maxElevation) }))) +
        metric(k('ov.avgSlope'), `${fmt(tr.meanSlope, 1)}<small>°</small>`, esc(t('ov.grade', { pct: fmt(Math.tan((tr.meanSlope * Math.PI) / 180) * 100, 1) }))) +
        `<div class="metric wide"><div class="k">${k('ov.steepness')}</div><div class="slope-bar">${bars}</div><div class="slope-legend">${legend}</div></div>` +
        `<div class="metric wide"><div class="k">${k('ov.faces')}</div><div class="aspect-wrap">${compassSvg(tr.aspectDeg)}<div><div class="v">${esc(aspectName(tr.aspect))}</div><div class="sub">${esc(aspectSub)}</div></div></div></div>`;
    }
    el.innerHTML = `
      <div class="detail-head"><span class="swatch"></span><input class="name-input" id="nameInput" value="${esc(field.name)}" maxlength="60" aria-label="${k('ov.nameAria')}" /></div>
      <div class="metrics">
        ${window.FieldClimate ? window.FieldClimate.badgesHtml(selectedId) : ''}
        ${window.FieldAdvisor ? window.FieldAdvisor.html(selectedId, field) : ''}
        ${landHtml(selectedId, field)}
        ${metric(k('ov.area'), `${fmt(g.areaHa, g.areaHa < 10 ? 2 : 1)}<small>${k('unit.ha')}</small>`, esc(t('ov.acres', { v: fmt(g.areaHa * 2.47105, 1) })))}
        ${metric(k('ov.perimeter'), `${fmt(g.perimeterKm < 1 ? g.perimeterKm * 1000 : g.perimeterKm, g.perimeterKm < 1 ? 0 : 2)}<small>${k(g.perimeterKm < 1 ? 'unit.m' : 'unit.km')}</small>`)}
        ${metric(k('ov.location'), g.centroid ? `${fmt(g.centroid[1], 5)}; ${fmt(g.centroid[0], 5)}` : '–', k('ov.latlon'), true)}
        ${terrainHtml}
      </div>
      ${tr ? `<p class="note">${esc(t('ov.demNote', { samples: fmt(tr.samples), res: fmt(tr.resolutionM, 1) }))}</p>` : ''}
      <div class="detail-actions">
        <button class="btn-sm" id="zoomBtn" type="button">${k('ov.zoomTo')}</button>
        <button class="btn-sm" id="editShapeBtn" type="button">${k('ov.editShape')}</button>
        <button class="btn-sm danger" id="delFieldBtn" type="button">${k('ov.delete')}</button>
      </div>`;
    const input = $('nameInput');
    input.addEventListener('change', () => {
      const v = input.value.trim().slice(0, 60);
      if (!v) { input.value = field.name; return; }
      field.name = v;
      updateLabel(selectedId);
      save();
      renderList();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
    const id = selectedId;
    $('zoomBtn').addEventListener('click', () => zoomToField(id));
    $('editShapeBtn').addEventListener('click', startEdit);
    $('delFieldBtn').addEventListener('click', () => deleteField(id));
    if ($('trimBtn')) $('trimBtn').addEventListener('click', () => trimField(id));
    if ($('recheckBtn')) $('recheckBtn').addEventListener('click', () => runLandCheck(id));
  }

  function renderList() {
    const list = $('fieldList');
    $('fieldCount').textContent = String(fields.size);
    $('listTitle').hidden = fields.size === 0;
    $('deleteAllBtn').hidden = fields.size < 2;
    list.innerHTML = '';
    [...fields.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt)).forEach(([id, f]) => {
      const li = document.createElement('li');
      li.className = id === selectedId ? 'active' : '';
      li.dataset.id = id;
      li.innerHTML = `
        <button type="button" class="fl-select" title="${esc(t('list.selectTip'))}">
          <span class="swatch"></span><span class="fl-name">${esc(f.name)}</span>${landBadge(f.land, true)}
          <span class="fl-area">${f.geo ? fmt(f.geo.areaHa, 2) + ' ' + esc(t('unit.ha')) : ''}</span>
        </button>
        <button type="button" class="fl-act" data-act="rename" title="${esc(t('list.rename'))}" aria-label="${esc(t('list.renameAria', { name: f.name }))}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="fl-act danger" data-act="delete" title="${esc(t('list.delete'))}" aria-label="${esc(t('list.deleteAria', { name: f.name }))}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>`;
      li.querySelector('.fl-select').addEventListener('click', () => selectField(id));
      li.querySelector('[data-act="rename"]').addEventListener('click', (e) => { e.stopPropagation(); renameField(id); });
      li.querySelector('[data-act="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteField(id); });
      list.appendChild(li);
    });
  }

  function render() {
    // Stage 2: NASA data, timeline and risk badges follow the selected field
    if (window.FieldClimate) {
      const sel = selectedId && fields.get(selectedId);
      window.FieldClimate.setField(sel && sel.geo ? { id: selectedId, name: sel.name, centroid: sel.geo.centroid } : null);
    }
    if (window.FieldDisease) {
      const sel = selectedId && fields.get(selectedId);
      window.FieldDisease.setField(sel && sel.geo ? { id: selectedId, centroid: sel.geo.centroid } : null);
    }
    if (window.FieldWater) {
      const sel = selectedId && fields.get(selectedId);
      window.FieldWater.setField(sel && sel.geo ? { id: selectedId, feature: featureOf(selectedId), geo: sel.geo } : null);
    }
    renderDetail();
    renderList();
    $('deleteBtn').disabled = !selectedId;
    if ($('editBtn').classList.contains('active')) startEditHintOnly();
  }
  function startEditHintOnly() {
    hintBy(() => esc(t(selectedId ? 'hint.edit' : 'hint.pickToEdit')));
  }
  function drawBtnText(on) { $('drawBtn').querySelector('span').textContent = t(on ? 'tool.cancelDraw' : 'tool.draw'); }
  // Language switch: redraw every text this module wrote (fields, selection and map position stay)
  I18N.onChange(() => {
    drawBtnText(isDrawing());
    if (statusFn) status(statusFn);
    if (hintFn) hintBy(hintFn);
    labels.forEach((_, id) => updateLabel(id));
    render();
  });

  // ─── Toolbar & keys ────────────────────────────────────────────────────────
  function bindToolbar() {
    $('drawBtn').addEventListener('click', () => setDrawing(draw.getMode() !== 'polygon'));
    $('editBtn').addEventListener('click', () => {
      if ($('editBtn').classList.contains('active')) { $('editBtn').classList.remove('active'); hint(''); }
      else startEdit();
    });
    $('deleteBtn').addEventListener('click', () => deleteField(selectedId));
    $('deleteAllBtn').addEventListener('click', deleteAllFields);
    $('exportBtn').addEventListener('click', exportFields);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('keydown', (e) => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === 'Escape' && draw && draw.getMode() === 'polygon') setDrawing(false);
      else if (e.key === 'Escape' && $('editBtn').classList.contains('active')) { $('editBtn').classList.remove('active'); hint(''); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selectedId && !isDrawing() &&
               !document.querySelector('.modal-backdrop')) { e.preventDefault(); deleteField(selectedId); }
    });
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  bindViewControls();
  bindSearch();
  bindToolbar();
  render();
  $('brandBtn').addEventListener('click', myLocation); // logo re-centres on the user's location

  // Loading screen: hide once the map has rendered; never block longer than 15 s
  let loaderHidden = false;
  const hideLoader = () => {
    if (loaderHidden) return;
    loaderHidden = true;
    $('loader').classList.add('done');
    setTimeout(() => $('loader').remove(), 700);
  };
  map.once('load', hideLoader);
  map.once('style.load', () => setTimeout(hideLoader, 5000)); // slow horizon tiles shouldn't hold it
  setTimeout(hideLoader, 15000);

  // 'style.load' rather than 'load': at 60° pitch 'load' waits for every horizon tile,
  // which can take many seconds on slow connections. Drawing only needs the style.
  // Fold the map credits into their (i) button from the start (MapLibre folds them on the first drag),
  // so they never run into the toolbar
  map.once('style.load', () => map.fire('drag'));
  map.once('load', () => map.fire('drag'));
  map.once('style.load', () => {
    addHatch();
    // Slow lime pulse on field outlines (off when there are no fields, or with reduced motion)
    window.FSStyles.pulse(map, 'field-glow', { active: () => fields.size > 0 && $('lyrFields').checked });
    // 3D trees and crop rows (added before Terra Draw so field outlines stay on top)
    const plantOptions = {
      mobile: MOBILE,
      // field.crop ({ color, color2, height }) is reserved for the crop advisor in a later stage
      getFields: () => [...fields.entries()].map(([id, f]) => ({ id, feature: featureOf(id), terrain: f.terrain, crop: f.crop })),
    };
    window.FieldPlants.init(map, plantOptions);
    window.FieldTrees.init(map, plantOptions);
    window.FieldClimate.init(map, { rerender: () => render() }); // Stage 2: fire layer, timeline, risk badges
    window.FieldWater.init(map, { rerender: () => render() });
    window.FieldDisease.init({ rerender: () => render() }); // crop disease risk from the last 30 days of NASA POWER // nearest river/canal/lake for the crop advisor
    // Stage 3: crop advisor. Its top crop sets the colour and height of the field's 3D crop rows.
    window.FieldAdvisor.init({
      rerender: () => render(),
      getSelectedId: () => selectedId,
      setCrop: (id, crop) => {
        const f = fields.get(id);
        if (!f || (f.crop && f.crop.id === crop.id)) return;
        f.crop = crop;
        if (window.FieldPlants) window.FieldPlants.fieldsChanged();
      },
    });
    setupDraw();
    loadSaved();
    updateGlow();
    render();
    map.on('moveend', () => { if ($('lyrZones').checked || isDrawing()) refreshZones(); });
    map.on('mousemove', (e) => { if (isDrawing()) updateCursorTip(e); });
    map.getCanvas().addEventListener('mouseleave', () => { $('cursorTip').hidden = true; });
    if (fields.size) {
      // Returning user: open on their saved fields rather than the IP location
      const all = turf.featureCollection([...fields.keys()].map(featureOf).filter(Boolean));
      const b = turf.bbox(all);
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 120, maxZoom: 15, pitch: PITCH_3D, duration: 1500 });
      status(() => t('status.saved'));
    } else {
      startLocation();
    }
  });

  // Exposed for debugging in the console only
  window.fieldShift = { map, fields, landParts, get draw() { return draw; } };
})();
