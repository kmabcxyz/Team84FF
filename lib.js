'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* no .env */ }
}

// Bangladesh mobile numbers: 01XXXXXXXXX, +8801XXXXXXXXX, 8801XXXXXXXXX -> 01XXXXXXXXX
function normPhone(v) {
  const m = String(v || '').replace(/[\s-]/g, '').match(/^(?:\+?88)?(01[3-9]\d{8})$/);
  return m ? m[1] : null;
}

function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPass(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(String(pw || ''), Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getSecret(dir) {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(dir, '.secret');
  try { return fs.readFileSync(f, 'utf8'); } catch (e) {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}
const signer = (secret) => ({
  sign(payload, ttlSec = 7 * 86400) {
    const b = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
    return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url');
  },
  verify(tok) {
    const [b, sig] = String(tok || '').split('.');
    if (!b || !sig) return null;
    const good = crypto.createHmac('sha256', secret).update(b).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch (e) { return null; }
  },
});

// Simple fixed-window in-memory rate limiter (per process).
const hits = new Map();
function limit(ip, key, max, windowMs) {
  const k = key + ':' + ip, now = Date.now(), h = hits.get(k);
  if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + windowMs }); return; }
  if (++h.n > max) bad('Too many attempts. Please wait a few minutes and try again.', 429);
}

// WhatsApp/SMS: always recorded in `outbox`; delivered through any JSON webhook gateway when configured.
async function notify(db, phone, message) {
  const id = Number(db.prepare('INSERT INTO outbox(phone,message) VALUES(?,?)').run(phone, message).lastInsertRowid);
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.NOTIFY_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + process.env.NOTIFY_WEBHOOK_TOKEN } : {}) },
      body: JSON.stringify({ to: phone, message }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(id);
  } catch (e) { db.prepare("UPDATE outbox SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 200), id); }
}

// Player-name lookup via a configurable third-party JSON API. Returns {configured:false} when not set up.
async function checkUid(uid, region) {
  const tpl = process.env.UID_API_URL;
  if (!tpl) return { configured: false, name: null };
  let j;
  try {
    const r = await fetch(tpl.replace('{uid}', encodeURIComponent(uid)).replace('{region}', encodeURIComponent(region || 'BD')), {
      headers: process.env.UID_API_KEY ? { Authorization: 'Bearer ' + process.env.UID_API_KEY } : {},
      signal: AbortSignal.timeout(6000),
    });
    if (r.status === 404) return { configured: true, name: null };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) { bad('Player lookup service is unavailable right now. Please try again.', 502); }
  const name = String(process.env.UID_API_NAME_FIELD || 'nickname').split('.').reduce((o, k) => (o == null ? o : o[k]), j);
  return { configured: true, name: name ? String(name).slice(0, 60) : null };
}

module.exports = { HttpError, bad, loadEnv, normPhone, hashPass, checkPass, getSecret, signer, limit, notify, checkUid };
