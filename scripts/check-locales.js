#!/usr/bin/env node
/*
 * npm run check-locales
 *   1. Compares locales/en.json, ru.json, tg.json: lists missing and extra keys.
 *      Plural forms (key.one / .few / .many / .other) count as one key; each language needs key.other,
 *      because the number of forms differs by language.
 *   2. Checks that every {placeholder} in English also appears in ru/tg (and no unknown ones),
 *      and that ru/tg contain no stray Latin words.
 *   3. Checks that every t('key') used in public/map/*.js exists in en.json.
 *   4. Scans public/map/*.js and index.html for hard-coded English text shown to users.
 * Exit code 1 if anything is wrong.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'ru', 'tg'];
const PLURAL = /\.(one|few|many|other)$/;
let problems = 0;
const say = (msg) => { console.log(msg); problems++; };

// ── 1. Keys ──
const dicts = {};
for (const l of LANGS) {
  const f = path.join(ROOT, 'locales', `${l}.json`);
  try { dicts[l] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (err) { say(`✗ ${l}.json: cannot read (${err.message})`); dicts[l] = {}; }
}
const base = (k) => k.replace(PLURAL, '');
const groups = (d) => {
  const g = new Map();
  Object.keys(d).forEach((k) => { const b = base(k); if (!g.has(b)) g.set(b, []); if (PLURAL.test(k)) g.get(b).push(k.match(PLURAL)[1]); });
  return g;
};
const en = groups(dicts.en);
for (const l of LANGS) {
  const g = groups(dicts[l]);
  if (l !== 'en') {
    [...en.keys()].filter((k) => !g.has(k)).forEach((k) => say(`✗ ${l}.json: missing key "${k}"`));
    [...g.keys()].filter((k) => !en.has(k)).forEach((k) => say(`✗ ${l}.json: extra key "${k}" (not in en.json)`));
  }
  g.forEach((forms, k) => { if (forms.length && !forms.includes('other')) say(`✗ ${l}.json: plural "${k}" has no ".other" form`); });
  Object.entries(dicts[l]).forEach(([k, v]) => {
    if (typeof v !== 'string') say(`✗ ${l}.json: "${k}" is not text`);
    else if (!v.trim()) say(`✗ ${l}.json: "${k}" is empty`);
  });
}

// ── 2. Placeholders and alphabet ──
const vars = (s) => new Set(String(s).match(/\{(\w+)\}/g) || []);
const enText = (b) => (dicts.en[b] != null ? dicts.en[b] : dicts.en[`${b}.other`]);
const LATIN_OK = /^(NASA|FIRMS|POWER|MODIS|VIIRS|GPS|IP|GeoJSON|OpenStreetMap|Terrarium|Space|Apps|Challenge|ABF|Field|Shift|npm|run|build|trees|MW|MB|3D|2D)$/;
for (const l of LANGS.filter((x) => x !== 'en')) {
  Object.entries(dicts[l]).forEach(([k, v]) => {
    const e = enText(base(k));
    if (e != null) {
      const want = vars(e), have = vars(v);
      want.forEach((x) => { if (!have.has(x)) say(`✗ ${l}.json: "${k}" lacks placeholder ${x}`); });
      have.forEach((x) => { if (!want.has(x)) say(`✗ ${l}.json: "${k}" has unknown placeholder ${x}`); });
    }
    const latin = (String(v).replace(/\{\w+\}/g, '').match(/[A-Za-z]{2,}/g) || []).filter((w) => !LATIN_OK.test(w));
    if (latin.length) say(`✗ ${l}.json: "${k}" has Latin words: ${latin.join(', ')}`);
  });
}

// ── 3 + 4. Source files ──
const DIR = path.join(ROOT, 'public', 'map');
const jsFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
const known = new Set(en.keys());
const dynamicPrefixes = ['acct.', 'dis.', 'ov.slope.', 'ov.aspect.', 'land.badge.', 'land.long.', 'land.short.', 'risk.', 'tl.trend.', 'adv.level.', 'adv.need.', 'adv.limit.', 'adv.wt.type.', 'adv.wt.access.', 'crop.', 'family.', 'wx.desc.'];

// Strings that are data or code, not text for people
const ALLOW = [
  /^#[0-9a-f]{3,8}$/i, /^[a-z0-9_.\-/:]+$/, /^[A-Z_]+$/,
  /^(Easy|Moderate|Hard)$/,                 // water.js access classes (shown through adv.wt.access.*)
  /^ABF Field Shift/, /^Powered by NASA data/, // export file header (data, stays English)
  /^Contours from Terrarium DEM$/,          // map attribution
  /^(Inter|JetBrains Mono|Open Sans Semibold|Open Sans Regular|Noto Sans Regular|Esc)$/,
];
// A quoted string that reads like a sentence or label: starts with a capital, has a space, no code characters
const looksEnglish = (s) => /^[A-Z][a-z]+/.test(s) && /\s/.test(s) && !/[{}$<>=;()|&?:]/.test(s);
const TAG_TEXT = /<[a-z][a-z0-9]*(?:\s[^<>]*)?>([^<>{}$`]{3,})</gi;

for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    const k = m[1];
    if (!k.endsWith('.') && !known.has(k)) say(`✗ ${f}: t('${k}') is not in en.json`);
  }
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*(\*|\/\*)/.test(line) || /console\.(warn|log|error)|new Error\(|throw /.test(code)) return;
    for (const m of code.matchAll(/'([^'\\]{3,})'|"([^"\\]{3,})"/g)) {
      const s = (m[1] || m[2]).trim();
      if (!ALLOW.some((re) => re.test(s)) && looksEnglish(s)) say(`✗ ${f}:${i + 1}: hard-coded text "${s}"`);
    }
    for (const m of code.matchAll(TAG_TEXT)) {
      const s = m[1].trim();
      if (/[A-Za-z]{3,}/.test(s) && !ALLOW.some((re) => re.test(s))) say(`✗ ${f}:${i + 1}: hard-coded text "${s}"`);
    }
  });
}

// index.html: visible text must come from data-i18n
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<body'));
const HTML_OK = /^(ABF|Field Shift|Powered by NASA data|2D|3D|EN|RU|TJ|VIIRS|MODIS ·|1\.5×|1\.0×|\?)$/;
body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').split('\n').forEach((line) => {
  for (const m of line.matchAll(/>([^<>]+)</g)) {
    const s = m[1].replace(/\s+/g, ' ').trim();
    if (s && /[A-Za-z]{2,}/.test(s) && !HTML_OK.test(s)) say(`✗ index.html: hard-coded text "${s}"`);
  }
  for (const m of line.matchAll(/\s(title|placeholder|aria-label|alt|data-tip)="([^"]+)"/g)) {
    if (/data-lang=/.test(line) && m[1] === 'title') continue; // language names stay in their own language
    if (/[A-Za-z]{3,}/.test(m[2])) say(`✗ index.html: hard-coded ${m[1]}="${m[2]}"`);
  }
  for (const m of line.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) if (!known.has(m[1])) say(`✗ index.html: key "${m[1]}" is not in en.json`);
  for (const m of line.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    m[1].split(',').forEach((pair) => { const k = (pair.split(':')[1] || '').trim(); if (k && !known.has(k)) say(`✗ index.html: key "${k}" is not in en.json`); });
  }
});

// Keys nothing uses (note only; some keys are built from prefixes at run time)
const allSrc = jsFiles.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n') + html + fs.readFileSync(path.join(DIR, 'i18n.js'), 'utf8');
const unused = [...known].filter((k) => !allSrc.includes(`'${k}'`) && !allSrc.includes(`"${k}"`) && !allSrc.includes(`:${k}`) && !dynamicPrefixes.some((p) => k.startsWith(p)));
if (unused.length) console.log(`(note) ${unused.length} key(s) not found in code, may be built at run time: ${unused.join(', ')}`);

console.log(problems ? `\n${problems} problem(s) found.` : `✓ Locales OK: ${known.size} keys in en, ru and tg; no hard-coded text found.`);
process.exit(problems ? 1 : 0);
