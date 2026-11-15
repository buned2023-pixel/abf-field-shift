/* Field Shift — front-end logic */
(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  const DUSHANBE = { lat: 38.56, lon: 68.77, city: 'Dushanbe', country: 'Tajikistan', source: 'default' };
  const state = {
    lang: 'en',
    loc: null,
    token: 0,
    weather: null, weatherErr: false,
    firms: null, firmsErr: false,
    climate: null, powerErr: false,
    cropsData: null,
    fire: null,
    advice: null,
  };
  const charts = {};

  // ─── Helpers ────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(d));
  const signed = (n, d = 1) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d);

  function t(key, vars) {
    const dict = window.I18N[state.lang] || window.I18N.en;
    let s = dict[key] != null ? dict[key] : (window.I18N.en[key] != null ? window.I18N.en[key] : key);
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
    return s;
  }

  async function getJson(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function haversineKm(a, b) {
    const R = 6371, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function store(key, val) { try { localStorage.setItem(key, val); } catch (_) { /* ignore */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  const ICONS = {
    alert: '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    drop: '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s7 7.3 7 12.3a7 7 0 0 1-14 0c0-5 7-12.3 7-12.3z"/><path d="M4 4l16 16"/></svg>',
    heat: '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>',
    fire: '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.3 1.2 2.3 2.5 2.8z"/></svg>',
    ok: '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    up: '<svg viewBox="0 0 12 12"><path d="M6 2l4 5H2z" fill="currentColor"/></svg>',
    down: '<svg viewBox="0 0 12 12"><path d="M6 10l4-5H2z" fill="currentColor"/></svg>',
    flat: '<svg viewBox="0 0 12 12"><rect x="2" y="5" width="8" height="2" rx="1" fill="currentColor"/></svg>',
  };

  // ─── Language ───────────────────────────────────────────────────────────────
  function applyStaticI18n() {
    document.documentElement.lang = state.lang === 'tj' ? 'tg' : state.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
  }

  function setLang(lang) {
    state.lang = window.I18N[lang] ? lang : 'en';
    store('fs-lang', state.lang);
    applyStaticI18n();
    renderAll();
  }

  // ─── Map ────────────────────────────────────────────────────────────────────
  let map, pointMarker, fireLayer;
  function initMap() {
    map = L.map('map', { zoomControl: true, worldCopyJump: true, scrollWheelZoom: false, preferCanvas: true }).setView([DUSHANBE.lat, DUSHANBE.lon], 8);
    // Don't hijack page scrolling: wheel-zoom only once the user has interacted with the map
    map.on('focus click', () => map.scrollWheelZoom.enable());
    map.on('blur mouseout', () => map.scrollWheelZoom.disable());
    // OSM tiles, darkened with a CSS filter (see .leaflet-tile-pane in style.css)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    fireLayer = L.layerGroup().addTo(map);
    pointMarker = L.marker([DUSHANBE.lat, DUSHANBE.lon], {
      icon: L.divIcon({ className: '', html: '<div class="point-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
    }).addTo(map);
    map.on('click', (e) => setLocation({ lat: e.latlng.lat, lon: e.latlng.lng, city: '', country: '', source: 'map' }));
  }

  function renderFireMarkers() {
    fireLayer.clearLayers();
    if (!state.firms) return;
    const all = [...state.firms.modis, ...state.firms.viirs];
    all.forEach((f) => {
      const isV = f.sensor === 'VIIRS';
      const color = isV ? '#ff4f3a' : '#ffd43b';
      const time = f.time ? `${String(f.time).padStart(4, '0').slice(0, 2)}:${String(f.time).padStart(4, '0').slice(2)} UTC` : '';
      const conf = { h: t('high'), n: t('medium'), l: t('low') }[f.confidence] || (f.confidence ? `${f.confidence}%` : '–');
      L.circleMarker([f.lat, f.lon], {
        radius: Math.min(4 + Math.sqrt(f.frp || 1), 12),
        color: 'rgba(0,0,0,0.6)', weight: 1, fillColor: color, fillOpacity: 0.9,
      }).bindPopup(
        `<b>${esc(t('fireDetected'))} · ${isV ? 'VIIRS' : 'MODIS'}</b><br>` +
        `${esc(t('detected'))}: ${esc(f.date)} ${esc(time)}<br>` +
        `${esc(t('confidence'))}: ${esc(conf)}<br>` +
        `${esc(t('power'))}: ${fmt(f.frp, 1)} MW<br>` +
        `${fmt(f.dist, 0)} km`
      ).addTo(fireLayer);
    });
  }

  // ─── Location ───────────────────────────────────────────────────────────────
  function browserLocation(timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no_geo'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, city: '', country: '', source: 'browser' }),
        reject, { timeout, maximumAge: 600000 }
      );
    });
  }

  async function ipLocation() {
    const d = await getJson('/api/location');
    return { lat: d.lat, lon: d.lon, city: d.city, country: d.country, source: 'ipstack' };
  }

  async function autoLocate() {
    $('placeMeta').textContent = t('locating');
    try { return setLocation(await ipLocation()); } catch (_) { /* next */ }
    try { return setLocation(await browserLocation()); } catch (_) { /* next */ }
    setLocation({ ...DUSHANBE });
  }

  async function myLocation() {
    $('placeMeta').textContent = t('locating');
    try { return setLocation(await browserLocation()); } catch (_) { /* next */ }
    try { return setLocation(await ipLocation()); } catch (_) { /* next */ }
    setLocation({ ...DUSHANBE });
  }

  function setLocation(loc) {
    state.loc = loc;
    const token = ++state.token;
    state.weather = state.firms = state.climate = state.fire = state.advice = null;
    state.weatherErr = state.firmsErr = state.powerErr = false;

    pointMarker.setLatLng([loc.lat, loc.lon]);
    map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 8));
    fireLayer.clearLayers();
    $('searchMsg').hidden = true;
    renderAll();

    const q = `lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`;
    getJson(`/api/weather?${q}`)
      .then((d) => { if (token === state.token) state.weather = d; })
      .catch(() => { if (token === state.token) state.weatherErr = true; })
      .finally(() => { if (token === state.token) { computeFire(); renderPlace(); renderWeather(); renderFire(); renderWarnings(); } });

    getJson(`/api/firms?${q}&range=1.5&days=3`)
      .then((d) => {
        if (token !== state.token) return;
        const here = { lat: loc.lat, lon: loc.lon };
        const add = (arr) => arr.map((f) => ({ ...f, dist: haversineKm(here, f) }));
        state.firms = { viirs: add(d.viirs || []), modis: add(d.modis || []), days: d.days };
      })
      .catch(() => { if (token === state.token) state.firmsErr = true; })
      .finally(() => { if (token === state.token) { computeFire(); renderFireMarkers(); renderFire(); renderWarnings(); } });

    getJson(`/api/power?${q}`)
      .then((d) => { if (token === state.token) state.climate = processClimate(d); })
      .catch(() => { if (token === state.token) state.powerErr = true; })
      .finally(() => { if (token === state.token) { computeFire(); runAdvisor(); renderCharts(); renderFire(); renderWarnings(); renderAdvice(); } });
  }

  // ─── Search ─────────────────────────────────────────────────────────────────
  async function doSearch(q) {
    const list = $('searchResults');
    list.hidden = true;
    if (!q.trim()) return;
    try {
      const { results } = await getJson(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!results.length) throw new Error('none');
      if (results.length === 1) return pickResult(results[0]);
      list.innerHTML = '';
      results.forEach((r) => {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.innerHTML = `${esc(r.city)}<small>${esc([r.admin, r.country].filter(Boolean).join(', '))}</small>`;
        li.addEventListener('click', () => pickResult(r));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pickResult(r); });
        list.appendChild(li);
      });
      list.hidden = false;
    } catch (_) {
      const msg = $('searchMsg');
      msg.textContent = t('notFound');
      msg.hidden = false;
    }
  }
  function pickResult(r) {
    $('searchResults').hidden = true;
    $('searchInput').value = '';
    setLocation({ lat: r.lat, lon: r.lon, city: r.city, country: r.country, source: 'search' });
  }

  // ─── Climate processing ─────────────────────────────────────────────────────
  function linreg(xs, ys) {
    const pts = xs.map((x, i) => [x, ys[i]]).filter((p) => p[1] != null && !isNaN(p[1]));
    const n = pts.length;
    if (n < 3) return { slope: 0, intercept: pts.length ? pts[0][1] : 0 };
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, den = 0;
    pts.forEach(([x, y]) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
    const slope = den ? num / den : 0;
    return { slope, intercept: my - slope * mx };
  }
  const mean = (arr) => { const v = arr.filter((x) => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const daysIn = (y, m) => new Date(y, m, 0).getDate();

  function processClimate(d) {
    const rules = state.cropsData ? state.cropsData.rules : null;
    const th = rules ? rules.trendThresholds : { precipPct: 10, tempDegPerDecade: 0.2, soilPct: 5 };
    const gsMonths = rules ? rules.growingSeasonMonths : [4, 5, 6, 7, 8, 9];
    const years = [];
    for (let y = d.startYear; y <= d.endYear; y++) years.push(y);

    const byYear = years.map((y) => {
      const ms = d.months.filter((m) => m.year === y);
      const complete = (k) => ms.length === 12 && ms.every((m) => m[k] != null);
      return {
        year: y,
        precip: complete('precip') ? ms.reduce((s, m) => s + m.precip * daysIn(y, m.month), 0) : null,
        temp: complete('temp') ? mean(ms.map((m) => m.temp)) : null,
        soil: complete('soil') ? mean(ms.map((m) => m.soil)) : null,
      };
    });

    function series(key, kind) {
      const ys = byYear.map((b) => b[key]);
      const reg = linreg(years, ys);
      const m = mean(ys);
      const perDecade = reg.slope * 10;
      let dir = 'stable', pct = m ? (perDecade / m) * 100 : 0;
      if (kind === 'abs') {
        if (Math.abs(perDecade) >= th.tempDegPerDecade) dir = perDecade > 0 ? 'increasing' : 'decreasing';
      } else {
        const limit = key === 'precip' ? th.precipPct : th.soilPct;
        if (Math.abs(pct) >= limit) dir = pct > 0 ? 'increasing' : 'decreasing';
      }
      const recent = mean(ys.slice(-3));
      return { values: ys, trendLine: years.map((x) => reg.intercept + reg.slope * x), mean: m, perDecade, pct, dir, recent };
    }

    return {
      years,
      precip: series('precip', 'pct'),
      temp: series('temp', 'abs'),
      soil: series('soil', 'pct'),
      gsTemp: mean(d.months.filter((m) => gsMonths.includes(m.month)).map((m) => m.temp)),
      julyTemp: mean(d.months.filter((m) => m.month === 7).map((m) => m.temp)),
      startYear: d.startYear, endYear: d.endYear,
    };
  }

  // ─── Fire risk ──────────────────────────────────────────────────────────────
  function computeFire() {
    if (!state.firms || !state.cropsData) { state.fire = null; return; }
    const r = state.cropsData.rules.warnings.fire;
    const all = [...state.firms.viirs, ...state.firms.modis];
    const within = all.filter((f) => f.dist <= r.radiusKm);
    const near = all.filter((f) => f.dist <= r.nearKm);
    const nearest = all.length ? Math.min(...all.map((f) => f.dist)) : null;
    const w = state.weather;
    const dry = w && w.humidity != null && w.humidity < r.lowHumidity;
    const windy = w && w.windSpeed != null && w.windSpeed >= r.strongWindKmh;
    const hot = w && w.temperature != null && w.temperature >= r.hotTempC;
    const soilDry = state.climate && state.climate.soil.recent != null &&
      state.climate.soil.recent < state.cropsData.rules.warnings.drought.soilDry;

    let level = 'low';
    if (within.length >= r.highCount || (near.length >= 1 && (dry || windy))) level = 'high';
    else if (within.length >= 1 || (dry && (hot || windy)) || (hot && soilDry && dry !== false)) level = 'medium';

    state.fire = {
      level, withinCount: within.length, nearest,
      viirs: state.firms.viirs.length, modis: state.firms.modis.length,
      radiusKm: r.radiusKm, days: state.firms.days,
    };
  }

  // ─── Crop advisor ───────────────────────────────────────────────────────────
  function runAdvisor() {
    const c = state.climate;
    if (!c || !state.cropsData) { state.advice = null; return; }
    const rules = state.cropsData.rules;
    const water = (document.querySelector('input[name="water"]:checked') || {}).value || 'medium';
    let ha = parseFloat($('landSize').value);
    if (!(ha > 0)) ha = 1;

    const levels = rules.waterLevels;
    const avail = levels.indexOf(water);
    const P = c.precip.mean, T = c.gsTemp, S = c.soil.mean;
    const bonus = rules.irrigationBonusMm[water] || 0;
    const sm = rules.soilMoisture;
    const soilLabel = S < sm.dry ? 'dry' : S > sm.wet ? 'wet' : 'moist';

    const scored = state.cropsData.crops.map((crop) => {
      const reasons = [];
      // Temperature fit
      let sT;
      const tVars = { t: fmt(T, 1), min: crop.tempMin, max: crop.tempMax };
      if (T >= crop.tempMin && T <= crop.tempMax) {
        const mid = (crop.tempMin + crop.tempMax) / 2, half = (crop.tempMax - crop.tempMin) / 2;
        sT = 1 - 0.3 * Math.abs(T - mid) / half;
        reasons.push({ key: 'r_temp_in', vars: tVars });
      } else {
        const dist = T < crop.tempMin ? crop.tempMin - T : T - crop.tempMax;
        sT = Math.max(0, 0.7 * (1 - dist / rules.temperatureToleranceC));
        reasons.push({ key: 'r_temp_out', vars: tVars, neg: true });
      }
      // Water fit (irrigation only tops up a deficit; excess rain can't be removed)
      let sW;
      const eff = P + bonus;
      const wVars = { p: fmt(P), e: fmt(eff), min: crop.precipMin, max: crop.precipMax };
      if (P > crop.precipMax) {
        sW = Math.max(0.5, 1 - ((P - crop.precipMax) / crop.precipMax) * 0.5);
        reasons.push({ key: 'r_water_excess', vars: wVars, neg: true });
      } else if (eff >= crop.precipMin) {
        sW = 1;
        reasons.push({ key: 'r_water_ok', vars: wVars });
      } else {
        sW = 0.85 * Math.max(0, eff / crop.precipMin) ** 1.5;
        reasons.push({ key: 'r_water_short', vars: wVars, neg: true });
      }
      const need = levels.indexOf(crop.waterNeed);
      if (need > avail) {
        sW *= Math.max(0, 1 - rules.waterNeedPenaltyPerStep * (need - avail));
        reasons.push({ key: 'r_water_need', neg: true });
      }
      // Soil moisture
      const soilTable = {
        low: { dry: 1, moist: 0.9, wet: 0.7 },
        medium: { dry: water === 'high' ? 0.85 : 0.6, moist: 1, wet: 0.9 },
        high: { dry: water === 'high' ? 0.8 : 0.3, moist: 0.8, wet: 1 },
      };
      const sS = soilTable[crop.waterNeed][soilLabel];
      reasons.push({ key: 'r_soil', vars: { s: fmt(S, 2), label: t('soil_' + soilLabel) }, neg: sS < 0.6, soilLabel });
      // Land size
      const ls = rules.landSize;
      let sL = 0.85;
      const isHV = ls.highValue.includes(crop.id), isLS = ls.largeScale.includes(crop.id);
      if (ha <= ls.smallMaxHa) {
        sL = isHV ? 1 : isLS ? 0.4 : 0.7;
        if (isHV) reasons.push({ key: 'r_land_small', vars: { ha: fmt(ha, ha < 10 ? 1 : 0) } });
      } else if (ha >= ls.largeMinHa) {
        sL = isLS ? 1 : isHV ? 0.5 : 0.7;
        if (isLS) reasons.push({ key: 'r_land_large', vars: { ha: fmt(ha, 0) } });
      }
      // Climate trends
      let sTr = 1;
      if (c.precip.dir === 'decreasing') {
        const x = fmt(c.precip.pct, 0);
        if (crop.waterNeed === 'low') reasons.push({ key: 'r_trend_dry_good', vars: { x } });
        else if (crop.waterNeed === 'high') { sTr = 0.3; reasons.push({ key: 'r_trend_dry_bad', vars: { x }, neg: true }); }
        else sTr = 0.7;
      }
      if (c.temp.dir === 'increasing' && crop.tempMax <= rules.heatSensitiveTempMax) {
        sTr *= 0.6;
        reasons.push({ key: 'r_trend_heat', vars: { x: signed(c.temp.perDecade, 2) }, neg: true });
      }
      const wt = rules.weights;
      const score = Math.round(wt.temperature * sT + wt.water * sW + wt.soil * sS + wt.landFit * sL + wt.trend * sTr);
      return { crop, score, reasons };
    }).sort((a, b) => b.score - a.score);

    // Top 3, preferring different crop groups
    const top = [];
    for (const s of scored) {
      if (top.length === 3) break;
      if (rules.diversifyGroups && top.some((x) => x.crop.group === s.crop.group)) continue;
      top.push(s);
    }
    for (const s of scored) { if (top.length < 3 && !top.includes(s)) top.push(s); }

    // 3-year rotation
    const rot = rules.rotation;
    const pool = scored.filter((s) => !rot.perennial.includes(s.crop.id));
    const plan = [];
    if (pool.length) plan.push({ ...pool[0], why: [{ key: 'rot_start', vars: { s: pool[0].score } }] });
    while (plan.length < rot.years && plan.length) {
      const prev = plan[plan.length - 1];
      const used = plan.map((p) => p.crop.id);
      const hasFixer = plan.some((p) => rot.nitrogenFixers.includes(p.crop.id));
      const rank = (s) => s.score + (!hasFixer && rot.nitrogenFixers.includes(s.crop.id) ? rot.nitrogenFixerBonus : 0);
      let cands = pool.filter((s) => !used.includes(s.crop.id) &&
        (!rot.avoidSameGroupConsecutive || s.crop.group !== prev.crop.group) &&
        (s.crop.rotateAfter || []).includes(prev.crop.group));
      if (!cands.length) cands = pool.filter((s) => !used.includes(s.crop.id) && s.crop.group !== prev.crop.group);
      if (!cands.length) break;
      cands.sort((a, b) => rank(b) - rank(a));
      const next = cands[0];
      const why = [{ key: 'rot_after', vars: { groupKey: next.crop.group, prevGroupKey: prev.crop.group } }];
      if (rot.nitrogenFixers.includes(next.crop.id)) why.push({ key: 'rot_fixer' });
      if (rot.nitrogenFixers.includes(prev.crop.id)) why.push({ key: 'rot_uses_n', vars: { prevCrop: prev.crop } });
      why.push({ key: 'rot_climate', vars: { s: next.score } });
      // Pull in the strongest climate reason for this crop too
      plan.push({ ...next, why });
    }
    plan.forEach((p) => { p.climateReasons = p.reasons.filter((r) => !r.neg).slice(0, 2); });

    const perennialTop = top.find((s) => rot.perennial.includes(s.crop.id));
    state.advice = { top, plan, perennial: perennialTop ? perennialTop.crop : null };
  }

  function reasonText(r) {
    const v = { ...(r.vars || {}) };
    if (v.groupKey) v.group = t('g_' + v.groupKey);
    if (v.prevGroupKey) v.prevGroup = t('g_' + v.prevGroupKey).toLowerCase();
    if (v.prevCrop) v.prev = v.prevCrop.name[state.lang] || v.prevCrop.name.en;
    if (r.soilLabel) v.label = t('soil_' + r.soilLabel);
    return t(r.key, v);
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────
  function renderAll() {
    renderPlace();
    renderWeather();
    renderFire();
    renderFireMarkers();
    renderCharts();
    renderWarnings();
    renderAdvice();
  }

  function renderPlace() {
    const loc = state.loc;
    if (!loc) return;
    let name = loc.city;
    if (!name && state.weather && state.weather.place) name = state.weather.place;
    if (!name) name = `${loc.lat.toFixed(2)}°, ${loc.lon.toFixed(2)}°`;
    $('placeName').textContent = name + (loc.country && loc.country !== name ? `, ${loc.country}` : '');
    $('placeMeta').textContent = `${t('src_' + loc.source)} · ${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°`;
  }

  function wxKey(code, isDay) {
    const c = Number(code);
    if (c === 113) return isDay ? 'wx_sunny' : 'wx_clear';
    if (c === 116) return 'wx_partly';
    if (c === 119) return 'wx_cloudy';
    if (c === 122) return 'wx_overcast';
    if ([143, 248, 260].includes(c)) return 'wx_fog';
    if ([263, 266, 281, 284].includes(c)) return 'wx_drizzle';
    if ([305, 308, 356, 359].includes(c)) return 'wx_heavyRain';
    if ([176, 293, 296, 299, 302, 353].includes(c)) return 'wx_rain';
    if ([182, 185, 311, 314, 317, 320, 350, 362, 365, 374, 377].includes(c)) return 'wx_sleet';
    if ([179, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371, 392, 395].includes(c)) return 'wx_snow';
    if ([200, 386, 389].includes(c)) return 'wx_thunder';
    return 'wx_unknown';
  }

  const skeleton = '<div class="skeleton tall"></div><div class="skeleton"></div>';

  function renderWeather() {
    const el = $('weatherBody');
    if (state.weatherErr) { el.innerHTML = `<p class="error-msg">${esc(t('weatherError'))}</p>`; return; }
    const w = state.weather;
    if (!w) { el.innerHTML = skeleton; return; }
    const desc = t(wxKey(w.code, w.isDay));
    const icon = w.icon && /^https:\/\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="">` : '';
    const stat = (label, value, unit) => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}<small>${esc(unit)}</small></div></div>`;
    el.innerHTML = `
      <div class="wx-main">
        <div class="wx-icon">${icon}</div>
        <div>
          <div class="wx-temp">${fmt(w.temperature)}<sup>°C</sup></div>
          <div class="wx-desc">${esc(desc)}</div>
          <div class="wx-feels">${esc(t('feelsLike', { v: fmt(w.feelsLike) }))}</div>
        </div>
      </div>
      <div class="stat-grid">
        ${stat(t('humidity'), fmt(w.humidity), '%')}
        ${stat(t('wind'), fmt(w.windSpeed), t('unit_kmh') + (w.windDir ? ' ' + w.windDir : ''))}
        ${stat(t('precipNow'), fmt(w.precip, 1), t('unit_mm_short'))}
        ${stat(t('pressure'), fmt(w.pressure), t('unit_hpa'))}
      </div>`;
  }

  function renderFire() {
    const el = $('fireBody');
    if (state.firmsErr) { el.innerHTML = `<p class="error-msg">${esc(t('firmsError'))}</p>`; return; }
    const f = state.fire;
    if (!f) { el.innerHTML = skeleton; return; }
    const lines = [];
    if (f.withinCount > 0) lines.push(t('hotspotsFound', { n: f.withinCount, km: f.radiusKm }));
    else lines.push(t('noHotspots'));
    if (f.nearest != null) lines.push(t('nearest', { km: fmt(f.nearest) }));
    lines.push(t('hotspotsWindow', { d: f.days }));
    el.innerHTML = `
      <div class="risk-row">
        <span class="risk-pill risk-${f.level}">${f.level === 'low' ? ICONS.ok.replace('w-icon', '') : ICONS.fire.replace('w-icon', '')}${esc(t('risk_' + f.level))}</span>
      </div>
      <div class="fire-lines">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
      <div class="sensor-counts">
        <span class="sensor-chip"><span class="legend-dot legend-viirs"></span>VIIRS · ${f.viirs}</span>
        <span class="sensor-chip"><span class="legend-dot legend-modis"></span>MODIS · ${f.modis}</span>
      </div>`;
  }

  function computeWarnings() {
    const out = [];
    if (!state.cropsData) return out;
    const W = state.cropsData.rules.warnings;
    const c = state.climate, w = state.weather;

    // Drought
    if (c && c.soil.recent != null) {
      const s = c.soil.recent;
      const drop = c.soil.mean ? ((c.soil.mean - s) / c.soil.mean) * 100 : 0;
      const pDec = c.precip.dir === 'decreasing';
      if (s < W.drought.soilCritical || (s < W.drought.soilDry && pDec)) {
        out.push({ type: 'drought', level: 'high', text: t('w_drought_high', { s: fmt(s, 2), trend: t('trend_' + c.precip.dir).toLowerCase() }) });
      } else if (drop >= W.drought.recentDropPct || s < W.drought.soilDry) {
        out.push({ type: 'drought', level: 'medium', text: t('w_drought_medium', { s: fmt(s, 2), pct: fmt(Math.max(drop, 0)) }) });
      } else if (pDec) {
        out.push({ type: 'drought', level: 'medium', text: t('w_drought_trend', { s: fmt(s, 2), x: fmt(c.precip.pct, 0) }) });
      }
    }
    // Heat
    if (w && w.temperature != null && w.temperature >= W.heat.currentHigh) {
      out.push({ type: 'heat', level: 'high', text: t('w_heat_high', { t: fmt(w.temperature) }) });
    } else if (w && w.temperature != null && w.temperature >= W.heat.currentMedium) {
      out.push({ type: 'heat', level: 'medium', text: t('w_heat_medium', { t: fmt(w.temperature) }) });
    } else if (c && c.temp.dir === 'increasing' && c.julyTemp >= W.heat.summerMeanHigh) {
      out.push({ type: 'heat', level: 'medium', text: t('w_heat_trend', { x: signed(c.temp.perDecade, 2), j: fmt(c.julyTemp, 1) }) });
    }
    // Fire
    if (state.fire && state.fire.level === 'high') {
      out.push({ type: 'fire', level: 'high', text: t('w_fire_high', { n: state.fire.withinCount, km: state.fire.radiusKm }) });
    } else if (state.fire && state.fire.level === 'medium') {
      out.push({ type: 'fire', level: 'medium', text: t('w_fire_medium') });
    }
    return out.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1));
  }

  function renderWarnings() {
    const el = $('warnings');
    const loaded = (state.climate || state.powerErr) && (state.weather || state.weatherErr) && (state.fire || state.firmsErr);
    const list = computeWarnings();
    if (!list.length) {
      el.innerHTML = loaded ? `<div class="warning ok">${ICONS.ok}<div>${esc(t('noWarnings'))}</div></div>` : '';
      return;
    }
    const icon = { drought: ICONS.drop, heat: ICONS.heat, fire: ICONS.fire };
    el.innerHTML = list.map((w) => `
      <div class="warning ${w.level}" role="alert">
        ${icon[w.type]}
        <div><span class="w-level">${esc(t('risk_' + w.level))} · ${esc(t('warn_' + w.type))}</span>${esc(w.text)}</div>
      </div>`).join('');
  }

  // Charts
  Chart.defaults.color = '#7e88b4';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = 'rgba(140,160,255,0.08)';

  const METRICS = [
    { key: 'precip', canvas: 'precipChart', badge: 'precipTrend', stat: 'precipStat', color: '#5aaeff', dec: 0, unit: 'unit_mm' },
    { key: 'temp', canvas: 'tempChart', badge: 'tempTrend', stat: 'tempStat', color: '#ff8a5c', dec: 1, unit: 'unit_c' },
    { key: 'soil', canvas: 'soilChart', badge: 'soilTrend', stat: 'soilStat', color: '#5fd68a', dec: 2, unit: null },
  ];

  function renderCharts() {
    const c = state.climate;
    METRICS.forEach((m) => {
      const canvas = $(m.canvas);
      const container = canvas.parentElement;
      const loadingEl = container.querySelector('.chart-loading');
      if (charts[m.key]) { charts[m.key].destroy(); delete charts[m.key]; }
      if (!c) {
        container.classList.remove('ready');
        loadingEl.textContent = state.powerErr ? t('powerError') : t('loadingClimate');
        $(m.badge).innerHTML = '';
        $(m.stat).innerHTML = '';
        return;
      }
      container.classList.add('ready');
      const s = c[m.key];
      const icon = s.dir === 'increasing' ? ICONS.up : s.dir === 'decreasing' ? ICONS.down : ICONS.flat;
      const cls = s.dir === 'increasing' ? 'trend-up' : s.dir === 'decreasing' ? 'trend-down' : 'trend-flat';
      const unitTxt = m.key === 'precip' ? ' ' + t('unit_mm_short') : m.key === 'temp' ? '°C' : '';
      $(m.badge).className = `trend-badge ${cls}`;
      $(m.badge).innerHTML = `${icon}${esc(t('trend_' + s.dir))}`;
      const per = m.key === 'temp' ? `${signed(s.perDecade, 2)}°C` : `${signed(s.pct, 1)}%`;
      $(m.stat).innerHTML = `<b>${fmt(s.mean, m.dec)}${esc(unitTxt)}</b>${esc(t('mean20', { v: '' }).trim())} · ${esc(t('perDecade', { v: per }))}`;

      charts[m.key] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: c.years,
          datasets: [
            {
              label: t('annual'), data: s.values, borderColor: m.color, backgroundColor: m.color + '22',
              borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, pointBackgroundColor: m.color,
              fill: true, tension: 0.3, spanGaps: true,
            },
            {
              label: t('trendLine'), data: s.trendLine, borderColor: '#e9edff', borderWidth: 1.5,
              borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#10173a', borderColor: 'rgba(140,160,255,0.3)', borderWidth: 1,
              titleColor: '#e9edff', bodyColor: '#b0b9de', padding: 10,
              callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y, m.dec)}${unitTxt}` },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
            y: { grid: { color: 'rgba(140,160,255,0.08)' }, ticks: { maxTicksLimit: 5 }, beginAtZero: m.key !== 'temp' },
          },
        },
      });
    });
  }

  function cropName(c) { return c.name[state.lang] || c.name.en; }

  function renderAdvice() {
    const res = $('cropResults'), rotEl = $('rotationTimeline'), note = $('perennialNote');
    const a = state.advice;
    if (!a) {
      const msg = state.powerErr ? t('powerError') : t('waitData');
      res.innerHTML = `<p class="muted">${esc(msg)}</p>`;
      rotEl.innerHTML = '';
      note.hidden = true;
      return;
    }
    res.innerHTML = a.top.map((s, i) => `
      <article class="card crop-card">
        <span class="crop-rank">#${i + 1}</span>
        <div class="crop-top">
          <div class="crop-emoji" aria-hidden="true">${s.crop.icon}</div>
          <div><h4 class="crop-name">${esc(cropName(s.crop))}</h4><div class="crop-group">${esc(t('g_' + s.crop.group))}</div></div>
        </div>
        <div class="score-row">
          <div class="score-bar"><div class="score-fill" style="width:${Math.max(0, Math.min(100, s.score))}%"></div></div>
          <span class="score-num">${s.score}<small>/100 ${esc(t('match'))}</small></span>
        </div>
        <span class="water-tag">${esc(t('waterNeed', { v: t(s.crop.waterNeed) }))}</span>
        <p class="crop-desc">${esc(s.crop.description[state.lang] || s.crop.description.en)}</p>
        <ul class="reasons">${s.reasons.map((r) => `<li class="${r.neg ? 'neg' : ''}">${esc(reasonText(r))}</li>`).join('')}</ul>
      </article>`).join('');

    rotEl.innerHTML = a.plan.map((p, i) => `
      <article class="card rot-step">
        <div class="rot-year">${esc(t('year', { n: i + 1 }))}</div>
        <div class="rot-crop">
          <div class="crop-emoji" aria-hidden="true">${p.crop.icon}</div>
          <div><h4 class="crop-name">${esc(cropName(p.crop))}</h4><div class="crop-group">${esc(t('g_' + p.crop.group))}</div></div>
        </div>
        <ul>${[...p.why, ...p.climateReasons].map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>
      </article>`).join('');

    if (a.perennial) {
      note.textContent = t('perennialNote', { crop: cropName(a.perennial) });
      note.hidden = false;
    } else note.hidden = true;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  function bindUi() {
    document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
    $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('searchInput').value); });
    document.addEventListener('click', (e) => { if (!$('searchForm').contains(e.target)) $('searchResults').hidden = true; });
    $('myLocationBtn').addEventListener('click', myLocation);
    $('cropForm').addEventListener('submit', (e) => { e.preventDefault(); runAdvisor(); renderAdvice(); });
    document.querySelectorAll('input[name="water"]').forEach((r) => r.addEventListener('change', () => { runAdvisor(); renderAdvice(); }));
  }

  async function boot() {
    const saved = load('fs-lang');
    state.lang = saved && window.I18N[saved] ? saved : 'en';
    applyStaticI18n();
    initMap();
    bindUi();
    try { state.cropsData = await getJson('/api/crops'); } catch (_) { state.cropsData = null; }
    renderAll();
    autoLocate();
  }

  boot();
})();
