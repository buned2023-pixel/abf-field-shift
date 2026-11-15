/*
 * Stage 2 — NASA data and risks for the selected field.
 *
 *  - NASA POWER (20 full years + the current year, monthly) at the field centroid → 3 charts with
 *    a linear-regression trend, a significance check, and the current year vs the 20-year average.
 *  - Weatherstack → current weather card.
 *  - NASA FIRMS → fire detections of the last 10 days around the field, drawn on the map.
 *  - DROUGHT / HEAT / FIRE badges, scored with the rules in config/risk-rules.json.
 *
 * All requests go through the backend; nothing here shows raw JSON.
 */
(function () {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const SENSOR_COLOR = { VIIRS: '#ff5a1f', MODIS: '#ffd43b' };
  const CHARTS = [
    { key: 'rain', title: 'Rainfall', unit: 'mm / year', color: '#5aaeff', dec: 0, canvas: 'tlRain' },
    { key: 'temp', title: 'Temperature', unit: '°C, yearly mean', color: '#ff8a5c', dec: 1, canvas: 'tlTemp' },
    { key: 'soil', title: 'Root soil moisture', unit: '0 dry – 1 saturated', color: '#5fd68a', dec: 2, canvas: 'tlSoil' },
  ];

  let map = null, opts = null, rules = null;
  let current = null;        // { id, name, centroid, key }
  let token = 0;
  const state = { power: null, powerErr: false, firms: null, firmsErr: false, weather: null, weatherErr: false, analysis: null, risks: null };
  const cache = new Map();   // location key → { power, firms, weather }
  const charts = {};
  let firePins = [];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !isFinite(n) ? 'No data' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const signed = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d);
  const mean = (a) => { const v = a.filter((x) => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const daysIn = (y, m) => new Date(y, m, 0).getDate();

  async function getJson(url, timeoutMs = 60000) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
      return d;
    } finally { clearTimeout(timer); }
  }

  function haversineKm(a, b) {
    const R = 6371, t = (x) => (x * Math.PI) / 180;
    const h = Math.sin(t(b[1] - a[1]) / 2) ** 2 + Math.cos(t(a[1])) * Math.cos(t(b[1])) * Math.sin(t(b[0] - a[0]) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ── Trend: least-squares line + t-test on the slope ──
  function trend(xs, ys, stableLimit, kind) {
    const pts = xs.map((x, i) => [x, ys[i]]).filter((p) => p[1] != null && isFinite(p[1]));
    const n = pts.length, m = mean(pts.map((p) => p[1]));
    if (n < 5) return { dir: 'stable', significant: false, perDecade: 0, pct: 0, mean: m, slope: 0, intercept: m, n };
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    let sxx = 0, sxy = 0;
    pts.forEach(([x, y]) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - m); });
    const slope = sxy / sxx, intercept = m - slope * mx;
    let sse = 0;
    pts.forEach(([x, y]) => { sse += (y - (intercept + slope * x)) ** 2; });
    const se = Math.sqrt(sse / (n - 2) / sxx), t = se > 0 ? slope / se : 0;
    const perDecade = slope * 10, pct = m ? (perDecade / m) * 100 : 0;
    const big = kind === 'deg' ? Math.abs(perDecade) >= stableLimit : Math.abs(pct) >= stableLimit;
    return {
      dir: !big ? 'stable' : slope > 0 ? 'increasing' : 'decreasing',
      significant: Math.abs(t) >= rules.trend.significance.minAbsT,
      perDecade, pct, mean: m, slope, intercept, n, t,
    };
  }

  // ── POWER → yearly series, monthly normals, current year vs normal ──
  function analyze(d) {
    const lim = rules.trend.stableLimit;
    const years = [];
    for (let y = d.startYear; y <= d.lastFullYear; y++) years.push(y);
    const of = (y) => d.months.filter((m) => m.year === y);
    const full = (ms, k) => ms.length === 12 && ms.every((m) => m[k] != null);
    const yearly = {
      rain: years.map((y) => { const ms = of(y); return full(ms, 'precip') ? ms.reduce((s, m) => s + m.precip * daysIn(y, m.month), 0) : null; }),
      temp: years.map((y) => { const ms = of(y); return full(ms, 'temp') ? mean(ms.map((m) => m.temp)) : null; }),
      soil: years.map((y) => { const ms = of(y); return full(ms, 'soil') ? mean(ms.map((m) => m.soil)) : null; }),
      tmax: years.map((y) => { const ms = of(y); return full(ms, 'tmax') ? mean(ms.map((m) => m.tmax)) : null; }),
    };
    const trends = {
      rain: trend(years, yearly.rain, lim.rainPctPerDecade, 'pct'),
      temp: trend(years, yearly.temp, lim.tempDegPerDecade, 'deg'),
      soil: trend(years, yearly.soil, lim.soilPctPerDecade, 'pct'),
      tmax: trend(years, yearly.tmax, lim.tempDegPerDecade, 'deg'),
    };
    // 20-year normal for each calendar month
    const base = d.months.filter((m) => m.year <= d.lastFullYear);
    const normal = (k, month) => mean(base.filter((m) => m.month === month).map((m) => m[k]));
    const norm = {};
    ['precip', 'temp', 'tmax', 'soil', 'sun'].forEach((k) => { norm[k] = MONTHS.map((_, i) => normal(k, i + 1)); });

    // "This year": the partial current year if POWER has enough of it, otherwise the last full year
    let ty = d.endYear > d.lastFullYear ? d.endYear : d.lastFullYear;
    let tm = of(ty).filter((m) => m.precip != null && m.temp != null && m.soil != null);
    if (ty > d.lastFullYear && tm.length < rules.currentYear.minMonths) { ty = d.lastFullYear; tm = of(ty).filter((m) => m.precip != null && m.temp != null && m.soil != null); }
    const months = tm.map((m) => m.month);
    const span = months.length === 12 ? 'full year' : months.length ? `${MONTHS[months[0] - 1]}–${MONTHS[months[months.length - 1] - 1]}` : '';
    const rainNow = tm.reduce((s, m) => s + m.precip * daysIn(ty, m.month), 0);
    const rainNorm = tm.reduce((s, m) => s + norm.precip[m.month - 1] * daysIn(ty, m.month), 0);
    const tempNow = mean(tm.map((m) => m.temp)), tempNorm = mean(tm.map((m) => norm.temp[m.month - 1]));
    const soilNow = mean(tm.map((m) => m.soil)), soilNorm = mean(tm.map((m) => norm.soil[m.month - 1]));
    const thisYear = {
      year: ty, partial: months.length < 12, span, months: months.length,
      rain: { now: rainNow, norm: rainNorm, pct: rainNorm ? ((rainNow - rainNorm) / rainNorm) * 100 : 0 },
      temp: { now: tempNow, norm: tempNorm, diff: tempNow - tempNorm },
      soil: { now: soilNow, norm: soilNorm, pct: soilNorm ? ((soilNow - soilNorm) / soilNorm) * 100 : 0 },
    };
    // Chart marker for this year, put on the yearly scale: same relative (rain, soil) or absolute (temp) gap to normal
    thisYear.marker = {
      rain: trends.rain.mean * (1 + thisYear.rain.pct / 100),
      temp: trends.temp.mean + thisYear.temp.diff,
      soil: trends.soil.mean * (1 + thisYear.soil.pct / 100),
    };

    // Heat: months in the last 12 (with data) whose maximum temperature beat the normal by the margin
    const withTmax = d.months.filter((m) => m.tmax != null).slice(-12);
    const hot = withTmax.map((m) => ({ ...m, over: m.tmax - norm.tmax[m.month - 1] })).filter((m) => m.over >= rules.heat.hotMonthMarginC);
    const hottest = withTmax.slice().sort((a, b) => b.tmax - a.tmax)[0] || null;
    return {
      years, yearly, trends, norm, thisYear,
      heat: { checked: withTmax.length, hotMonths: hot, hottest: hottest && { ...hottest, over: hottest.tmax - norm.tmax[hottest.month - 1] } },
      sun: mean(base.map((m) => m.sun)),
    };
  }

  // ── Risk scoring (rules from config/risk-rules.json) ──
  const tier = (list, value) => list.reduce((p, r) => (value >= r.atLeast ? Math.max(p, r.points) : p), 0);
  const levelOf = (points) => (points >= rules.levels.high ? 'high' : points >= rules.levels.medium ? 'medium' : 'low');
  const trendWords = (t, unit) => `${t.dir === 'stable' ? 'stable' : t.dir === 'increasing' ? 'rising' : 'falling'} (${signed(unit === 'deg' ? t.perDecade : t.pct, unit === 'deg' ? 2 : 0)}${unit === 'deg' ? ' °C' : '%'} per decade${t.dir !== 'stable' ? (t.significant ? ', significant' : ', not significant') : ''})`;

  function scoreRisks() {
    const a = state.analysis, w = state.weather, f = state.firms, out = {};
    if (a) {
      // DROUGHT: falling rainfall trend + this year's soil moisture and rain against the 20-year norm
      const R = rules.drought, rt = a.trends.rain, ty = a.thisYear;
      const soilBelow = Math.max(0, -ty.soil.pct), rainBelow = Math.max(0, -ty.rain.pct);
      let p = 0;
      if (rt.dir === 'decreasing') p += rt.significant ? R.rainTrendDecreasing.pointsIfSignificant : R.rainTrendDecreasing.points;
      p += tier(R.soilBelowNormPct, soilBelow) + tier(R.rainBelowNormPct, rainBelow);
      out.drought = {
        level: levelOf(p), points: p,
        why: `Rainfall trend over 20 years is ${trendWords(rt, 'pct')}; in ${ty.year} (${ty.span}) root soil moisture is ${fmt(ty.soil.now, 2)} against a norm of ${fmt(ty.soil.norm, 2)} (${signed(ty.soil.pct)}%) and rainfall is ${fmt(ty.rain.now)} mm against ${fmt(ty.rain.norm)} mm (${signed(ty.rain.pct)}%).`,
      };
      // HEAT: months with maximum temperature above normal, the T2M_MAX trend, and the temperature right now
      const H = rules.heat, tt = a.trends.tmax, n = a.heat.hotMonths.length;
      p = tier(H.hotMonthsLast12, n);
      if (tt.dir === 'increasing') p += tt.significant ? H.tmaxTrendIncreasing.pointsIfSignificant : H.tmaxTrendIncreasing.points;
      if (w && w.temperature != null) p += tier(H.currentTempC, w.temperature);
      const hm = a.heat.hottest;
      out.heat = {
        level: levelOf(p), points: p,
        why: `${n} of the last ${a.heat.checked} months had maximum temperatures at least ${fmt(H.hotMonthMarginC, 1)} °C above the 20-year normal` +
          (hm ? `; the hottest was ${MONTHS[hm.month - 1]} ${hm.year} at ${fmt(hm.tmax, 1)} °C (${signed(hm.over, 1)} °C)` : '') +
          `. Yearly maximum-temperature trend is ${trendWords(tt, 'deg')}.`,
      };
    }
    if (f) {
      // FIRE: FIRMS detections by number and distance, plus dry soil and hot, dry air
      const F = rules.fire;
      let p = tier(F.detectionsInRadius, f.inRadius) + tier(F.detectionsNear, f.near);
      const parts = [];
      if (a) {
        const soilBelow = Math.max(0, -a.thisYear.soil.pct);
        if (soilBelow >= F.drySoilBelowNormPct.atLeast) p += F.drySoilBelowNormPct.points;
        parts.push(`root soil moisture is ${signed(a.thisYear.soil.pct)}% against the 20-year norm`);
      }
      if (w && w.temperature != null) {
        if (w.temperature >= F.hotNowC.atLeast) p += F.hotNowC.points;
        if (w.humidity != null && w.humidity < F.lowHumidityPct.below) p += F.lowHumidityPct.points;
        parts.push(`it is ${fmt(w.temperature)} °C with ${fmt(w.humidity)}% humidity now`);
      }
      out.fire = {
        level: levelOf(p), points: p,
        why: (f.inRadius ? `NASA FIRMS shows ${f.inRadius} fire detection${f.inRadius > 1 ? 's' : ''} within ${F.radiusKm} km in the last ${f.days} days (${f.near} within ${F.nearKm} km, nearest ${fmt(f.nearestKm, f.nearestKm < 10 ? 1 : 0)} km away)`
          : `NASA FIRMS shows no fire detections within ${F.radiusKm} km in the last ${f.days} days`) + (parts.length ? `; ${parts.join(' and ')}.` : '.'),
      };
    }
    state.risks = out;
  }

  // ── Badges (shown in the Field overview) ──
  const help = (tip) => `<button type="button" class="help" data-tip="${esc(tip)}" aria-label="Help: ${esc(tip)}">?</button>`;
  const BADGES = [
    ['drought', 'Drought risk', 'powerErr', 'Chance that the field gets too little water, from 20 years of rain and soil-moisture data.'],
    ['heat', 'Heat risk', 'powerErr', 'Chance that plants are stressed by heat, from recent hot months and the temperature now.'],
    ['fire', 'Fire risk', 'firmsErr', 'Chance of fire near the field, from fires seen by satellites in the last 10 days plus dry, hot weather.'],
  ];
  const LEVEL_ICON = { low: '✓', medium: '!', high: '▲' };
  // What the level means and what to do, in plain words
  const ADVICE = {
    drought: { low: 'Enough rain and soil water now. Normal watering is fine.', medium: 'Drier than usual. Water a bit more often and keep the soil covered.', high: 'Very dry. Choose crops that need little water and plan irrigation.' },
    heat: { low: 'Temperatures are normal for this place.', medium: 'Hotter than usual. Water early in the morning and avoid work at midday.', high: 'Very hot. Shade young plants, water morning or evening, protect workers.' },
    fire: { low: 'No fires close to this field.', medium: 'Fires were seen in the area. Clear dry grass around the field.', high: 'Fires are close. Remove dry plants, keep water ready, watch for smoke.' },
  };
  function badgesHtml(fieldId) {
    if (!current || current.id !== fieldId) return '';
    const rows = BADGES.map(([key, label, errKey, tip]) => {
      const r = state.risks && state.risks[key];
      const head = (lvl) => `<div class="risk-head"><span class="risk-name">${label} ${help(tip)}</span>${lvl}</div>`;
      if (r) {
        return `<div class="risk risk-${key} lvl-${r.level}">${head(`<span class="risk-level"><span aria-hidden="true">${LEVEL_ICON[r.level]}</span> ${r.level.toUpperCase()}</span>`)}` +
          `<p class="risk-say">${esc(ADVICE[key][r.level])}</p><details class="risk-more"><summary>Details from NASA data</summary><p class="risk-why">${esc(r.why)}</p></details></div>`;
      }
      const msg = state[errKey] ? 'No data right now: the NASA service could not be reached.' : 'Loading NASA data…';
      return `<div class="risk risk-${key} lvl-none">${head('<span class="risk-level">…</span>')}<p class="risk-say">${msg}</p></div>`;
    }).join('');
    return `<div class="metric wide risk-box"><div class="k">Risks for this field</div>${rows}</div>`;
  }

  // ── Timeline panel ──
  // Trend as an arrow + plain word: "Getting drier", "Getting warmer", "Stable"
  const TREND_WORDS = {
    rain: { increasing: 'Getting wetter', decreasing: 'Getting drier' },
    temp: { increasing: 'Getting warmer', decreasing: 'Getting cooler' },
    soil: { increasing: 'Soil getting wetter', decreasing: 'Soil getting drier' },
  };
  function trendBadge(t, key) {
    const arrow = t.dir === 'increasing' ? '↗' : t.dir === 'decreasing' ? '↘' : '→';
    const word = t.dir === 'stable' ? 'Stable' : TREND_WORDS[key][t.dir];
    const sure = t.dir === 'stable' ? '' : t.significant ? ' (clear trend)' : ' (weak trend)';
    return `<span class="tl-trend ${t.dir}"><span aria-hidden="true">${arrow}</span> ${word}</span>` +
      help(`Trend = the direction over 20 years, from a straight line through the yearly values${sure ? '. "' + sure.trim().slice(1, -1) + '": ' + (t.significant ? 'the change is bigger than normal year-to-year ups and downs' : 'the change could be normal year-to-year variation') : ''}.`);
  }
  const SOIL_WORD = (v) => (v == null ? '' : v < 0.35 ? 'dry' : v > 0.6 ? 'wet' : 'normal');

  function renderWeather() {
    const el = $('wxCard');
    if (!el) return;
    const w = state.weather;
    if (state.weatherErr) { el.innerHTML = '<div class="k">Weather now</div><p class="tl-msg">The weather service could not be reached. <button type="button" class="btn-sm tl-retry">Try again</button></p>'; return; }
    if (!w) { el.innerHTML = '<div class="k">Weather now</div><p class="tl-msg">Loading…</p>'; return; }
    const icon = w.icon && /^https:\/\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" width="44" height="44">` : '';
    const unitIf = (v, u) => (v == null || !isFinite(v) ? '' : `<small>${u}</small>`);
    el.innerHTML = `
      <div class="k">Weather now${w.place ? ' · ' + esc(w.place) : ''}</div>
      <div class="wx-main">${icon}<div><div class="wx-temp">${fmt(w.temperature)}${unitIf(w.temperature, '°C')}</div><div class="wx-desc">${esc((w.description || '').trim())}</div></div></div>
      <dl class="wx-stats">
        <div><dt>Humidity</dt><dd>${fmt(w.humidity)}${unitIf(w.humidity, '%')}</dd></div>
        <div><dt>Wind</dt><dd>${fmt(w.windSpeed)}${unitIf(w.windSpeed, 'km/h')}</dd></div>
        <div><dt>Feels like</dt><dd>${fmt(w.feelsLike)}${unitIf(w.feelsLike, '°C')}</dd></div>
        <div><dt>Rain today</dt><dd>${fmt(w.precip, 1)}${unitIf(w.precip, 'mm')}</dd></div>
      </dl>`;
  }

  function renderCharts() {
    const a = state.analysis;
    CHARTS.forEach((c) => {
      const box = $(c.canvas).closest('.tl-chart');
      if (charts[c.key]) { charts[c.key].destroy(); delete charts[c.key]; }
      const head = box.querySelector('.tl-trend-slot'), stat = box.querySelector('.tl-stat'), msg = box.querySelector('.tl-msg');
      if (!a) {
        head.innerHTML = ''; stat.textContent = '';
        msg.innerHTML = state.powerErr
          ? 'NASA POWER could not be reached and no saved copy exists for this area. <button type="button" class="btn-sm tl-retry">Try again</button>'
          : 'Loading 20 years of NASA POWER data…';
        msg.hidden = false;
        return;
      }
      msg.hidden = true;
      const t = a.trends[c.key], ty = a.thisYear, cmp = ty[c.key];
      const unit = c.key === 'rain' ? ' mm' : c.key === 'temp' ? ' °C' : '';
      head.innerHTML = trendBadge(t, c.key);
      const gap = c.key === 'temp' ? `${signed(cmp.diff, 1)} °C` : `${signed(cmp.pct)}%`;
      const big = c.key === 'soil' ? `${fmt(cmp.now, 2)} <small>${SOIL_WORD(cmp.now)}</small>` : `${fmt(cmp.now, c.dec)}<small>${unit}</small>`;
      stat.innerHTML = `<span class="tl-big">${big}</span>` +
        `<span class="tl-cmp">${ty.year}${ty.partial ? ` (${esc(ty.span)})` : ''} · usual for these months: ${fmt(cmp.norm, c.dec)}${unit} (${gap})</span>`;
      const labels = ty.year > a.years[a.years.length - 1] ? [...a.years, ty.year] : a.years.slice();
      const pad = labels.length - a.years.length;
      const yearlyData = [...a.yearly[c.key], ...Array(pad).fill(null)];
      const trendData = labels.map((y) => t.intercept + t.slope * y);
      const nowData = labels.map((y) => (y === ty.year ? ty.marker[c.key] : null));
      charts[c.key] = new Chart($(c.canvas), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Yearly value', data: yearlyData, borderColor: c.color, backgroundColor: c.color + '22', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: c.color, fill: true, tension: 0.3, spanGaps: true },
            { label: 'Trend', data: trendData, borderColor: '#eaeeff', borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, fill: false },
            { label: `${ty.year}${ty.partial ? ' (same-month comparison)' : ''}`, data: nowData, borderColor: '#D4F20C', backgroundColor: '#D4F20C', pointRadius: 6, pointHoverRadius: 8, pointBorderColor: '#0A1020', pointBorderWidth: 2, showLine: false },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#0d1530', borderColor: 'rgba(110,135,255,0.38)', borderWidth: 1, titleColor: '#eaeeff', bodyColor: '#aab4da', padding: 9,
              filter: (item) => item.parsed.y != null,
              callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y, c.dec)}${unit}` },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, color: '#7480ab', font: { size: 10 } } },
            y: { grid: { color: 'rgba(110,135,255,0.1)' }, ticks: { maxTicksLimit: 4, color: '#7480ab', font: { size: 10 } }, beginAtZero: c.key === 'rain' },
          },
        },
      });
    });
  }

  function renderPanel() {
    const panel = $('timeline');
    if (!panel) return;
    panel.hidden = !current;
    document.body.classList.toggle('tl-open', !!current && !panel.classList.contains('collapsed'));
    if (!current) return;
    $('tlField').textContent = current.name;
    // Saved copy in use (live NASA POWER failed): say so, with its date
    const p = state.power, note = $('tlStale');
    if (note) { note.hidden = !(p && p.stale); note.textContent = p && p.stale ? `Offline copy from ${String(p.savedAt || '').slice(0, 10)}` : ''; }
    renderWeather();
    renderCharts();
  }

  // ── Fire detections on the map ──
  function setupFireLayers() {
    map.addSource('fires', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const color = ['match', ['get', 'sensor'], 'MODIS', SENSOR_COLOR.MODIS, SENSOR_COLOR.VIIRS];
    map.addLayer({ id: 'fires-halo', type: 'circle', source: 'fires', paint: { 'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 12, 14], 'circle-blur': 1, 'circle-opacity': 0.55 } });
    map.addLayer({ id: 'fires-dot', type: 'circle', source: 'fires', paint: { 'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 12, 5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } });
    map.on('click', 'fires-dot', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ closeButton: false, className: 'fire-popup' }).setLngLat(e.lngLat)
        .setHTML(`<b>Fire detection · ${esc(p.sensor)}</b><br>${esc(p.satellite)} · ${esc(p.date)} ${esc(p.time)} UTC<br>Confidence: ${esc(p.confidence)} · Power: ${fmt(+p.frp, 1)} MW<br>${fmt(+p.dist, 1)} km from the field`)
        .addTo(map);
    });
    map.on('mouseenter', 'fires-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'fires-dot', () => { map.getCanvas().style.cursor = ''; });
    const toggle = $('lyrFires');
    if (toggle) toggle.addEventListener('change', renderFires);
  }

  function renderFires() {
    if (!map.getSource('fires')) return;
    const on = !$('lyrFires') || $('lyrFires').checked;
    ['fires-halo', 'fires-dot'].forEach((l) => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
    firePins.forEach((m) => m.remove());
    firePins = [];
    const f = state.firms;
    const feats = f && current ? f.list.map((d) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      properties: { sensor: d.sensor, satellite: d.satellite || '', date: d.date, time: String(d.time || '').padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2'), confidence: String(d.confidence || '–'), frp: d.frp, dist: d.dist },
    })) : [];
    map.getSource('fires').setData({ type: 'FeatureCollection', features: feats });
    // Labeled pins for the three nearest detections
    if (on && f && current && window.FSStyles) {
      f.list.slice(0, 3).forEach((d) => {
        const el = window.FSStyles.createPin({ kind: 'fire', title: `${d.sensor} fire`, sub: `${d.date} · ${fmt(d.dist, d.dist < 10 ? 1 : 0)} km` });
        firePins.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 5], opacityWhenCovered: '1' }).setLngLat([d.lon, d.lat]).addTo(map));
      });
    }
  }

  // ── Loading ──
  function recompute() {
    scoreRisks();
    renderPanel();
    renderFires();
    if (opts.rerender) opts.rerender();
  }

  async function load(field) {
    const my = ++token;
    const q = `lat=${field.centroid[1].toFixed(4)}&lon=${field.centroid[0].toFixed(4)}`;
    const hit = cache.get(field.key) || {};
    Object.assign(state, { power: hit.power || null, firms: hit.firms || null, weather: hit.weather || null, powerErr: false, firmsErr: false, weatherErr: false, analysis: hit.power ? analyze(hit.power) : null, risks: null });
    recompute();
    const keep = (part, value) => { cache.set(field.key, { ...(cache.get(field.key) || {}), [part]: value }); };
    const jobs = [];
    // One automatic retry after 3 s, so a single hiccup doesn't leave the panel empty
    const getRetry = (url, ms) => getJson(url, ms).catch(() => new Promise((r) => setTimeout(r, 3000)).then(() => {
      if (my !== token) throw new Error('stale');
      return getJson(url, ms);
    }));
    if (!hit.power) jobs.push(getRetry(`/api/power?${q}`, 100000).then((d) => { if (my !== token) return; state.power = d; state.analysis = analyze(d); keep('power', d); })
      .catch(() => { if (my === token) state.powerErr = true; }).finally(() => { if (my === token) recompute(); }));
    if (!hit.weather) jobs.push(getRetry(`/api/weather?${q}`, 30000).then((d) => { if (my !== token) return; state.weather = d; keep('weather', d); })
      .catch(() => { if (my === token) state.weatherErr = true; }).finally(() => { if (my === token) recompute(); }));
    if (!hit.firms) {
      const F = rules.fire, range = Math.max(0.3, (F.radiusKm / 111) * 1.15);
      jobs.push(getJson(`/api/firms?${q}&range=${range.toFixed(2)}&days=${F.days}`, 60000).then((d) => {
        if (my !== token) return;
        const list = [...(d.viirs || []), ...(d.modis || [])].map((x) => ({ ...x, dist: haversineKm(field.centroid, [x.lon, x.lat]) })).sort((a, b) => a.dist - b.dist);
        const inR = list.filter((x) => x.dist <= F.radiusKm);
        state.firms = { list: inR, days: d.days, inRadius: inR.length, near: inR.filter((x) => x.dist <= F.nearKm).length, nearestKm: inR.length ? inR[0].dist : null, viirs: inR.filter((x) => x.sensor === 'VIIRS').length, modis: inR.filter((x) => x.sensor === 'MODIS').length };
        keep('firms', state.firms);
      }).catch(() => { if (my === token) state.firmsErr = true; }).finally(() => { if (my === token) recompute(); }));
    }
    await Promise.all(jobs);
  }

  /** Called by the map on every render with the selected field (or null). */
  function setField(field) {
    if (!rules || !map) return;
    if (!field) {
      if (!current) return;
      current = null; token++;
      Object.assign(state, { power: null, firms: null, weather: null, analysis: null, risks: null });
      renderPanel(); renderFires();
      return;
    }
    // POWER is a ~50 km grid and FIRMS a 50 km search, so a rounded centroid is the cache key
    const key = `${field.centroid[1].toFixed(2)},${field.centroid[0].toFixed(2)}`;
    if (current && current.id === field.id && current.key === key) {
      if (current.name !== field.name) { current.name = field.name; if ($('tlField')) $('tlField').textContent = field.name; }
      return;
    }
    current = { id: field.id, name: field.name, centroid: field.centroid, key };
    load(current);
  }

  async function init(m, options) {
    map = m; opts = options || {};
    setupFireLayers();
    // "Try again" after a failed load: forget the failed parts and request them again
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('.tl-retry') || !current) return;
      load(current);
    });
    // Open/close of the charts panel is handled by ui.js
    try { rules = await getJson('/api/risk-rules', 15000); }
    catch (_) { rules = null; console.warn('[climate] risk rules unavailable'); return; }
    if (opts.rerender) opts.rerender(); // pick up a field that was selected before the rules arrived
  }

  window.FieldClimate = { init, setField, badgesHtml, state, get rules() { return rules; }, get currentId() { return current ? current.id : null; } };
})();
