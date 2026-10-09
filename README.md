# TEAM 84 FF — Free Fire Top-Up Store

Full-stack build of the website outline: storefront, accounts, orders, payment flow, player-name lookup, WhatsApp/SMS notifications, admin panel and reports.
Node.js ≥ 22.5, **zero npm dependencies**, SQLite database (one file).

## Run it
```bash
cp .env.example .env      # set ADMIN_PASSWORD, merchant numbers, support number
node server.js            # http://localhost:3000
npm test                  # 13 API/integration tests
```
First start creates the admin account (`ADMIN_PHONE` / `ADMIN_PASSWORD`; a random password is printed once if you leave it empty).
Log in on the site with the admin phone → you land in the **Admin Panel** (`/#/admin`).

## Edit and see results instantly
```bash
npm run dev        # or: node --watch server.js --dev
```
Open http://localhost:3000, then edit and **save** — the browser refreshes by itself:
- `public/index.html` — the whole site. Colours are at the top (`:root{--orange:...}`), styles in `<style>`, page logic at the bottom in `<script>`.
- `server.js`, `lib.js`, `db.js` — the server restarts automatically, then the browser reloads.
- Prices, stock and packages need **no code**: use the Admin Panel.
- After changing `.env`, stop (Ctrl+C) and run `npm run dev` again.

## What's in it
| Roadmap step | Built |
|---|---|
| Static frontend | `public/index.html` — Home, 6 category pages, Contact, Login/Register, bilingual notices, design system from the outline |
| Backend & database | `server.js`, `db.js` — categories, packages (price, bonus, **stock**), price history, users, orders, outbox |
| Accounts & orders | scrypt-hashed passwords, signed 7-day tokens, BD phone validation, server-side pricing, sold-out handling, duplicate-TrxID protection |
| Payments | bKash / Nagad / Rocket / manual **Send-Money + TrxID** flow: buyer pays, submits TrxID + sender number, admin verifies (pending → paid → completed / rejected) |
| Admin panel | Orders (filter/search, verify, complete, reject with reason), Packages (edit price/bonus/stock/active, add), Users, Sales report |
| Notifications | every status change is queued in `outbox` and POSTed to your WhatsApp/SMS gateway (`NOTIFY_WEBHOOK_URL`) |
| Player lookup | "Check Player Name" calls any JSON API you configure (`UID_API_URL`) |
| QA | `test.js` (13 tests incl. mock gateways), security headers/CSP, rate limiting, XSS-escaped rendering |

## Needs YOUR credentials (cannot be built without them)
- **Automatic payment verification** via bKash/Nagad/Rocket merchant APIs requires a merchant account + API credentials. Until then the admin confirms each TrxID in the wallet app. Put your numbers in `BKASH_NUMBER`, `NAGAD_NUMBER`, `ROCKET_NUMBER`.
- **Player-name lookup**: set `UID_API_URL` (e.g. `https://your-provider/uid/{uid}?region={region}`), optional `UID_API_KEY`, and `UID_API_NAME_FIELD` (dot path, e.g. `data.nickname`). If unset, the button says lookup isn't enabled and the admin verifies the UID.
- **WhatsApp/SMS**: any gateway that accepts `POST {"to": "01XXXXXXXXX", "message": "..."}` (optional Bearer token). If unset, messages are only stored in `outbox`.

## Deploy (Ubuntu VPS, HTTPS)
```bash
sudo apt install -y nginx certbot python3-certbot-nginx   # + Node 22 from nodesource
sudo useradd -r -m team84 && sudo cp -r . /opt/team84ff && sudo chown -R team84 /opt/team84ff
# /etc/systemd/system/team84.service
#   [Service] User=team84 WorkingDirectory=/opt/team84ff ExecStart=/usr/bin/node server.js Restart=always
#   [Install] WantedBy=multi-user.target
sudo systemctl enable --now team84
# nginx: server_name yourdomain.com; location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Real-IP $remote_addr; }
sudo certbot --nginx -d yourdomain.com
```
Back up `data/shop.db` (and `data/.secret`) daily. cPanel works too if it supports Node.js apps.

## Honest limits
- Database is **SQLite**, not MySQL. It comfortably handles a shop of this size; the schema is plain SQL if you later migrate.
- Rate limiting is in-memory (per process). Run a single instance, or add nginx `limit_req`.
- Password reset and SMS-OTP signup are not included (need an SMS provider).
- The "Tutorial video" box and social links are placeholders — add your URLs in `public/index.html`.
