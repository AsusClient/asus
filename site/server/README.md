# asus.wtf — site, Discord gate, key server

Static site plus one small Node process that does three jobs:

1. serves the site,
2. optionally gates `/download` behind Discord OAuth2,
3. issues and checks client keys at `/api/license/auth`, with an admin panel at `/admin`.

Zero npm dependencies. Node 18 or newer (it uses the built-in `fetch`).

```
site/
  index.html
  assets/            style.css, app.js, auth.js, shots/, asus-wtf-1.0.10.jar
  server/
    server.mjs       static + /auth/discord + /api/me + /download + /api/license/*
    license.mjs      key format, store, binding rules (shared with the CLI)
    admin.html       key admin panel (Basic auth)
    genkey.mjs       offline key generator / lister / revoker
    config.example.json
    package.json
    keys.json        created on first run — never serve this
```

## 1. Run it locally

```bash
cd site/server
node server.mjs
```

Open <http://localhost:3000>. Without Discord credentials the server runs in **open mode**:
the site works and `/download` is public. Keys still work either way — the jar checks them
against this same server, so you can test the whole flow locally.

Useful env vars (all optional, see `config.example.json`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:$PORT` | Public origin; sets `Secure` cookies and the OAuth redirect |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / — | `/admin` and `/api/admin/*`; closed when the password is empty |
| `KEY_STORE` | `./keys.json` | Where keys live |
| `JAR_PATH` | `../assets/asus-wtf-1.0.10.jar` | File served by `/download` |
| `PUBLISH_SITE` | `1` | Republish the site's key fingerprints after generate/revoke/delete; `0` turns it off |

## 2. Keys

Every key looks like `ASUS-XXXXX-XXXXX-XXXXX-XXXXX` (20 characters from a 32-symbol alphabet
with `I`, `O`, `0`, `1` removed — 100 bits of entropy). One key binds to one install by default;
`--uses` raises that. Binding happens on the first successful check, so the client is the thing
that claims a slot, not the generator.

**Generate from the panel** — set `ADMIN_PASSWORD`, open `/admin`, fill the form, copy. The page
lists every key with bound slots, last seen time and expiry, and can revoke or unbind.

**Generate from the CLI** (same store, offline):

```bash
node genkey.mjs 10                        # ten keys, one machine each
node genkey.mjs 5 --uses 2 --days 30      # multi-machine, 30 day expiry
node genkey.mjs --list                    # table of everything
node genkey.mjs --revoke ASUS-...         # burn a key
node genkey.mjs --unbind ASUS-...         # free its machines (for a PC swap)
```

**Endpoint the client calls**

```
POST /api/license/auth
{ "key": "ASUS-...", "hwid": "32 hex chars" }

200 { "ok": true,  "reason": "ok", "plan": "beta", "expiresAt": null, "remainingUses": 0 }
403 { "ok": false, "reason": "unknown" | "malformed" | "revoked" | "expired" | "in-use" }
```

The client derives `hwid` as SHA-256 over a random per-install id file plus OS name, arch and
user name. It is stable across restarts, survives reinstalling the jar, and dies with the
`.minecraft/config/asus_wtf/install.id` file.

**Pointing the client at your host** — one line, then rebuild:

```java
// src/client/java/wtf/asus/client/auth/KeyAuth.java
public static final String DEFAULT_SERVER = "http://localhost:3000";   // ← your https origin
```

A JVM flag overrides it without a rebuild (`-Dasuswtf.license.url=https://keys.example.com`),
and `config/asus_wtf/license.json` remembers whatever it last talked to.

The client caches a successful check for **72 hours**, so a server outage does not lock people
out overnight, and revalidates every 30 minutes so a revoked key stops working.

**The launch gate** — the key prompt owns the screen from the moment the game window is up until a
key is accepted *during that launch*, so nothing can be played before it is answered: Escape is
ignored, there is no close button, and the prompt is reinstated every tick if the title screen (or
anything else) takes the screen back. A cached licence opens the menu but not the gate, so every
start asks; the stored key is prefilled, which makes it one Enter. A rejected key answers
`Invalid key - try again.` plus the reason and the game stays locked. The gate lives in
`wtf.asus.client.auth.LaunchGate` and is driven from the client tick; `KeyAuth.isLicensed()` still
gates the menu itself.

Nothing runs before the JVM starts — a mod cannot intercept the process earlier than the client's
first tick, so "before launch" means before the title screen is usable, not before the window
appears.

## 3. Discord application (download gate)

The site's Discord button and the key screen's "Get a key" button both point at
`https://discord.gg/Ua8qVQ2JU`. The OAuth login below is optional and only gates the download.

1. <https://discord.com/developers/applications> → **New Application** → `asus.wtf`.
2. **OAuth2** → copy **Client ID** and **Client Secret**.
3. **OAuth2 → Redirects** → add both:
   - `http://localhost:3000/auth/discord/callback`
   - `https://your-domain.example/auth/discord/callback`
4. Scopes: `identify`, plus `guilds` if you use the membership gate.

```bash
cp config.example.json config.json    # then fill in the ids
node server.mjs
```

The nav gains a **Sign in** chip and every `.jar` link is rewritten to `/download`, which
bounces through Discord and lands back on the file. Environment variables win over
`config.json`.

## 4. Membership gate (optional)

| Setting | What it does |
|---|---|
| `GUILD_ID` | Require the user to be in this server. |
| `REQUIRED_ROLE_IDS` | Comma-separated role IDs; user needs at least one. |
| `DISCORD_BOT_TOKEN` | Bot token used to read the member record. Bot must be in the guild. |
| `INVITE_URL` | Shown on the "not authorised" page. |

Check: bot token → `GET /guilds/{guild}/members/{user}` → 404 means not in the server, else the
`roles` array is intersected with `REQUIRED_ROLE_IDS`. Set `GUILD_ID` without a bot token and
the gate is skipped with a log warning. No privileged intents needed, just `View Members`.

## 5. Deploying

**GitHub Pages cannot host this part.** Pages is static; OAuth needs somewhere to hold
`DISCORD_CLIENT_SECRET`, and keys need a writable store. Also never put the jar in a public
Pages repo — anyone can fetch it.

1. **One host for everything** (simplest) — Render, Railway, Fly.io, a VPS. `npm start`, set the
   env vars, point the domain at it. One origin, no CORS, `/download` sits next to the site.
   `keys.json` needs a persistent disk: mount a volume and set `KEY_STORE` to it.
2. **Pages front-end, this server for API** — deploy `server.mjs` on a subdomain, change the
   fetches in `assets/auth.js` to absolute URLs, add CORS on the API routes. More moving parts.
3. **Cloudflare Workers** — same flow, keys in KV or D1, jar in R2. Rewrite `license.mjs`
   against KV; the rules are a dozen functions and port cleanly.

Set `BASE_URL` to the real HTTPS origin. Cookies flip to `Secure` automatically on `https://`
and the redirect URI must match the Discord portal entry exactly.

## 6. Publishing the site gate

The GitHub Pages dashboard only carries SHA-256 fingerprints, so a new key is invisible until
that list is republished. The server does it for you: after a successful generate, revoke,
revoke-all, delete or delete-all it rewrites `docs/assets/licenses.js` **and**
`docs/assets/licenses.json`, commits only those two files and pushes to `origin/main`.

It does this from a dedicated shallow clone at `site/server/.site-publish` (gitignored), fetched
from `origin/main` first. That means it works even when your local checkout is behind or dirty,
and it never stages `keys.json`, `config.json` or anything else. The first run clones the repo;
git needs working push credentials. Failures are logged as `[site] publish failed: …` and do not
break key generation — the key is still valid on the server.

The site fetches `licenses.json` with `cache: "no-store"`, so a revocation locks the dashboard on
the next page load instead of waiting out GitHub Pages' 10-minute cache.

This gates the page: the paid jar is still a public file under `docs/assets/`. Revoking hides the
download button and locks the gate, but anyone who knows the jar URL can still fetch it. True
file-level revocation needs the jar behind a server that checks the key before streaming it.

## 7. What is already handled

- Key format with a fixed alphabet, canonical re-grouping, and per-IP rate limit on `/api/license/auth`.
- Atomic `keys.json` writes (temp file + rename); the store is never served (`/server/*` is 403).
- `state` cookie for OAuth — CSRF/replay protection, 10 minute window, cleared after use.
- HMAC-SHA256 signed session cookie, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, 14 day expiry.
- `/download` refuses unauthenticated requests (when auth is on) and the jar is blocked on the static path.
- Dotfile/path traversal guard, `.jar` blocked in the static handler, ETag + 304 for assets,
  `no-store` on the API and the jar.
- Admin routes are Basic-auth only and constant-time compared; closed entirely if `ADMIN_PASSWORD` is empty.

## 8. Known gaps

- Keys are stored in plain text in `keys.json` — that file is the crown jewels. Keep it off
  backups you share, and off the web root.
- Client checks are authentication, not DRM: the jar contains the endpoint and the rules, and a
  patcher can strip them. This stops key sharing between users, not a determined reverser.
- No token refresh for the Discord session; Discord is only consulted at login.
- In-memory rate limit resets on deploy; fine for one instance, move to Redis if you scale.
- No Range support on `/download`; 14 MB rarely needs resuming.
