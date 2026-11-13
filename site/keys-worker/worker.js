/* =========================================================================
   asus.wtf — key API, Cloudflare Worker + D1

   Port of site/server/license.mjs + handleLicenseAuth so the client can reach
   a stable public origin instead of a localhost address. The JSON contract is
   identical to the Node server:

     POST /api/license/auth  { key, hwid }
       200 { ok:true,  reason:"ok", key, plan, expiresAt, remainingUses }
       403 { ok:false, reason:"malformed"|"unknown"|"revoked"|"expired"|"in-use"|"no-hwid" }

   Admin (HTTP Basic, env.ADMIN_USER / env.ADMIN_PASSWORD, closed when unset):
     GET  /api/admin/keys            list + stats
     POST /api/admin/keys            { count, uses, days, note, expiresAtMs }
     POST /api/admin/import          { keys:[ ...entries from keys.json ] }
     POST /api/admin/revoke|unbind|delete   { key }
     GET  /api/admin/announcements   every message, oldest first
     POST /api/admin/announcements   { text, level, hours }
     POST /api/admin/announcements/delete  { id }
     POST /api/admin/announcements/update  { id, text, level, hours }
     POST /api/admin/announcements/clear
     GET  /api/admin/release         latest client version published by the console
     POST /api/admin/release         { version, message, url } (empty version clears it)
     GET  /api/admin/presence        live clients (heartbeat within the last 150s) + 24h count

   Public:
     GET  /api/announcements         active messages + published client release
     POST /api/presence              { key, hwid, name, version, server } heartbeat from a running jar
   ========================================================================= */

const PREFIX = "ASUS";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const GROUPS = 4;
const GROUP_LEN = 5;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS keys (
     key          TEXT PRIMARY KEY,
     note         TEXT NOT NULL DEFAULT '',
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER,
     max_uses     INTEGER NOT NULL DEFAULT 1,
     hwids        TEXT NOT NULL DEFAULT '[]',
     revoked      INTEGER NOT NULL DEFAULT 0,
     last_seen_at INTEGER,
     last_hwid    TEXT,
     created_by   TEXT NOT NULL DEFAULT ''
   )`,
  "CREATE INDEX IF NOT EXISTS keys_created ON keys(created_at DESC)",
];

/* ------------------------------ community hub ----------------------------- */

// Public, account-free config sharing: the client's Configs > Community tab reads and writes here.
// A config belongs to the install that uploaded it (its "uploader" id), which is the only thing
// that may later rename, re-tag or delete it.
const HUB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hub_configs (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     author      TEXT NOT NULL DEFAULT '',
     game_mode   TEXT NOT NULL DEFAULT 'Other',
     description TEXT NOT NULL DEFAULT '',
     tags        TEXT NOT NULL DEFAULT '[]',
     blob        TEXT NOT NULL,
     uploader    TEXT NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     downloads   INTEGER NOT NULL DEFAULT 0
   )`,
  "CREATE INDEX IF NOT EXISTS hub_configs_new ON hub_configs(created_at DESC)",
  `CREATE TABLE IF NOT EXISTS hub_ratings (
     config_id  TEXT NOT NULL,
     rater      TEXT NOT NULL,
     stars      INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (config_id, rater)
   )`,
];

// Announcements: the console's message channel to every running client. A row is public while it has
// no expiry or its expiry is still in the future; clients poll GET /api/announcements.
const ANNOUNCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS announcements (
     id         TEXT PRIMARY KEY,
     text       TEXT NOT NULL,
     level      TEXT NOT NULL DEFAULT 'info',
     created_at INTEGER NOT NULL,
     expires_at INTEGER
   )`,
  "CREATE INDEX IF NOT EXISTS announcements_created ON announcements(created_at DESC)",
];

// The newest client release the console has published. A running jar older than this version is told
// in chat and with a toast to update; clearing the row stops the reminders everywhere.
const RELEASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_release (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     version    TEXT NOT NULL,
     message    TEXT NOT NULL DEFAULT '',
     url        TEXT NOT NULL DEFAULT '',
     sha256     TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL
   )`,
];

// Administrator-managed testing exemptions. A username or account id can only annotate a key that
// already validated; it is never a bearer credential. Only server-observed IPs and bound hardware
// ids can open the client without a key, which keeps a pvper from claiming someone else's name.
const ALLOW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS allowed_testers (
     id         TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     value      TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     expires_at INTEGER,
     revoked    INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL DEFAULT ''
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS allowed_testers_value ON allowed_testers(kind, value)",
  "CREATE INDEX IF NOT EXISTS allowed_testers_created ON allowed_testers(created_at DESC)",
];

