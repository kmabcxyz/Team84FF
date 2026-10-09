'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./lib');
L.loadEnv(path.join(__dirname, '.env'));
const { open } = require('./db');
const { HttpError, bad, normPhone } = L;

const METHODS = ['bkash', 'nagad', 'rocket', 'manual'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const PUB = path.join(__dirname, 'public');
const int = (v, d = null) => (v === '' || v == null ? d : Number.isInteger(Number(v)) ? Number(v) : NaN);

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'shop.db'), dev = process.argv.includes('--dev') } = {}) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = open(dbFile), tokens = L.signer(L.getSecret(path.dirname(dbFile)));

  // ---- first-run admin ----
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
    const phone = normPhone(process.env.ADMIN_PHONE || '01700000000');
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare("INSERT INTO users(name,phone,pass,role) VALUES('Admin',?,?,'admin')").run(phone, L.hashPass(pw));
    console.log(`[setup] Admin created — phone ${phone}, password ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw}`);
  }

  const clients = new Set();
  if (dev) {
    let t;
    fs.watch(PUB, { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => clients.forEach((r) => r.write('data: reload\n\n')), 120); });
  }
  const LIVE = "<script>(()=>{let down=false;const es=new EventSource('/__dev');es.onmessage=()=>location.reload();es.onerror=()=>{down=true};es.onopen=()=>{if(down)location.reload()}})()</script>";

  const routes = [];
  const R = (m, p, auth, fn) => routes.push({ m, auth, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
  const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || '', avatar: u.avatar || '', balance: u.balance || 0, verified: u.verified ? 1 : 0, role: u.role });
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const authed = (u) => ({ token: tokens.sign({ id: u.id }), user: pub(u) });

  // ---- public ----
  R('GET', '/api/config', null, () => ({
    methods: [
      ['bkash', 'bKash', process.env.BKASH_NUMBER || '01848657470'],
      ['nagad', 'Nagad', process.env.NAGAD_NUMBER || '01643204363'],
      ['rocket', 'Rocket', process.env.ROCKET_NUMBER || ''],
      ['manual', 'Manual payment', '']
    ].map(([id, name, number]) => ({ id, name, number: number || '' })),
    support: { 
      whatsapp: process.env.SUPPORT_WHATSAPP || '01643204362', 
      hours: process.env.SUPPORT_HOURS || '9AM–12AM',
      ytLink: process.env.YT_GUIDE_LINK || 'https://youtube.com'
    },
  }));

  R('GET', '/api/categories', null, () => {
    const pk = db.prepare('SELECT id,category_id,label,price,bonus,stock FROM packages WHERE active=1 ORDER BY sort,id').all();
    return { categories: db.prepare('SELECT id,slug,name,short,tag,icon,image,region FROM categories WHERE active=1 ORDER BY sort,id').all().map((c) => ({ ...c, pkgs: pk.filter((p) => p.category_id === c.id).map(({ category_id, ...p }) => p) })) };
  });

  R('POST', '/api/register', null, ({ body, ip }) => {
    L.limit(ip, 'auth', 10, 15 * 60e3);
    const name = String(body.name || '').trim(), phone = normPhone(body.phone), pw = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 60) bad('Enter your name (2–60 characters)');
    if (!phone) bad('Enter a valid Bangladeshi mobile number (01XXXXXXXXX)');
    if (pw.length < 8 || pw.length > 100) bad('Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) bad('This phone number is already registered — please log in', 409);
    const id = Number(db.prepare('INSERT INTO users(name,phone,email,pass) VALUES(?,?,?,?)').run(name, phone, email || null, L.hashPass(pw)).lastInsertRowid);
    return authed(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  });

  R('POST', '/api/login', null, ({ body, ip }) => {
    L.limit(ip, 'auth', 10, 15 * 60e3);
    const iden = String(body.phone || '').trim();
    const phone = normPhone(iden);
    const u = phone ? db.prepare('SELECT * FROM users WHERE phone=?').get(phone) : db.prepare('SELECT * FROM users WHERE email=?').get(iden.toLowerCase());
    if (!u || !L.checkPass(body.password, u.pass)) bad('Wrong phone/email or password', 401);
    return authed(u);
  });

  R('POST', '/api/uid-check', null, async ({ body, ip }) => {
    L.limit(ip, 'uid', 30, 10 * 60e3);
    const uid = String(body.uid || '').trim();
    if (!/^\d{6,14}$/.test(uid)) bad('Enter a valid Player UID (6–14 digits)');
    const c = db.prepare('SELECT region FROM categories WHERE slug=?').get(String(body.slug || ''));
    return L.checkUid(uid, c ? c.region : 'BD');
  });

  // ---- customer ----
  R('GET', '/api/me', 'user', ({ user }) => {
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const stats = db.prepare(`SELECT COUNT(*) total_orders, COALESCE(SUM(CASE WHEN created_at >= date('now','-30 days') AND status IN ('paid','completed') THEN amount ELSE 0 END),0) last_month_spent FROM orders WHERE user_id=?`).get(user.id);
    return { user: pub(fresh), stats };
  });

  R('PUT', '/api/user/profile', 'user', ({ user, body }) => {
    const name = String(body.name || '').trim(), phone = normPhone(body.phone), email = String(body.email || '').trim().toLowerCase();
    const avatar = String(body.avatar || '').trim();
    if (name.length < 2) bad('Name is too short');
    if (!phone) bad('Valid phone required');
    const exist = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(phone, user.id);
    if (exist) bad('This phone is already in use by another account', 409);
    db.prepare('UPDATE users SET name=?, phone=?, email=?, avatar=? WHERE id=?').run(name, phone, email || null, avatar || null, user.id);
    return { ok: true, user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) };
  });

  R('PUT', '/api/user/password', 'user', ({ user, body }) => {
    const current = db.prepare('SELECT pass FROM users WHERE id=?').get(user.id);
    if (!L.checkPass(body.oldPassword, current.pass)) bad('Old password does not match', 400);
    const nw = String(body.newPassword || '');
    if (nw.length < 8) bad('New password must be at least 8 characters');
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(L.hashPass(nw), user.id);
    return { ok: true };
  });

  R('GET', '/api/orders', 'user', ({ user }) => ({ orders: db.prepare('SELECT code,product,uid,player_name,amount,method,trx_id,status,note,created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 200').all(user.id) }));

  R('POST', '/api/orders', 'user', async (ctx) => {
    const { body, user } = ctx;
    L.limit(ctx.ip, 'order', 20, 60 * 60e3);
    const pid = int(body.packageId), uid = String(body.uid || '').trim(), method = String(body.method || '');
    const trx = String(body.trxId || '').trim().toUpperCase(), sender = normPhone(body.sender || user.phone);
    const qty = Math.max(1, int(body.quantity || 1));
    if (!Number.isInteger(pid)) bad('Choose a package');
    if (!uid) bad('Enter Player UID');
    if (!METHODS.includes(method)) bad('Choose a payment method');
    if (!/^[A-Z0-9]{6,20}$/.test(trx)) bad('Enter valid Transaction ID (TrxID)');
    const pkg = db.prepare('SELECT p.*, c.name cname, c.region, c.active cact FROM packages p JOIN categories c ON c.id=p.category_id WHERE p.id=?').get(pid);
    if (!pkg || !pkg.active || !pkg.cact) bad('This package is not available', 404);
    
    const totalAmount = pkg.price * qty;
    const code = '6ac' + crypto.randomBytes(10).toString('hex');
    tx(() => {
      const cur = db.prepare('SELECT price,stock,active FROM packages WHERE id=?').get(pid);
      if (!cur.active) bad('This package is not available', 404);
      if (cur.stock !== null && cur.stock < qty) bad('Sorry, insufficient stock', 409);
      try {
        db.prepare('INSERT INTO orders(code,user_id,package_id,product,uid,player_name,amount,method,trx_id,sender) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(code, user.id, pid, (pkg.cname + ' — ' + pkg.label + (qty > 1 ? ` (x${qty})` : '')), uid, '', totalAmount, method, trx, sender);
      } catch (e) { if (/UNIQUE/i.test(e.message)) bad('This Transaction ID has already been used', 409); throw e; }
      if (cur.stock !== null) db.prepare('UPDATE packages SET stock=stock-? WHERE id=?').run(qty, pid);
    });
    const o = db.prepare('SELECT code,product,uid,player_name,amount,method,trx_id,status,created_at FROM orders WHERE code=?').get(code);
    ctx.status = 201;
    return { order: o };
  });

  // ---- admin ----
  R('GET', '/api/admin/orders', 'admin', ({ url }) => {
    const st = url.searchParams.get('status') || '', q = (url.searchParams.get('q') || '').trim(), args = [];
    let sql = 'SELECT o.id,o.code,o.product,o.uid,o.player_name,o.amount,o.method,o.trx_id,o.sender,o.status,o.note,o.created_at,u.name customer,u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE 1=1';
    if (st) { sql += ' AND o.status=?'; args.push(st); }
    if (q) { sql += ' AND (o.code LIKE ? OR o.uid LIKE ? OR u.phone LIKE ? OR o.trx_id LIKE ?)'; args.push(...Array(4).fill('%' + q.replace(/[%_]/g, '') + '%')); }
    return { orders: db.prepare(sql + ' ORDER BY o.id DESC LIMIT 300').all(...args) };
  });

  R('POST', '/api/admin/orders/:id/status', 'admin', async ({ params, body }) => {
    const st = String(body.status || ''), o = db.prepare('SELECT o.*, u.phone uphone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(int(params.id));
    if (!o) bad('Order not found', 404);
    tx(() => {
      db.prepare("UPDATE orders SET status=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(st, String(body.note || '').slice(0, 200) || null, o.id);
      if (st === 'rejected') db.prepare('UPDATE packages SET stock=stock+1 WHERE id=? AND stock IS NOT NULL').run(o.package_id);
    });
    return { ok: true };
  });

  R('POST', '/api/admin/categories', 'admin', ({ body }) => {
    const name = String(body.name || '').trim();
    const short = String(body.short || name).trim();
    const image = String(body.image || '').trim();
    const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || ('cat-' + Date.now());
    if (!name) bad('Category title is required');
    const id = Number(db.prepare('INSERT INTO categories(slug,name,short,tag,icon,image,region,sort) VALUES(?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM categories))').run(slug, name, short, '', '💎', image, 'BD').lastInsertRowid);
    return { id };
  });

  R('PUT', '/api/admin/categories/:id', 'admin', ({ params, body }) => {
    const id = int(params.id);
    const name = String(body.name || '').trim();
    const image = String(body.image || '').trim();
    const active = body.active ? 1 : 0;
    if (!name) bad('Category title required');
    db.prepare('UPDATE categories SET name=?, short=?, image=?, active=? WHERE id=?').run(name, name, image, active, id);
    return { ok: true };
  });

  const pkgSql = 'SELECT p.id,p.category_id,c.short category,p.label,p.price,p.bonus,p.stock,p.active FROM packages p JOIN categories c ON c.id=p.category_id ORDER BY c.sort,p.sort,p.id';
  R('GET', '/api/admin/packages', 'admin', () => ({ 
    packages: db.prepare(pkgSql).all(), 
    categories: db.prepare('SELECT id,short,name,image,active FROM categories ORDER BY sort').all() 
  }));

  const pkgFields = (b, partial) => {
    const f = {};
    if (!partial || b.label !== undefined) { f.label = String(b.label || '').trim(); if (!f.label || f.label.length > 120) bad('Enter a package label'); }
    if (!partial || b.price !== undefined) { f.price = int(b.price); if (!Number.isInteger(f.price) || f.price < 0 || f.price > 1e6) bad('Enter a valid price'); }
    if (!partial || b.bonus !== undefined) { f.bonus = int(b.bonus, 0); if (!Number.isInteger(f.bonus) || f.bonus < 0) bad('Enter a valid bonus'); }
    if (!partial || b.stock !== undefined) { f.stock = int(b.stock, null); if (f.stock !== null && (!Number.isInteger(f.stock) || f.stock < 0)) bad('Enter a valid stock'); }
    if (b.active !== undefined) f.active = b.active ? 1 : 0;
    return f;
  };
  R('POST', '/api/admin/packages', 'admin', (ctx) => {
    const f = pkgFields(ctx.body, false), cid = int(ctx.body.category_id);
    if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(cid)) bad('Choose a category');
    const id = Number(db.prepare('INSERT INTO packages(category_id,label,price,bonus,stock,sort) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM packages WHERE category_id=?))').run(cid, f.label, f.price, f.bonus, f.stock, cid).lastInsertRowid);
    ctx.status = 201; return { id };
  });
  R('PUT', '/api/admin/packages/:id', 'admin', ({ params, body }) => {
    const id = int(params.id), old = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!old) bad('Package not found', 404);
    const f = pkgFields(body, true), keys = Object.keys(f);
    if (keys.length) tx(() => {
      db.prepare(`UPDATE packages SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => f[k]), id);
    });
    return { ok: true };
  });

  R('GET', '/api/admin/users', 'admin', () => ({ users: db.prepare("SELECT u.id,u.name,u.phone,u.role,u.created_at,(SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders FROM users u ORDER BY u.id DESC LIMIT 500").all() }));

  R('GET', '/api/admin/report', 'admin', () => {
    const rev = "CASE WHEN o.status IN ('paid','completed') THEN o.amount ELSE 0 END";
    return {
      totals: db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(${rev}),0) revenue, (SELECT COUNT(*) FROM users WHERE role='user') customers FROM orders o`).get(),
      byStatus: db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all(),
      byDay: db.prepare(`SELECT date(o.created_at) day, COUNT(*) n, SUM(${rev}) revenue FROM orders o WHERE o.created_at >= date('now','-13 days') GROUP BY day ORDER BY day`).all(),
      byCategory: db.prepare(`SELECT c.short category, COUNT(*) n, SUM(${rev}) revenue FROM orders o JOIN packages p ON p.id=o.package_id JOIN categories c ON c.id=p.category_id GROUP BY c.id ORDER BY revenue DESC`).all(),
    };
  });

  // ---- plumbing ----
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
  const readBody = (req) => new Promise((ok, no) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 5 * 1024 * 1024) { no(new HttpError(413, 'Request too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', no);
  });
  const userFrom = (req) => {
    const p = tokens.verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    return p ? db.prepare('SELECT * FROM users WHERE id=?').get(p.id) : null;
  };

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'");
    let url; try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    if (dev && url.pathname === '/__dev') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 500\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname.startsWith('/api/')) {
      let hit = null, params = {};
      for (const r of routes) { const m = r.m === req.method && r.re.exec(url.pathname); if (m) { hit = r; params = m.groups || {}; break; } }
      if (!hit) return send(res, routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, { error: 'Not found' });
      try {
        const ctx = { req, url, params, ip: req.socket.remoteAddress || '', user: null, body: {}, status: 200 };
        if (hit.auth) {
          ctx.user = userFrom(req);
          if (!ctx.user) return send(res, 401, { error: 'Please log in' });
          if (hit.auth === 'admin' && ctx.user.role !== 'admin') return send(res, 403, { error: 'Admins only' });
        }
        if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
        const out = await hit.fn(ctx);
        return send(res, ctx.status, out);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        console.error(e); return send(res, 500, { error: 'Server error' });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p; try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
    const full = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
    if (!full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(full, (e, d) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      if (dev && full.endsWith('.html')) d = Buffer.from(String(d).replace('</body>', LIVE + '</body>'));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : d);
    });
  });
}

module.exports = { createApp };
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`TEAM 84 FF running on http://localhost:${port}` + (process.argv.includes('--dev') ? '  (live reload ON — edit public/index.html and save)' : '')));
}