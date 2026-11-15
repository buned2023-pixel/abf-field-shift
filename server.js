require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const IPSTACK_KEY = process.env.IPSTACK_KEY;
const WEATHERSTACK_KEY = process.env.WEATHERSTACK_KEY;
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;

// Default location: Dushanbe, Tajikistan
const DEFAULT_LOCATION = { lat: 38.56, lon: 68.77, city: 'Dushanbe', country: 'Tajikistan' };

app.use(express.static(path.join(__dirname, 'public')));
app.use('/locales', express.static(path.join(__dirname, 'locales'))); // UI texts: en, ru, tg

/**
 * Helper: fetch a URL and return the raw body as a string.
 * Handles both http and https URLs. 20-second timeout.
 */
function fetchUrl(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'FieldShift/1.0' } }, (res) => {
      // Follow redirects (3xx)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', (err) => {
      console.error(`[fetch] ${url.replace(/(access_key=|csv\/)[^&/]+/, '$1***')} -> ${err.code || err.message}`);
      reject(err);
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Helper: parse CSV text into an array of objects.
 * First row is treated as header. Rows with invalid lat/lon are filtered out.
 */
function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  if (!headers.includes('latitude')) return []; // FIRMS returns plain-text errors
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim());
    if (values.length !== headers.length) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx]; });
    const lat = parseFloat(obj.latitude);
    const lon = parseFloat(obj.longitude);
    if (isNaN(lat) || isNaN(lon)) continue;
    rows.push(obj);
  }
  return rows;
}

// In-memory cache: every external API response is reused for 10 minutes
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(key, { t: Date.now(), v });
  return v;
}

function isPrivateIp(ip) {
  return !ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.') ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:10\.|::ffff:192\.168\.|fe80:|fc|fd)/i.test(ip);
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/location  — the visitor's location via IPstack (normalized)
// GET /api/location/:ip — a specific IP
async function locationHandler(req, res) {
  try {
    let ip = req.params.ip;
    if (!ip) {
      const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      ip = fwd || req.socket.remoteAddress;
      // Running locally: let IPstack detect the public IP of this machine
      if (isPrivateIp(ip)) ip = 'check';
    }
    const data = await cached(`ip:${ip}`, CACHE_TTL, async () => {
      const url = `https://api.apilayer.net/ipstack/${encodeURIComponent(ip)}?access_key=${IPSTACK_KEY}`;
      const d = JSON.parse(await fetchUrl(url));
      if (d.error || d.success === false || d.latitude == null || d.longitude == null) throw new Error('location_unavailable');
      return d;
    });
    res.json({
      lat: data.latitude,
      lon: data.longitude,
      city: data.city || data.region_name || '',
      country: data.country_name || '',
      source: 'ipstack',
    });
  } catch (err) {
    res.status(502).json({ error: 'location_unavailable' });
  }
}
app.get('/api/location', locationHandler);
app.get('/api/location/:ip', locationHandler);

// GET /api/default-location
app.get('/api/default-location', (req, res) => res.json({ ...DEFAULT_LOCATION, source: 'default' }));

// GET /api/geocode?q=city — city search (Open-Meteo geocoder, no key; Weatherstack fallback)
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing_query' });
  try {
    const results = await cached(`geo:${q.toLowerCase()}`, CACHE_TTL, async () => {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&format=json`;
      const data = JSON.parse(await fetchUrl(url));
      return (data.results || []).map((r) => ({
        lat: r.latitude, lon: r.longitude, city: r.name, country: r.country || '', admin: r.admin1 || '',
      }));
    });
    if (results.length) return res.json({ results });
  } catch (_) { /* fall through */ }
  try {
    const url = `https://api.apilayer.net/weatherstack/current?access_key=${WEATHERSTACK_KEY}&query=${encodeURIComponent(q)}`;
    const data = JSON.parse(await fetchUrl(url));
    if (data.location && data.location.lat) {
      return res.json({ results: [{
        lat: parseFloat(data.location.lat), lon: parseFloat(data.location.lon),
        city: data.location.name, country: data.location.country, admin: data.location.region || '',
      }] });
    }
  } catch (_) { /* ignore */ }
  res.json({ results: [] });
});

// GET /api/weather?lat=&lon=  (or /api/weather/:query) — normalized current weather
async function weatherHandler(req, res) {
  try {
    let query = req.params.query;
    if (!query) {
      const lat = parseFloat(req.query.lat);
      const lon = parseFloat(req.query.lon);
      if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'missing_coordinates' });
      query = `${round(lat, 3)},${round(lon, 3)}`;
    }
    const data = await cached(`wx:${query}`, CACHE_TTL, async () => {
      const url = `https://api.apilayer.net/weatherstack/current?access_key=${WEATHERSTACK_KEY}&query=${encodeURIComponent(query)}&units=m`;
      const d = JSON.parse(await fetchUrl(url));
      if (d.error || !d.current) throw new Error('weather_unavailable');
      return d;
    });
    const c = data.current;
    res.json({
      temperature: c.temperature,
      feelsLike: c.feelslike,
      humidity: c.humidity,
      windSpeed: c.wind_speed,
      windDir: c.wind_dir,
      pressure: c.pressure,
      precip: c.precip,
      uvIndex: c.uv_index,
      cloudcover: c.cloudcover,
      code: c.weather_code,
      description: (c.weather_descriptions || [])[0] || '',
      icon: (c.weather_icons || [])[0] || '',
      isDay: c.is_day === 'yes',
      localTime: data.location ? data.location.localtime : '',
      place: data.location ? data.location.name : '',
    });
  } catch (err) {
    res.status(502).json({ error: 'weather_unavailable' });
  }
}
app.get('/api/weather', weatherHandler);
app.get('/api/weather/:query', weatherHandler);

