'use strict';
const { DatabaseSync } = require('node:sqlite');

const SEED = [
  ['like-guild-bot', 'ফ্রী ফায়ার লাইক এবং গিল্ড বট', 'ফ্রী ফায়ার লাইক এবং গিল্ড বট', 'Like & Guild Service', '👍', 'https://placehold.co/400x300/1e293b/ffffff?text=Like+%26+Guild+Bot', 'BD', [['100 Profile Likes', 29], ['500 Profile Likes', 119], ['Guild Boost (Small)', 89], ['Guild Boost (Large)', 199]]],
  ['diamond-topup', 'FF (UID) TopUp (BD)', 'FF (UID) TopUp (BD)', 'Instant UID Top-Up', '💎', 'https://placehold.co/400x300/1e293b/ffffff?text=UID+TopUp', 'BD', [['25 💎', 19], ['50 💎', 35], ['115 💎', 79], ['240 💎', 158], ['505 💎', 335], ['725 💎', 479]]],
  ['weekly-monthly', 'Weekly monthly BD BD', 'Weekly monthly BD BD', 'Membership Passes', '📅', 'https://placehold.co/400x300/1e293b/ffffff?text=Weekly+Monthly', 'BD', [['Weekly Membership', 159], ['Monthly Membership', 649], ['Weekly + Monthly (BD)', 749]]],
  ['topup-event', 'Top Up Event ( DB BD )', 'Top Up Event ( DB BD )', 'Event Bonuses', '🔥', 'https://placehold.co/400x300/1e293b/ffffff?text=TopUp+Event', 'BD', [['50 💎 Event', 35, 10], ['115 💎 Event', 79, 25], ['240 💎 Event', 158, 60], ['505 💎 Event', 335, 150]]],
  ['bd-weekly-lite', 'BD weekly lite BD', 'BD weekly lite BD', 'Lite Membership', '⚡', 'https://placehold.co/400x300/1e293b/ffffff?text=Weekly+Lite', 'BD', [['Weekly Lite 1', 49], ['Weekly Lite 2', 89]]],
  ['level-up-pass', 'BD Level up pass বাংলাদেশ BD', 'BD Level up pass বাংলাদেশ BD', 'Pass Level 1-60', '🏆', 'https://placehold.co/400x300/1e293b/ffffff?text=Level+Up+Pass', 'BD', [['Level 1–20', 49], ['Level 21–40', 99], ['Level 41–60', 179], ['Level 61+', 299]]],
  ['indonesia-topup', 'MC 💎 ইন্দোনেশিয়া সকল টপ আপ 💎 MC', 'MC 💎 ইন্দোনেশিয়া সকল টপ আপ 💎 MC', 'Indonesia Region', '🌏', 'https://placehold.co/400x300/1e293b/ffffff?text=Indonesia+TopUp', 'ID', [['50 💎 (ID)', 39], ['115 💎 (ID)', 85], ['240 💎 (ID)', 169], ['505 💎 (ID)', 349]]]
];

function open(file) {
  const db = new DatabaseSync(file);
  db.exec(`
  PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, email TEXT, avatar TEXT, balance INTEGER DEFAULT 0, verified INTEGER DEFAULT 0, role TEXT NOT NULL DEFAULT 'user', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, short TEXT NOT NULL, tag TEXT, icon TEXT, image TEXT, region TEXT DEFAULT 'BD', sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), label TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), bonus INTEGER NOT NULL DEFAULT 0, stock INTEGER, active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS price_history(id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL, old_price INTEGER, new_price INTEGER, changed_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), package_id INTEGER NOT NULL REFERENCES packages(id), product TEXT NOT NULL, uid TEXT NOT NULL, player_name TEXT, amount INTEGER NOT NULL, method TEXT NOT NULL, trx_id TEXT, sender TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_trx ON orders(method, trx_id) WHERE trx_id IS NOT NULL AND status <> 'rejected';
  CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, phone TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);

  try { db.exec("ALTER TABLE users ADD COLUMN email TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN balance INTEGER DEFAULT 0;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0;"); } catch (e) {}
  try { db.exec("ALTER TABLE categories ADD COLUMN image TEXT;"); } catch (e) {}

  // বিদ্যমান ক্যাটাগরিগুলো সরাসরি বাংলায় আপডেট করার কুয়েরি
  const updateStmt = db.prepare('UPDATE categories SET name=?, short=?, sort=? WHERE slug=?');
  const insertStmt = db.prepare('INSERT INTO categories(slug,name,short,tag,icon,image,region,sort) VALUES(?,?,?,?,?,?,?,?)');
  const ip = db.prepare('INSERT INTO packages(category_id,label,price,bonus,sort) VALUES(?,?,?,?,?)');

  SEED.forEach((c, i) => {
    const existing = db.prepare('SELECT id FROM categories WHERE slug=?').get(c[0]);
    if (existing) {
      updateStmt.run(c[1], c[2], i, c[0]);
    } else {
      const id = Number(insertStmt.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6], i).lastInsertRowid);
      c[7].forEach((p, j) => ip.run(id, p[0], p[1], p[2] || 0, j));
    }
  });

  return db;
}
module.exports = { open };