/*
 * Protection for the public deployment, so visitors cannot use up the API quota.
 *  - rateLimit(): requests per visitor IP in a time window (in memory) → 429 when exceeded.
 *  - budget(): a daily cap on calls to a paid upstream API (IPstack, Weatherstack). Only real upstream
 *    calls count: answers served from the cache are free. When the cap is reached the route fails the
 *    same way as an upstream error, and the app already falls back (GPS / Dushanbe, "weather unavailable").
 * Counters live in memory, so they reset when the server restarts (Render's free plan sleeps when idle).
 */
'use strict';

function rateLimit({ windowMs, max, name = 'api' }) {
  const hits = new Map(); // ip → { n, until }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.until <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || '?';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.until <= now) { h = { n: 0, until: now + windowMs }; hits.set(key, h); }
    h.n++;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - h.n)));
    if (h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.until - now) / 1000)));
      return res.status(429).json({ error: 'too_many_requests', limit: name });
    }
    next();
  };
}

function budget(name, perDay) {
  let day = '', used = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    /** Call before a real upstream request; throws when today's budget is used up. */
    take() {
      if (day !== today()) { day = today(); used = 0; }
      if (used >= perDay) {
        if (used === perDay) console.warn(`[quota] ${name}: daily limit of ${perDay} calls reached; serving fallbacks until tomorrow (UTC)`);
        used = perDay + 1; // log once
        throw new Error(`${name}_daily_limit`);
      }
      used++;
    },
    get used() { return day === today() ? Math.min(used, perDay) : 0; },
    perDay,
  };
}

module.exports = { rateLimit, budget };
