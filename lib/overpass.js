/*
 * OpenStreetMap land-use lookup via the Overpass API.
 * Returns "blocked" land (water, settlements, buildings, roads, airports) and
 * "allowed" land (farmland, orchards, meadows, scrub…) as GeoJSON for a bbox.
 */
const https = require('https');
const querystring = require('querystring');

// Main server first, then two mirrors as fallback
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const TIMEOUT_MS = 10000;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 400;
const cache = new Map();
const inflight = new Map();

// Road widths in metres (lines are buffered by half of this on the client)
const ROAD_WIDTH = {
  motorway: 24, trunk: 20, primary: 14, secondary: 11, tertiary: 9,
  motorway_link: 10, trunk_link: 10, primary_link: 9, secondary_link: 8, tertiary_link: 8,
  unclassified: 7, residential: 7, living_street: 6, service: 5,
};
const RIVER_WIDTH = { river: 25, canal: 10 };

function classify(tags) {
  const t = tags || {};
  if (t.waterway === 'riverbank' || (t.natural === 'water' && t.water === 'river')) return { cls: 'river', blocked: true };
  if (t.waterway && RIVER_WIDTH[t.waterway]) return { cls: t.waterway === 'canal' ? 'canal' : 'river', blocked: true, width: RIVER_WIDTH[t.waterway] };
  if (t.landuse === 'reservoir' || t.landuse === 'basin' || t.natural === 'water') return { cls: 'water', blocked: true };
  if (t.natural === 'wetland') return { cls: 'wetland', blocked: true };
  if (t.landuse === 'residential') return { cls: 'settlement', blocked: true };
  if (['commercial', 'industrial', 'retail'].includes(t.landuse)) return { cls: 'built', blocked: true };
  if (t.landuse === 'cemetery') return { cls: 'cemetery', blocked: true };
  if (t.aeroway) return { cls: 'airport', blocked: true };
  if (t.building) return { cls: 'building', blocked: true };
  if (t['area:highway'] || (t.highway && t.area === 'yes')) return { cls: 'road', blocked: true };
  if (t.highway && ROAD_WIDTH[t.highway]) return { cls: 'road', blocked: true, width: ROAD_WIDTH[t.highway] };
  if (['farmland', 'farmyard', 'orchard', 'vineyard', 'meadow', 'grass'].includes(t.landuse)) return { cls: t.landuse, blocked: false };
  if (['scrub', 'grassland', 'bare_rock', 'scree', 'heath'].includes(t.natural)) return { cls: t.natural, blocked: false };
  return null;
}

function buildQuery([w, s, e, n], { buildings, allowed, minorRoads }) {
  const b = `(${s},${w},${n},${e})`;
  const roads = minorRoads
    ? 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service'
    : 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const parts = [
    `nwr["natural"~"^(water|wetland)$"]${b};`,
    `nwr["waterway"="riverbank"]${b};`,
    `way["waterway"~"^(river|canal)$"]${b};`,
    `nwr["landuse"~"^(reservoir|basin|residential|commercial|industrial|retail|cemetery)$"]${b};`,
    `nwr["aeroway"~"^(aerodrome|runway|taxiway|apron|helipad)$"]${b};`,
    `way["highway"~"^(${roads})$"]${b};`,
    `way["area:highway"]${b};`,
  ];
  if (buildings) parts.push(`way["building"]${b};`);
  if (allowed) {
    parts.push(`nwr["landuse"~"^(farmland|farmyard|orchard|vineyard|meadow|grass)$"]${b};`);
    parts.push(`nwr["natural"~"^(scrub|grassland|bare_rock|scree|heath)$"]${b};`);
  }
  return `[out:json][timeout:10];(${parts.join('')});out geom;`;
}

// Overpass allows ~2 concurrent requests per IP; queue the rest instead of getting HTTP 429
const MAX_CONCURRENT = 2;
let running = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      fn().then(resolve, reject).finally(() => { running--; if (queue.length) queue.shift()(); });
    };
    if (running < MAX_CONCURRENT) run(); else queue.push(run);
  });
}

function post(endpoint, query) {
  return limited(() => postNow(endpoint, query));
}

function postNow(endpoint, query) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({ data: query });
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'FieldShift/1.0 (farm planning tool)',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

// ── OSM → GeoJSON ──
const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const closed = (r) => r.length >= 4 && same(r[0], r[r.length - 1]);

function joinRings(ways) {
  const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (!closed(ring) && guard++ < 2000) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
      if (i < 0) break;
      let w = pool.splice(i, 1)[0];
      if (!same(w[0], end)) w = w.reverse();
      ring = ring.concat(w.slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const coords = (geom) => (geom || []).map((p) => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7]);

function toFeature(el) {
  const c = classify(el.tags);
  if (!c) return null;
  const props = { cls: c.cls, blocked: c.blocked, osm: `${el.type}/${el.id}` };
  if (el.tags && el.tags.name) props.name = el.tags.name;
  if (el.type === 'way') {
    const line = coords(el.geometry);
    if (line.length < 2) return null;
    if (c.width) return { type: 'Feature', properties: { ...props, kind: 'line', width: c.width }, geometry: { type: 'LineString', coordinates: line } };
    if (!closed(line)) return null; // an "area" tag on an open way is a mapping error
    return { type: 'Feature', properties: { ...props, kind: 'area' }, geometry: { type: 'Polygon', coordinates: [line] } };
  }
  if (el.type === 'relation' && el.members) {
    const outers = joinRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => coords(m.geometry)));
    const inners = joinRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => coords(m.geometry)));
    if (!outers.length) return null;
    const polys = outers.map((o) => [o]);
    inners.forEach((h) => {
      const p = polys.find((poly) => inRing(h[0], poly[0]));
      if (p) p.push(h);
    });
    return { type: 'Feature', properties: { ...props, kind: 'area' }, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } };
  }
  return null;
}

/**
 * Land features for a bbox [w, s, e, n].
 * Resolves { status: 'ok', blocked, allowed, source } or { status: 'unverified', reason }.
 */
async function landFeatures(bbox, opts = {}) {
  const key = `${bbox.map((v) => v.toFixed(5)).join(',')}|${opts.buildings ? 1 : 0}${opts.allowed ? 1 : 0}${opts.minorRoads ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const query = buildQuery(bbox, opts);
    const errors = [];
    for (const ep of ENDPOINTS) {
      try {
        const data = await post(ep, query);
        if (data.remark && /runtime error|timed out/i.test(data.remark)) throw new Error(data.remark.slice(0, 80));
        const blocked = [], allowed = [];
        (data.elements || []).forEach((el) => {
          const f = toFeature(el);
          if (f) (f.properties.blocked ? blocked : allowed).push(f);
        });
        const v = {
          status: 'ok',
          source: new URL(ep).hostname,
          blocked: { type: 'FeatureCollection', features: blocked },
          allowed: { type: 'FeatureCollection', features: allowed },
        };
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { t: Date.now(), v });
        return v;
      } catch (err) {
        errors.push(`${new URL(ep).hostname}: ${err.message}`);
      }
    }
    console.warn('[overpass] all endpoints failed:', errors.join(' | '));
    return { status: 'unverified', reason: 'overpass_unavailable', errors }; // not cached: retry next time
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

module.exports = { landFeatures };
