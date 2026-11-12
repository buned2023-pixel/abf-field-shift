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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 5);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query parameters' });
    }

    const area = [lon - range, lat - range, lon + range, lat + range].map((v) => round(v, 3)).join(',');
    const result = await cached(`firms:${area}:${days}`, CACHE_TTL, async () => {
      // VIIRS: Suomi-NPP stopped publishing NRT data in Nov 2026, so use NOAA-20 + NOAA-21.
      const firmsUrl = (source) => `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/${source}/${area}/${days}`;
      const [noaa20Raw, noaa21Raw, modisRaw] = await Promise.all([
        fetchUrl(firmsUrl('VIIRS_NOAA20_NRT')).catch(() => ''),
        fetchUrl(firmsUrl('VIIRS_NOAA21_NRT')).catch(() => ''),
        fetchUrl(firmsUrl('MODIS_NRT')).catch(() => ''),
      ]);
      const slim = (r, sensor) => ({
        lat: parseFloat(r.latitude),
        lon: parseFloat(r.longitude),
        date: r.acq_date,
        time: r.acq_time,
        confidence: r.confidence,
        frp: parseFloat(r.frp) || 0,
        sensor,
      });
      return {
        viirs: [...parseCsv(noaa20Raw), ...parseCsv(noaa21Raw)].map((r) => slim(r, 'VIIRS')),
        modis: parseCsv(modisRaw).map((r) => slim(r, 'MODIS')),
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

    const result = await cached(`power:${lat},${lon}`, CACHE_TTL, async () => {
      const currentYear = new Date().getFullYear();
      // The most recent year can lag on POWER; step back a year if it isn't published yet.
      for (let endYear = currentYear - 1; endYear >= currentYear - 2; endYear--) {
        const startYear = endYear - 19;
        const url = `https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=PRECTOTCORR,T2M,GWETROOT&community=AG&longitude=${lon}&latitude=${lat}&start=${startYear}&end=${endYear}&format=JSON`;
        let data;
        try { data = JSON.parse(await fetchUrl(url, 45000)); } catch (_) { continue; }
        const p = data.properties && data.properties.parameter;
        if (!p || !p.T2M) continue;

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
              soil: val('GWETROOT'),      // 0..1
            });
          }
        }
        return { startYear, endYear, lat, lon, months };
      }
      throw new Error('power_unavailable');
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'power_unavailable' });
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
        const p = fetchBuffer(url, 15000)
          .catch((e) => (e.status === 404 ? Promise.reject(e) : fetchBuffer(url, 20000)))
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
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
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