const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_audit (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL DEFAULT '',
     action  TEXT NOT NULL,
     target  TEXT NOT NULL DEFAULT '',
     detail  TEXT NOT NULL DEFAULT '',
     ip      TEXT NOT NULL DEFAULT ''
   )`,
  "CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at DESC)",
];

// Presence: one row per installation, refreshed every minute by a running client. The key must be
// valid and the hwid bound to it, so the admin list cannot be filled with invented names.
const PRESENCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS presence (
     hwid          TEXT PRIMARY KEY,
     key           TEXT NOT NULL,
     name          TEXT NOT NULL DEFAULT '',
     version       TEXT NOT NULL DEFAULT '',
     server        TEXT NOT NULL DEFAULT '',
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS presence_seen ON presence(last_seen_at DESC)",
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(
    SCHEMA.concat(HUB_SCHEMA, ANNOUNCE_SCHEMA, RELEASE_SCHEMA, PRESENCE_SCHEMA,
      ALLOW_SCHEMA, AUDIT_SCHEMA).map((sql) => env.DB.prepare(sql))
  );
  // Existing deployments already have these tables; add the newer columns once. A duplicate
  // column error just means this isolate is not the first to run the migration.
  try {
    await env.DB.prepare("ALTER TABLE presence ADD COLUMN server TEXT NOT NULL DEFAULT ''").run();
  } catch (ignored) {}
  try {
    await env.DB.prepare("ALTER TABLE client_release ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''").run();
  } catch (ignored) {}
  schemaReady = true;
}

/* -------------------------------- helpers -------------------------------- */

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extra || {}),
    },
  });
}

function normalizeKey(input) {
  if (typeof input !== "string") return "";
  let cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.startsWith(PREFIX)) cleaned = cleaned.slice(PREFIX.length);
  if (cleaned.length !== GROUPS * GROUP_LEN) return "";
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) groups.push(cleaned.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  const key = `${PREFIX}-${groups.join("-")}`;
  return /^ASUS-[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/.test(key) ? key : "";
}

function newKey() {
  let out = "";
  for (let i = 0; i < GROUPS * GROUP_LEN; i += 1) {
    out += ALPHABET[crypto.getRandomValues(new Uint8Array(1))[0] % ALPHABET.length];
  }
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) groups.push(out.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  return `${PREFIX}-${groups.join("-")}`;
}

function parseHwids(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function toEntry(row) {
  return {
    key: row.key,
    note: row.note || "",
    createdAt: row.created_at,
    expiresAt: row.expires_at == null ? null : row.expires_at,
    maxUses: row.max_uses || 1,
    hwids: parseHwids(row.hwids),
    revoked: Boolean(row.revoked),
    lastSeenAt: row.last_seen_at == null ? null : row.last_seen_at,
    lastHwid: row.last_hwid == null ? null : row.last_hwid,
    createdBy: row.created_by || "",
  };
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* --------------------------------- limits -------------------------------- */

const WINDOW_MS = 60_000;
const LIMIT = 60;
const hits = new Map(); // per isolate; good enough to blunt a key-guessing loop

function limited(ip) {
  const now = Date.now();
  const bucket = hits.get(ip);
  if (!bucket || bucket.reset < now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  if (hits.size > 5000) hits.clear();
  return bucket.count > LIMIT;
}

/* -------------------------------- license -------------------------------- */

async function authorize(env, rawKey, hwid) {
  const key = normalizeKey(rawKey);
  if (!key) return { status: 403, body: { ok: false, reason: "malformed" } };

  const row = await env.DB.prepare("SELECT * FROM keys WHERE key = ?").bind(key).first();
  if (!row) return { status: 403, body: { ok: false, reason: "unknown" } };

  const now = Date.now();
  const expiresAt = Number(row.expires_at) > 0 ? Number(row.expires_at) : 0;
  if (row.revoked) return { status: 403, body: { ok: false, reason: "revoked" } };
  if (expiresAt && expiresAt <= now) return { status: 403, body: { ok: false, reason: "expired" } };
  if (!hwid || typeof hwid !== "string") return { status: 403, body: { ok: false, reason: "no-hwid" } };

  const maxUses = row.max_uses || 1;
  const hwids = parseHwids(row.hwids);

  const ok = (list) => ({
    status: 200,
    body: {
      ok: true,
      reason: "ok",
      key,
      plan: row.note || "standard",
      expiresAt: expiresAt || null,
      remainingUses: Math.max(0, maxUses - list.length),
    },
  });

  if (hwids.includes(hwid)) {
    await env.DB.prepare("UPDATE keys SET last_seen_at = ?, last_hwid = ? WHERE key = ?")
      .bind(now, hwid, key)
      .run();
    return ok(hwids);
  }

  if (hwids.length >= maxUses) {
    return {
      status: 403,
      body: { ok: false, reason: "in-use", key, remainingUses: 0, expiresAt: expiresAt || null },
    };
  }

  // Compare-and-set on the serialised list so two clients racing for the last
  // slot cannot both win: the loser retries and then sees it is full.
  const before = row.hwids;
  const next = hwids.concat(hwid);
  const written = await env.DB.prepare(
    "UPDATE keys SET hwids = ?, last_seen_at = ?, last_hwid = ? WHERE key = ? AND hwids = ? AND revoked = 0"
  )
    .bind(JSON.stringify(next), now, hwid, key, before)
    .run();

  if (!written.meta || written.meta.changes !== 1) {
    const again = await env.DB.prepare("SELECT hwids, max_uses FROM keys WHERE key = ?").bind(key).first();
    const nowHwids = parseHwids(again && again.hwids);
    if (nowHwids.includes(hwid)) return ok(nowHwids);
    if (nowHwids.length >= ((again && again.max_uses) || 1)) {
      return { status: 403, body: { ok: false, reason: "in-use", key, remainingUses: 0 } };
    }
    return { status: 409, body: { ok: false, reason: "retry" } };
  }

  return ok(next);
}

async function handleLicenseAuth(request, env) {
  if (request.method !== "POST") return json(405, { ok: false, reason: "method" });
  const body = await readJson(request);
  if (!body) return json(400, { ok: false, reason: "bad-json" });

  const key = normalizeKey(body.key);
  const hwid = typeof body.hwid === "string" ? body.hwid.trim().toLowerCase() : "";
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const now = Date.now();

  // A revoked key can never be rescued by an allowlist entry. Checked before any exemption so the
  // administrator's revocation always wins over a stale tester row.
  if (key) {
    const row = await env.DB.prepare("SELECT revoked FROM keys WHERE key = ?").bind(key).first();
    if (row && row.revoked) return json(403, { ok: false, reason: "revoked" });
  }

  const result = await authorize(env, body.key, body.hwid);
  if (!result.body.ok) {
    // Keyless internal testers: exact server-observed IP or the already-bound hardware id only.
    // Usernames and account ids deliberately do not grant access on their own because the client
    // cannot prove either value; they only annotate a real key below.
    const exemption = await testerExemption(env, ip, hwid, now);
    if (exemption) {
      return json(200, {
        ok: true,
        reason: "ok",
        key: key || "",
        plan: "tester",
        tester: true,
        exemption: exemption.kind,
        expiresAt: exemption.expiresAt || null,
        remainingUses: 1,
      });
    }
    return json(result.status, result.body);
  }

  const annotated = await keyedTesterExemption(env, {
    ip,
    hwid,
    name: typeof body.name === "string" ? body.name.trim().toLowerCase() : "",
    accountId: typeof body.accountId === "string" ? body.accountId.trim().toLowerCase() : "",
  }, now);
  if (annotated) {
    result.body.tester = true;
    result.body.exemption = annotated.kind;
    result.body.testingExpiresAt = annotated.expiresAt || null;
  }
  return json(result.status, result.body);
}

/* ------------------------------ announcements ---------------------------- */

const ANNOUNCE_LEVELS = new Set(["info", "update", "warning"]);
const ANNOUNCE_MAX = 300;

function announceLevel(value) {
  return ANNOUNCE_LEVELS.has(value) ? value : "info";
}

/** A version the client can compare. "1.0.11", "1.0.11-26.2" and "1.0.11+build" are all accepted. */
function releaseVersion(value) {
  const text = hubText(value, 24);
  return /^[0-9][0-9A-Za-z._+-]*$/.test(text) ? text : "";
}

function announceMessage(row) {
  return {
    id: row.id,
    text: row.text,
    level: row.level || "info",
    createdAt: row.created_at,
    expiresAt: row.expires_at == null ? null : row.expires_at,
  };
}

function releaseEntry(row) {
  if (!row) return null;
  return {
    version: row.version || "",
    message: row.message || "",
    url: row.url || "",
    sha256: row.sha256 || "",
    updatedAt: row.updated_at == null ? null : row.updated_at,
  };
}

async function currentRelease(env) {
  const row = await env.DB.prepare(
    "SELECT version, message, url, sha256, updated_at FROM client_release WHERE id = 1"
  ).first();
  return releaseEntry(row);
}

/** Public feed: what every client polls. No admin credentials, nothing private in the answer. */
async function handleAnnouncements(env) {
  const rows = await env.DB.prepare(
    "SELECT id, text, level, created_at, expires_at FROM announcements" +
      " WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(Date.now())
    .all();
  return json(
    200,
    {
      ok: true,
      messages: (rows.results || []).map(announceMessage),
      release: await currentRelease(env),
    },
    { "Access-Control-Allow-Origin": "*" }
  );
}

/* -------------------------------- presence ------------------------------- */

const PRESENCE_ONLINE_MS = 150_000; // two missed minute beats before a client drops off
const PRESENCE_KEEP_MS = 30 * 86_400_000;

function presenceEntry(row) {
  return {
    hwid: String(row.hwid || "").slice(0, 8),
    key: row.key,
    name: row.name || "",
    version: row.version || "",
    server: row.server || "",
    plan: row.plan || "",
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/* ----------------------------- tester allowlist --------------------------- */

const ALLOW_KINDS = new Set(["username", "account_id", "ip", "hwid"]);

/** Canonical storage value. Returns "" when the value cannot be an exact match. */
function allowValue(kind, raw) {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text || text.length > 128) return "";
  if (kind === "username") return /^[a-z0-9_]{3,16}$/.test(text) ? text : "";
  if (kind === "account_id") return /^[0-9a-f-]{8,64}$/.test(text) ? text : "";
  if (kind === "hwid") return /^[0-9a-f]{8,64}$/.test(text) ? text : "";
  if (kind === "ip") {
    const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    const ipv6 = /^[0-9a-f:]{2,45}$/;
    return ipv4.test(text) || (ipv6.test(text) && text.includes(":")) ? text : "";
  }
  return "";
}

function allowEntry(row) {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    note: row.note || "",
    expiresAt: row.expires_at == null ? null : row.expires_at,
    revoked: Boolean(row.revoked),
    createdAt: row.created_at,
    createdBy: row.created_by || "",
  };
}

async function testerExemption(env, ip, hwid, now) {
  if (!ip && !hwid) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM allowed_testers
     WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
       AND ((kind = 'ip' AND value = ?) OR (kind = 'hwid' AND value = ?))
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(now, ip || "\u0000", hwid || "\u0000")
    .first();
  return row ? allowEntry(row) : null;
}

/** Username/account entries only annotate a key that already passed authorize(). */
async function keyedTesterExemption(env, who, now) {
  const row = await env.DB.prepare(
    `SELECT * FROM allowed_testers
     WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
       AND ((kind = 'ip' AND value = ?) OR (kind = 'hwid' AND value = ?)
         OR (kind = 'username' AND value = ?) OR (kind = 'account_id' AND value = ?))
     ORDER BY CASE kind WHEN 'hwid' THEN 0 WHEN 'ip' THEN 1 WHEN 'account_id' THEN 2 ELSE 3 END
     LIMIT 1`
  )
    .bind(now, who.ip || "\u0000", who.hwid || "\u0000", who.name || "\u0000", who.accountId || "\u0000")
    .first();
  return row ? allowEntry(row) : null;
}

/** Heartbeat from a running jar. Nothing here is trusted beyond the key binding check. */
async function handlePresence(request, env) {
  if (request.method !== "POST") return json(405, { ok: false, reason: "method" });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (limited("presence:" + ip)) return json(429, { ok: false, reason: "slow-down" });

  const body = await readJson(request);
  if (!body) return json(400, { ok: false, reason: "bad-json" });

  const key = normalizeKey(body.key);
  const hwid = typeof body.hwid === "string" ? body.hwid.trim().toLowerCase() : "";
  if (!key || !/^[0-9a-f]{8,64}$/.test(hwid)) return json(403, { ok: false, reason: "bad-request" });

  const row = await env.DB.prepare("SELECT revoked, expires_at, hwids FROM keys WHERE key = ?")
    .bind(key)
    .first();
  if (!row) return json(403, { ok: false, reason: "unknown" });

  const now = Date.now();
  if (row.revoked) return json(403, { ok: false, reason: "revoked" });
  if (Number(row.expires_at) > 0 && Number(row.expires_at) <= now) return json(403, { ok: false, reason: "expired" });
  if (!parseHwids(row.hwids).includes(hwid)) return json(403, { ok: false, reason: "not-bound" });

  const name = hubText(body.name, 24);
  const version = hubText(body.version, 24);
  const server = hubText(body.server, 80);

  await env.DB.prepare(
    `INSERT INTO presence (hwid, key, name, version, server, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hwid) DO UPDATE SET
       key = excluded.key, name = excluded.name, version = excluded.version,
       server = excluded.server, last_seen_at = excluded.last_seen_at`
  )
    .bind(hwid, key, name, version, server, now, now)
    .run();

  // Opportunistic cleanup: rows for installs that have not run in a month.
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM presence WHERE last_seen_at < ?").bind(now - PRESENCE_KEEP_MS).run();
  }

  return json(200, { ok: true });
}

/* ---------------------------------- admin -------------------------------- */

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function allowedOrigins(env) {
  return String(env.ADMIN_ORIGINS || "https://asusclient.github.io,http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function requireAdmin(request, env) {
  const password = env.ADMIN_PASSWORD || "";
  if (!password) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  return sameSecret(user, env.ADMIN_USER || "admin") && sameSecret(pass, password);
}

async function createKeys(env, body) {
  const count = Math.min(Math.max(Number(body.count) || 1, 1), 200);
  const uses = Math.max(1, Number(body.uses) || 1);
  const days = Number(body.days) || 0;
  const explicit = Number(body.expiresAtMs) || 0;
  const note = typeof body.note === "string" ? body.note.slice(0, 40) : "";
  const now = Date.now();
  const expiresAt = explicit > 0 ? explicit : days > 0 ? now + days * 86_400_000 : null;

  const created = [];
  for (let i = 0; i < count; i += 1) {
    const key = newKey();
    await env.DB.prepare(
      `INSERT INTO keys (key, note, created_at, expires_at, max_uses, hwids, revoked, created_by)
       VALUES (?, ?, ?, ?, ?, '[]', 0, 'admin')`
    )
      .bind(key, note, now, expiresAt, uses)
      .run();
    created.push(key);
  }
  return created;
}

function entryToRow(entry) {
  const hwids = Array.isArray(entry.hwids) ? entry.hwids.filter((h) => typeof h === "string") : [];
  return {
    key: normalizeKey(entry.key),
    note: typeof entry.note === "string" ? entry.note.slice(0, 40) : "",
    created_at: Number(entry.createdAt) || Date.now(),
    expires_at: Number(entry.expiresAt) || null,
    max_uses: Math.max(1, Number(entry.maxUses) || 1),
    hwids: JSON.stringify(hwids),
    revoked: entry.revoked ? 1 : 0,
    last_seen_at: Number(entry.lastSeenAt) || null,
    last_hwid: typeof entry.lastHwid === "string" ? entry.lastHwid : null,
    created_by: typeof entry.createdBy === "string" ? entry.createdBy.slice(0, 20) : "",
  };
}

async function audit(env, request, action, target, detail) {
  try {
    const actor = String(env.ADMIN_USER || "admin").slice(0, 40);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    await env.DB.prepare(
      "INSERT INTO admin_audit (at, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(Date.now(), actor, String(action).slice(0, 48), String(target || "").slice(0, 160),
        String(detail || "").slice(0, 300), ip)
      .run();
  } catch (ignored) {
    // An audit write must never make the administrator's action appear to fail.
  }
}

async function handleAdmin(request, env, url) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (!requireAdmin(request, env)) return json(401, { error: "unauthorized" }, cors);

  const method = request.method;
  const origin = request.headers.get("Origin") || "";
  if (origin && !allowedOrigins(env).includes(origin)) {
    return json(403, { error: "origin" }, cors);
  }
  // JSON-only writes stop a cross-site HTML form from driving a state change with a
  // browser's cached Basic credentials (the browser cannot send this content type cross-origin
  // without a successful preflight).
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
      && !/^application\/json(;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return json(415, { error: "json-required" }, cors);
  }

  if (url.pathname === "/api/admin/presence") {
    if (method !== "GET") return json(405, { error: "method" }, cors);
    const now = Date.now();
    const onlineRows = await env.DB.prepare(
      `SELECT p.hwid, p.key, p.name, p.version, p.server, p.first_seen_at, p.last_seen_at, k.note AS plan
       FROM presence p LEFT JOIN keys k ON k.key = p.key
       WHERE p.last_seen_at > ? ORDER BY p.last_seen_at DESC LIMIT 200`
    )
      .bind(now - PRESENCE_ONLINE_MS)
      .all();
    const recentRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM presence WHERE last_seen_at > ?"
    )
      .bind(now - 86_400_000)
      .first();
    const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM presence").first();
    return json(
      200,
      {
        now,
        online: (onlineRows.results || []).map(presenceEntry),
        recent: Number(recentRow && recentRow.n) || 0,
        total: Number(totalRow && totalRow.n) || 0,
      },
      cors
    );
  }

  if (url.pathname === "/api/admin/whoami") {
    if (method !== "GET") return json(405, { error: "method" }, cors);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    return json(200, { ip, family: ip.includes(":") ? "ipv6" : "ipv4" }, cors);
  }

  if (url.pathname === "/api/admin/allowlist") {
    if (method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM allowed_testers ORDER BY created_at DESC").all();
      const all = (rows.results || []).map(allowEntry);
      const now = Date.now();
      return json(200, {
        testerAllowlist: all,
        stats: {
          total: all.length,
          active: all.filter((e) => !e.revoked && (!e.expiresAt || e.expiresAt > now)).length,
          revoked: all.filter((e) => e.revoked).length,
        },
      }, cors);
    }
    if (method !== "POST") return json(405, { error: "method" }, cors);
    const body = await readJson(request);
    if (!body) return json(400, { error: "bad-json" }, cors);
    const kind = ALLOW_KINDS.has(body.kind) ? body.kind : "";
    const value = allowValue(kind, body.value);
    if (!kind || !value) return json(400, { error: "bad-value" }, cors);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) : "";
    const expiresAt = Number(body.expiresAtMs) > Date.now() ? Number(body.expiresAtMs) : null;
    if (body.expiresAtMs && !expiresAt) return json(400, { error: "bad-expiry" }, cors);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO allowed_testers (id, kind, value, note, expires_at, revoked, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET
         note = excluded.note, expires_at = excluded.expires_at, revoked = 0,
         created_at = excluded.created_at, created_by = excluded.created_by`
    )
      .bind(id, kind, value, note, expiresAt, now, String(env.ADMIN_USER || "admin").slice(0, 40))
      .run();
    await audit(env, request, "allowlist.add", `${kind}:${value}`, note);
    return json(200, { ok: true, exemption: { id, kind, value, note, expiresAt, revoked: false, createdAt: now } }, cors);
  }

  if (url.pathname === "/api/admin/allowlist/revoke" || url.pathname === "/api/admin/allowlist/delete") {
    if (method !== "POST") return json(405, { error: "method" }, cors);
    const body = await readJson(request);
    const id = body && typeof body.id === "string" ? body.id.slice(0, 64) : "";
    if (!id) return json(400, { error: "no-id" }, cors);
    const deleting = url.pathname.endsWith("/delete");
    const row = await env.DB.prepare("SELECT kind, value FROM allowed_testers WHERE id = ?").bind(id).first();
    if (!row) return json(404, { error: "not-found" }, cors);
    await (deleting
      ? env.DB.prepare("DELETE FROM allowed_testers WHERE id = ?").bind(id).run()
      : env.DB.prepare("UPDATE allowed_testers SET revoked = 1 WHERE id = ?").bind(id).run());
    await audit(env, request, deleting ? "allowlist.delete" : "allowlist.revoke", `${row.kind}:${row.value}`, id);
    return json(200, { ok: true, id, deleted: deleting }, cors);
  }

  if (url.pathname === "/api/admin/audit") {
    if (method !== "GET") return json(405, { error: "method" }, cors);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
    const rows = await env.DB.prepare("SELECT * FROM admin_audit ORDER BY at DESC LIMIT ?").bind(limit).all();
    return json(200, {
      audit: (rows.results || []).map((row) => ({
        id: row.id, at: row.at, actor: row.actor, action: row.action,
        target: row.target, detail: row.detail, ip: row.ip,
      })),
    }, cors);
  }

  if (url.pathname === "/api/admin/keys") {
    if (method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM keys ORDER BY created_at DESC").all();
      const all = (rows.results || []).map(toEntry);
      const now = Date.now();
      return json(
        200,
        {
          stats: {
            total: all.length,
            active: all.filter((e) => !e.revoked && (!e.expiresAt || e.expiresAt > now)).length,
            bound: all.filter((e) => e.hwids.length > 0).length,
            revoked: all.filter((e) => e.revoked).length,
          },
          keys: all,
        },
        cors
      );
    }
    if (method !== "POST") return json(405, { error: "method" }, cors);
    const body = await readJson(request);
    if (!body) return json(400, { error: "bad-json" }, cors);
    const created = await createKeys(env, body);
    await audit(env, request, "key.create", `${created.length} key(s)`, body.note || "");
    return json(200, { keys: created }, cors);
  }

  if (url.pathname === "/api/admin/import") {
    if (method !== "POST") return json(405, { error: "method" }, cors);
    const body = await readJson(request);
    const list = body && Array.isArray(body.keys) ? body.keys : null;
    if (!list) return json(400, { error: "bad-json" }, cors);
    let imported = 0;
    for (const entry of list) {
      const row = entryToRow(entry || {});
      if (!row.key) continue;
      await env.DB.prepare(
        `INSERT INTO keys (key, note, created_at, expires_at, max_uses, hwids, revoked, last_seen_at, last_hwid, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           note = excluded.note, created_at = excluded.created_at, expires_at = excluded.expires_at,
           max_uses = excluded.max_uses, hwids = excluded.hwids, revoked = excluded.revoked,
           last_seen_at = excluded.last_seen_at, last_hwid = excluded.last_hwid, created_by = excluded.created_by`
      )
        .bind(row.key, row.note, row.created_at, row.expires_at, row.max_uses, row.hwids, row.revoked, row.last_seen_at, row.last_hwid, row.created_by)
        .run();
      imported += 1;
    }
    return json(200, { ok: true, imported }, cors);
  }

  if (url.pathname === "/api/admin/revoke-all" || url.pathname === "/api/admin/delete-all") {
    if (method !== "POST") return json(405, { error: "method" }, cors);
    const deleting = url.pathname.endsWith("delete-all");
    const result = deleting
      ? await env.DB.prepare("DELETE FROM keys").run()
      : await env.DB.prepare("UPDATE keys SET revoked = 1 WHERE revoked = 0").run();
    const count = (result.meta && result.meta.changes) || 0;
    await audit(env, request, deleting ? "key.delete-all" : "key.revoke-all", String(count), "");
    return json(200, deleting ? { ok: true, removed: count } : { ok: true, revoked: count }, cors);
  }

  if (url.pathname === "/api/admin/release") {
    if (method === "GET") return json(200, { release: await currentRelease(env) }, cors);
    if (method !== "POST") return json(405, { error: "method" }, cors);

    const body = await readJson(request);
    if (!body) return json(400, { error: "bad-json" }, cors);

    const rawVersion = typeof body.version === "string" ? body.version.trim() : "";
    const version = releaseVersion(rawVersion);
    if (rawVersion && !version) return json(400, { error: "bad-version" }, cors);
    if (!version) {
      await env.DB.prepare("DELETE FROM client_release WHERE id = 1").run();
      return json(200, { ok: true, release: null }, cors);
    }

    const message = hubText(body.message, 160);
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    const link = hubText(rawUrl, 300);
    if (link && !/^https?:\/\//i.test(link)) return json(400, { error: "bad-url" }, cors);
    const hash = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
    if (hash && !/^[0-9a-f]{64}$/.test(hash)) return json(400, { error: "bad-hash" }, cors);

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO client_release (id, version, message, url, sha256, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version, message = excluded.message, url = excluded.url,
         sha256 = excluded.sha256, updated_at = excluded.updated_at`
    )
      .bind(version, message, link, hash, now)
      .run();
    await audit(env, request, "release.publish", version, link);
    return json(200, { ok: true, release: { version, message, url: link, sha256: hash, updatedAt: now } }, cors);
  }

  if (url.pathname.startsWith("/api/admin/announcements")) {
    const sub = url.pathname.slice("/api/admin/announcements".length).replace(/^\/+/, "");

    if (sub === "" && method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 200").all();
      return json(200, { messages: (rows.results || []).map(announceMessage) }, cors);
    }

    if (sub === "" && method === "POST") {
      const body = await readJson(request);
      const text = hubText(body && body.text, ANNOUNCE_MAX);
      if (!text) return json(400, { error: "text required" }, cors);
      const hours = Number(body.hours) || 0;
      const createdAt = Date.now();
      const expiresAt = hours > 0 ? createdAt + Math.round(hours * 3_600_000) : null;
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO announcements (id, text, level, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(id, text, announceLevel(body.level), createdAt, expiresAt)
        .run();
      return json(200, { ok: true, message: { id, text, level: announceLevel(body.level), createdAt, expiresAt } }, cors);
    }

    if (sub === "update" && method === "POST") {
      const body = await readJson(request);
      const id = typeof (body && body.id) === "string" ? body.id : "";
      const text = hubText(body && body.text, ANNOUNCE_MAX);
      if (!id || !text) return json(400, { error: "id and text required" }, cors);

      // Bumping created_at is deliberate: clients ignore anything they have already shown, so an edited
      // message has to look new to them or the change would never reach the people who saw the old text.
      const now = Date.now();
      const hours = Number(body.hours) || 0;
      const expiresAt = hours > 0 ? now + Math.round(hours * 3_600_000) : null;
      const result = await env.DB.prepare(
        "UPDATE announcements SET text = ?, level = ?, created_at = ?, expires_at = ? WHERE id = ?"
      )
        .bind(text, announceLevel(body.level), now, expiresAt, id)
        .run();
      const changed = Boolean(result.meta && result.meta.changes);
      return json(
        changed ? 200 : 404,
        changed ? { ok: true, id, text, level: announceLevel(body.level), createdAt: now, expiresAt } : { ok: false, error: "not-found" },
        cors
      );
    }

    if (sub === "delete" && method === "POST") {
      const body = await readJson(request);
      const id = typeof (body && body.id) === "string" ? body.id : "";
      if (!id) return json(400, { error: "id required" }, cors);
      const result = await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run();
      const changed = Boolean(result.meta && result.meta.changes);
      return json(changed ? 200 : 404, changed ? { ok: true, id } : { ok: false, error: "not-found" }, cors);
    }

    if (sub === "clear" && method === "POST") {
      const result = await env.DB.prepare("DELETE FROM announcements").run();
      return json(200, { ok: true, removed: (result.meta && result.meta.changes) || 0 }, cors);
    }

    return json(404, { error: "unknown route" }, cors);
  }

  const action = url.pathname.replace("/api/admin/", "");
  if (!["revoke", "unbind", "delete"].includes(action)) return json(404, { error: "unknown route" }, cors);
  if (method !== "POST") return json(405, { error: "method" }, cors);
  const body = await readJson(request);
  const key = normalizeKey((body && body.key) || "");
  if (!key) return json(400, { error: "bad-key" }, cors);

  const result =
    action === "delete"
      ? await env.DB.prepare("DELETE FROM keys WHERE key = ?").bind(key).run()
      : action === "unbind"
        ? await env.DB.prepare("UPDATE keys SET hwids = '[]', last_hwid = NULL WHERE key = ?").bind(key).run()
        : await env.DB.prepare("UPDATE keys SET revoked = 1 WHERE key = ?").bind(key).run();

  const changed = Boolean(result.meta && result.meta.changes);
  await audit(env, request, `key.${action}`, key, changed ? "changed" : "not-found");
  return json(changed ? 200 : 404, changed ? { ok: true, key } : { ok: false, error: "not-found" }, cors);
}

/* ------------------------------ community hub ----------------------------- */

const HUB_MAX_BLOB = 900_000; // same ceiling the old /api/config backend used
const HUB_MAX_TAGS = 8;

function hubText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function hubId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-z-]{8,64}$/.test(trimmed) ? trimmed : "";
}

function hubTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    const tag = hubText(raw, 16);
    if (tag && !out.includes(tag) && out.length < HUB_MAX_TAGS) out.push(tag);
  }
  return out;
}

function hubParseTags(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function hubCors(request) {
  // The desktop client sends no cookies and no credentials, so any origin may call this.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

async function hubOwnerOf(env, id) {
  const row = await env.DB.prepare("SELECT uploader FROM hub_configs WHERE id = ?").bind(id).first();
  return row ? row.uploader || "" : null;
}

async function handleHub(request, env) {
  const cors = hubCors(request);
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "POST") return json(405, { ok: false, reason: "method" }, cors);

  const body = await readJson(request);
  if (!body) return json(400, { ok: false, reason: "bad-json" }, cors);

  const action = typeof body.action === "string" ? body.action : "";
  const me = hubId(body.uploader);

  if (action === "listPublic") {
    const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 300);
    const where = [];
    const args = [];
    const tags = hubTags(body.tags);
    if (tags.length) {
      where.push("(" + tags.map(() => "c.tags LIKE ?").join(" OR ") + ")");
      for (const tag of tags) args.push(`%"${tag}"%`);
    }
    const username = hubText(body.username, 24);
    if (username) {
      where.push("lower(c.author) LIKE ?");
      args.push("%" + username.toLowerCase() + "%");
    }
    const order =
      body.sort === "popular"
        ? "c.downloads DESC, c.created_at DESC"
        : body.sort === "top"
          ? "rating_avg DESC, rating_count DESC, c.created_at DESC"
          : "c.created_at DESC";
    const sql = `SELECT c.*,
        (SELECT COUNT(*) FROM hub_ratings r WHERE r.config_id = c.id) AS rating_count,
        (SELECT COALESCE(AVG(r.stars), 0) FROM hub_ratings r WHERE r.config_id = c.id) AS rating_avg,
        (SELECT COALESCE(MAX(r.stars), 0) FROM hub_ratings r WHERE r.config_id = c.id AND r.rater = ?) AS my_rating
      FROM hub_configs c
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT ?`;
    const rows = await env.DB.prepare(sql).bind(me, ...args, limit).all();
    const configs = (rows.results || []).map((row) => ({
      id: row.id,
      name: row.name,
      ownerName: row.author || "anonymous",
      gameMode: row.game_mode || "Other",
      description: row.description || "",
      tags: hubParseTags(row.tags),
      isPublic: true,
      active: false,
      ratingAvg: Math.round((Number(row.rating_avg) || 0) * 10) / 10,
      ratingCount: Number(row.rating_count) || 0,
      weeklyScore: Number(row.downloads) || 0,
      myRating: Number(row.my_rating) || 0,
      owned: Boolean(me) && row.uploader === me,
    }));
    return json(200, { ok: true, configs }, cors);
  }

  if (action === "getPublic") {
    const id = hubId(body.id);
    const row = id ? await env.DB.prepare("SELECT * FROM hub_configs WHERE id = ?").bind(id).first() : null;
    if (!row) return json(404, { ok: false, reason: "not-found" }, cors);
    let data = null;
    try {
      data = JSON.parse(row.blob);
    } catch {
      return json(500, { ok: false, reason: "corrupt" }, cors);
    }
    await env.DB.prepare("UPDATE hub_configs SET downloads = downloads + 1 WHERE id = ?").bind(id).run();
    return json(200, { ok: true, id, name: row.name, data }, cors);
  }

  if (action === "upload") {
    if (!me) return json(403, { ok: false, reason: "no-uploader" }, cors);
    if (limited("hub:" + (request.headers.get("CF-Connecting-IP") || "unknown"))) {
      return json(429, { ok: false, reason: "slow-down" }, cors);
    }
    const name = hubText(body.name, 40);
    if (!name) return json(400, { ok: false, reason: "no-name" }, cors);
    let blob = "";
    try {
      blob = JSON.stringify(body.data);
    } catch {
      blob = "";
    }
    if (!blob || blob === "null" || blob === "undefined") return json(400, { ok: false, reason: "no-data" }, cors);
    if (blob.length > HUB_MAX_BLOB) return json(413, { ok: false, reason: "too-big" }, cors);

    const description = hubText(body.description, 200);
    const gameMode = hubText(body.gameMode, 20) || "Other";
    const tags = JSON.stringify(hubTags(body.tags));
    const now = Date.now();

    const existing = await env.DB.prepare(
      "SELECT id FROM hub_configs WHERE uploader = ? AND lower(name) = lower(?)"
    )
      .bind(me, name)
      .first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE hub_configs SET name = ?, game_mode = ?, description = ?, tags = ?, blob = ?, updated_at = ? WHERE id = ? AND uploader = ?"
      )
        .bind(name, gameMode, description, tags, blob, now, existing.id, me)
        .run();
      return json(200, { ok: true, id: existing.id }, cors);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO hub_configs (id, name, author, game_mode, description, tags, blob, uploader, created_at, updated_at, downloads)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
      .bind(id, name, hubText(body.author, 24) || "anonymous", gameMode, description, tags, blob, me, now, now)
      .run();
    return json(200, { ok: true, id }, cors);
  }

  if (action === "delete") {
    const id = hubId(body.id);
    if (!id) return json(400, { ok: false, reason: "no-id" }, cors);
    const owner = await hubOwnerOf(env, id);
    if (owner === null) return json(200, { ok: true, id }, cors);
    if (!me || owner !== me) return json(403, { ok: false, reason: "not-owner" }, cors);
    await env.DB.prepare("DELETE FROM hub_configs WHERE id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM hub_ratings WHERE config_id = ?").bind(id).run();
    return json(200, { ok: true, id }, cors);
  }

  if (action === "rate") {
    if (!me) return json(403, { ok: false, reason: "no-uploader" }, cors);
    const id = hubId(body.id);
    const stars = Number(body.stars);
    if (!id || !Number.isInteger(stars) || stars < 0 || stars > 5) {
      return json(400, { ok: false, reason: "bad-request" }, cors);
    }
    const owner = await hubOwnerOf(env, id);
    if (owner === null) return json(404, { ok: false, reason: "not-found" }, cors);
    if (owner === me) return json(403, { ok: false, reason: "OWN_CONFIG" }, cors);
    if (stars === 0) {
      await env.DB.prepare("DELETE FROM hub_ratings WHERE config_id = ? AND rater = ?").bind(id, me).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO hub_ratings (config_id, rater, stars, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(config_id, rater) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`
      )
        .bind(id, me, stars, Date.now())
        .run();
    }
    const agg = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(AVG(stars), 0) AS avg FROM hub_ratings WHERE config_id = ?"
    )
      .bind(id)
      .first();
    return json(
      200,
      {
        ok: true,
        ratingAvg: Math.round((Number(agg && agg.avg) || 0) * 10) / 10,
        ratingCount: Number(agg && agg.n) || 0,
        myRating: stars,
      },
      cors
    );
  }

  if (action === "rename" || action === "setTags") {
    const id = hubId(body.id);
    if (!id) return json(400, { ok: false, reason: "no-id" }, cors);
    const owner = await hubOwnerOf(env, id);
    if (owner === null) return json(404, { ok: false, reason: "not-found" }, cors);
    if (!me || owner !== me) return json(403, { ok: false, reason: "not-owner" }, cors);
    if (action === "rename") {
      const name = hubText(body.name, 40);
      if (!name) return json(400, { ok: false, reason: "no-name" }, cors);
      await env.DB.prepare("UPDATE hub_configs SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name, Date.now(), id)
        .run();
    } else {
      await env.DB.prepare("UPDATE hub_configs SET tags = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(hubTags(body.tags)), Date.now(), id)
        .run();
    }
    return json(200, { ok: true, id }, cors);
  }

  return json(404, { ok: false, reason: "unknown-action" }, cors);
}

/* ---------------------------------- entry -------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      await ensureSchema(env);

      if (url.pathname === "/api/license/auth" && limited(ip) && request.method === "POST") {
        return new Response("slow down", { status: 429 });
      }
      if (url.pathname === "/api/license/auth") return await handleLicenseAuth(request, env);
      if (url.pathname === "/api/license/ping") return json(200, { ok: true, service: "asus.wtf keys" });
      if (url.pathname === "/api/config") return await handleHub(request, env);
      if (url.pathname === "/api/announcements") return await handleAnnouncements(env);
      if (url.pathname === "/api/presence") return await handlePresence(request, env);
      if (url.pathname.startsWith("/api/admin")) return await handleAdmin(request, env, url);

      return new Response("asus.wtf key API\n", {
        status: url.pathname === "/" ? 200 : 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      return json(500, { ok: false, reason: "server", detail: String((error && error.message) || error) });
    }
  },
};
