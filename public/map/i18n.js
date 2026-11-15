/*
 * Languages: English, Russian, Tajik. Texts live in /locales/<lang>.json (flat keys).
 *   t(key, vars)  → text with {placeholders} filled; plural forms as key.one / key.few / key.many / key.other
 *   A key missing in ru/tg falls back to English, never to the key name.
 *   setLang(l)    → switches instantly (no reload); listeners from onChange() re-render their parts.
 * Numbers, months and dates use Intl in the active language (Russian formats if Tajik is unsupported).
 */
(function () {
  'use strict';

  const LANGS = ['en', 'ru', 'tg'];
  const KEY = 'fieldshift.lang';
  const dicts = {};
  const listeners = [];

  function loadDict(l) {
    if (dicts[l]) return dicts[l];
    try {
      const x = new XMLHttpRequest();
      x.open('GET', `/locales/${l}.json`, false); // small files, needed before the first render
      x.send();
      dicts[l] = x.status === 200 ? JSON.parse(x.responseText) : {};
    } catch (_) { dicts[l] = {}; }
    return dicts[l];
  }

  function pickLang() {
    const s = window.FSStore ? window.FSStore.getSetting(KEY) : null; if (LANGS.includes(s)) return s; // account or this browser
    const nav = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
    for (const n of nav) { const p = String(n).toLowerCase().slice(0, 2); if (LANGS.includes(p)) return p; }
    return 'en';
  }

  let lang = pickLang();
  loadDict('en');
  loadDict(lang);

  const supported = (l) => { try { return Intl.NumberFormat.supportedLocalesOf([l]).length > 0 && Intl.DateTimeFormat.supportedLocalesOf([l]).length > 0; } catch (_) { return false; } };
  let intlLoc = 'en';
  function updateIntl() { intlLoc = lang === 'tg' ? (supported('tg') ? 'tg' : 'ru') : lang; }
  updateIntl();

  const plural = {};
  function pluralCat(n) {
    try { if (!plural[intlLoc]) plural[intlLoc] = new Intl.PluralRules(intlLoc); return plural[intlLoc].select(n); } catch (_) { return n === 1 ? 'one' : 'other'; }
  }

  function lookup(d, key, vars) {
    if (vars && typeof vars.n === 'number') {
      const c = d === dicts.en ? (vars.n === 1 ? 'one' : 'other') : pluralCat(vars.n);
      if (d[`${key}.${c}`] != null) return d[`${key}.${c}`];
      if (d[`${key}.other`] != null) return d[`${key}.other`];
    }
    return d[key];
  }

  function t(key, vars) {
    let s = lookup(dicts[lang] || {}, key, vars);
    if (s == null) s = lookup(dicts.en || {}, key, vars);
    if (s == null) { console.warn('[i18n] missing', key); return ''; }
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : (typeof vars[k] === 'number' && k === 'n' ? fmt(vars[k]) : String(vars[k]))));
  }
  const has = (key) => (dicts[lang] && dicts[lang][key] != null) || (dicts.en && dicts.en[key] != null);

  // ── Formats ──
  function fmt(n, d = 0) {
    if (n == null || !isFinite(n)) return t('common.noData');
    return Number(n).toLocaleString(intlLoc, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function month(i) { // 0–11 → short month name
    try { return new Intl.DateTimeFormat(intlLoc, { month: 'short' }).format(new Date(2001, i, 15)).replace(/\.$/, ''); } catch (_) { return String(i + 1); }
  }
  function monthLong(i) {
    try { return new Intl.DateTimeFormat(intlLoc, { month: 'long' }).format(new Date(2001, i, 15)); } catch (_) { return String(i + 1); }
  }
  function dayMonth(m, d) { // 0-based month, day → "5 Mar" / "5 мар."
    try { return new Intl.DateTimeFormat(intlLoc, { day: 'numeric', month: 'short' }).format(new Date(2001, m, d)); } catch (_) { return `${d} ${month(m)}`; }
  }
  function date(iso) { // "2026-11-02" → local short date
    const s = String(iso || '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    try { return new Intl.DateTimeFormat(intlLoc, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(+m[1], +m[2] - 1, +m[3])); } catch (_) { return s; }
  }
  function list(arr) { // "a, b and c" in the active language
    const a = arr.filter(Boolean);
    return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} ${t('common.and')} ${a[a.length - 1]}`;
  }
  // Weatherstack descriptions are English: translate known ones, else keep the original
  function weather(desc) {
    const k = String(desc || '').trim();
    if (!k) return '';
    const key = 'wx.desc.' + k.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
    return has(key) ? t(key) : k;
  }

  // ── Static markup: data-i18n (text), data-i18n-html (trusted markup), data-i18n-attr="attr:key,attr:key" ──
  function applyStatic(root) {
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    r.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    r.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.dataset.i18nAttr.split(',').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
    r.querySelectorAll('[data-lang]').forEach((b) => {
      const on = b.dataset.lang === lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function setLang(l) {
    if (!LANGS.includes(l) || l === lang) return;
    loadDict(l);
    lang = l;
    updateIntl();
    if (window.FSStore) window.FSStore.setSetting(KEY, l);
    document.documentElement.lang = l;
    applyStatic();
    listeners.forEach((fn) => { try { fn(l); } catch (e) { console.warn('[i18n]', e); } });
  }
  const onChange = (fn) => listeners.push(fn);

  document.documentElement.lang = lang;
  function boot() {
    applyStatic();
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-lang]');
      if (b) setLang(b.dataset.lang);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.FSi18n = { t, has, fmt, month, monthLong, dayMonth, date, list, weather, applyStatic, setLang, onChange, LANGS, get lang() { return lang; }, get locale() { return intlLoc; } };
})();
