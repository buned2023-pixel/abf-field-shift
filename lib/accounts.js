/*
 * Private accounts: username + password only (no email, no Google).
 *  - Passwords and the one-time recovery code are hashed with argon2id (Node's built-in crypto.argon2).
 *  - Sessions: random token in an httpOnly cookie; only its SHA-256 is stored. 30 days.
 *  - CSRF: every POST/PUT/DELETE needs a same-origin Origin (when the browser sends one) and the
 *    X-CSRF-Token header: the session's token when signed in, otherwise the pre-session token from GET /api/auth/me.
 *  - Rate limits on sign in, sign up and recovery (per IP and per username).
 *  - SQLite (node:sqlite) in data/accounts.db (git-ignored). Fields and settings are always filtered by user_id;
 *    another user's item answers 404.
 * The map and NASA routes stay public.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const COOKIE = 'fs_sid';
const PRE_COOKIE = 'fs_pre';                // pre-session CSRF token for sign in / sign up forms
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
const MAX_FIELDS = 500;
const MAX_FEATURE_BYTES = 300 * 1024;
const MAX_SETTINGS_BYTES = 32 * 1024;
const SETTING_KEYS = ['fieldshift.lang', 'fieldshift.ui.v1', 'fieldshift.advisor.v1'];
const ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

// ── Database ──
function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fields (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      feature TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    );`);
  return db;
}

// ── Hashing (argon2id, PHC string) ──
const A2 = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 }; // OWASP minimum for argon2id
function argon2(message, nonce) {
  return new Promise((resolve, reject) => crypto.argon2('argon2id', { ...A2, message, nonce }, (err, key) => (err ? reject(err) : resolve(key))));
}
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await argon2(Buffer.from(secret, 'utf8'), salt);
  return `$argon2id$v=19$m=${A2.memory},t=${A2.passes},p=${A2.parallelism}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifySecret(secret, phc) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(phc || '');
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64');
  const key = await new Promise((resolve, reject) => crypto.argon2('argon2id', {
    message: Buffer.from(secret, 'utf8'), nonce: Buffer.from(m[4], 'base64'),
    memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: want.length,
  }, (err, k) => (err ? reject(err) : resolve(k))));
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
// Recovery code: 20 characters from an unambiguous alphabet (≈100 bits), shown once as XXXXX-XXXXX-XXXXX-XXXXX
function recoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(20);
  const s = [...b].map((x) => A[x % 32]).join('');
  return s.match(/.{5}/g).join('-');
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,5}/g)?.join('-') || '';

// ── Rate limit (in memory): failures per key within a window ──
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key) { const h = hits.get(key); return !!h && h.until > Date.now() && h.n >= max; },
    fail(key) {
      const now = Date.now(), h = hits.get(key);
      if (!h || h.until <= now) hits.set(key, { n: 1, until: now + windowMs }); else h.n++;
      if (hits.size > 10000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
    },
    reset(key) { hits.delete(key); },
  };
}

// ── Cookies ──
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, name, value, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

module.exports = function mountAccounts(app, opts = {}) {
  const db = openDb(opts.dbFile || path.join(__dirname, '..', 'data', 'accounts.db'));
  const loginIp = limiter(20, 15 * 60 * 1000), loginUser = limiter(8, 15 * 60 * 1000);
  const signupIp = limiter(10, 60 * 60 * 1000), recoverIp = limiter(10, 15 * 60 * 1000);
  const q = {
    userByName: db.prepare('SELECT id, username, pass_hash, recovery_hash FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
    addUser: db.prepare('INSERT INTO users (username, pass_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?)'),
    setPass: db.prepare('UPDATE users SET pass_hash = ?, recovery_hash = ? WHERE id = ?'),
    addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT user_id, csrf, expires_at FROM sessions WHERE token_hash = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    dropUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    dropExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    listFields: db.prepare('SELECT id, feature FROM fields WHERE user_id = ? ORDER BY updated_at'),
    getField: db.prepare('SELECT id, feature FROM fields WHERE user_id = ? AND id = ?'),
    countFields: db.prepare('SELECT COUNT(*) AS n FROM fields WHERE user_id = ?'),
    putField: db.prepare(`INSERT INTO fields (user_id, id, feature, updated_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT(user_id, id) DO UPDATE SET feature = excluded.feature, updated_at = excluded.updated_at`),
    delField: db.prepare('DELETE FROM fields WHERE user_id = ? AND id = ?'),
    getSettings: db.prepare('SELECT data FROM settings WHERE user_id = ?'),
    putSettings: db.prepare(`INSERT INTO settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data`),
  };
  setInterval(() => { try { q.dropExpired.run(Date.now()); } catch (_) { /* next time */ } }, 60 * 60 * 1000).unref();

  const json = express.json({ limit: '400kb' });
  const ip = (req) => req.ip || req.socket.remoteAddress || '?';

  // Who is calling: attaches req.user / req.session from the cookie
  function identify(req, res, next) {
    const sid = parseCookies(req)[COOKIE];
    if (sid) {
      const s = q.session.get(sha256(sid));
      if (s && s.expires_at > Date.now()) {
        const u = q.userById.get(s.user_id);
        if (u) { req.user = { id: u.id, username: u.username }; req.session = { hash: sha256(sid), csrf: s.csrf }; }
      } else if (s) q.dropSession.run(sha256(sid));
    }
    next();
  }

  // CSRF: same-origin Origin (if sent) + the X-CSRF-Token header
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch (_) { /* bad origin */ }
      if (host !== req.headers.host) return res.status(403).json({ error: 'bad_origin' });
    }
    const sent = String(req.headers['x-csrf-token'] || '');
    const want = req.session ? req.session.csrf : parseCookies(req)[PRE_COOKIE];
    if (!want || sent.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) {
      return res.status(403).json({ error: 'bad_csrf' });
    }
    next();
  }

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'sign_in_required' }));

  function startSession(req, res, userId) {
    const sid = token(), csrfToken = token(24);
    q.addSession.run(sha256(sid), userId, csrfToken, Date.now() + SESSION_DAYS * 86400000);
    setCookie(req, res, COOKIE, sid, SESSION_DAYS * 86400);
    return csrfToken;
  }

  function checkCredentials(body) {
    const username = String((body && body.username) || '').trim().normalize('NFC').toLowerCase(); // usernames are stored in lower case (also Cyrillic)
    const password = String((body && body.password) || '');
    if (!USERNAME_RE.test(username)) return { error: 'bad_username' };
    if (password.length < MIN_PASSWORD) return { error: 'short_password' };
    if (password.length > MAX_PASSWORD) return { error: 'long_password' };
    return { username, password };
  }

  const auth = express.Router();
  auth.use(identify);

  // Current user + CSRF token. Signed out: a pre-session token (cookie + body) for the sign-in form.
  // ?full=1 also returns the user's saved fields and settings (one request at page start).
  auth.get('/api/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.user) {
      let pre = parseCookies(req)[PRE_COOKIE];
      if (!pre || pre.length < 20) { pre = token(24); setCookie(req, res, PRE_COOKIE, pre, 86400); }
      return res.json({ user: null, csrf: pre });
    }
    const out = { user: { username: req.user.username }, csrf: req.session.csrf };
    if (req.query.full) {
      out.fields = q.listFields.all(req.user.id).map((r) => JSON.parse(r.feature));
      const s = q.getSettings.get(req.user.id);
      out.settings = s ? JSON.parse(s.data) : {};
    }
    res.json(out);
  });

  auth.post('/api/auth/signup', json, csrf, async (req, res) => {
    if (signupIp.blocked(ip(req))) return res.status(429).json({ error: 'too_many_attempts' });
    const c = checkCredentials(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    signupIp.fail(ip(req)); // counts every sign up from this address
    if (q.userByName.get(c.username)) return res.status(409).json({ error: 'username_taken' });
    try {
      const code = recoveryCode();
      const [ph, rh] = await Promise.all([hashSecret(c.password), hashSecret(normCode(code))]);
      const r = q.addUser.run(c.username, ph, rh, new Date().toISOString());
      const csrfToken = startSession(req, res, Number(r.lastInsertRowid));
      res.status(201).json({ user: { username: c.username }, csrf: csrfToken, recoveryCode: code });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'username_taken' });
      console.warn('[accounts] signup failed:', err.message);
      res.status(500).json({ error: 'signup_failed' });
    }
  });

  auth.post('/api/auth/login', json, csrf, async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().normalize('NFC').toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (loginIp.blocked(ip(req)) || loginUser.blocked(username)) return res.status(429).json({ error: 'too_many_attempts' });
    const u = username && password.length <= MAX_PASSWORD ? q.userByName.get(username) : null;
    // Same work whether or not the user exists, so timing does not reveal usernames
    const ok = u ? await verifySecret(password, u.pass_hash) : (await hashSecret(password), false);
    if (!ok) { loginIp.fail(ip(req)); loginUser.fail(username); return res.status(401).json({ error: 'wrong_login' }); }
    loginUser.reset(username);
    const csrfToken = startSession(req, res, u.id);
    res.json({ user: { username: u.username }, csrf: csrfToken });
  });

  // Forgotten password: username + recovery code + new password. Gives a new recovery code; signs out other devices.
  auth.post('/api/auth/recover', json, csrf, async (req, res) => {
    if (recoverIp.blocked(ip(req))) return res.status(429).json({ error: 'too_many_attempts' });
    const c = checkCredentials(req.body);
    if (c.error && c.error !== 'bad_username') return res.status(400).json({ error: c.error });
    const u = c.error ? null : q.userByName.get(c.username);
    const ok = u ? await verifySecret(normCode(req.body.code), u.recovery_hash) : (await hashSecret('x'), false);
    if (!ok) { recoverIp.fail(ip(req)); return res.status(401).json({ error: 'wrong_recovery' }); }
    const code = recoveryCode();
    const [ph, rh] = await Promise.all([hashSecret(c.password), hashSecret(normCode(code))]);
    q.setPass.run(ph, rh, u.id);
    q.dropUserSessions.run(u.id);
    const csrfToken = startSession(req, res, u.id);
    res.json({ user: { username: u.username }, csrf: csrfToken, recoveryCode: code });
  });

  auth.post('/api/auth/logout', csrf, (req, res) => {
    if (req.session) q.dropSession.run(req.session.hash);
    setCookie(req, res, COOKIE, '', 0);
    res.json({ ok: true });
  });

  // ── Saved fields (only the signed-in user's own) ──
  auth.get('/api/fields', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ type: 'FeatureCollection', features: q.listFields.all(req.user.id).map((r) => JSON.parse(r.feature)) });
  });
  auth.get('/api/fields/:id', requireUser, (req, res) => {
    const r = ID_RE.test(req.params.id) ? q.getField.get(req.user.id, req.params.id) : null;
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(JSON.parse(r.feature));
  });
  auth.put('/api/fields/:id', requireUser, json, csrf, (req, res) => {
    const id = req.params.id, f = req.body;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });
    const g = f && f.geometry;
    if (!f || f.type !== 'Feature' || !g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) return res.status(400).json({ error: 'bad_feature' });
    const text = JSON.stringify({ type: 'Feature', id, geometry: g, properties: f.properties && typeof f.properties === 'object' ? f.properties : {} });
    if (Buffer.byteLength(text) > MAX_FEATURE_BYTES) return res.status(413).json({ error: 'too_large' });
    if (!q.getField.get(req.user.id, id) && q.countFields.get(req.user.id).n >= MAX_FIELDS) return res.status(409).json({ error: 'too_many_fields' });
    q.putField.run(req.user.id, id, text, new Date().toISOString());
    res.json({ ok: true });
  });
  auth.delete('/api/fields/:id', requireUser, csrf, (req, res) => {
    const r = ID_RE.test(req.params.id) ? q.delField.run(req.user.id, req.params.id) : { changes: 0 };
    if (!r.changes) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  // ── Settings (language, panels, advisor inputs) ──
  auth.get('/api/settings', requireUser, (req, res) => {
    const s = q.getSettings.get(req.user.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(s ? JSON.parse(s.data) : {});
  });
  auth.put('/api/settings', requireUser, json, csrf, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const clean = {};
    SETTING_KEYS.forEach((k) => { if (typeof b[k] === 'string') clean[k] = b[k]; });
    const text = JSON.stringify(clean);
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) return res.status(413).json({ error: 'too_large' });
    q.putSettings.run(req.user.id, text);
    res.json({ ok: true });
  });

  app.use(auth);
  return { db };
};
