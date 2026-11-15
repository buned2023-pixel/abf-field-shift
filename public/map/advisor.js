/*
 * Stage 3 — Crop advisor for the selected field. Rule-based, no AI:
 * rules come from config/crops.json, climate from NASA POWER (Stage 2), terrain from the DEM (Stage 1).
 *
 * Output: top 3 crops with a 0–100 suitability score and reasons that cite the numbers,
 * a 3-year rotation that keeps the soil fertile, a planting window per crop, and warnings
 * for steep slopes and drought risk. Advisory only.
 */
(function () {
  'use strict';

  const STORE_KEY = 'fieldshift.advisor.v1';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MID_DAY = MONTH_DAYS.map((d, i) => MONTH_DAYS.slice(0, i).reduce((s, x) => s + x, 0) + 15); // day of year of each 15th

  let rules = null, opts = {};
  let inputs = {};   // fieldId → { water, irrigation, prefs: [cropId] }
  let open = true;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !isFinite(n) ? 'No data' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const help = (tip) => `<button type="button" class="help" data-tip="${esc(tip)}" aria-label="Help: ${esc(tip)}">?</button>`;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const list = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);

  function load() { try { inputs = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { inputs = {}; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(inputs)); } catch (_) { /* storage blocked: keep in memory */ } }
  function inputsFor(id) {
    if (!inputs[id]) inputs[id] = { water: 'medium', irrigation: false, prefs: [] };
    return inputs[id];
  }

  // 1 inside [min, max], falling linearly to 0 over `tol` outside it
  function rangeFit(v, range, tol) {
    if (v < range[0]) return clamp01(1 - (range[0] - v) / tol);
    if (v > range[1]) return clamp01(1 - (v - range[1]) / tol);
    return 1;
  }

  // ── Planting window from the 20-year monthly temperature normals ──
  function tempAtDay(normTemp, day) {
    const d = ((day - 1) % 365) + 1;
    for (let i = 0; i < 12; i++) {
      const a = MID_DAY[i], b = i === 11 ? MID_DAY[0] + 365 : MID_DAY[i + 1];
      const dd = d < MID_DAY[0] ? d + 365 : d;
      if (dd >= a && dd <= b) return normTemp[i] + ((normTemp[(i + 1) % 12] - normTemp[i]) * (dd - a)) / (b - a);
    }
    return normTemp[0];
  }
  function dateOf(day) {
    let d = ((day - 1) % 365) + 1, m = 0;
    while (d > MONTH_DAYS[m]) { d -= MONTH_DAYS[m]; m++; }
    return { month: m, text: `${d} ${MONTHS[m]}` };
  }
  function plantingWindow(crop, clim, irrigated) {
    const s = crop.sowing, [tMin, tMax] = s.tempC;
    let start = null, end = null;
    if (s.season === 'spring') { // temperature rising: start when it reaches tMin, stop when it passes tMax
      for (let d = 32; d <= 200; d++) { if (tempAtDay(clim.temp, d) >= tMin) { start = d; break; } }
      if (start == null) return { ok: false, text: `Too cool here: the normal temperature never reaches the ${tMin} °C it needs by July.` };
      for (let d = start; d <= start + 50; d++) { end = d; if (tempAtDay(clim.temp, d) >= tMax) break; }
    } else { // autumn: temperature falling: start once it is down to tMax, stop when it drops below tMin
      for (let d = 227; d <= 365; d++) { if (tempAtDay(clim.temp, d) <= tMax) { start = d; break; } }
      if (start == null) return { ok: false, text: `Autumn stays above ${tMax} °C here: too warm for autumn sowing.` };
      for (let d = start; d <= start + 50; d++) { end = d; if (tempAtDay(clim.temp, d) <= tMin) break; }
    }
    if (end - start < 10) end = start + 10;
    const a = dateOf(start), b = dateOf(end), rain = clim.rainMm[a.month];
    let text = `${s.what} ${a.text} – ${b.text}: normal temperature is ${fmt(tempAtDay(clim.temp, start), 0)}–${fmt(tempAtDay(clim.temp, end), 0)} °C then, with about ${fmt(rain)} mm of rain in ${MONTHS[a.month]}.`;
    if (rain < rules.warnings.drySowingMonthMm) text += irrigated ? ' Little rain then: irrigate at planting.' : ' Little rain then: needs watering to establish.';
    return { ok: true, text };
  }

  // ── Scoring ──
  function evaluate(field, inp, a, risks) {
    const S = rules.scoring, W = S.weights, T = S.tolerance;
    const rainYear = a.trends.rain.mean;
    const clim = {
      temp: a.norm.temp, tmax: a.norm.tmax, soil: a.norm.soil,
      rainMm: a.norm.precip.map((p, i) => p * MONTH_DAYS[i]),
    };
    const extra = rules.water[inp.irrigation ? 'irrigated' : 'rainfed'][inp.water] || 0;
    const supply = rainYear + extra;
    const elev = field.terrain.meanElevation, slope = field.terrain.meanSlope;
    const drought = risks && risks.drought ? risks.drought.level : 'low';

    const results = rules.crops.map((c) => {
      const gm = c.growMonths.map((m) => m - 1);
      const span = `${MONTHS[gm[0]]}–${MONTHS[gm[gm.length - 1]]}`;
      const sTemp = mean(gm.map((m) => clim.temp[m])), sTmax = Math.max(...gm.map((m) => clim.tmax[m]));
      let sSoil = mean(gm.map((m) => clim.soil[m]));
      const reasons = [];

      const fT = rangeFit(sTemp, c.temperatureC, T.temperatureC);
      reasons.push({ ok: fT >= 0.99, text: `Growing-season temperature (${span}) is ${fmt(sTemp, 1)} °C; it needs ${c.temperatureC[0]}–${c.temperatureC[1]} °C.` });
      const over = sTmax - c.maxTempLimitC;
      if (over > 0) reasons.push({ ok: false, text: `Hottest month reaches ${fmt(sTmax, 1)} °C, above its ${c.maxTempLimitC} °C limit.` });

      let fW = 1;
      const waterText = `Rain ${fmt(rainYear)} mm/yr${extra ? ` + ${inp.irrigation ? 'irrigation' : 'other water'} ${fmt(extra)} mm = ${fmt(supply)} mm` : ''}`;
      if (supply < c.waterMm[0]) {
        fW = clamp01(1 - (((c.waterMm[0] - supply) / c.waterMm[0]) * 100) / T.waterPct);
        reasons.push({ ok: false, text: `${waterText}: short of the ${c.waterMm[0]}–${c.waterMm[1]} mm it needs.` });
      } else if (rainYear > c.waterMm[1]) {
        fW = clamp01(1 - (((rainYear - c.waterMm[1]) / c.waterMm[1]) * 100) / T.waterPct);
        reasons.push({ ok: false, text: `Rain ${fmt(rainYear)} mm/yr is more than its ${c.waterMm[1]} mm upper limit.` });
      } else reasons.push({ ok: true, text: `${waterText}: covers the ${c.waterMm[0]}–${c.waterMm[1]} mm it needs.` });

      const soilNote = inp.irrigation && sSoil < rules.water.irrigatedSoilMoistureFloor;
      if (soilNote) sSoil = rules.water.irrigatedSoilMoistureFloor;
      const fS = rangeFit(sSoil, c.soilMoisture, T.soil);
      reasons.push({ ok: fS >= 0.99, text: `Root soil moisture in season is ${fmt(sSoil, 2)}${soilNote ? ' (with irrigation)' : ''}; it likes ${c.soilMoisture[0]}–${c.soilMoisture[1]}.` });

      const fE = rangeFit(elev, c.elevationM, T.elevationM);
      reasons.push({ ok: fE >= 0.99, text: `Field elevation ${fmt(elev)} m; it grows at ${fmt(c.elevationM[0])}–${fmt(c.elevationM[1])} m.` });

      const fL = slope <= c.maxSlopeDeg ? 1 : clamp01(1 - (slope - c.maxSlopeDeg) / T.slopeDeg);
      reasons.push({ ok: fL >= 0.99, text: `Mean slope ${fmt(slope, 1)}°; its limit is ${c.maxSlopeDeg}°.` });

      let score = W.temperature * fT + W.water * fW + W.soil * fS + W.elevation * fE + W.slope * fL;
      if (over > 0) score -= over * S.heatPenaltyPerDegC;
      const dp = !inp.irrigation && S.droughtPenalty[drought] ? (S.droughtPenalty[drought][c.waterNeed] || 0) : 0;
      if (dp) { score -= dp; reasons.push({ ok: false, text: `Drought risk is ${drought} and the field is not irrigated: risky for a crop with ${c.waterNeed} water need.` }); }
      const preferred = inp.prefs.includes(c.id);
      if (preferred) score += S.preferenceBonus;
      score = Math.round(Math.max(0, Math.min(100, score)));
      return { crop: c, score, reasons, preferred, window: plantingWindow(c, clim, inp.irrigation) };
    }).sort((x, y) => y.score - x.score);

    return { results, top: results.slice(0, 3), rotation: buildRotation(results), warnings: buildWarnings(field, inp, results, drought), rainYear, supply };
  }

  // ── 3-year rotation: change family every year, fit in a legume, follow it with a feeder ──
  function buildRotation(results) {
    const R = rules.rotation;
    let pool = results.filter((r) => !r.crop.perennialYears && r.score >= R.minScore);
    if (pool.length < R.years) pool = results.filter((r) => !r.crop.perennialYears);
    const plan = [];
    for (let y = 0; y < R.years && pool.length; y++) {
      const prev = plan[y - 1], hasLegume = plan.some((p) => p.crop.family === 'legume');
      let best = null, bestV = -Infinity, why = '';
      pool.forEach((r) => {
        if (plan.some((p) => p.crop.id === r.crop.id)) return;
        let v = r.score, note = '';
        if (prev && prev.crop.family === r.crop.family) v -= R.sameFamilyPenalty;
        if (y > 0 && !hasLegume && r.crop.family === 'legume') { v += R.legumeBonus; note = 'legume'; }
        if (prev && prev.crop.soilEffect.nitrogen > 0 && r.crop.soilEffect.nitrogen < 0) { v += R.afterLegumeFeederBonus; note = 'feeder'; }
        if (v > bestV) { bestV = v; best = r; why = note; }
      });
      if (!best) break;
      let reason;
      if (y === 0) reason = `Best-scoring annual crop for this field (${best.score}/100).`;
      else if (why === 'legume') reason = `Legume after ${prev.crop.name.toLowerCase()}: puts back the nitrogen the ${prev.crop.family} used.`;
      else if (why === 'feeder') reason = `Uses the nitrogen left by ${prev.crop.name.toLowerCase()}; a different family breaks pest and disease cycles.`;
      else reason = `Different family from ${prev.crop.name.toLowerCase()} (${prev.crop.family} → ${best.crop.family}): breaks pest and disease cycles.`;
      plan.push({ crop: best.crop, score: best.score, reason });
    }
    const balance = plan.reduce((s, p) => s + p.crop.soilEffect.nitrogen, 0);
    return { plan, balance, hasLegume: plan.some((p) => p.crop.family === 'legume') };
  }

  function buildWarnings(field, inp, results, drought) {
    const out = [], Wn = rules.warnings, slope = field.terrain.meanSlope;
    const holders = results.filter((r) => r.crop.protectsSlopes).map((r) => r.crop.name.toLowerCase());
    if (slope >= Wn.verySteepSlopeDeg) out.push(`Very steep: mean slope ${fmt(slope, 1)}°. High erosion risk; avoid ploughed row crops. Terraces or permanent cover (${list(holders)}) hold the soil.`);
    else if (slope >= Wn.steepSlopeDeg) out.push(`Steep: mean slope ${fmt(slope, 1)}°. Erosion risk; plough and plant along the contour and keep the soil covered. Best slope holders: ${list(holders)}.`);
    const lowNeed = results.filter((r) => r.crop.waterNeed === 'low').slice(0, 3).map((r) => r.crop.name.toLowerCase());
    if (drought === 'high') out.push(`Drought risk is HIGH for this field. ${inp.irrigation ? 'Plan irrigation carefully and' : 'Without irrigation,'} prefer low-water crops: ${list(lowNeed)}.`);
    else if (drought === 'medium' && !inp.irrigation) out.push(`Drought risk is medium and the field is not irrigated: low-water crops (${list(lowNeed)}) are the safer choice.`);
    return out;
  }

  // ── Water for one crop: need, rain, irrigation (1 mm on 1 ha = 10 m³), nearest water ──
  const dist = (m) => (m < 1000 ? `${fmt(Math.round(m / 10) * 10)} m` : `${fmt(m / 1000, 1)} km`);
  function waterHtml(crop, rainMm, field, w) {
    const need = crop.waterNeedMmYear;
    if (!need) return '';
    const ha = field.geo.areaHa;
    const irr = Math.max(0, need - rainMm);
    let near;
    if (w.status === 'loading') near = 'looking for the nearest river, canal or lake…';
    else if (w.status === 'ok') {
      const what = w.type === 'lake' ? 'lake / reservoir' : w.type;
      near = w.distanceM === 0 ? `${what} at the field` : `${what}, ${dist(w.distanceM)}`;
      near += ` <span class="adv-access ${w.access.toLowerCase()}">${w.access}</span>`;
    } else if (w.status === 'none') near = `none within ${fmt(window.FieldWater.SEARCH_M / 1000)} km <span class="adv-access hard">Hard</span>`;
    else near = 'unknown';
    return `
      <dl class="adv-water">
        <div><dt>Water needed</dt><dd>${fmt(need)} mm per year <small>(${fmt(need * 10)} m³ per ha, approx.)</small></dd></div>
        <div><dt>Water from rain</dt><dd>${fmt(rainMm)} mm per year <small>(20-year average)</small></dd></div>
        <div><dt>Irrigation needed ${help('Water you must add yourself: water needed minus water from rain. 1 mm on 1 hectare = 10 m³.')}</dt><dd>${irr > 0 ? `${fmt(irr)} mm per year <small>= ${fmt(irr * 10 * ha)} m³ per year for this field</small>` : 'None: rain is enough'}</dd></div>
        <div><dt>Nearest water</dt><dd>${near}</dd></div>
      </dl>`;
  }

  // One short line: why this crop fits, or its main limit
  const LIMITS = [
    [/^Growing-season temperature/, 'the temperature is outside its best range'], [/^Hottest month/, 'summers are too hot for it'],
    [/short of/, 'it needs more water than you have'], [/more than its/, 'there is too much rain for it'],
    [/^Root soil moisture/, 'the soil is too dry or too wet for it'], [/^Field elevation/, 'the field is too high or too low for it'],
    [/^Mean slope/, 'the field is too steep for it'], [/^Drought risk/, 'it is risky in a drought without irrigation'],
  ];
  function shortReason(t) {
    const bad = t.reasons.find((x) => !x.ok);
    if (!bad) return 'Good match for the weather, water and land of this field.';
    const m = LIMITS.find(([re]) => re.test(bad.text));
    return `${t.score >= 60 ? 'Good choice, but' : 'Possible, but'} ${m ? m[1] : 'one condition is not ideal'}.`;
  }

  // ── UI ──
  function controlsHtml(id, inp) {
    const seg = ['low', 'medium', 'high'].map((v) => `<button type="button" data-adv="water" data-v="${v}" class="${inp.water === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
    const chips = rules.crops.map((c) => `<button type="button" class="adv-chip${inp.prefs.includes(c.id) ? ' on' : ''}" data-adv="pref" data-v="${c.id}" aria-pressed="${inp.prefs.includes(c.id)}">${esc(c.name)}</button>`).join('');
    return `
      <div class="adv-row"><span class="label">Water you have</span><div class="seg" role="group" aria-label="Water availability">${seg}</div></div>
      <label class="toggle adv-irr"><input type="checkbox" data-adv="irrigation" ${inp.irrigation ? 'checked' : ''} /><span class="sw"></span>Irrigation available</label>
      <div class="adv-pref"><span class="label">Crops you prefer <small>(optional)</small></span><div class="adv-chips">${chips}</div></div>`;
  }

  function html(id, field) {
    if (!rules || !id) return '';
    const inp = inputsFor(id);
    const C = window.FieldClimate;
    const a = C && C.currentId === id ? C.state.analysis : null;
    let body;
    if (!field.terrain) body = '<p class="adv-wait">Waiting for the terrain analysis (elevation and slope)…</p>';
    else if (!a) body = `<p class="adv-wait">${C && C.state.powerErr ? 'NASA climate data is unavailable right now, so crops cannot be scored.' : 'Waiting for NASA climate data…'}</p>`;
    else {
      const r = evaluate(field, inp, a, C.state.risks);
      if (opts.setCrop && r.top[0]) { const c = r.top[0].crop; opts.setCrop(id, { id: c.id, color: c.color, color2: c.color2, height: c.rowHeightM }); }
      const warn = r.warnings.map((w) => `<div class="adv-warn"><span aria-hidden="true">⚠</span><span>${esc(w)}</span></div>`).join('');
      const wInfo = window.FieldWater ? window.FieldWater.info(id, field) : { status: 'unknown' };
      const cards = r.top.map((t, i) => `
        <div class="adv-crop">
          <div class="adv-crop-head"><span class="adv-rank">${i + 1}</span><span class="adv-swatch" style="background:${t.crop.color}"></span><b>${esc(t.crop.name)}</b>${t.preferred ? '<span class="adv-tag">your pick</span>' : ''}<span class="adv-score">${t.score}<small>/100</small></span></div>
          <div class="adv-bar" role="img" aria-label="Match score ${t.score} out of 100"><span style="width:${t.score}%"></span></div>
          <p class="adv-why">${esc(shortReason(t))}</p>
          ${waterHtml(t.crop, r.rainYear, field, wInfo)}
          <details class="adv-more"><summary>More details</summary>
            <ul class="adv-reasons">${t.reasons.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${esc(x.text)}</li>`).join('')}</ul>
            <p class="adv-plant"><b>Planting:</b> ${esc(t.window.text)}</p>
            <p class="adv-soil">${esc(t.crop.soilEffect.note)}${t.crop.perennialYears ? ` Stays ${t.crop.perennialYears >= 10 ? 'for decades' : 'about ' + t.crop.perennialYears + ' years'}: not part of a yearly rotation.` : ''}</p>
          </details>
        </div>`).join('');
      const rot = r.rotation;
      const steps = rot.plan.map((p, i) => `<li><span class="adv-year">Year ${i + 1}</span><span class="adv-swatch" style="background:${p.crop.color}"></span><b>${esc(p.crop.name)}</b><span class="adv-n ${p.crop.soilEffect.nitrogen > 0 ? 'plus' : 'minus'}">${p.crop.soilEffect.nitrogen > 0 ? 'adds nitrogen' : 'uses nitrogen'}</span><p>${esc(p.reason)}</p></li>`).join('');
      const fert = rot.hasLegume
        ? (rot.balance < 0 ? 'The legume year gives back part of what the other crops take; add manure or compost before the heaviest feeder.' : 'The legume year puts back at least as much nitrogen as the other crops take.')
        : 'No legume scored well enough here: add manure or compost every year to keep the soil fertile.';
      body = `
        ${warn}
        <div class="adv-sub">Best 3 crops for this field ${help('Score from 0 to 100: how well each crop fits this field’s temperature, water, soil moisture, height and slope. Highest first.')}</div>
        ${cards}
        <div class="adv-sub">3-year rotation</div>
        <ol class="adv-rot">${steps}</ol>
        <p class="adv-soil">${fert}</p>`;
    }
    return `
      <details class="metric wide adv" id="advBox" ${open ? 'open' : ''}>
        <summary><span class="k">Crop advisor</span><svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/></svg></summary>
        ${controlsHtml(id, inp)}
        ${body}
        <p class="adv-note">Advisory tool, confirm with a local agronomist.</p>
      </details>`;
  }

  async function init(options) {
    opts = options || {};
    load();
    // One delegated listener: the overview is re-rendered often, so per-element listeners would be lost
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('[data-adv]');
      if (!el || el.tagName === 'INPUT') return;
      const id = opts.getSelectedId && opts.getSelectedId();
      if (!id) return;
      const inp = inputsFor(id);
      if (el.dataset.adv === 'water') inp.water = el.dataset.v;
      else if (el.dataset.adv === 'pref') inp.prefs = inp.prefs.includes(el.dataset.v) ? inp.prefs.filter((x) => x !== el.dataset.v) : [...inp.prefs, el.dataset.v];
      save();
      if (opts.rerender) opts.rerender();
    });
    document.addEventListener('change', (e) => {
      if (!e.target.dataset || e.target.dataset.adv !== 'irrigation') return;
      const id = opts.getSelectedId && opts.getSelectedId();
      if (!id) return;
      inputsFor(id).irrigation = e.target.checked;
      save();
      if (opts.rerender) opts.rerender();
    });
    document.addEventListener('toggle', (e) => { if (e.target.id === 'advBox') open = e.target.open; }, true);
    try {
      const r = await fetch('/api/crop-rules');
      rules = await r.json();
      if (!r.ok || !rules.crops) throw new Error('bad rules');
    } catch (_) { rules = null; console.warn('[advisor] crop rules unavailable'); return; }
    if (opts.rerender) opts.rerender();
  }

  window.FieldAdvisor = { init, html, get rules() { return rules; } };
})();
