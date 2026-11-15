/*
 * Accounts on the page (server side: lib/accounts.js).
 *   FSStore: where fields and settings live. Signed in → the user's account on the server
 *            (loaded once at page start, changes sent in the background). Signed out → this browser (localStorage).
 *   Top bar "Sign in" button and the sign in / create account / forgotten password window.
 * After signing in, fields and settings saved in this browser as a guest are moved into the account.
 * Must load before i18n.js (the language setting comes from here).
 */
(function () {
  'use strict';

  const FIELDS_KEY = 'fieldshift.fields.v1';
  const SETTING_KEYS = ['fieldshift.lang', 'fieldshift.ui.v1', 'fieldshift.advisor.v1'];
  let me = { user: null, csrf: '' }, settings = {}, synced = new Map(); // field id → JSON last sent
  let fields = null;

  // One synchronous request at page start: user, CSRF token, the user's fields and settings
  try {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/auth/me?full=1', false);
    x.send();
    if (x.status === 200) {
      const d = JSON.parse(x.responseText);
      me = { user: d.user, csrf: d.csrf };
      if (d.user) {
        settings = d.settings || {};
        fields = { type: 'FeatureCollection', features: d.fields || [] };
        fields.features.forEach((f) => synced.set(f.id, JSON.stringify(f)));
      }
    }
  } catch (_) { /* server unreachable: stay a guest */ }

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* storage blocked */ } },
  };

  async function api(method, url, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, {
        method, signal: ctl.signal, credentials: 'same-origin',
        headers: { 'X-CSRF-Token': me.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 && me.user && !/\/api\/auth\//.test(url)) lostSession();
      return { status: r.status, ok: r.ok, data: d };
    } finally { clearTimeout(timer); }
  }

  // ── Settings ──
  let settingsTimer = null;
  function getSetting(k) { return me.user ? (settings[k] != null ? settings[k] : null) : ls.get(k); }
  function setSetting(k, v) {
    if (!me.user) { ls.set(k, v); return; }
    settings[k] = v;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => api('PUT', '/api/settings', settings).catch(() => {}), 800);
  }

  // ── Fields: whole collection in, changes out (PUT changed ones, DELETE removed ones) ──
  function loadFields() {
    if (me.user) return fields;
    const raw = ls.get(FIELDS_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  let pending = null, fieldsTimer = null, failed = false;
  function saveFields(gj) {
    if (!me.user) { ls.set(FIELDS_KEY, JSON.stringify(gj)); return true; } // may throw → caller shows the storage warning
    pending = gj;
    clearTimeout(fieldsTimer);
    fieldsTimer = setTimeout(flushFields, 700);
    return true;
  }
  async function flushFields() {
    const gj = pending; pending = null;
    if (!gj) return;
    const now = new Map(gj.features.map((f) => [String(f.id), JSON.stringify(f)]));
    const jobs = [];
    now.forEach((text, id) => {
      if (synced.get(id) === text) return;
      jobs.push(api('PUT', `/api/fields/${encodeURIComponent(id)}`, JSON.parse(text)).then((r) => { if (r.ok) synced.set(id, text); else throw new Error(r.status); }));
    });
    [...synced.keys()].forEach((id) => {
      if (now.has(id)) return;
      jobs.push(api('DELETE', `/api/fields/${encodeURIComponent(id)}`).then((r) => { if (r.ok || r.status === 404) synced.delete(id); else throw new Error(r.status); }));
    });
    const res = await Promise.allSettled(jobs);
    const bad = res.some((r) => r.status === 'rejected');
    if (bad && !failed) notify(t('acct.syncFailed'), true);
    failed = bad;
    if (bad) { pending = pending || gj; clearTimeout(fieldsTimer); fieldsTimer = setTimeout(flushFields, 15000); } // try again later
  }
  window.addEventListener('pagehide', () => { if (pending) flushFields(); });

  const t = (k, v) => (window.FSi18n ? window.FSi18n.t(k, v) : k);
  function notify(msg, isError) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4500);
  }
  function lostSession() {
    if (lostSession.done) return;
    lostSession.done = true;
    notify(t('acct.lost'), true);
  }

  // ── Move guest data (this browser) into the account, then start fresh from the account ──
  async function moveGuestData() {
    let moved = 0;
    const raw = ls.get(FIELDS_KEY);
    let gj = null;
    try { gj = raw ? JSON.parse(raw) : null; } catch (_) { gj = null; }
    if (gj && Array.isArray(gj.features)) {
      for (const f of gj.features) {
        if (!f || !f.id) continue;
        const r = await api('PUT', `/api/fields/${encodeURIComponent(f.id)}`, f).catch(() => null);
        if (r && r.ok) moved++;
      }
      if (moved === gj.features.length) ls.del(FIELDS_KEY);
    }
    const s = {};
    SETTING_KEYS.forEach((k) => { const v = ls.get(k); if (v != null) s[k] = v; });
    if (Object.keys(s).length) {
      const cur = await api('GET', '/api/settings').catch(() => null);
      const merged = { ...s, ...((cur && cur.ok && cur.data) || {}) }; // the account's own settings win
      const r = await api('PUT', '/api/settings', merged).catch(() => null);
      if (r && r.ok) SETTING_KEYS.forEach((k) => ls.del(k));
    }
    return moved;
  }

  // ── Window: sign in / create account / forgotten password ──
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ERR = { bad_username: 'acct.errUsername', short_password: 'acct.errShort', long_password: 'acct.errLong', username_taken: 'acct.errTaken', wrong_login: 'acct.errLogin', wrong_recovery: 'acct.errRecovery', too_many_attempts: 'acct.errTooMany', bad_csrf: 'acct.errReload', bad_origin: 'acct.errReload' };

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal acct-modal" role="dialog" aria-modal="true" aria-labelledby="acctTitle">${html}</div>`;
    document.body.appendChild(back);
    const prev = document.activeElement;
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    return { back, close };
  }

  function openAuth(mode = 'login') {
    const tabs = ['login', 'signup', 'recover'].map((m) => `<button type="button" class="acct-tab${m === mode ? ' on' : ''}" data-mode="${m}" aria-pressed="${m === mode}">${esc(t('acct.tab.' + m))}</button>`).join('');
    const pw = mode === 'login' ? 'current-password' : 'new-password';
    const m = modal(`
      <h3 id="acctTitle">${esc(t('acct.title.' + mode))}</h3>
      <div class="acct-tabs" role="group">${tabs}</div>
      <form class="acct-form" novalidate>
        <label class="acct-label">${esc(t('acct.username'))}<input class="modal-input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required></label>
        ${mode === 'recover' ? `<label class="acct-label">${esc(t('acct.code'))}<input class="modal-input" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" required></label>` : ''}
        <label class="acct-label">${esc(t(mode === 'recover' ? 'acct.newPassword' : 'acct.password'))}<input class="modal-input" name="password" type="password" autocomplete="${pw}" minlength="8" maxlength="200" required></label>
        <p class="acct-hint">${esc(t('acct.hint.' + mode))}</p>
        <p class="acct-err" role="alert" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn-sm" data-act="cancel">${esc(t('dlg.cancel'))}</button>
          <button type="submit" class="btn-sm btn-ok">${esc(t('acct.submit.' + mode))}</button>
        </div>
      </form>`);
    const form = m.back.querySelector('form'), err = m.back.querySelector('.acct-err');
    m.back.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { m.close(); openAuth(b.dataset.mode); }));
    m.back.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    form.querySelector('input').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      if (String(body.password || '').length < 8) { err.textContent = t('acct.errShort'); err.hidden = false; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; err.hidden = true;
      let r;
      try { r = await api('POST', `/api/auth/${mode}`, body); }
      catch (_) { r = { ok: false, data: {} }; }
      btn.disabled = false;
      if (!r.ok) { err.textContent = t(ERR[r.data && r.data.error] || 'acct.errServer'); err.hidden = false; return; }
      me = { user: r.data.user, csrf: r.data.csrf };
      m.close();
      await moveGuestData();
      if (r.data.recoveryCode) await showCode(r.data.recoveryCode);
      location.reload(); // start again from the account's fields and settings
    });
  }

  function showCode(code) {
    return new Promise((resolve) => {
      const m = modal(`
        <h3 id="acctTitle">${esc(t('acct.codeTitle'))}</h3>
        <p class="modal-msg">${esc(t('acct.codeMsg'))}</p>
        <p class="acct-code" tabindex="0">${esc(code)}</p>
        <div class="modal-actions">
          <button type="button" class="btn-sm" data-act="copy">${esc(t('acct.copy'))}</button>
          <button type="button" class="btn-sm btn-ok" data-act="ok">${esc(t('acct.codeSaved'))}</button>
        </div>`);
      const copy = m.back.querySelector('[data-act="copy"]');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); copy.textContent = t('acct.copied'); } catch (_) { /* select it instead */ }
        const sel = window.getSelection(), range = document.createRange();
        range.selectNodeContents(m.back.querySelector('.acct-code')); sel.removeAllRanges(); sel.addRange(range);
      });
      m.back.querySelector('[data-act="ok"]').addEventListener('click', () => { m.close(); resolve(); });
      m.back.querySelector('[data-act="ok"]').focus();
    });
  }

  function openMenu() {
    const m = modal(`
      <h3 id="acctTitle">${esc(t('acct.signedInAs', { name: me.user.username }))}</h3>
      <p class="modal-msg">${esc(t('acct.menuMsg'))}</p>
      <div class="modal-actions">
        <button type="button" class="btn-sm" data-act="cancel">${esc(t('dlg.close'))}</button>
        <button type="button" class="btn-sm btn-danger" data-act="logout">${esc(t('acct.logout'))}</button>
      </div>`);
    m.back.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.back.querySelector('[data-act="logout"]').addEventListener('click', async () => {
      if (pending) await flushFields();
      await api('POST', '/api/auth/logout').catch(() => {});
      location.reload();
    });
  }

  // ── Top bar button ──
  function renderButton() {
    const b = document.getElementById('accountBtn');
    if (!b) return;
    const label = me.user ? me.user.username : t('acct.signIn');
    b.querySelector('.acct-label-text').textContent = label;
    b.classList.toggle('signed-in', !!me.user);
    b.title = me.user ? t('acct.signedInAs', { name: me.user.username }) : t('acct.signIn');
    b.setAttribute('aria-label', b.title);
  }
  function boot() {
    const b = document.getElementById('accountBtn');
    if (b) b.addEventListener('click', () => (me.user ? openMenu() : openAuth('login')));
    renderButton();
    if (window.FSi18n) window.FSi18n.onChange(renderButton);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.FSStore = {
    get user() { return me.user; },
    getSetting, setSetting, loadFields, saveFields, openAuth,
  };
})();
