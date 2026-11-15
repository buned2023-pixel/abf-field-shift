/*
 * 3D trees for Field Shift — GPU-instanced custom WebGL layer.
 *
 * Data: /data/trees.bin, built offline by "npm run build-trees" (no Overpass calls at runtime).
 *   32-byte header ('FSTR', version, count, bbox) then 12 bytes per tree:
 *   lon f32, lat f32, rank u16 (0–65535 = 0–1), type u8, height variation u8.
 *
 * Four tree types, each a small low-poly mesh drawn with one instanced draw call:
 *   0 poplar (tall narrow column, bright green)      1 juniper/archa (small dense cone, blue-green)
 *   2 pine/spruce (tall tiered cone, very dark)      3 broadleaf (round canopy, medium green)
 *
 * Zoom rule (uses the stable rank, so trees never jump): none below zoom 8, 50 % at zoom 8,
 * rising smoothly to 100 % at zoom 12. If more trees are in view than the quality budget allows,
 * the rank limit is lowered so the lowest-rank trees stay.
 * Each tree's ground height comes from MapLibre's terrain, so trees sit on the 3D surface.
 *
 * Numbers you can change: BUDGET, ZOOM_*, MIN_PX and TYPES below.
 */
(function () {
  'use strict';

  const BUDGET = { low: 6000, medium: 12000, high: 20000 }; // max trees drawn at once
  const ZOOM_MIN = 8;          // no trees below this zoom
  const ZOOM_FULL = 12;        // 100 % of trees from this zoom
  const START_FRACTION = 0.5;  // share of trees shown at ZOOM_MIN
  // Smallest on-screen tree height (pixels) by zoom: at low zoom trees are drawn larger than life
  // so a forest reads as a forest, not as dots. Above ~zoom 16 trees are real size.
  const MIN_PX = [[8, 6], [12, 8], [14, 7], [16, 5]];
  const TRUNK = [0.36, 0.25, 0.17];
  const TYPES = [
    { name: 'poplar', height: 18, color: [0.40, 0.70, 0.24], trunk: 0.014, profile: [[0.10, 0], [0.20, 0.065], [0.50, 0.085], [0.80, 0.06], [1, 0]] },
    { name: 'juniper', height: 5, color: [0.15, 0.36, 0.33], trunk: 0.03, profile: [[0.06, 0], [0.12, 0.30], [0.55, 0.19], [1, 0]] },
    { name: 'pine', height: 15, color: [0.07, 0.25, 0.14], trunk: 0.018, profile: [[0.16, 0], [0.20, 0.20], [0.50, 0.11], [0.52, 0.15], [0.78, 0.06], [1, 0]] },
    { name: 'broadleaf', height: 9, color: [0.24, 0.52, 0.20], trunk: 0.03, profile: [[0.28, 0], [0.42, 0.30], [0.62, 0.38], [0.82, 0.28], [1, 0]] },
  ];
  const CELL = 0.02; // spatial index cell, degrees
  const EARTH = 40075016.686;

  let map = null, opts = null, gl = null, program = null, loc = null, glFailed = false;
  let enabled = true, quality = 'medium';
  let data = null;               // { n, lon, lat, rank, type, hv, bbox, cols, rows, start, order }
  let origin = [0, 0];           // mercator origin of the data (keeps float32 instance coords precise)
  let refLngLat = null;          // elevation reference point for the current instance set
  const meshes = [];             // per type: { vao, vertexCount, instBuf, count, segs }
  let rebuildTimer = null, elevDirty = false, lastSet = null;
  // All WebGL work happens inside render(): MapLibre caches GL state (bound buffers, VAOs) and only
  // expects a custom layer to change it there. Touching GL elsewhere made the ground draw black.
  let needMeshes = true, pendingArrays = null, currentArrays = null;
  const stats = { total: 0, inView: 0, drawn: 0, fraction: 0, zoom: 0, ms: 0, loaded: false };

  const $ = (id) => document.getElementById(id);
  const rad = (d) => (d * Math.PI) / 180;
  const mercX = (lon) => (lon + 180) / 360;
  const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2)) / Math.PI) / 2;

  // Status text is kept as a function so a language switch can redraw it
  let statusFn = null;
  function setStatus(fn) { statusFn = typeof fn === 'function' ? fn : null; const el = $('plantStatus'); if (el) el.textContent = statusFn ? statusFn() : (fn || ''); }
  if (window.FSi18n) window.FSi18n.onChange(() => { if (statusFn) setStatus(statusFn); });
  const t = (k, v) => window.FSi18n.t(k, v);

  // ── Data ──
  async function loadData() {
    try {
      const res = await fetch('/data/trees.bin');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer(), dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x52545346) throw new Error('bad file'); // 'FSTR'
      const n = dv.getUint32(8, true);
      const bbox = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
      const lon = new Float32Array(n), lat = new Float32Array(n), rank = new Uint16Array(n), type = new Uint8Array(n), hv = new Uint8Array(n);
      for (let i = 0, o = 32; i < n; i++, o += 12) {
        lon[i] = dv.getFloat32(o, true); lat[i] = dv.getFloat32(o + 4, true);
        rank[i] = dv.getUint16(o + 8, true); type[i] = dv.getUint8(o + 10) & 3; hv[i] = dv.getUint8(o + 11);
      }
      // Grid index (counting sort): trees of each cell are contiguous in "order"
      const cols = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / CELL)), rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / CELL));
      const cellOf = new Int32Array(n), start = new Int32Array(cols * rows + 1);
      for (let i = 0; i < n; i++) {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((lon[i] - bbox[0]) / CELL))), cy = Math.min(rows - 1, Math.max(0, Math.floor((lat[i] - bbox[1]) / CELL)));
        cellOf[i] = cy * cols + cx; start[cellOf[i] + 1]++;
      }
      for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
      const fill = start.slice(0, cols * rows), order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;
      data = { n, lon, lat, rank, type, hv, bbox, cols, rows, start, order };
      origin = [mercX((bbox[0] + bbox[2]) / 2), mercY((bbox[1] + bbox[3]) / 2)];
      stats.total = n; stats.loaded = true;
    } catch (err) {
      data = null; stats.loaded = false;
      setStatus(() => t('trees.noData'));
    }
  }

  // ── Meshes ──
  function buildMesh(t, segs) {
    const v = []; // x, y, z, nx, ny, nz, trunkFlag  (x, y as a fraction of tree height; z from 0 to 1)
    const tri = (a, b, c) => { v.push(...a, ...b, ...c); };
    const p = t.profile;
    for (let i = 0; i < p.length - 1; i++) {
      const z0 = p[i][0], r0 = p[i][1], z1 = p[i + 1][0], r1 = p[i + 1][1];
      const nz = (r0 - r1) / Math.max(0.001, z1 - z0); // outward normal tilts up where the canopy narrows
      for (let s = 0; s < segs; s++) {
        const a0 = (2 * Math.PI * s) / segs, a1 = (2 * Math.PI * (s + 1)) / segs, am = (a0 + a1) / 2;
        const len = Math.hypot(1, nz), n = [Math.cos(am) / len, Math.sin(am) / len, nz / len, 0];
        const A = [r0 * Math.cos(a0), r0 * Math.sin(a0), z0, ...n], B = [r0 * Math.cos(a1), r0 * Math.sin(a1), z0, ...n];
        const C = [r1 * Math.cos(a1), r1 * Math.sin(a1), z1, ...n], D = [r1 * Math.cos(a0), r1 * Math.sin(a0), z1, ...n];
        if (r0 > 0) tri(A, B, C);
        if (r1 > 0) tri(A, C, D);
      }
    }
    const top = p[0][0] + 0.06, r = t.trunk; // trunk: a thin 4-sided post up into the canopy
    for (let s = 0; s < 4; s++) {
      const a0 = (Math.PI / 2) * s, a1 = (Math.PI / 2) * (s + 1), am = (a0 + a1) / 2, n = [Math.cos(am), Math.sin(am), 0, 1];
      const A = [r * Math.cos(a0), r * Math.sin(a0), 0, ...n], B = [r * Math.cos(a1), r * Math.sin(a1), 0, ...n];
      const C = [r * Math.cos(a1), r * Math.sin(a1), top, ...n], D = [r * Math.cos(a0), r * Math.sin(a0), top, ...n];
      tri(A, B, C); tri(A, C, D);
    }
    return new Float32Array(v);
  }

  const VS = `#version 300 es
    uniform mat4 uMatrix; uniform float uMpm; uniform float uScale; uniform float uRefElev; uniform vec3 uSun;
    in vec3 aPos; in vec3 aNor; in float aTrunk;
    in vec4 iA;   // x, y (mercator, relative to origin), ground elevation (m, relative to reference), height (m)
    in vec4 iB;   // r, g, b, rotation
    out vec3 vCol;
    void main() {
      float c = cos(iB.w), s = sin(iB.w);
      vec2 xy = vec2(aPos.x * c - aPos.y * s, aPos.x * s + aPos.y * c);
      vec3 n = normalize(vec3(aNor.x * c - aNor.y * s, aNor.x * s + aNor.y * c, aNor.z));
      float H = iA.w * uScale;
      vec3 w = vec3(iA.x + xy.x * H * uMpm, iA.y - xy.y * H * uMpm, (iA.z + uRefElev + aPos.z * H) * uMpm);
      gl_Position = uMatrix * vec4(w, 1.0);
      float light = 0.60 + 0.40 * max(dot(n, uSun), 0.0);   // low afternoon sun
      float grad = 0.70 + 0.42 * aPos.z;                    // darker near the ground
      vCol = mix(iB.rgb, vec3(${TRUNK.join(', ')}), aTrunk) * light * grad;
    }`;
  const FS = `#version 300 es
    precision mediump float;
    in vec3 vCol; out vec4 outColor;
    void main() { outColor = vec4(vCol, 1.0); }`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function setupGl() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    loc = {
      aPos: gl.getAttribLocation(program, 'aPos'), aNor: gl.getAttribLocation(program, 'aNor'), aTrunk: gl.getAttribLocation(program, 'aTrunk'),
      iA: gl.getAttribLocation(program, 'iA'), iB: gl.getAttribLocation(program, 'iB'),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'), uMpm: gl.getUniformLocation(program, 'uMpm'), uScale: gl.getUniformLocation(program, 'uScale'),
      uRefElev: gl.getUniformLocation(program, 'uRefElev'), uSun: gl.getUniformLocation(program, 'uSun'),
    };
  }

  function buildMeshes() {
    meshes.forEach((m) => { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.instBuf); });
    meshes.length = 0;
    const segs = quality === 'low' ? 5 : 6;
    TYPES.forEach((t) => {
      const verts = buildMesh(t, segs);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(loc.aNor); gl.vertexAttribPointer(loc.aNor, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(loc.aTrunk); gl.vertexAttribPointer(loc.aTrunk, 1, gl.FLOAT, false, 28, 24);
      const instBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.enableVertexAttribArray(loc.iA); gl.vertexAttribPointer(loc.iA, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(loc.iA, 1);
      gl.enableVertexAttribArray(loc.iB); gl.vertexAttribPointer(loc.iB, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(loc.iB, 1);
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      meshes.push({ vao, vbo, instBuf, vertexCount: verts.length / 7, count: 0 });
    });
    needMeshes = false;
    if (currentArrays) pendingArrays = currentArrays; // new buffers need the instances again
  }

  // Called from render(): send prepared instance data to the GPU
  function uploadPending() {
    meshes.forEach((m, ti) => {
      const arr = pendingArrays[ti];
      gl.bindBuffer(gl.ARRAY_BUFFER, m.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      m.count = arr.length / 8;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    currentArrays = pendingArrays;
    pendingArrays = null;
  }

  // ── Which trees to draw ──
  function fractionForZoom(z) {
    if (z < ZOOM_MIN) return 0;
    if (z >= ZOOM_FULL) return 1;
    return START_FRACTION + (1 - START_FRACTION) * ((z - ZOOM_MIN) / (ZOOM_FULL - ZOOM_MIN));
  }

  function collect() {
    const z = map.getZoom(), b = map.getBounds();
    const d = data, bb = d.bbox;
    const w = Math.max(bb[0], b.getWest()), e = Math.min(bb[2], b.getEast()), s = Math.max(bb[1], b.getSouth()), n = Math.min(bb[3], b.getNorth());
    const frac = fractionForZoom(z);
    stats.zoom = z; stats.fraction = frac; stats.inView = 0;
    if (frac === 0 || w >= e || s >= n) return [];
    let limit = Math.round(frac * 65536);
    const cx0 = Math.max(0, Math.floor((w - bb[0]) / CELL)), cx1 = Math.min(d.cols - 1, Math.floor((e - bb[0]) / CELL));
    const cy0 = Math.max(0, Math.floor((s - bb[1]) / CELL)), cy1 = Math.min(d.rows - 1, Math.floor((n - bb[1]) / CELL));
    // Pass 1: how many trees are in view, by rank (256 bins)
    const hist = new Uint32Array(256);
    let inView = 0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * d.cols + cx;
      for (let k = d.start[c]; k < d.start[c + 1]; k++) {
        const i = d.order[k];
        if (d.lon[i] < w || d.lon[i] > e || d.lat[i] < s || d.lat[i] > n) continue;
        inView++;
        if (d.rank[i] < limit) hist[d.rank[i] >> 8]++;
      }
    }
    stats.inView = inView;
    // Over budget? Lower the rank limit so only the lowest-rank trees stay
    const budget = BUDGET[quality];
    let acc = 0;
    for (let bin = 0; bin < 256; bin++) {
      if (acc + hist[bin] > budget) { limit = Math.min(limit, bin << 8); break; }
      acc += hist[bin];
    }
    // Pass 2: gather, skipping trees inside the user's fields
    const fields = (opts.getFields() || []).filter((f) => f.feature).map((f) => {
      const ring = f.feature.geometry.coordinates[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ring.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      return { ring, x0, y0, x1, y1 };
    });
    const inField = (x, y) => {
      for (const f of fields) {
        if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) continue;
        let inside = false;
        for (let i = 0, j = f.ring.length - 1; i < f.ring.length; j = i++) {
          const xi = f.ring[i][0], yi = f.ring[i][1], xj = f.ring[j][0], yj = f.ring[j][1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return true;
      }
      return false;
    };
    const out = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * d.cols + cx;
      for (let k = d.start[c]; k < d.start[c + 1]; k++) {
        const i = d.order[k];
        if (d.rank[i] >= limit || d.lon[i] < w || d.lon[i] > e || d.lat[i] < s || d.lat[i] > n) continue;
        if (fields.length && inField(d.lon[i], d.lat[i])) continue;
        out.push(i);
      }
    }
    return out;
  }

  // Build the per-type instance buffers for the current view
  function rebuild() {
    if (!gl) return;
    const t0 = performance.now();
    if (!enabled || !data) { pendingArrays = TYPES.map(() => new Float32Array(0)); stats.drawn = 0; lastSet = null; map.triggerRepaint(); if (data && !enabled) setStatus(''); return; }
    const list = collect();
    lastSet = list;
    const c = map.getCenter();
    refLngLat = [c.lng, c.lat];
    const refElev = map.queryTerrainElevation(refLngLat) || 0;
    const per = TYPES.map(() => []);
    const d = data;
    for (const i of list) {
      const ground = map.queryTerrainElevation([d.lon[i], d.lat[i]]);
      const t = TYPES[d.type[i]];
      const h = t.height * (0.75 + 0.5 * (d.hv[i] / 255));          // ±25 % height
      const v = ((d.rank[i] & 255) / 255 - 0.5) * 0.22;              // small colour variation
      const w = (((d.rank[i] * 7919) & 255) / 255 - 0.5) * 0.08;
      per[d.type[i]].push(
        mercX(d.lon[i]) - origin[0], mercY(d.lat[i]) - origin[1], (ground == null ? refElev : ground) - refElev, h,
        t.color[0] * (1 + v) + w, t.color[1] * (1 + v), t.color[2] * (1 + v) - w * 0.5, ((i * 2654435761) >>> 0) / 4294967296 * 6.283
      );
    }
    pendingArrays = per.map((a) => new Float32Array(a)); // uploaded on the next render()
    elevDirty = false;
    stats.drawn = list.length; stats.ms = Math.round(performance.now() - t0);
    stats.byType = per.map((a) => a.length / 8);
    const pct = Math.round(stats.fraction * 100);
    const shown = list.length, inView = stats.inView;
    setStatus(map.getZoom() < ZOOM_MIN ? () => t('trees.zoomIn')
      : () => t('trees.shown', { shown: window.FSi18n.fmt(shown), inView: window.FSi18n.fmt(inView), pct: window.FSi18n.fmt(pct) }));
    map.triggerRepaint();
  }
  function scheduleRebuild(delay) { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, delay == null ? 150 : delay); }

  // ── Custom layer ──
  const layer = {
    id: 'trees-3d', type: 'custom', renderingMode: '3d',
    onAdd(m, context) {
      gl = context;
    },
    render(context, args) {
      if (glFailed) return;
      if (!program) {
        try { setupGl(); } catch (err) { console.warn('[trees] WebGL setup failed', err); glFailed = true; program = null; setStatus(() => t('trees.noGl')); return; }
      }
      if (needMeshes) buildMeshes();
      if (pendingArrays) uploadPending();
      if (!enabled || !stats.drawn) return;
      const M = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix) || (args && args.modelViewProjectionMatrix) || args;
      if (!M || M.length !== 16) return;
      // Move the matrix to the data origin in double precision, so float32 instance coords stay exact
      const T = new Float32Array(16);
      for (let k = 0; k < 16; k++) T[k] = M[k];
      for (let r = 0; r < 4; r++) T[12 + r] = M[r] * origin[0] + M[4 + r] * origin[1] + M[12 + r];
      const lat = map.getCenter().lat, zoom = map.getZoom();
      const mpp = (EARTH * Math.cos(rad(lat))) / (512 * Math.pow(2, zoom)); // metres per pixel
      let minPx = MIN_PX[MIN_PX.length - 1][1];
      for (let k = 0; k < MIN_PX.length; k++) {
        if (zoom <= MIN_PX[k][0]) { if (k === 0) minPx = MIN_PX[0][1]; else { const a = MIN_PX[k - 1], b = MIN_PX[k]; minPx = a[1] + ((b[1] - a[1]) * (zoom - a[0])) / (b[0] - a[0]); } break; }
      }
      const scale = Math.max(1, (minPx * mpp) / 10); // 10 m = typical tree height
      const refElev = (refLngLat && map.queryTerrainElevation(refLngLat)) || 0;

      gl.useProgram(program);
      gl.uniformMatrix4fv(loc.uMatrix, false, T);
      gl.uniform1f(loc.uMpm, 1 / (EARTH * Math.cos(rad(lat))));
      gl.uniform1f(loc.uScale, scale);
      gl.uniform1f(loc.uRefElev, refElev);
      gl.uniform3f(loc.uSun, -0.87, -0.32, 0.37); // from the west-south-west, low in the sky
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      for (const m of meshes) {
        if (!m.count) continue;
        gl.bindVertexArray(m.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, m.vertexCount, m.count);
      }
      gl.bindVertexArray(null);
    },
  };

  function setQuality(q) {
    if (!BUDGET[q]) return;
    quality = q;
    document.querySelectorAll('#plantQuality button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
    needMeshes = true; // rebuilt on the next render()
    if (window.FieldPlants) window.FieldPlants.setQuality(q);
    rebuild();
  }

  async function init(m, options) {
    map = m; opts = options;
    quality = options.mobile ? 'low' : 'medium';
    map.addLayer(layer);
    const toggle = $('lyrTrees');
    if (toggle) {
      enabled = toggle.checked;
      toggle.addEventListener('change', () => { enabled = toggle.checked; rebuild(); });
    }
    document.querySelectorAll('#plantQuality button').forEach((b) => {
      b.classList.toggle('on', b.dataset.q === quality);
      b.addEventListener('click', () => setQuality(b.dataset.q));
    });
    await loadData();
    map.on('moveend', () => scheduleRebuild());
    // Terrain tiles arriving, or terrain being switched / re-exaggerated, changes ground heights
    map.on('sourcedata', (e) => { if (e.sourceId === 'terrainDem') elevDirty = true; });
    map.on('idle', () => { if (elevDirty && lastSet) rebuild(); });
    map.on('terrain', () => scheduleRebuild(50));
    rebuild();
  }

  function fieldsChanged() { if (map && data) scheduleRebuild(500); }

  window.FieldTrees = { init, rebuild, fieldsChanged, setQuality, stats, BUDGET, TYPES };
})();
