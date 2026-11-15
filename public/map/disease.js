/*
 * Crop disease risk. Rules: config/disease-rules.json (approximate thresholds, confirm with a local agronomist).
 * Weather: NASA POWER daily temperature, humidity and rain for the last 30 days at the field centre (/api/power-daily).
 * Each disease: count "favourable" days (temperature in range, humidity high enough), add recent rain and the
 * season (dangerous months) → LOW / MEDIUM / HIGH.
 *   cropHtml(cropId)     → top 2 diseases for a crop card (badge, why, prevention tip)
 *   fieldBadgeHtml(ids)  → the DISEASE badge for the field (worst disease of the given crops)
 */
(function () {
  'use strict';

  const I18N = window.FSi18n, t = I18N.t, fmt = I18N.fmt;
  const ICON = { low: '✓', medium: '!', high: '▲' };
  const RANK = { low: 0, medium: 1, high: 2 };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let rules = null, opts = {}, current = null, token = 0;
  const state = { data: null, err: false };
  const cache = new Map(); // location key → daily data

  async function getJson(url, ms) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
      return d;
    } finally { clearTimeout(timer); }
  }

  async function load(field) {
    const my = ++token;
    const hit = cache.get(field.key);
    Object.assign(state, { data: hit || null, err: false });
    if (hit) return;
    const url = `/api/power-daily?lat=${field.centroid[1].toFixed(4)}&lon=${field.centroid[0].toFixed(4)}`;
    try {
      let d;
      try { d = await getJson(url, 70000); }
      catch (_) { await new Promise((r) => setTimeout(r, 3000)); if (my !== token) return; d = await getJson(url, 70000); } // one retry
      if (my !== token) return;
      state.data = d; cache.set(field.key, d);
    } catch (_) { if (my === token) state.err = true; }
    if (my === token && opts.rerender) opts.rerender();
  }

  /** Called by the map with the selected field (or null). */
  function setField(field) {
    if (!field) { current = null; token++; Object.assign(state, { data: null, err: false }); return; }
    const key = `${field.centroid[1].toFixed(2)},${field.centroid[0].toFixed(2)}`;
    if (current && current.id === field.id && current.key === key) return;
    current = { id: field.id, centroid: field.centroid, key };
    load(current);
  }

  // ── Scoring ──
  function assess(id) {
    const D = rules.diseases[id], days = state.data.days;
    const [a, b] = D.temp;
    const fav = days.filter((d) => d.temp >= a && d.temp <= b && (!D.rhMin || d.rh >= D.rhMin)).length;
    const rain = days.reduce((s, d) => s + (d.rain || 0), 0);
    const month = new Date(days[days.length - 1].date).getMonth() + 1;
    const inSeason = D.months.includes(month);
    let p = fav >= D.daysHigh ? 2 : fav >= D.daysMedium ? 1 : 0;
    if (D.rainMm != null && rain >= D.rainMm) p += 1;
    p += inSeason ? 1 : -1;
    const level = p >= rules.levels.high ? 'high' : p >= rules.levels.medium ? 'medium' : 'low';
    const why = t(D.rhMin ? 'dis.whyHumid' : 'dis.whyWarm', { fav: fmt(fav), n: days.length, a: fmt(a), b: fmt(b), rh: fmt(D.rhMin) }) +
      ' ' + t('dis.whyRain', { rain: fmt(rain) }) + ' ' + t(inSeason ? 'dis.inSeason' : 'dis.offSeason');
    return { id, level, why };
  }
  const name = (id) => (I18N.has(`dis.${id}.name`) ? t(`dis.${id}.name`) : rules.diseases[id].name);
  const tip = (id) => (I18N.has(`dis.${id}.tip`) ? t(`dis.${id}.tip`) : rules.diseases[id].tip);
  const ready = () => rules && state.data && state.data.days && state.data.days.length >= (rules.minDays || 10);
  const forCrop = (cropId) => ((rules && rules.crops[cropId]) || []).filter((id) => rules.diseases[id]).map(assess).sort((x, y) => RANK[y.level] - RANK[x.level]).slice(0, 2);
  const badge = (level) => `<span class="dis-level lvl-${level}"><span aria-hidden="true">${ICON[level]}</span> ${esc(t('risk.level.' + level))}</span>`;

  // ── UI ──
  function statusMsg() {
    if (!rules) return t('dis.noRules');
    if (state.err || (state.data && !ready())) return t('dis.noData');
    return t('dis.loading');
  }

  function cropHtml(cropId) {
    if (!rules || !rules.crops[cropId]) return '';
    if (!ready()) return `<div class="adv-dis"><div class="adv-dis-h">${esc(t('dis.cropTitle'))}</div><p class="adv-dis-msg">${esc(statusMsg())}</p></div>`;
    const rows = forCrop(cropId).map((r) => `
      <div class="dis-row lvl-${r.level}">
        <div class="dis-head"><b>${esc(name(r.id))}</b>${badge(r.level)}</div>
        <p class="dis-why">${esc(r.why)}</p>
        <p class="dis-tip"><span aria-hidden="true">💡</span> ${esc(tip(r.id))}</p>
      </div>`).join('');
    return `<div class="adv-dis"><div class="adv-dis-h">${esc(t('dis.cropTitle'))}${state.data.stale ? ` <small>· ${esc(t('dis.offline'))}</small>` : ''}</div>${rows}</div>`;
  }

  // DISEASE badge for the field: the worst disease among the given crops (the advisor's best 3)
  function fieldBadgeHtml(cropIds, helpBtn) {
    if (!rules) return '';
    const head = (lvl) => `<div class="risk-head"><span class="risk-name">${esc(t('dis.name'))} ${helpBtn(t('dis.tip'))}</span>${lvl}</div>`;
    if (!ready()) return `<div class="risk risk-disease lvl-none">${head('<span class="risk-level">…</span>')}<p class="risk-say">${esc(statusMsg())}</p></div>`;
    const ids = (cropIds && cropIds.length ? cropIds : Object.keys(rules.crops)).filter((c) => rules.crops[c]);
    let worst = null;
    ids.forEach((c) => forCrop(c).forEach((r) => { if (!worst || RANK[r.level] > RANK[worst.r.level]) worst = { r, c }; }));
    if (!worst) return '';
    const L = worst.r.level;
    const say = L === 'low' ? t('dis.fieldLow') : t('dis.fieldRisk', { disease: name(worst.r.id), crop: cropName(worst.c) });
    return `<div class="risk risk-disease lvl-${L}">${head(`<span class="risk-level"><span aria-hidden="true">${ICON[L]}</span> ${esc(t('risk.level.' + L))}</span>`)}` +
      `<p class="risk-say">${esc(say)}</p><details class="risk-more"><summary>${esc(t('risk.details'))}</summary><p class="risk-why">${esc(worst.r.why)} ${esc(tip(worst.r.id))}</p><p class="risk-why"><i>${esc(t('dis.approx'))}</i></p></details></div>`;
  }
  function cropName(id) {
    if (I18N.has(`crop.${id}.lower`)) return t(`crop.${id}.lower`);
    const c = window.FieldAdvisor && window.FieldAdvisor.rules && window.FieldAdvisor.rules.crops.find((x) => x.id === id);
    return c ? c.name.toLowerCase() : id;
  }

  async function init(options) {
    opts = options || {};
    try { rules = await getJson('/api/disease-rules', 15000); }
    catch (_) { rules = null; console.warn('[disease] rules unavailable'); }
    if (opts.rerender) opts.rerender();
  }

  window.FieldDisease = { init, setField, cropHtml, fieldBadgeHtml, state, get rules() { return rules; } };
})();