// GET /api/firms?lat=&lon=&range=&days= — fire hot spots, MODIS + VIIRS
app.get('/api/firms', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const range = Math.min(parseFloat(req.query.range) || 1.5, 5);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 10); // FIRMS allows up to 10 days

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query parameters' });
    }

    const area = [lon - range, lat - range, lon + range, lat + range].map((v) => round(v, 3)).join(',');
    const result = await cached(`firms:${area}:${days}`, CACHE_TTL, async () => {
      // VIIRS: Suomi-NPP (VIIRS_SNPP_NRT) is queried as specified, but it stopped publishing
      // NRT data on 2026-11-02, so NOAA-20 and NOAA-21 (the same VIIRS instrument) are included too.
      // FIRMS accepts at most 5 days per request ("Invalid day range. Expects [1..5]"), so a longer
      // period is fetched as consecutive windows, each with its own start date, and merged.
      const windows = [];
      const start = new Date(Date.now() - (days - 1) * 86400000);
      for (let offset = 0; offset < days; offset += 5) {
        const from = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
        windows.push({ from, span: Math.min(5, days - offset) });
      }
      const fetchSource = async (source) => {
        const parts = await Promise.all(windows.map((w) =>
          fetchUrl(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/${source}/${area}/${w.span}/${w.from}`)
            .then(parseCsv).catch(() => [])));
        return parts.flat();
      };
      const [snpp, noaa20, noaa21, modis] = await Promise.all([
        fetchSource('VIIRS_SNPP_NRT'), fetchSource('VIIRS_NOAA20_NRT'), fetchSource('VIIRS_NOAA21_NRT'), fetchSource('MODIS_NRT'),
      ]);
      const slim = (r, sensor, satellite) => ({
        lat: parseFloat(r.latitude),
        lon: parseFloat(r.longitude),
        date: r.acq_date,
        time: r.acq_time,
        confidence: r.confidence,
        frp: parseFloat(r.frp) || 0,
        sensor,
        satellite,
      });
      return {
        viirs: [
          ...snpp.map((r) => slim(r, 'VIIRS', 'Suomi-NPP')),
          ...noaa20.map((r) => slim(r, 'VIIRS', 'NOAA-20')),
          ...noaa21.map((r) => slim(r, 'VIIRS', 'NOAA-21')),
        ],
        modis: modis.map((r) => slim(r, 'MODIS', r.satellite || 'Terra/Aqua')),
      };
    });
    res.json({ ...result, days, range });
  } catch (err) {
    res.status(502).json({ error: 'firms_unavailable' });
  }
});

// GET /api/power?lat=&lon= — NASA POWER monthly data, last 20 full years
app.get('/api/power', async (req, res) => {
  try {
    const lat = round(parseFloat(req.query.lat), 2);
    const lon = round(parseFloat(req.query.lon), 2);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query parameters' });
    }

    let result;
    try {
      result = await cached(`power:${lat},${lon}`, CACHE_TTL, () => fetchPower(lat, lon)); // errors are never cached
      savePowerFile(result);
    } catch (err) {
      // Live NASA POWER failed: fall back to the last saved answer for this point (or one close by)
      const saved = readPowerFile(lat, lon);
      if (!saved) {
        console.warn(`[power] ${lat},${lon}: live request failed (${err.message}) and no saved copy exists`);
        return res.status(502).json({ error: 'power_unavailable', reason: err.message });
      }
      console.warn(`[power] ${lat},${lon}: live request failed (${err.message}); serving saved copy from ${saved.savedAt}`);
      result = { ...saved, stale: true };
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'power_unavailable' });
  }
});

// NASA POWER: 30 s timeout per request, one retry. Asks for the last 20 full years plus the current
// (partial) year; if the current year isn't published yet, it steps back one year (no retry then).
const POWER_TIMEOUT_MS = 30000;
async function fetchPower(lat, lon) {
  const currentYear = new Date().getFullYear();
  const errors = [];
  for (const endYear of [currentYear, currentYear - 1]) {
    const startYear = Math.min(endYear, currentYear - 1) - 19;
    const url = `https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=PRECTOTCORR,T2M,T2M_MAX,GWETROOT,ALLSKY_SFC_SW_DWN&community=AG&longitude=${lon}&latitude=${lat}&start=${startYear}&end=${endYear}&format=JSON`;
    const tries = endYear === currentYear ? 2 : 1;
    for (let t = 1; t <= tries; t++) {
      try {
        const data = JSON.parse((await fetchBuffer(url, POWER_TIMEOUT_MS)).toString('utf8'));
        const parsed = parsePower(data, startYear, endYear, currentYear, lat, lon);
        if (parsed) return parsed;
        errors.push(`end ${endYear}: no data in answer`);
        break; // a valid answer without data won't change on retry: step back a year
      } catch (err) {
        errors.push(`end ${endYear} try ${t}: ${err.status ? 'HTTP ' + err.status : err.message}`);
        if (err.status && err.status < 500) break; // e.g. 422 "year not available yet": step back, no retry
      }
    }
  }
  throw new Error(errors.join('; '));
}

function parsePower(data, startYear, endYear, currentYear, lat, lon) {
        const p = data.properties && data.properties.parameter;
        if (!p || !p.T2M) return null;

        const fill = (data.header && data.header.fill_value) != null ? data.header.fill_value : -999;
        const months = [];
        for (let y = startYear; y <= endYear; y++) {
          for (let m = 1; m <= 12; m++) {
            const k = `${y}${String(m).padStart(2, '0')}`;
            const val = (param) => {
              const v = p[param] ? p[param][k] : undefined;
              return v == null || v === fill ? null : v;
            };
            months.push({
              year: y, month: m,
              precip: val('PRECTOTCORR'), // mm/day
              temp: val('T2M'),           // °C
              tmax: val('T2M_MAX'),       // °C, monthly maximum
              soil: val('GWETROOT'),      // 0..1
              sun: val('ALLSKY_SFC_SW_DWN'), // solar radiation at the surface
            });
          }
        }
        // lastFullYear: the 20-year baseline ends here; a later year in the data is the partial current year
        return { startYear, endYear, lastFullYear: Math.min(endYear, currentYear - 1), lat, lon, months };
}

// Saved copies of successful POWER answers (data/power-cache), used when the live API fails.
// Monthly climate history barely changes, so an old copy is still useful for a demo.
const POWER_DIR = path.join(__dirname, 'data', 'power-cache');
const POWER_DAILY_DIR = path.join(POWER_DIR, 'daily'); // last-30-days answers for the disease badge
const powerFile = (lat, lon, dir = POWER_DIR) => path.join(dir, `${lat.toFixed(2)}_${lon.toFixed(2)}.json`);
function savePowerFile(result, dir = POWER_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(powerFile(result.lat, result.lon, dir), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
  } catch (err) { console.warn('[power] could not save copy:', err.message); }
}
function readPowerFile(lat, lon, dir = POWER_DIR) {
  const POWER_DIR = dir; // nearby search below looks in the same folder
  try { return JSON.parse(fs.readFileSync(powerFile(lat, lon, dir), 'utf8')); } catch (_) { /* try a nearby point */ }
  // POWER cells are 0.5° x 0.625°, so a saved point within 0.25° has practically the same data
  let best = null, bestD = 0.25;
  try {
    for (const f of fs.readdirSync(POWER_DIR)) {
      const m = f.match(/^(-?[\d.]+)_(-?[\d.]+)\.json$/);
      if (!m) continue;
      const d = Math.hypot(+m[1] - lat, +m[2] - lon);
      if (d <= bestD) { bestD = d; best = f; }
    }
    return best ? JSON.parse(fs.readFileSync(path.join(POWER_DIR, best), 'utf8')) : null;
  } catch (_) { return null; }
}

// GET /api/power-daily?lat=&lon= — NASA POWER daily T2M, RH2M, PRECTOTCORR for the last 30 days
// (crop disease risk). Cached 1 hour in memory (errors never cached), saved copy on disk as a fallback.
const POWER_DAILY_TTL = 60 * 60 * 1000;
app.get('/api/power-daily', async (req, res) => {
  const lat = round(parseFloat(req.query.lat), 2);
  const lon = round(parseFloat(req.query.lon), 2);
  if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon are required numeric query parameters' });
  try {
    const result = await cached(`power-daily:${lat},${lon}`, POWER_DAILY_TTL, () => fetchPowerDaily(lat, lon));
    savePowerFile(result, POWER_DAILY_DIR);
    res.json(result);
  } catch (err) {
    const saved = readPowerFile(lat, lon, POWER_DAILY_DIR);
    if (!saved) {
      console.warn(`[power-daily] ${lat},${lon}: live request failed (${err.message}) and no saved copy exists`);
      return res.status(502).json({ error: 'power_daily_unavailable' });
    }
    console.warn(`[power-daily] ${lat},${lon}: live request failed (${err.message}); serving saved copy from ${saved.savedAt}`);
    res.json({ ...saved, stale: true });
  }
});

// POWER daily data lags a few days, so ask for 40 days and keep the last 30 that have values. One retry.
async function fetchPowerDaily(lat, lon) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date(), start = new Date(Date.now() - 40 * 86400000);
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,RH2M,PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${ymd(start)}&end=${ymd(end)}&format=JSON`;
  let lastErr;
  for (let t = 1; t <= 2; t++) {
    try {
      const data = JSON.parse((await fetchBuffer(url, POWER_TIMEOUT_MS)).toString('utf8'));
      const p = data.properties && data.properties.parameter;
      if (!p || !p.T2M) throw new Error('no data in answer');
      const fill = (data.header && data.header.fill_value) != null ? data.header.fill_value : -999;
      const v = (param, k) => { const x = p[param] ? p[param][k] : undefined; return x == null || x === fill ? null : x; };
      const days = Object.keys(p.T2M).sort().map((k) => ({
        date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`,
        temp: v('T2M', k), rh: v('RH2M', k), rain: v('PRECTOTCORR', k), // °C, %, mm/day
      })).filter((d) => d.temp != null && d.rh != null).slice(-30);
      if (days.length < 10) throw new Error('too few days with data');
      return { lat, lon, days };
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500) break;
    }
  }
  throw lastErr;
}

// GET /api/disease-rules — crop disease thresholds (config/disease-rules.json)
app.get('/api/disease-rules', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'disease-rules.json'), 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: 'disease_rules_unavailable' });
  }
});

// GET /api/risk-rules — scoring rules for the drought / heat / fire badges (config/risk-rules.json)
app.get('/api/risk-rules', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'risk-rules.json'), 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: 'risk_rules_unavailable' });
  }
});

// GET /api/crop-rules — crop advisor rules (config/crops.json)
app.get('/api/crop-rules', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'crops.json'), 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: 'crop_rules_unavailable' });
  }
});

// ─── Land check (OpenStreetMap via Overpass) ─────────────────────────────────
const { landFeatures } = require('./lib/overpass');

function polygonBbox(geometry) {
  const pts = geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// POST /api/landcheck  { geometry: Polygon }  → blocked + allowed land around the field
app.post('/api/landcheck', express.json({ limit: '1mb' }), async (req, res) => {
  const body = req.body || {};
  const geometry = body.type === 'Feature' ? body.geometry : (body.geometry || body);
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) {
    return res.status(400).json({ error: 'polygon_required' });
  }
  let bbox;
  try { bbox = polygonBbox(geometry); } catch (_) { return res.status(400).json({ error: 'bad_polygon' }); }
  if (!bbox.every(Number.isFinite) || bbox[2] - bbox[0] > 0.12 || bbox[3] - bbox[1] > 0.12) {
    return res.status(400).json({ error: 'polygon_too_large' });
  }
  const pad = 0.0006; // ~60 m, so roads and rivers along the edge are included
  const padded = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const result = await landFeatures(padded, { buildings: true, allowed: true, minorRoads: true });
  res.json(result);
});

// GET /api/landzones?bbox=w,s,e,n — no-draw zones for one map cell (max 0.06° square)
app.get('/api/landzones', async (req, res) => {
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] ||
      bbox[2] - bbox[0] > 0.06 || bbox[3] - bbox[1] > 0.06) {
    return res.status(400).json({ error: 'bad_bbox' });
  }
  const result = await landFeatures(bbox, { buildings: false, allowed: false, minorRoads: false });
  res.json(result.status === 'ok' ? { status: 'ok', blocked: result.blocked } : result);
});

// Trees are not fetched at runtime: "npm run build-trees" writes public/data/trees.bin,
// which is served as a static file.

// GET /tiles/osm/:z/:x/:y.pbf — OpenStreetMap vector tiles (OpenFreeMap, no key) for rivers and lakes.
// The tile URL contains a dated build name, read from OpenFreeMap's TileJSON (refreshed daily).
// Tiles are kept on disk in data/tile-cache/osm (safe to delete).
const OSM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OSM_DIR = path.join(__dirname, 'data', 'tile-cache', 'osm');
let osmTemplate = null, osmTemplateAt = 0;
async function osmTileUrl(z, x, y) {
  if (!osmTemplate || Date.now() - osmTemplateAt > 24 * 3600 * 1000) {
    const tj = JSON.parse((await fetchBuffer(OSM_TILEJSON, 15000)).toString('utf8'));
    osmTemplate = tj.tiles[0]; osmTemplateAt = Date.now();
  }
  return osmTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
async function getOsmTile(z, x, y) {
  const file = path.join(OSM_DIR, String(z), String(x), `${y}.pbf`);
  try { return await fs.promises.readFile(file); } catch (_) { /* not on disk yet */ }
  const url = await osmTileUrl(z, x, y);
  const buf = await fetchBuffer(url, 20000).catch((e) => (e.status === 404 ? Promise.reject(e) : fetchBuffer(url, 20000)));
  fs.promises.mkdir(path.dirname(file), { recursive: true }).then(() => fs.promises.writeFile(file, buf)).catch(() => {});
  return buf;
}

// GET /api/water-near?lat=&lon=&r=4000 — rivers, canals, streams and lakes within r metres (max 6 km),
// read from the same OpenStreetMap tiles (zoom 14, full detail). The browser measures distances with Turf.
const { VectorTile } = require('@mapbox/vector-tile');
const Pbf = require('pbf');
const WATERWAY_CLASSES = ['river', 'canal', 'stream', 'ditch', 'drain'];
app.get('/api/water-near', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  const r = Math.min(Math.max(parseFloat(req.query.r) || 4000, 500), 6000);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) return res.status(400).json({ error: 'bad_coordinates' });
  const z = 14, n = 2 ** z;
  const dLat = r / 110540, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  const tx = (lo) => Math.floor(((lo + 180) / 360) * n);
  const ty = (la) => { const a = (la * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(a) + 1 / Math.cos(a)) / Math.PI) / 2) * n); };
  const tiles = [];
  for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++) for (let y = ty(lat + dLat); y <= ty(lat - dLat); y++) tiles.push([x, y]);
  const features = [];
  let failed = 0;
  await Promise.all(tiles.map(async ([x, y]) => {
    let vt;
    try { vt = new VectorTile(new Pbf(await getOsmTile(z, x, y))); } catch (_) { failed++; return; }
    const ww = vt.layers.waterway, wa = vt.layers.water;
    for (let i = 0; ww && i < ww.length; i++) {
      const f = ww.feature(i);
      if (!WATERWAY_CLASSES.includes(f.properties.class) || f.properties.brunnel === 'tunnel') continue;
      const g = f.toGeoJSON(x, y, z);
      g.properties = { type: f.properties.class, name: f.properties.name || f.properties['name:latin'] || '' };
      features.push(g);
    }
    for (let i = 0; wa && i < wa.length; i++) {
      const f = wa.feature(i);
      if (f.properties.class === 'swimming_pool') continue;
      const g = f.toGeoJSON(x, y, z);
      g.properties = { type: f.properties.class === 'river' ? 'river' : 'lake', name: '' };
      features.push(g);
    }
  }));
  if (failed === tiles.length) return res.status(502).json({ error: 'water_data_unavailable' });
  res.json({ type: 'FeatureCollection', radiusM: r, partial: failed > 0, features });
});

app.get('/tiles/osm/:z/:x/:y.pbf', async (req, res) => {
  const z = parseInt(req.params.z, 10), x = parseInt(req.params.x, 10), y = parseInt(req.params.y, 10);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 14 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return res.status(400).end();
  try {
    const buf = await getOsmTile(z, x, y);
    res.set({ 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'public, max-age=86400' });
    res.send(buf);
  } catch (err) {
    res.status(err.status === 404 ? 204 : 502).end();
  }
});

// GET /tiles/terrarium/:z/:x/:y.png — DEM tile proxy (same-origin for canvas reads, cached)
function fetchBuffer(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FieldShift/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}
const tileCache = new Map();
const tileInflight = new Map();
const TILE_CACHE_MAX_BYTES = 120 * 1024 * 1024; // z15 tiles are up to ~110 KB, so cap by size
let tileCacheBytes = 0;

// Disk cache for terrain tiles. Elevation never changes, so each tile is downloaded from AWS
// once and then served from data/tile-cache (survives restarts, hides a slow AWS connection).
// The folder is safe to delete at any time; writing stops once it reaches the size limit.
const TILE_DISK_DIR = path.join(__dirname, 'data', 'tile-cache', 'terrarium');
const TILE_DISK_MAX_BYTES = 600 * 1024 * 1024;
let tileDiskBytes = 0;
(function measureTileDisk(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) measureTileDisk(p); else tileDiskBytes += fs.statSync(p).size;
    }
  } catch (_) { /* folder not created yet */ }
})(TILE_DISK_DIR);
const tileDiskPath = (key) => path.join(TILE_DISK_DIR, `${key}.png`);
const readDiskTile = (key) => fs.promises.readFile(tileDiskPath(key));
function writeDiskTile(key, buf) {
  if (tileDiskBytes + buf.length > TILE_DISK_MAX_BYTES) return;
  const file = tileDiskPath(key);
  fs.promises.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.writeFile(file, buf))
    .then(() => { tileDiskBytes += buf.length; })
    .catch(() => { /* disk cache is best-effort */ });
}
app.get('/tiles/terrarium/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z, 10), x = parseInt(req.params.x, 10), y = parseInt(req.params.y, 10);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 15 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return res.status(400).end();
  }
  const key = `${z}/${x}/${y}`;
  try {
    let hit = tileCache.get(key);
    if (!hit || Date.now() - hit.t > CACHE_TTL) {
      // One upstream fetch per tile even when many requests arrive at once; retry once on failure
      if (!tileInflight.has(key)) {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`;
        const p = readDiskTile(key)
          .catch(() => fetchBuffer(url, 15000)
            .catch((e) => (e.status === 404 ? Promise.reject(e) : fetchBuffer(url, 20000)))
            .then((buf) => { writeDiskTile(key, buf); return buf; }))
          .finally(() => tileInflight.delete(key));
        tileInflight.set(key, p);
      }
      const buf = await tileInflight.get(key);
      const old = tileCache.get(key);
      if (old) { tileCacheBytes -= old.buf.length; tileCache.delete(key); }
      while (tileCache.size && tileCacheBytes + buf.length > TILE_CACHE_MAX_BYTES) {
        const oldestKey = tileCache.keys().next().value;
        tileCacheBytes -= tileCache.get(oldestKey).buf.length;
        tileCache.delete(oldestKey);
      }
      hit = { t: Date.now(), buf };
      tileCache.set(key, hit);
      tileCacheBytes += buf.length;
    }
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.send(hit.buf);
  } catch (err) {
    res.status(err.status === 404 ? 404 : 502).end();
  }
});

// GET /api/crops — crop catalog + advisor rules
app.get('/api/crops', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'data', 'crops.json');
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: 'crops_unavailable' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Field Shift server running on http://localhost:${PORT}`);
});
