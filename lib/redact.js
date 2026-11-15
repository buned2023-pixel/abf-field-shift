/*
 * Last line of defence: API key values never leave the server.
 *  - Log lines (console.log / warn / error) have any key value replaced by ***.
 *  - JSON and text replies from /api routes are checked the same way before they are sent.
 *  - Unexpected errors answer with a short JSON message, never a stack trace.
 * The routes already avoid putting keys in replies and logs; this catches mistakes.
 */
'use strict';

const NAMES = ['IPSTACK_KEY', 'WEATHERSTACK_KEY', 'FIRMS_MAP_KEY'];

function secrets() {
  return NAMES.map((n) => process.env[n]).filter((v) => typeof v === 'string' && v.length >= 8);
}

function scrub(text) {
  let s = String(text);
  for (const v of secrets()) if (s.includes(v)) s = s.split(v).join('***');
  return s;
}

function patchConsole() {
  ['log', 'info', 'warn', 'error'].forEach((m) => {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? scrub(a) : a instanceof Error ? scrub(a.stack || a.message) : a)));
  });
}

// Wraps res.json / res.send so a key value can never reach the browser
function replies(req, res, next) {
  const json = res.json.bind(res), send = res.send.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    return text !== undefined && scrub(text) !== text ? json(JSON.parse(scrub(text))) : json(body);
  };
  res.send = (body) => (typeof body === 'string' ? send(scrub(body)) : send(body));
  next();
}

// Final error handler: short JSON, no stack trace, no details
function errors(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[server] unexpected error on', req.method, req.path, '-', err && err.message);
  if (res.headersSent) return;
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'server_error' : 'bad_request' });
}

module.exports = { patchConsole, replies, errors, scrub };
