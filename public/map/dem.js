/*
 * Field terrain analysis from Terrarium DEM tiles (AWS Open Data, CORS-enabled).
 * Elevation per pixel = (R * 256 + G + B / 256) - 32768 metres.
 * Slope and aspect use Horn's 3x3 method (same as GDAL / ArcGIS).
 */
(function () {
  'use strict';

  // Terrarium tiles via our backend proxy (source: s3.amazonaws.com/elevation-tiles-prod)
  const TILE_URL = '/tiles/terrarium/{z}/{x}/{y}.png';
  const TILE = 256;
  const MAX_Z = 15;          // highest zoom Terrarium serves
  const NATIVE_Z = 12;       // ≈ 30 m pixels at Tajik latitudes, the source DEM resolution
  const MAX_TILES = 16;      // cap the download per field
  const MAX_SAMPLES = 60000; // cap the per-pixel work for big fields
  const tileCache = new Map();

  const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
  };
  const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
  const y2lat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`DEM tile ${key} failed`));
      img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
    p.catch(() => tileCache.delete(key));
    if (tileCache.size > 200) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, p);
    return p;
  }

  // Ray-casting point-in-polygon on [lon, lat] rings (first ring = outer, rest = holes)
  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(pt, rings) {
    if (!inRing(pt, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (inRing(pt, rings[k])) return false;
    return true;
  }

  const tilesAt = (bbox, z) =>
    (Math.floor(lon2x(bbox[2], z)) - Math.floor(lon2x(bbox[0], z)) + 1) *
    (Math.floor(lat2y(bbox[1], z)) - Math.floor(lat2y(bbox[3], z)) + 1);
  const pixelsAt = (bbox, z) =>
    (lon2x(bbox[2], z) - lon2x(bbox[0], z)) * (lat2y(bbox[1], z) - lat2y(bbox[3], z)) * TILE * TILE;

  // Zoom 12 (~30 m pixels) matches the source data, so prefer it: higher zooms are only
  // upsampled and much heavier to download. Go higher only for tiny fields that would
  // otherwise get fewer than ~40 samples; go lower for huge areas.
  function pickZoom(bbox) {
    let z = NATIVE_Z;
    while (z < MAX_Z && pixelsAt(bbox, z) < 40) z++;
    while (z > 8 && tilesAt(bbox, z) > MAX_TILES) z--;
    return z;
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  /**
   * Analyze a GeoJSON Polygon feature. Returns elevation, slope and aspect stats.
   */
  async function analyzeTerrain(feature) {
    const rings = feature.geometry.coordinates;
    const lons = rings[0].map((c) => c[0]), lats = rings[0].map((c) => c[1]);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    const z = pickZoom(bbox);

    // Global pixel window of the field, plus a 2-pixel margin so Horn's 3x3 window
    // always has neighbours. Only the tiles this window touches are downloaded.
    const n = 2 ** z;
    const gx0 = Math.floor(lon2x(bbox[0], z) * TILE) - 2, gx1 = Math.ceil(lon2x(bbox[2], z) * TILE) + 2;
    const gy0 = Math.floor(lat2y(bbox[3], z) * TILE) - 2, gy1 = Math.ceil(lat2y(bbox[1], z) * TILE) + 2;
    const bx0 = Math.floor(gx0 / TILE), by0 = Math.max(0, Math.floor(gy0 / TILE));
    const bnx = Math.floor(gx1 / TILE) - bx0 + 1, bny = Math.min(n - 1, Math.floor(gy1 / TILE)) - by0 + 1;

    const canvas = document.createElement('canvas');
    canvas.width = bnx * TILE; canvas.height = bny * TILE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = 0; ty < bny; ty++) {
      for (let tx = 0; tx < bnx; tx++) {
        const X = bx0 + tx, Y = by0 + ty;
        jobs.push(loadTile(z, ((X % n) + n) % n, Y).then((img) => ctx.drawImage(img, tx * TILE, ty * TILE)));
      }
    }
    await Promise.all(jobs);
    const W = canvas.width;
    const data = ctx.getImageData(0, 0, W, canvas.height).data;
    const elev = (px, py) => {
      const i = (py * W + px) * 4;
      return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    };

    // Pixel window covering the field
    const px0 = Math.max(1, Math.floor((lon2x(bbox[0], z) - bx0) * TILE));
    const px1 = Math.min(W - 2, Math.ceil((lon2x(bbox[2], z) - bx0) * TILE));
    const py0 = Math.max(1, Math.floor((lat2y(bbox[3], z) - by0) * TILE));
    const py1 = Math.min(canvas.height - 2, Math.ceil((lat2y(bbox[1], z) - by0) * TILE));
    const step = Math.max(1, Math.ceil(Math.sqrt(((px1 - px0 + 1) * (py1 - py0 + 1)) / MAX_SAMPLES)));

    const midLat = (bbox[1] + bbox[3]) / 2;
    const cell = (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / n; // metres per pixel

    let count = 0, sumE = 0, minE = Infinity, maxE = -Infinity, sumS = 0, ax = 0, ay = 0;
    const slopeClasses = [0, 0, 0, 0]; // <2°, 2–5°, 5–15°, >15°
    const sample = (px, py) => {
      const a = elev(px - 1, py - 1), b = elev(px, py - 1), c = elev(px + 1, py - 1);
      const d = elev(px - 1, py), e = elev(px, py), f = elev(px + 1, py);
      const g = elev(px - 1, py + 1), h = elev(px, py + 1), i = elev(px + 1, py + 1);
      const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell);
      const slope = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      // Downslope direction, clockwise from north (ArcGIS convention)
      let asp = (Math.atan2(dzdy, -dzdx) * 180) / Math.PI;
      asp = asp < 0 ? 90 - asp : asp > 90 ? 450 - asp : 90 - asp;
      count++; sumE += e; sumS += slope;
      if (e < minE) minE = e; if (e > maxE) maxE = e;
      const w = Math.sin((slope * Math.PI) / 180); // steeper cells count more for aspect
      ax += Math.sin((asp * Math.PI) / 180) * w;
      ay += Math.cos((asp * Math.PI) / 180) * w;
      slopeClasses[slope < 2 ? 0 : slope < 5 ? 1 : slope < 15 ? 2 : 3]++;
    };

    for (let py = py0; py <= py1; py += step) {
      for (let px = px0; px <= px1; px += step) {
        const lon = x2lon(bx0 + (px + 0.5) / TILE, z);
        const lat = y2lat(by0 + (py + 0.5) / TILE, z);
        if (inPolygon([lon, lat], rings)) sample(px, py);
      }
    }
    // Very small field: no pixel centre fell inside, so sample at its centroid
    if (!count) {
      const cLon = lons.reduce((s, v) => s + v, 0) / lons.length;
      const cLat = lats.reduce((s, v) => s + v, 0) / lats.length;
      sample(
        Math.min(W - 2, Math.max(1, Math.floor((lon2x(cLon, z) - bx0) * TILE))),
        Math.min(canvas.height - 2, Math.max(1, Math.floor((lat2y(cLat, z) - by0) * TILE)))
      );
    }

    const meanSlope = sumS / count;
    let aspectDeg = (Math.atan2(ax, ay) * 180) / Math.PI;
    if (aspectDeg < 0) aspectDeg += 360;
    const flat = meanSlope < 2;
    // Slopes facing every way (e.g. a field across a ridge) cancel out: no single aspect
    const mixed = !flat && Math.hypot(ax, ay) / count < 0.25 * Math.sin((meanSlope * Math.PI) / 180);
    return {
      zoom: z,
      resolutionM: cell * step,
      samples: count,
      meanElevation: sumE / count,
      minElevation: minE,
      maxElevation: maxE,
      meanSlope,
      aspectDeg: flat || mixed ? null : aspectDeg,
      aspect: flat ? 'flat' : mixed ? 'mixed' : COMPASS[Math.round(aspectDeg / 45) % 8],
      slopeShare: slopeClasses.map((v) => v / count),
    };
  }

  window.FieldDEM = { analyzeTerrain };
})();
