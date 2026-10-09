'use strict';
process.env.ADMIN_PHONE = '01700000000';
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.SECRET = 'test-secret';
delete process.env.UID_API_URL; delete process.env.NOTIFY_WEBHOOK_URL;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createApp } = require('./server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't84-'));
const server = createApp({ dbFile: path.join(dir, 'test.db') });
let base;
test.before(() => new Promise((ok) => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; ok(); })));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let user, admin, cats;
const pkgOf = (slug, i = 0) => cats.find((c) => c.slug === slug).pkgs[i];
const order = (pid, trx, extra = {}) => call('POST', '/api/orders', { packageId: pid, uid: '123456789', method: 'bkash', trxId: trx, sender: '01711111111', ...extra }, user.token);

test('catalogue is seeded with 6 categories and correct prices', async () => {
  const r = await call('GET', '/api/categories');
  cats = r.body.categories;
  assert.equal(r.status, 200); assert.equal(cats.length, 6);
  assert.deepEqual(cats[0].pkgs.map((p) => p.price), [19, 35, 79, 158, 335, 479]);
});

test('register validates input, rejects duplicates, normalises phone', async () => {
  assert.equal((await call('POST', '/api/register', { name: 'A', phone: '123', password: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/register', { name: 'Rahim', phone: '01711111111', password: 'short' })).status, 400);
  const r = await call('POST', '/api/register', { name: 'Rahim', phone: '+8801711111111', password: 'secret123' });
  assert.equal(r.status, 200); assert.equal(r.body.user.phone, '01711111111'); assert.equal(r.body.user.role, 'user');
  assert.equal((await call('POST', '/api/register', { name: 'Rahim', phone: '01711111111', password: 'secret123' })).status, 409);
  user = r.body;
});

test('login: wrong password 401, correct works, admin role is not assignable at signup', async () => {
  assert.equal((await call('POST', '/api/login', { phone: '01711111111', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { phone: '01711111111', password: 'secret123' })).status, 200);
  const a = await call('POST', '/api/login', { phone: '01700000000', password: 'AdminPass123' });
  assert.equal(a.body.user.role, 'admin'); admin = a.body;
  const sneaky = await call('POST', '/api/register', { name: 'Eve', phone: '01722222222', password: 'secret123', role: 'admin' });
  assert.equal(sneaky.body.user.role, 'user');
});

test('auth: forged/absent tokens are rejected; users cannot reach admin API', async () => {
  assert.equal((await call('GET', '/api/orders')).status, 401);
  assert.equal((await call('GET', '/api/orders', null, 'garbage.token')).status, 401);
  const forged = user.token.split('.')[0] + '.AAAA';
  assert.equal((await call('GET', '/api/me', null, forged)).status, 401);
  assert.equal((await call('GET', '/api/admin/orders', null, user.token)).status, 403);
  assert.equal((await call('GET', '/api/admin/report', null, user.token)).status, 403);
});

test('uid-check validates and reports when lookup is not configured', async () => {
  assert.equal((await call('POST', '/api/uid-check', { uid: 'abc' })).status, 400);
  const r = await call('POST', '/api/uid-check', { uid: '123456789', slug: 'diamond-topup' });
  assert.equal(r.status, 200); assert.equal(r.body.configured, false);
});

test('order: validation, server-side price, duplicate TrxID, ownership', async () => {
  const p = pkgOf('diamond-topup', 2);
  assert.equal((await call('POST', '/api/orders', { packageId: p.id, uid: '1', method: 'bkash', trxId: 'ABC12345', sender: '01711111111' })).status, 401);
  assert.equal((await order(p.id, '')).status, 400);
  assert.equal((await order(p.id, 'ABC12345', { uid: 'xx' })).status, 400);
  assert.equal((await order(p.id, 'ABC12345', { method: 'paypal' })).status, 400);
  assert.equal((await order(p.id, 'ABC12345', { sender: '999' })).status, 400);
  assert.equal((await order(99999, 'ABC12345')).status, 404);
  const ok = await order(p.id, 'abc12345', { amount: 1, price: 1 });
  assert.equal(ok.status, 201); assert.equal(ok.body.order.amount, 79); assert.equal(ok.body.order.status, 'pending'); assert.equal(ok.body.order.trx_id, 'ABC12345');
  assert.equal((await order(p.id, 'ABC12345')).status, 409);
  const mine = await call('GET', '/api/orders', null, user.token);
  assert.equal(mine.body.orders.length, 1);
  const other = (await call('POST', '/api/register', { name: 'Karim', phone: '01733333333', password: 'secret123' })).body;
  assert.equal((await call('GET', '/api/orders', null, other.token)).body.orders.length, 0);
});

test('stock is decremented, sold-out is enforced, rejection restores stock', async () => {
  const p = pkgOf('topup-event', 0);
  assert.equal((await call('PUT', '/api/admin/packages/' + p.id, { stock: 1 }, admin.token)).status, 200);
  const first = await order(p.id, 'STOCK0001');
  assert.equal(first.status, 201);
  assert.equal((await order(p.id, 'STOCK0002')).status, 409);
  const id = (await call('GET', '/api/admin/orders?q=STOCK0001', null, admin.token)).body.orders[0].id;
  assert.equal((await call('POST', `/api/admin/orders/${id}/status`, { status: 'rejected', note: 'bad trx' }, admin.token)).status, 200);
  assert.equal((await order(p.id, 'STOCK0002')).status, 201);
  assert.equal((await call('POST', `/api/admin/orders/${id}/status`, { status: 'paid' }, admin.token)).status, 409);
});

test('admin: status workflow, invalid transitions, filters, notifications outbox', async () => {
  const p = pkgOf('weekly-monthly', 0);
  await order(p.id, 'FLOW00001');
  const o = (await call('GET', '/api/admin/orders?q=FLOW00001', null, admin.token)).body.orders[0];
  assert.equal(o.customer, 'Rahim');
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/status`, { status: 'completed' }, admin.token)).status, 409);
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/status`, { status: 'paid' }, admin.token)).status, 200);
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/status`, { status: 'completed' }, admin.token)).status, 200);
  assert.equal((await call('GET', '/api/admin/orders?status=completed', null, admin.token)).body.orders.length, 1);
  const mine = (await call('GET', '/api/orders', null, user.token)).body.orders.find((x) => x.code === o.code);
  assert.equal(mine.status, 'completed');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  const msgs = db.prepare('SELECT message FROM outbox WHERE phone=?').all('01711111111').map((m) => m.message);
  assert.ok(msgs.some((m) => m.includes(o.code) && m.includes('complete')));
  db.close();
});

test('admin: package CRUD validates, records price history, hides inactive packages', async () => {
  const p = pkgOf('like-guild-bot', 0);
  assert.equal((await call('PUT', '/api/admin/packages/' + p.id, { price: -5 }, admin.token)).status, 400);
  assert.equal((await call('PUT', '/api/admin/packages/' + p.id, { price: 31 }, admin.token)).status, 200);
  const add = await call('POST', '/api/admin/packages', { category_id: cats[0].id, label: '1000 💎', price: 900, bonus: 0, stock: '' }, admin.token);
  assert.equal(add.status, 201);
  let c = (await call('GET', '/api/categories')).body.categories;
  assert.equal(c.find((x) => x.slug === 'like-guild-bot').pkgs[0].price, 31);
  assert.ok(c[0].pkgs.some((x) => x.label === '1000 💎'));
  await call('PUT', '/api/admin/packages/' + add.body.id, { active: false }, admin.token);
  c = (await call('GET', '/api/categories')).body.categories;
  assert.ok(!c[0].pkgs.some((x) => x.label === '1000 💎'));
  assert.equal((await order(add.body.id, 'HIDDEN001')).status, 404);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_history WHERE package_id=?').get(p.id).n, 1);
  db.close();
});

test('admin: report and users', async () => {
  const r = (await call('GET', '/api/admin/report', null, admin.token)).body;
  assert.ok(r.totals.orders >= 3); assert.ok(r.totals.revenue >= 159);
  assert.ok(r.byCategory.length >= 1); assert.ok(Array.isArray(r.byDay));
  const u = (await call('GET', '/api/admin/users', null, admin.token)).body.users;
  assert.ok(u.some((x) => x.phone === '01711111111' && x.orders >= 3));
  assert.ok(!JSON.stringify(u).includes('scrypt') && !u.some((x) => 'pass' in x));
});

test('static: index served, traversal blocked, security headers set', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  const raw = (p) => new Promise((ok) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (x) => { x.resume(); ok(x.statusCode); }));
  assert.equal(await raw('/..%2fserver.js'), 403);
  assert.notEqual(await raw('/%2e%2e/server.js'), 200);
  assert.notEqual(await raw('/../../etc/passwd'), 200); // URL normalisation confines this to public/
  assert.equal(await raw('/nope.txt'), 404);
});

test('integrations: UID lookup + notification webhook work against a mock gateway', async () => {
  const got = [];
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/uid/')) {
      if (req.url.startsWith('/uid/555555555')) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: { nickname: 'ProGamer84' } }));
    }
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200); res.end('{}'); });
  });
  await new Promise((ok) => mock.listen(0, ok));
  const m = 'http://127.0.0.1:' + mock.address().port;
  process.env.UID_API_URL = m + '/uid/{uid}'; process.env.UID_API_NAME_FIELD = 'data.nickname';
  process.env.NOTIFY_WEBHOOK_URL = m + '/notify'; process.env.NOTIFY_WEBHOOK_TOKEN = 'gw-token';
  try {
    const ok = await call('POST', '/api/uid-check', { uid: '123456789', slug: 'diamond-topup' });
    assert.deepEqual(ok.body, { configured: true, name: 'ProGamer84' });
    assert.equal((await call('POST', '/api/uid-check', { uid: '555555555', slug: 'diamond-topup' })).body.name, null);
    assert.equal((await order(pkgOf('diamond-topup', 0).id, 'UIDBAD001', { uid: '555555555' })).status, 400);
    const good = await order(pkgOf('diamond-topup', 0).id, 'UIDGOOD01');
    assert.equal(good.status, 201); assert.equal(good.body.order.player_name, 'ProGamer84');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(got.length >= 2 && got.every((g) => g.auth === 'Bearer gw-token'));
    assert.ok(got.some((g) => g.body.to === '01711111111' && g.body.message.includes(good.body.order.code)));
    process.env.UID_API_URL = 'http://127.0.0.1:1/x/{uid}';
    assert.equal((await call('POST', '/api/uid-check', { uid: '123456789', slug: 'diamond-topup' })).status, 502);
    process.env.NOTIFY_WEBHOOK_URL = 'http://127.0.0.1:1/down'; delete process.env.UID_API_URL;
    assert.equal((await order(pkgOf('diamond-topup', 1).id, 'NOTIFYDN1')).status, 201);
    await new Promise((r) => setTimeout(r, 300));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'test.db'));
    assert.ok(db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='failed'").get().n >= 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='sent'").get().n >= 2);
    db.close();
  } finally { delete process.env.UID_API_URL; delete process.env.NOTIFY_WEBHOOK_URL; delete process.env.NOTIFY_WEBHOOK_TOKEN; mock.close(); }
});

test('bad JSON → 400, unknown API → 404, rate limit → 429 (runs last)', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  let last;
  for (let i = 0; i < 15; i++) last = (await call('POST', '/api/login', { phone: '01799999999', password: 'x' })).status;
  assert.equal(last, 429);
});
