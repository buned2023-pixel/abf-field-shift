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
  const I18N = window.FSi18n, t = I18N.t;
  const mon = (i) => I18N.month(i);
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MID_DAY = MONTH_DAYS.map((d, i) => MONTH_DAYS.slice(0, i).reduce((s, x) => s + x, 0) + 15); // day of year of each 15th

  let rules = null, opts = {};
  let inputs = {};   // fieldId → { water, irrigation, prefs: [cropId] }
  let open = true;
  const topByField = {}; // fieldId → ids of the best 3 crops (used by the field's DISEASE badge)

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = I18N.fmt;
  const help = (tip) => `<button type="button" class="help" data-tip="${esc(tip)}" aria-label="${esc(t('common.helpAria', { tip }))}">?</button>`;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const list = (arr) => I18N.list(arr);
  // Crop texts from the language files (crop.<id>.name / .what / .note), English from crops.json as the last fallback
  const cropText = (c, part, fallback) => (I18N.has(`crop.${c.id}.${part}`) ? t(`crop.${c.id}.${part}`) : fallback);
  const cropName = (c) => cropText(c, 'name', c.name);
  const cropLower = (c) => cropText(c, 'lower', c.name.toLowerCase());
  const family = (f) => (I18N.has('family.' + f) ? t('family.' + f) : f);

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
    return { month: m, text: I18N.dayMonth(m, d) };
  }
  function plantingWindow(crop, clim, irrigated) {
    const s = crop.sowing, [tMin, tMax] = s.tempC;
    let start = null, end = null;
    if (s.season === 'spring') { // temperature rising: start when it reaches tMin, stop when it passes tMax
      for (let d = 32; d <= 200; d++) { if (tempAtDay(clim.temp, d) >= tMin) { start = d; break; } }
      if (start == null) return { ok: false, text: t('adv.tooCool', { t: fmt(tMin) }) };
      for (let d = start; d <= start + 50; d++) { end = d; if (tempAtDay(clim.temp, d) >= tMax) break; }
    } else { // autumn: temperature falling: start once it is down to tMax, stop when it drops below tMin
      for (let d = 227; d <= 365; d++) { if (tempAtDay(clim.temp, d) <= tMax) { start = d; break; } }
      if (start == null) return { ok: false, text: t('adv.tooWarm', { t: fmt(tMax) }) };
      for (let d = start; d <= start + 50; d++) { end = d; if (tempAtDay(clim.temp, d) <= tMin) break; }
    }
    if (end - start < 10) end = start + 10;
    const a = dateOf(start), b = dateOf(end), rain = clim.rainMm[a.month];
    let text = t('adv.window', { what: cropText(crop, 'what', s.what), from: a.text, to: b.text, t1: fmt(tempAtDay(clim.temp, start), 0), t2: fmt(tempAtDay(clim.temp, end), 0), rain: fmt(rain), month: I18N.monthLong(a.month) });
    if (rain < rules.warnings.drySowingMonthMm) text += ' ' + t(irrigated ? 'adv.dryIrr' : 'adv.dryNoIrr');
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
      const span = `${mon(gm[0])}–${mon(gm[gm.length - 1])}`;
      const sTemp = mean(gm.map((m) => clim.temp[m])), sTmax = Math.max(...gm.map((m) => clim.tmax[m]));
      let sSoil = mean(gm.map((m) => clim.soil[m]));
      const reasons = [];

      const fT = rangeFit(sTemp, c.temperatureC, T.temperatureC);
      reasons.push({ ok: fT >= 0.99, kind: 'temp', text: t('adv.r.temp', { span, t: fmt(sTemp, 1), a: fmt(c.temperatureC[0]), b: fmt(c.temperatureC[1]) }) });
      const over = sTmax - c.maxTempLimitC;
      if (over > 0) reasons.push({ ok: false, kind: 'hot', text: t('adv.r.hot', { t: fmt(sTmax, 1), max: fmt(c.maxTempLimitC) }) });

      let fW = 1;
      const waterText = t('adv.r.rain', { rain: fmt(rainYear) }) + (extra ? ' ' + t('adv.r.extra', { src: t(inp.irrigation ? 'adv.r.srcIrr' : 'adv.r.srcOther'), mm: fmt(extra), sum: fmt(supply) }) : '');
      if (supply < c.waterMm[0]) {
        fW = clamp01(1 - (((c.waterMm[0] - supply) / c.waterMm[0]) * 100) / T.waterPct);
        reasons.push({ ok: false, kind: 'short', text: t('adv.r.short', { water: waterText, a: fmt(c.waterMm[0]), b: fmt(c.waterMm[1]) }) });
      } else if (rainYear > c.waterMm[1]) {
        fW = clamp01(1 - (((rainYear - c.waterMm[1]) / c.waterMm[1]) * 100) / T.waterPct);
        reasons.push({ ok: false, kind: 'wet', text: t('adv.r.wet', { rain: fmt(rainYear), b: fmt(c.waterMm[1]) }) });
      } else reasons.push({ ok: true, kind: 'water', text: t('adv.r.covers', { water: waterText, a: fmt(c.waterMm[0]), b: fmt(c.waterMm[1]) }) });

      const soilNote = inp.irrigation && sSoil < rules.water.irrigatedSoilMoistureFloor;
      if (soilNote) sSoil = rules.water.irrigatedSoilMoistureFloor;
      const fS = rangeFit(sSoil, c.soilMoisture, T.soil);
      reasons.push({ ok: fS >= 0.99, kind: 'soil', text: t('adv.r.soil', { v: fmt(sSoil, 2), irr: soilNote ? ' ' + t('adv.r.withIrr') : '', a: fmt(c.soilMoisture[0], 2), b: fmt(c.soilMoisture[1], 2) }) });

      const fE = rangeFit(elev, c.elevationM, T.elevationM);
      reasons.push({ ok: fE >= 0.99, kind: 'elev', text: t('adv.r.elev', { v: fmt(elev), a: fmt(c.elevationM[0]), b: fmt(c.elevationM[1]) }) });

      const fL = slope <= c.maxSlopeDeg ? 1 : clamp01(1 - (slope - c.maxSlopeDeg) / T.slopeDeg);
      reasons.push({ ok: fL >= 0.99, kind: 'slope', text: t('adv.r.slope', { v: fmt(slope, 1), max: fmt(c.maxSlopeDeg) }) });

      let score = W.temperature * fT + W.water * fW + W.soil * fS + W.elevation * fE + W.slope * fL;
      if (over > 0) score -= over * S.heatPenaltyPerDegC;
      const dp = !inp.irrigation && S.droughtPenalty[drought] ? (S.droughtPenalty[drought][c.waterNeed] || 0) : 0;
      if (dp) { score -= dp; reasons.push({ ok: false, kind: 'drought', text: t('adv.r.drought', { level: t('risk.levelWord.' + drought), need: t('adv.need.' + c.waterNeed) }) }); }
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
      // Kept as a function: the text is built in the language shown when it is drawn
      const pc = prev && prev.crop, bc = best.crop, sc = best.score, w = why;
      if (y === 0) reason = () => t('adv.rot.first', { score: sc });
      else if (w === 'legume') reason = () => t('adv.rot.legume', { prev: cropLower(pc), family: family(pc.family) });
      else if (w === 'feeder') reason = () => t('adv.rot.feeder', { prev: cropLower(pc) });
      else reason = () => t('adv.rot.change', { prev: cropLower(pc), from: family(pc.family), to: family(bc.family) });
      plan.push({ crop: best.crop, score: best.score, reason });
    }
    const balance = plan.reduce((s, p) => s + p.crop.soilEffect.nitrogen, 0);
    return { plan, balance, hasLegume: plan.some((p) => p.crop.family === 'legume') };
  }

  function buildWarnings(field, inp, results, drought) {
    const out = [], Wn = rules.warnings, slope = field.terrain.meanSlope;
    const holders = results.filter((r) => r.crop.protectsSlopes).map((r) => cropLower(r.crop));
    if (slope >= Wn.verySteepSlopeDeg) out.push(t('adv.w.verySteep', { v: fmt(slope, 1), crops: list(holders) }));
    else if (slope >= Wn.steepSlopeDeg) out.push(t('adv.w.steep', { v: fmt(slope, 1), crops: list(holders) }));
    const lowNeed = results.filter((r) => r.crop.waterNeed === 'low').slice(0, 3).map((r) => cropLower(r.crop));
    if (drought === 'high') out.push(t(inp.irrigation ? 'adv.w.droughtHighIrr' : 'adv.w.droughtHigh', { crops: list(lowNeed) }));
    else if (drought === 'medium' && !inp.irrigation) out.push(t('adv.w.droughtMed', { crops: list(lowNeed) }));
    return out;
  }

  // ── Water for one crop: need, rain, irrigation (1 mm on 1 ha = 10 m³), nearest water ──
  const dist = (m) => (m < 1000 ? `${fmt(Math.round(m / 10) * 10)} ${t('unit.m')}` : `${fmt(m / 1000, 1)} ${t('unit.km')}`);
  function waterHtml(crop, rainMm, field, w) {
    const need = crop.waterNeedMmYear;
    if (!need) return '';
    const ha = field.geo.areaHa;
    const irr = Math.max(0, need - rainMm);
    let near;
    if (w.status === 'loading') near = esc(t('adv.wt.looking'));
    else if (w.status === 'ok') {
      const what = I18N.has('adv.wt.type.' + w.type) ? t('adv.wt.type.' + w.type) : w.type;
      near = esc(w.distanceM === 0 ? t('adv.wt.atField', { what }) : `${what}, ${dist(w.distanceM)}`);
      near += ` <span class="adv-access ${w.access.toLowerCase()}">${esc(t('adv.wt.access.' + w.access.toLowerCase()))}</span>`;
    } else if (w.status === 'none') near = `${esc(t('adv.wt.none', { km: fmt(window.FieldWater.SEARCH_M / 1000) }))} <span class="adv-access hard">${esc(t('adv.wt.access.hard'))}</span>`;
    else near = esc(t('adv.wt.unknown'));
    return `
      <dl class="adv-water">
        <div><dt>${esc(t('adv.wt.need'))}</dt><dd>${esc(t('adv.wt.mmYear', { v: fmt(need) }))} <small>(${esc(t('adv.wt.perHa', { v: fmt(need * 10) }))})</small></dd></div>
        <div><dt>${esc(t('adv.wt.rain'))}</dt><dd>${esc(t('adv.wt.mmYear', { v: fmt(rainMm) }))} <small>(${esc(t('adv.wt.avg20'))})</small></dd></div>
        <div><dt>${esc(t('adv.wt.irr'))} ${help(t('adv.wt.irrTip'))}</dt><dd>${irr > 0 ? `${esc(t('adv.wt.mmYear', { v: fmt(irr) }))} <small>= ${esc(t('adv.wt.field', { v: fmt(irr * 10 * ha) }))}</small>` : esc(t('adv.wt.noIrr'))}</dd></div>
        <div><dt>${esc(t('adv.wt.nearest'))}</dt><dd>${near}</dd></div>
      </dl>`;
  }

  // One short line: why this crop fits, or its main limit
  // The first failed check names the main limit: adv.limit.<kind>
  function shortReason(r) {
    const bad = r.reasons.find((x) => !x.ok);
    if (!bad) return t('adv.goodMatch');
    const limit = I18N.has('adv.limit.' + bad.kind) ? t('adv.limit.' + bad.kind) : t('adv.limit.misc');
    return t(r.score >= 60 ? 'adv.goodBut' : 'adv.possibleBut', { limit });
  }

  // ── UI ──
  function controlsHtml(id, inp) {
    const seg = ['low', 'medium', 'high'].map((v) => `<button type="button" data-adv="water" data-v="${v}" class="${inp.water === v ? 'on' : ''}">${esc(t('adv.level.' + v))}</button>`).join('');
    const chips = rules.crops.map((c) => `<button type="button" class="adv-chip${inp.prefs.includes(c.id) ? ' on' : ''}" data-adv="pref" data-v="${c.id}" aria-pressed="${inp.prefs.includes(c.id)}">${esc(cropName(c))}</button>`).join('');
    return `
      <div class="adv-row"><span class="label">${esc(t('adv.waterHave'))}</span><div class="seg" role="group" aria-label="${esc(t('adv.waterAria'))}">${seg}</div></div>
      <label class="toggle adv-irr"><input type="checkbox" data-adv="irrigation" ${inp.irrigation ? 'checked' : ''} /><span class="sw"></span>${esc(t('adv.irrAvail'))}</label>
      <div class="adv-pref"><span class="label">${esc(t('adv.prefer'))} <small>(${esc(t('adv.optional'))})</small></span><div class="adv-chips">${chips}</div></div>`;
  }

  function html(id, field) {
    if (!rules || !id) return '';
    const inp = inputsFor(id);
    const C = window.FieldClimate;
    const a = C && C.currentId === id ? C.state.analysis : null;
    let body;
    if (!field.terrain) body = `<p class="adv-wait">${esc(t('adv.waitTerrain'))}</p>`;
    else if (!a) body = `<p class="adv-wait">${esc(t(C && C.state.powerErr ? 'adv.noClimate' : 'adv.waitClimate'))}</p>`;
    else {
      const r = evaluate(field, inp, a, C.state.risks);
      const ids = r.top.map((x) => x.crop.id).join(',');
      if (topByField[id] !== ids) { topByField[id] = ids; if (opts.rerender) setTimeout(opts.rerender, 0); } // the DISEASE badge above follows the best crops
      if (opts.setCrop && r.top[0]) { const c = r.top[0].crop; opts.setCrop(id, { id: c.id, color: c.color, color2: c.color2, height: c.rowHeightM }); }
      const warn = r.warnings.map((w) => `<div class="adv-warn"><span aria-hidden="true">⚠</span><span>${esc(w)}</span></div>`).join('');
      const wInfo = window.FieldWater ? window.FieldWater.info(id, field) : { status: 'unknown' };
      const cards = r.top.map((c, i) => `
        <div class="adv-crop">
          <div class="adv-crop-head"><span class="adv-rank">${i + 1}</span><span class="adv-swatch" style="background:${c.crop.color}"></span><b>${esc(cropName(c.crop))}</b>${c.preferred ? `<span class="adv-tag">${esc(t('adv.yourPick'))}</span>` : ''}<span class="adv-score">${c.score}<small>/100</small></span></div>
          <div class="adv-bar" role="img" aria-label="${esc(t('adv.scoreAria', { score: c.score }))}"><span style="width:${c.score}%"></span></div>
          <p class="adv-why">${esc(shortReason(c))}</p>
          ${waterHtml(c.crop, r.rainYear, field, wInfo)}
          ${window.FieldDisease ? window.FieldDisease.cropHtml(c.crop.id) : ''}
          <details class="adv-more"><summary>${esc(t('adv.more'))}</summary>
            <ul class="adv-reasons">${c.reasons.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${esc(x.text)}</li>`).join('')}</ul>
            <p class="adv-plant"><b>${esc(t('adv.planting'))}</b> ${esc(c.window.text)}</p>
            <p class="adv-soil">${esc(cropText(c.crop, 'note', c.crop.soilEffect.note))}${c.crop.perennialYears ? ' ' + esc(c.crop.perennialYears >= 10 ? t('adv.staysDecades') : t('adv.staysYears', { years: c.crop.perennialYears })) : ''}</p>
          </details>
        </div>`).join('');
      const rot = r.rotation;
      const steps = rot.plan.map((p, i) => `<li><span class="adv-year">${esc(t('adv.year', { y: i + 1 }))}</span><span class="adv-swatch" style="background:${p.crop.color}"></span><b>${esc(cropName(p.crop))}</b><span class="adv-n ${p.crop.soilEffect.nitrogen > 0 ? 'plus' : 'minus'}">${esc(t(p.crop.soilEffect.nitrogen > 0 ? 'adv.addsN' : 'adv.usesN'))}</span><p>${esc(typeof p.reason === 'function' ? p.reason() : p.reason)}</p></li>`).join('');
      const fert = rot.hasLegume
        ? t(rot.balance < 0 ? 'adv.fertPart' : 'adv.fertFull')
        : t('adv.fertNone');
      body = `
        ${warn}
        <div class="adv-sub">${esc(t('adv.best3'))} ${help(t('adv.best3Tip'))}</div>
        ${cards}
        <div class="adv-sub">${esc(t('adv.rotation'))}</div>
        <ol class="adv-rot">${steps}</ol>
        <p class="adv-soil">${esc(fert)}</p>`;
    }
    return `
      <details class="metric wide adv" id="advBox" ${open ? 'open' : ''}>
        <summary><span class="k">${esc(t('adv.title'))}</span><svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/></svg></summary>
        ${controlsHtml(id, inp)}
        ${body}
        <p class="adv-note">${esc(t('adv.note'))}</p>
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

  const topIds = (fieldId) => (topByField[fieldId] ? topByField[fieldId].split(',') : []);
  window.FieldAdvisor = { init, html, topIds, get rules() { return rules; } };
})();
