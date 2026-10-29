# asus.wtf — running the site, keys and premium

Three separate things, often confused with each other:

| Piece | Lives in | Runs where | URL |
|---|---|---|---|
| Public site + accounts + key gate | `docs/` | GitHub Pages (`main`) | <https://asusclient.github.io/asus/> |
| Key server + **key admin panel** | `site/server/` | your PC (`node`) | <http://localhost:3000/admin> |
| Keysmith app (exe) | `keysmith/` | your PC | desktop app |

`/admin` exists **only** on the local Node server. There is no `/admin` on the
GitHub Pages site, so opening `asusclient.github.io/asus/admin` is a 404 by design.

---

## 1. Start the local key server + admin panel

```bash
cd site/server
node server.mjs
```

Then:

- site: <http://localhost:3000>
- key admin: <http://localhost:3000/admin>

Sign in with the Basic-auth pair from `site/server/config.json`:

```json
"ADMIN_USER": "admin",
"ADMIN_PASSWORD": "asus-admin-2026"
```

Change that password to something private. If `ADMIN_PASSWORD` is empty the whole
panel and `/api/admin/*` are closed — that is the most common reason "the admin
panel doesn't work".

You can also override everything with env vars for a one-off run:

```bash
PORT=3000 ADMIN_PASSWORD=change-me node server.mjs
```

### Generating keys in the panel

Durations now work down to seconds. The panel always sends an absolute
`expiresAtMs`, and the server used to ignore it (it only read whole `days`), so
every key came out as "never expires". That is fixed: 3s, 30m, 1h, 1d, 1w,
1mo, 1y and Never all store the exact expiry.

### Generating keys from the admin page

`/admin.html` on the deployed site has a **Key generator** card. It does not mint
keys itself — a static page can't, and keys it invented would be rejected in
game. It calls your local key server, so start that first:

```bash
cd site/server
node site/server/server.mjs
```

Then fill in the card:

| Field | Value |
|---|---|
| Server | `http://localhost:3000` |
| Admin user / password | from `site/server/config.json` |
| Duration | amount + unit, or tick **Never expires** |
| How many / PCs per key | batch size and binding limit |
| Give premium to | optional account email; also unlocks the website for them |

The browser only allows this because `localhost` counts as a secure origin and
the server answers the private-network preflight. If the card says
**server unreachable**, the Node server isn't running or the password is wrong.
The credentials are kept in `sessionStorage` only (gone when the tab closes).

### How panel keys reach the live site

With `PUBLISH_SITE=1` (default) the server writes `docs/assets/licenses.js`,
commits it and pushes to `origin main` after every generate / revoke / delete.
GitHub Pages then redeploys in about a minute.

That push needs working git credentials on this machine. If it fails, the panel
still generates keys locally, but the website won't know them. Publish by hand:

```bash
python tools/publish-site-keys.py
git add docs/assets/licenses.js docs/assets/licenses.json
git commit -m "update site keys"
git push
```

Only SHA-256 fingerprints are published — never the raw keys.

---

## 2. Premium for registered site accounts

Accounts are Supabase (`docs/assets/supabase-config.js`), not the Node server.
Premium is a flag on the account's profile row, and only listed admins can change it.

### One-time setup

1. Supabase → **SQL Editor** → paste all of [`docs/sql/premium.sql`](sql/premium.sql) → **Run**.
2. In that file, change the seeded admin email to the account **you** sign in with
   (it currently contains the test account `d62565565@gmail.com`):

   ```sql
   insert into public.site_admins (email) values ('you@example.com')
   on conflict (email) do nothing;
   ```

   Re-run just that statement after editing. Add more rows for more admins.

### Using it

1. Open <https://asusclient.github.io/asus/admin.html> (also works locally while
   serving `docs/`).
2. Sign in with the admin account.
3. Search the account, press **Give premium**.
4. That user's dashboard now shows **Premium** and the full-build download without
   needing a license key. **Remove premium** locks it again on their next dashboard load.

New sign-ups get a profile row automatically; the SQL also backfills accounts that
already existed.

### Why it is safe with a public anon key

- `public.profiles` has RLS: a user can read only their own row.
- Reading the full list and updating `is_premium` requires
  `public.is_site_admin()`, which checks the signed-in JWT's email against
  `public.site_admins`. That table has RLS with **no policies**, so only the SQL
  editor / service role can edit it.
- The page is `noindex`, but hiding is not the protection — RLS is. Signing in as
  a normal user shows "not an admin" and returns zero rows.

### Limitation

`docs/assets/asus-wtf-1.0.10.jar` is a static file on Pages. Premium and keys
control what the dashboard reveals, not the raw URL. Real download control needs
the Node server's `/download/premium` endpoint; treat the Pages button as
convenience, not DRM.

---

## 3. Serve the public site locally

```bash
python -m http.server 8777 --directory docs
```

Then <http://localhost:8777/>. Account pages will call Supabase for real, so add
`http://localhost:8777` to Supabase → **Authentication → URL Configuration** if
sign-in there should work; otherwise test accounts on the deployed URL.

---

## 4. Troubleshooting

| Symptom | Cause |
|---|---|
| `/admin` is a 404 | You are on the Pages site. Run `node site/server/server.mjs` and use `localhost:3000/admin`. |
| `/admin` rejects the password | `ADMIN_PASSWORD` is empty or different in `config.json`. |
| `localhost:3000` refuses to connect | The server isn't running — start it again; it does not stay up after a reboot. |
| Panel says keys generated but the site says "not on the list" | The publish push failed. Run `tools/publish-site-keys.py`, commit and push. |
| `/admin.html` says "not an admin account" | That email is not in `public.site_admins`, or `premium.sql` was never run. |
| Premium page says the profiles table is missing | Run `docs/sql/premium.sql`. |
