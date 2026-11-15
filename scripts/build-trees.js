/*
 * npm run build-trees
 *
 * Builds public/data/trees.bin: a static file of tree positions around Dushanbe (Varzob, Vahdat,
 * Hissar) that the 3D map loads directly, so the app never calls Overpass for trees at runtime.
 *
 *  1. Fetch forest / wood / scrub / orchard / vineyard polygons and tree rows from OpenStreetMap,
 *     plus the roads, waterways, water and buildings touching them, in small chunks.
 *     Limits: 2 mirrors, 20 s per request, 3 retries in total, a pause between chunks, and a
 *     100 s overall time limit. Each fetched chunk is saved in data/trees-cache, so running the
 *     command again continues where it stopped. Failed chunks are skipped and reported.
 *  2. Scatter tree points inside the polygons with a seeded random generator (same result every run).
 *  3. Give every tree a stable rank (0–1), a type (poplar, juniper, pine, broadleaf) chosen from
 *     land class + elevation, and a height variation. Write a 12-byte record per tree.
 *
 * Numbers you can change are in CONFIG below.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const querystring = require('querystring');
const { toFeature } = require('../lib/overpass');

const CONFIG = {
  bbox: [68.40, 38.40, 69.15, 38.95],        // west, south, east, north
  chunk: [0.15, 0.11],                        // chunk size in degrees (lon, lat)
  mirrors: ['https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass-api.de/api/interpreter'],
  requestTimeoutMs: 20000,
  totalRetries: 3,
  delayMs: 1200,
  deadlineMs: 100000,                         // whole run stays under 2 minutes
  maxTrees: 500000,
  // metres between trees, per land class
  spacing: { forest: 14, wood: 14, scrub: 30, orchard: 9, vineyard: 40, tree_row: 7 },
  demZoom: 9,
};
const TYPE = { poplar: 0, juniper: 1, pine: 2, broadleaf: 3 };
const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'trees-cache');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const M_LAT = 110540;
const started = Date.now();
const timeLeft = () => CONFIG.deadlineMs - (Date.now() - started);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Seeded random ──
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── HTTP with timeouts ──
function request(url, { method = 'GET', body = null, binary = false, timeout = CONFIG.requestTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'FieldShift/1.0 (tree build script)' };
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const buf = Buffer.concat(chunks);
        resolve(binary ? buf : buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end(body || undefined);
  });
}

// Three small queries per chunk (asking Overpass for "everything near vegetation" in one go times out):
//   veg   – the vegetation itself
//   avoid – roads, waterways and water (only for chunks that have vegetation)
//   bld   – building centres (only for chunks with orchards, vineyards or tree rows)
function query(kind, [w, s, e, n]) {
  const b = `(${s},${w},${n},${e})`;
  if (kind === 'veg') {
    return `[out:json][timeout:20];(way["landuse"~"^(forest|orchard|vineyard)$"]${b};relation["landuse"~"^(forest|orchard|vineyard)$"]${b};` +
      `way["natural"~"^(wood|scrub|tree_row)$"]${b};relation["natural"~"^(wood|scrub)$"]${b};);out geom;`;
  }
  if (kind === 'avoid') {
    return `[out:json][timeout:20];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]${b};` +
      `way["waterway"~"^(river|canal|stream|drain|ditch)$"]${b};way["natural"="water"]${b};relation["natural"="water"]${b};);out geom;`;
  }
  return `[out:json][timeout:20];way["building"]${b};out center;`;
}

async function fetchChunk(kind, bbox) {
  const body = querystring.stringify({ data: query(kind, bbox) });
  const errors = [];
  for (const mirror of CONFIG.mirrors) {
    if (timeLeft() < 3000) throw new Error('time limit');
    try {
      const text = await request(mirror, { method: 'POST', body, timeout: Math.min(CONFIG.requestTimeoutMs, timeLeft()) });
      const data = JSON.parse(text);
      if (data.remark && /error|timed out/i.test(data.remark)) throw new Error('server: ' + data.remark.slice(0, 60));
      return data.elements || [];
    } catch (err) { errors.push(`${new URL(mirror).hostname}: ${err.message}`); }
  }
  throw new Error(errors.join(' | '));
}

// ── Minimal PNG decoder (8-bit RGB / RGBA, non-interlaced) for Terrarium elevation tiles ──
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], rowIn = y * (stride + 1) + 1, rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[rowOut + x - bpp] : 0, b = y ? out[rowOut - stride + x] : 0, c = x >= bpp && y ? out[rowOut - stride + x - bpp] : 0;
      let v = raw[rowIn + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[rowOut + x] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

// Elevation lookup from a few zoom-9 Terrarium tiles (~120 m pixels: enough to pick a tree type)
async function loadDem() {
  const z = CONFIG.demZoom, n = 2 ** z, tiles = new Map();
  const tx = (lon) => ((lon + 180) / 360) * n;
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
  const [w, s, e, nn] = CONFIG.bbox;
  for (let x = Math.floor(tx(w)); x <= Math.floor(tx(e)); x++) {
    for (let y = Math.floor(ty(nn)); y <= Math.floor(ty(s)); y++) {
      const file = path.join(ROOT, 'data', 'tile-cache', 'terrarium', String(z), String(x), `${y}.png`);
      try {
        let buf;
        if (fs.existsSync(file)) buf = fs.readFileSync(file);
        else {
          buf = await request(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { binary: true, timeout: Math.min(20000, Math.max(1000, timeLeft())) });
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
        }
        tiles.set(`${x}/${y}`, decodePng(buf));
      } catch (err) { console.log(`  elevation tile ${z}/${x}/${y} unavailable (${err.message})`); }
    }
  }
  return (lon, lat) => {
    const fx = tx(lon), fy = ty(lat), t = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!t) return null;
    const px = Math.min(t.width - 1, Math.floor((fx % 1) * t.width)), py = Math.min(t.height - 1, Math.floor((fy % 1) * t.height));
    const i = (py * t.width + px) * t.bpp;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
}

// ── Geometry helpers (planar, in metres around a local origin) ──
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Type from land class + elevation (m). Tajik pattern: poplars and broadleaf in the lowlands,
// juniper (archa) on dry mountain slopes, pine/spruce in the higher forests.
function pickType(cls, elev, r) {
  if (cls === 'tree_row') return TYPE.poplar;
  if (cls === 'orchard' || cls === 'vineyard') return r < 0.1 ? TYPE.poplar : TYPE.broadleaf;
  const e = elev == null ? 1200 : elev;
  if (cls === 'scrub') return e > 1100 ? TYPE.juniper : (r < 0.6 ? TYPE.broadleaf : TYPE.juniper);
  if (e < 1300) return r < 0.7 ? TYPE.broadleaf : TYPE.poplar;
  if (e < 2000) return r < 0.4 ? TYPE.broadleaf : r < 0.75 ? TYPE.juniper : TYPE.pine;
  return r < 0.55 ? TYPE.pine : TYPE.juniper;
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const [W, S, E, N] = CONFIG.bbox;
  const chunks = [];
  for (let x = W; x < E - 1e-9; x += CONFIG.chunk[0]) for (let y = S; y < N - 1e-9; y += CONFIG.chunk[1]) {
    chunks.push([+x.toFixed(4), +y.toFixed(4), +Math.min(E, x + CONFIG.chunk[0]).toFixed(4), +Math.min(N, y + CONFIG.chunk[1]).toFixed(4)]);
  }

  // 1. Fetch (every result is cached, so a second run continues instead of starting over)
  let retriesLeft = CONFIG.totalRetries, fetched = 0;
  const failed = [], notReached = [];
  const elements = new Map(), buildingPts = [];
  const got = { veg: new Set(), avoid: new Set(), bld: new Set() };
  const needsBld = new Set();
  async function load(kind, i) {
    const file = path.join(CACHE_DIR, `${kind}-${chunks[i].join('_')}.json`);
    let els = null;
    if (fs.existsSync(file)) els = JSON.parse(fs.readFileSync(file, 'utf8'));
    else if (timeLeft() < 8000) { notReached.push(`${kind} ${i + 1}`); return null; }
    else {
      for (let attempt = 0; attempt < 2 && !els; attempt++) {
        try { els = await fetchChunk(kind, chunks[i]); fs.writeFileSync(file, JSON.stringify(els)); fetched++; }
        catch (err) {
          if (attempt === 0 && retriesLeft > 0 && timeLeft() > 45000) { retriesLeft--; console.log(`  ${kind} chunk ${i + 1} failed (${err.message}); retrying (${retriesLeft} retries left)`); await sleep(CONFIG.delayMs); }
          else { failed.push(`${kind} chunk ${i + 1} [${chunks[i].join(', ')}]: ${err.message}`); break; }
        }
      }
      await sleep(CONFIG.delayMs);
    }
    if (els) { got[kind].add(i); console.log(`  ${kind} chunk ${i + 1}/${chunks.length}: ${els.length} elements`); }
    return els;
  }
  for (let i = 0; i < chunks.length; i++) {
    const els = await load('veg', i);
    if (!els) continue;
    els.forEach((el) => {
      elements.set(`${el.type}/${el.id}`, el);
      const t = el.tags || {};
      if (t.landuse === 'orchard' || t.landuse === 'vineyard' || t.natural === 'tree_row') needsBld.add(i);
    });
    if (!els.length) { got.avoid.add(i); got.bld.add(i); } // nothing to protect in an empty chunk
  }
  for (let i = 0; i < chunks.length; i++) {
    if (!got.veg.has(i) || got.avoid.has(i)) continue;
    const els = await load('avoid', i);
    if (els) els.forEach((el) => elements.set(`${el.type}/${el.id}`, el));
  }
  for (let i = 0; i < chunks.length; i++) {
    if (!got.veg.has(i) || got.bld.has(i)) continue;
    if (!needsBld.has(i)) { got.bld.add(i); continue; }
    const els = await load('bld', i);
    if (els) els.forEach((el) => { if (el.center) buildingPts.push([el.center.lon, el.center.lat]); });
  }
  const chunkOf = (lon, lat) => chunks.findIndex((c) => lon >= c[0] && lon < c[2] && lat >= c[1] && lat < c[3]);

  // 2. Convert and index
  const veg = [], lines = [], areas = [];
  elements.forEach((el) => {
    const f = toFeature(el);
    if (!f) return;
    const p = f.properties;
    if (['forest', 'wood', 'scrub', 'orchard', 'vineyard', 'tree_row'].includes(p.cls)) veg.push(f);
    else if (p.blocked && p.kind === 'line') lines.push(f);
    else if (p.blocked) areas.push(f);
  });
  const elevAt = await loadDem();
  const lat0 = (S + N) / 2, kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const X = (lon) => (lon - W) * kx, Y = (lat) => (lat - S) * M_LAT;
  // Spatial hash (60 m cells) of things trees must avoid
  const CELL = 60, grid = new Map();
  const put = (cx, cy, item) => { const k = cx + ',' + cy; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(item); };
  lines.forEach((f) => {
    const half = f.properties.width / 2 + 2, c = f.geometry.coordinates;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = X(c[i][0]), ay = Y(c[i][1]), bx = X(c[i + 1][0]), by = Y(c[i + 1][1]);
      const item = { seg: [ax, ay, bx, by], half };
      for (let cx = Math.floor((Math.min(ax, bx) - half) / CELL); cx <= Math.floor((Math.max(ax, bx) + half) / CELL); cx++)
        for (let cy = Math.floor((Math.min(ay, by) - half) / CELL); cy <= Math.floor((Math.max(ay, by) + half) / CELL); cy++) put(cx, cy, item);
    }
  });
  areas.forEach((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    polys.forEach((poly) => {
      const rings = poly.map((r) => r.map((c) => [X(c[0]), Y(c[1])]));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      rings[0].forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      const item = { rings };
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) put(cx, cy, item);
    });
  });
  buildingPts.forEach(([lon, lat]) => { // buildings come as centre points: keep trees 9 m away
    const x = X(lon), y = Y(lat), item = { pt: [x, y], rad: 9 };
    for (let cx = Math.floor((x - 9) / CELL); cx <= Math.floor((x + 9) / CELL); cx++) for (let cy = Math.floor((y - 9) / CELL); cy <= Math.floor((y + 9) / CELL); cy++) put(cx, cy, item);
  });
  const blockedAt = (x, y) => {
    const a = grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL));
    if (!a) return false;
    for (const it of a) {
      if (it.pt) { if (Math.hypot(x - it.pt[0], y - it.pt[1]) < it.rad) return true; }
      else if (it.seg) { if (distToSeg(x, y, it.seg[0], it.seg[1], it.seg[2], it.seg[3]) < it.half) return true; }
      else if (inPoly(x, y, it.rings)) return true;
    }
    return false;
  };

  // 3. Scatter
  const pending = new Set(); // chunks with vegetation whose roads/water/buildings are not fetched yet
  const trees = []; // [lon, lat, rank, type, heightVar]
  const byClass = {};
  const add = (x, y, cls, r) => {
    if (blockedAt(x, y)) return;
    const lon = W + x / kx, lat = S + y / M_LAT;
    if (lon < W || lon > E || lat < S || lat > N) return;
    // Only place trees where the roads/water (and, if needed, buildings) for that chunk are known
    const ci = chunkOf(lon, lat);
    if (ci < 0 || !got.avoid.has(ci) || !got.bld.has(ci)) { pending.add(ci); return; }
    trees.push([lon, lat, r(), pickType(cls, elevAt(lon, lat), r()), r()]);
    byClass[cls] = (byClass[cls] || 0) + 1;
  };
  veg.forEach((f) => {
    const cls = f.properties.cls, sp = CONFIG.spacing[cls], r = rng(hashStr(f.properties.osm));
    if (f.geometry.type === 'LineString') { // tree row: one tree every few metres along the line
      const c = f.geometry.coordinates.map((p) => [X(p[0]), Y(p[1])]);
      let carry = sp * r();
      for (let i = 0; i < c.length - 1; i++) {
        const len = Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
        for (let d = carry; d < len; d += sp) add(c[i][0] + ((c[i + 1][0] - c[i][0]) * d) / len, c[i][1] + ((c[i + 1][1] - c[i][1]) * d) / len, cls, r);
        carry = (carry - len) % sp; if (carry < 0) carry += sp;
      }
      return;
    }
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const jitter = cls === 'orchard' ? 0.25 : 0.9; // orchards are planted in regular rows
    polys.forEach((poly) => {
      const rings = poly.map((ring) => ring.map((c) => [X(c[0]), Y(c[1])]));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      rings[0].forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      for (let gx = Math.floor(x0 / sp); gx <= Math.ceil(x1 / sp); gx++) for (let gy = Math.floor(y0 / sp); gy <= Math.ceil(y1 / sp); gy++) {
        const x = (gx + 0.5 + (r() - 0.5) * jitter) * sp, y = (gy + 0.5 + (r() - 0.5) * jitter) * sp;
        if (inPoly(x, y, rings)) add(x, y, cls, r);
      }
    });
  });

  // Too many? Thin evenly by rank and re-spread the ranks over 0–1
  let list = trees;
  if (list.length > CONFIG.maxTrees) {
    const keep = CONFIG.maxTrees / list.length;
    list = list.filter((t) => t[2] < keep);
    list.forEach((t) => { t[2] /= keep; });
  }

  // 4. Write: 32-byte header, then 12 bytes per tree (lon f32, lat f32, rank u16, type u8, height u8)
  const out = Buffer.alloc(32 + list.length * 12);
  out.write('FSTR', 0, 'ascii'); out.writeUInt32LE(1, 4); out.writeUInt32LE(list.length, 8);
  [W, S, E, N].forEach((v, i) => out.writeFloatLE(v, 12 + i * 4));
  const byType = [0, 0, 0, 0];
  list.forEach((t, i) => {
    const o = 32 + i * 12;
    out.writeFloatLE(t[0], o); out.writeFloatLE(t[1], o + 4);
    out.writeUInt16LE(Math.min(65535, Math.floor(t[2] * 65536)), o + 8);
    out.writeUInt8(t[3], o + 10); out.writeUInt8(Math.min(255, Math.floor(t[4] * 256)), o + 11);
    byType[t[3]]++;
  });
  fs.writeFileSync(path.join(OUT_DIR, 'trees.bin'), out);
  const complete = got.veg.size === chunks.length && !pending.size;
  const meta = {
    builtAt: new Date().toISOString(), count: list.length, bbox: CONFIG.bbox, complete,
    chunks: { total: chunks.length, vegetationLoaded: got.veg.size, waitingForRoadsWaterBuildings: pending.size, failedRequests: failed.length, notReached: notReached.length },
    byType: { poplar: byType[0], juniper: byType[1], pine: byType[2], broadleaf: byType[3] }, byLandClass: byClass,
    source: 'OpenStreetMap contributors (ODbL), via Overpass',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'trees.json'), JSON.stringify(meta, null, 2));

  console.log(`\nTrees: ${list.length} (${(out.length / 1e6).toFixed(2)} MB) → public/data/trees.bin`);
  console.log(`  by type: poplar ${byType[0]}, juniper ${byType[1]}, pine ${byType[2]}, broadleaf ${byType[3]}`);
  console.log(`  by land class: ${JSON.stringify(byClass)}`);
  console.log(`  vegetation areas: ${veg.length}; avoided: ${lines.length} road/water lines, ${areas.length} water shapes, ${buildingPts.length} buildings`);
  console.log(`  chunks: vegetation ${got.veg.size}/${chunks.length}, ${pending.size} chunk(s) still waiting for roads/water/buildings (no trees there yet); ${fetched} requests made now`);
  failed.forEach((f) => console.log(`  SKIPPED ${f}`));
  if (!complete) console.log(`  Not complete yet (${notReached.length} request(s) not reached in the time limit). Run "npm run build-trees" again to continue.`);
  else console.log('  Complete: every chunk is loaded.');
  console.log(`  done in ${Math.round((Date.now() - started) / 1000)} s`);
}

main().catch((err) => { console.error('build-trees failed:', err.message); process.exit(1); });
