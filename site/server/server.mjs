#!/usr/bin/env node
/* =========================================================================
   asus.wtf — site server
   Static site + Discord OAuth2 + gated download. Zero dependencies.
   node 18+ (uses global fetch). No build step, no node_modules.
   ========================================================================= */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as keys from "./license.mjs";
import * as auth from "./auth.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SITE = resolve(HERE, "..");

const cfg = await loadConfig();

/* ------------------------------- config -------------------------------- */

async function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(await readFile(join(HERE, "config.json"), "utf8"));
  } catch {
    /* no config.json — env only */
  }

  const pick = (key, def = "") => process.env[key] ?? file[key] ?? def;
  const port = Number(pick("PORT", 3000));

  return {
    port,
    baseUrl: String(pick("BASE_URL", `http://localhost:${port}`)).replace(/\/+$/, ""),
    clientId: String(pick("DISCORD_CLIENT_ID")),
    clientSecret: String(pick("DISCORD_CLIENT_SECRET")),
    sessionSecret: String(pick("SESSION_SECRET", "")),
    guildId: String(pick("GUILD_ID")),
    roleIds: String(pick("REQUIRED_ROLE_IDS"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    botToken: String(pick("DISCORD_BOT_TOKEN")),
    inviteUrl: String(pick("INVITE_URL")),
    jarPath: resolve(String(pick("JAR_PATH", join(SITE, "assets", "asus-wtf-1.0.10.jar")))),
    jarName: String(pick("JAR_NAME", "asus-wtf-1.0.10.jar")),
    sessionDays: Number(pick("SESSION_DAYS", 14)),
    keyStore: resolve(String(pick("KEY_STORE", join(HERE, "keys.json")))),
    adminUser: String(pick("ADMIN_USER", "admin")),
    adminPassword: String(pick("ADMIN_PASSWORD")),
    freeJar: resolve(String(pick("FREE_JAR_PATH", join(SITE, "assets", "asus-free-1.0.0.jar")))),
    freeJarName: String(pick("FREE_JAR_NAME", "asus-free-1.0.0.jar")),
    premiumJar: resolve(String(pick("PREMIUM_JAR_PATH", join(SITE, "assets", "asus-wtf-2.0.jar")))),
    premiumJarName: String(pick("PREMIUM_JAR_NAME", "asus-wtf-2.0.jar")),
  };
}

if (!cfg.sessionSecret) {
  cfg.sessionSecret = randomBytes(32).toString("hex");
  console.log("[auth] SESSION_SECRET not set - generated an ephemeral one (sessions die on restart)");
}

const authEnabled = Boolean(cfg.clientId && cfg.clientSecret);
const secureCookies = cfg.baseUrl.startsWith("https://");
const redirectUri = `${cfg.baseUrl}/auth/discord/callback`;

if (!authEnabled) {
  console.log("[auth] discord credentials missing - running in open mode (/download is public)");
}

if (!cfg.adminPassword) {
  console.log("[keys] ADMIN_PASSWORD not set - /admin and /api/admin/* are closed");
}

/* ------------------------------- helpers ------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const b64u = (value) => Buffer.from(value).toString("base64url");

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac("sha256", cfg.sessionSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;

  const expected = createHmac("sha256", cfg.sessionSecret).update(body).digest();
  let given;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure ?? secureCookies) bits.push("Secure");
  return bits.join("; ");
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" });

function redirect(res, location, extraCookies = []) {
  return send(res, 302, "", {
    Location: location,
    ...(extraCookies.length ? { "Set-Cookie": extraCookies } : {}),
  });
}

function page(title, message, action) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — asus.wtf</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#06040d;color:#f5f2ff;
       font:16px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:32px}
  .box{max-width:460px;text-align:center;border:1px solid rgba(255,255,255,.1);border-radius:22px;
       padding:40px 32px;background:rgba(255,255,255,.03)}
  h1{margin:0 0 12px;font-size:1.5rem;letter-spacing:-.03em}
  p{margin:0 0 24px;color:#c3bcdd;font-size:.95rem}
  a{display:inline-block;padding:12px 22px;border-radius:12px;color:#0a0614;font-weight:600;
    text-decoration:none;background:linear-gradient(135deg,#b49bff,#7c5cff)}
</style></head><body><div class="box">
<h1>${title}</h1><p>${message}</p><a href="${action.href}">${action.label}</a>
</div></body></html>`;
}

/* ------------------------------ json + admin --------------------------- */

async function readJson(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function isAdmin(req) {
  if (!cfg.adminPassword) return false;

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const i = decoded.indexOf(":");
  if (i < 0) return false;

  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  const a = Buffer.from(`${user}:${pass}`);
  const b = Buffer.from(`${cfg.adminUser}:${cfg.adminPassword}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, "authentication required", {
    "WWW-Authenticate": 'Basic realm="asus.wtf keys", charset="UTF-8"',
  });
  return false;
}

/* ------------------------------ rate limit ----------------------------- */
const buckets = new Map();

function limited(ip, max = 40, windowMs = 60_000) {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.reset < now) {
    buckets.set(ip, { count: 1, reset: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (b.reset < now) buckets.delete(ip);
}, 120_000).unref?.();

/* ------------------------------- discord ------------------------------- */

function authorizeUrl(state, next) {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchUser(accessToken) {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`user fetch ${res.status}`);
  return res.json();
}

async function checkMembership(userId) {
  if (!cfg.guildId) return { ok: true };
  if (!cfg.botToken) return { ok: true, note: "guild gate set without a bot token" };

  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/members/${userId}`,
    { headers: { Authorization: `Bot ${cfg.botToken}` } }
  );
  if (res.status === 404) return { ok: false, reason: "not-in-guild" };
  if (!res.ok) return { ok: false, reason: "lookup-failed" };

  const member = await res.json();
  if (!cfg.roleIds.length) return { ok: true };

  const roles = Array.isArray(member.roles) ? member.roles : [];
  return roles.some((id) => cfg.roleIds.includes(id))
    ? { ok: true }
    : { ok: false, reason: "missing-role" };
}

/* ------------------------------- sessions ------------------------------ */

const SESSION_COOKIE = "asus_session";
const STATE_COOKIE = "asus_state";

function currentUser(req) {
  const session = unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return null;
  return {
    id: session.sub,
    username: session.name,
    globalName: session.global || "",
    avatar: session.avatar || "",
  };
}

function sessionCookie(user) {
  const token = sign({
    sub: user.id,
    name: user.username || user.name,
    global: user.global_name || "",
    avatar: user.avatar || "",
    type: user.type || "discord",
    exp: Date.now() + cfg.sessionDays * 86_400_000,
  });
  return cookie(SESSION_COOKIE, token, { maxAge: cfg.sessionDays * 86_400 });
}

const ACCOUNT_TOKEN_COOKIE = "asus_account";
function accountCookie(user) {
  const token = auth.signToken({ sub: user.id, type: "account", exp: Date.now() + cfg.sessionDays * 86_400_000 }, cfg.sessionSecret);
  return cookie(ACCOUNT_TOKEN_COOKIE, token, { maxAge: cfg.sessionDays * 86_400 });
}
function currentAccount(req) {
  const tok = parseCookies(req.headers.cookie)[ACCOUNT_TOKEN_COOKIE];
  const data = auth.verifyToken(tok, cfg.sessionSecret);
  if (!data) return null;
  return auth.getUserById(data.sub).catch(() => null);
}

/* -------------------------------- routes ------------------------------- */

async function handleAuthStart(req, res, url) {
  if (!authEnabled) return redirect(res, "/");

  const state = randomBytes(16).toString("hex");
  const next = safeNext(url.searchParams.get("next"));
  const payload = Buffer.from(JSON.stringify({ state, next })).toString("base64url");

  return redirect(res, authorizeUrl(state, next), [
    cookie(STATE_COOKIE, payload, { maxAge: 600 }),
  ]);
}

function safeNext(value) {
  if (!value || typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 200);
}

async function handleCallback(req, res, url) {
  if (!authEnabled) return redirect(res, "/");

  const error = url.searchParams.get("error");
  if (error) {
    return send(res, 400, page("Sign-in cancelled", "Discord returned an error instead of a code. Nothing was changed.", { href: "/", label: "Back to site" }), {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  let stored = null;
  try {
    stored = JSON.parse(Buffer.from(parseCookies(req.headers.cookie)[STATE_COOKIE] || "", "base64url").toString("utf8"));
  } catch {
    stored = null;
  }

  if (!code || !state || !stored || stored.state !== state) {
    return send(res, 400, page("Sign-in expired", "The login link was reused or took too long. Start again from the site.", { href: "/auth/discord", label: "Try again" }), {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  let data;
  let user;
  try {
    data = await exchangeCode(code);
    user = await fetchUser(data.access_token);
  } catch (err) {
    console.error("[auth]", err.message);
    return send(res, 502, page("Discord unreachable", "The token exchange failed. Check the client id, secret and redirect URI.", { href: "/auth/discord", label: "Try again" }), {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  const gate = await checkMembership(user.id);
  if (!gate.ok) {
    const message =
      gate.reason === "not-in-guild"
        ? "This Discord account is not in the server yet, so the download stays locked."
        : gate.reason === "missing-role"
          ? "You are in the server, but you do not have the required role yet."
          : "The membership lookup failed. Ask an admin to check the bot token.";
    const action = cfg.inviteUrl ? { href: cfg.inviteUrl, label: "Join the Discord" } : { href: "/", label: "Back to site" };
    return send(res, 403, page("Not authorised", message, action), {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  console.log(`[auth] ${user.username} (${user.id}) signed in`);

  return redirect(res, stored.next || "/", [
    sessionCookie(user),
    cookie(STATE_COOKIE, "", { maxAge: 0 }),
  ]);
}

async function handleMe(req, res) {
  const user = currentUser(req);
  if (user) return json(res, 200, { authenticated: true, authEnabled, user, type: "discord" });
  const acc = await currentAccount(req);
  if (acc) return json(res, 200, { authenticated: true, authEnabled, user: { id: acc.id, username: acc.name, email: acc.email }, type: "account", premium: !!acc.premium, key: acc.key || null });
  return json(res, 401, { authenticated: false, authEnabled });
}

function handleLogout(req, res) {
  return redirect(res, "/", [cookie(SESSION_COOKIE, "", { maxAge: 0 }), cookie(ACCOUNT_TOKEN_COOKIE, "", { maxAge: 0 })]);
}

async function handleDownload(req, res) {
  // try account auth first
  const acc = await currentAccount(req);
  if (acc) {
    // default to free unless premium
    if (acc.premium && acc.key) {
      let info;
      try { info = await stat(cfg.premiumJar); }
      catch { return json(res, 404, { error: "build not found" }); }
      res.writeHead(200, {
        "Content-Type": "application/java-archive",
        "Content-Length": info.size,
        "Content-Disposition": `attachment; filename="${cfg.premiumJarName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return createReadStream(cfg.premiumJar).pipe(res);
    }
    let info;
    try { info = await stat(cfg.freeJar); }
    catch { return json(res, 404, { error: "build not found" }); }
    res.writeHead(200, {
      "Content-Type": "application/java-archive",
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${cfg.freeJarName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return createReadStream(cfg.freeJar).pipe(res);
  }

  if (authEnabled && !currentUser(req)) {
    return redirect(res, "/auth/discord?next=%2Fdownload");
  }
  if (!authEnabled && !currentUser(req)) {
    // allow? but keep existing behavior - redirect to discord if enabled
  }

  let info;
  try {
    info = await stat(cfg.jarPath);
  } catch {
    return json(res, 404, { error: "build not found", path: cfg.jarPath });
  }

  res.writeHead(200, {
    "Content-Type": "application/java-archive",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename="${cfg.jarName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(cfg.jarPath).pipe(res);
}

async function handleStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "bad request");
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  // the build is only reachable through /download
  if (/\.jar$/i.test(pathname)) return send(res, 403, "forbidden");

  // server-side files (config.json holds the client secret) are never static
  if (pathname === "/server" || pathname.startsWith("/server/")) return send(res, 403, "forbidden");
  if (/(^|\/)\./.test(pathname)) return send(res, 403, "forbidden");

  const target = resolve(SITE, "." + normalize(pathname));
  if (!target.startsWith(SITE)) return send(res, 403, "forbidden");

  let info;
  try {
    info = await stat(target);
    if (info.isDirectory()) return handleStatic(req, res, new URL(`${url.pathname}index.html`, url));
  } catch {
    return send(res, 404, page("Not found", "That page does not exist on this build.", { href: "/", label: "Back to site" }), {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  res.writeHead(200, {
    "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": pathname.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(target).pipe(res);
}

/* --------------------------------- keys -------------------------------- */

let storeCache = null;
let storeWrite = Promise.resolve();

async function getStore() {
  if (!storeCache) storeCache = await keys.loadStore(cfg.keyStore);
  return storeCache;
}

function persist() {
  storeWrite = storeWrite
    .then(() => keys.saveStore(storeCache, cfg.keyStore))
    .catch((err) => console.error("[keys] save failed:", err.message));
  return storeWrite;
}

/* --------------------- publish fingerprints to the site ----------------- */

const REPO_ROOT = resolve(SITE, "..");
const SITE_LICENSES_JS = join(REPO_ROOT, "docs", "assets", "licenses.js");
const SITE_LICENSES_JSON = join(REPO_ROOT, "docs", "assets", "licenses.json");
const PUBLISH_ENABLED = String(process.env.PUBLISH_SITE ?? "1") !== "0";

let publishQueue = Promise.resolve();

function siteSnapshot(store) {
  const now = Date.now();
  const fingerprints = {};
  for (const entry of keys.list(store)) {
    const key = keys.normalizeKey(entry.key);
    if (!key) continue;
    const status = entry.revoked
      ? "revoked"
      : entry.expiresAt && entry.expiresAt <= now
        ? "expired"
        : "active";
    fingerprints[createHash("sha256").update(key).digest("hex")] = {
      expiresAt: entry.expiresAt || null,
      status,
    };
  }
  return {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    keys: fingerprints,
  };
}

function runGit(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(output);
      else reject(new Error(output.trim().split("\n").slice(-3).join(" ") || `git exited ${code}`));
    });
  });
}

async function publishSiteNow(store) {
  if (!PUBLISH_ENABLED) return;
  try {
    const payload = siteSnapshot(store);
    const count = Object.keys(payload.keys).length;
    const active = Object.values(payload.keys).filter((entry) => entry.status === "active").length;
    // Skip the commit when nothing about the keys changed (e.g. an unbind).
    let previous = null;
    try {
      previous = JSON.parse(await readFile(SITE_LICENSES_JSON, "utf8")).keys;
    } catch {
      /* first publish */
    }
    if (previous && JSON.stringify(previous) === JSON.stringify(payload.keys)) return;

    const body = JSON.stringify(payload, null, 2);
    const js =
      "/* =========================================================================\n" +
      "   asus.wtf — key fingerprints for the download gate\n" +
      "\n" +
      "   Generated by site/server/server.mjs from the local key store.\n" +
      "   Contains SHA-256 hashes only: no raw keys, no notes, nothing reusable.\n" +
      `   Generated ${payload.generatedAt} · ${active} active of ${count} published.\n` +
      "   ========================================================================= */\n\n" +
      `window.ASUS_SITE_LICENSES = ${body};\n`;

    let changed = false;
    for (const [file, next] of [
      [SITE_LICENSES_JSON, `${body}\n`],
      [SITE_LICENSES_JS, js],
    ]) {
      let current = "";
      try {
        current = await readFile(file, "utf8");
      } catch {
        /* first publish */
      }
      if (current !== next) {
        await writeFile(file, next, "utf8");
        changed = true;
      }
    }

    if (!changed) return;

    await runGit(["add", "docs/assets/licenses.js", "docs/assets/licenses.json"]);
    let identity = [];
    try {
      identity = (await runGit(["config", "user.email"])).trim()
        ? []
        : ["-c", "user.name=asus.wtf", "-c", "user.email=keys@asus.wtf"];
    } catch {
      identity = ["-c", "user.name=asus.wtf", "-c", "user.email=keys@asus.wtf"];
    }
    await runGit([...identity, "commit", "-m", "update site keys"]);
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    await runGit(branch && branch !== "HEAD" ? ["push", "origin", branch] : ["push"]);
    console.log(`[site] published ${count} fingerprint(s) (${active} active) and pushed`);
  } catch (error) {
    console.error(`[site] publish failed: ${error.message}`);
  }
}

/** Snapshot the store now, publish in order after the current write queue. */
function publishSite(store) {
  const snapshot = JSON.parse(JSON.stringify(store));
  publishQueue = publishQueue.then(() => publishSiteNow(snapshot));
  return publishQueue;
}

async function handleLicenseAuth(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method" });

  const body = await readJson(req);
  if (!body) return json(res, 400, { ok: false, reason: "bad-json" });

  const store = await getStore();
  const result = keys.authorize(store, body.key, body.hwid);
  if (result.ok) await persist();

  const who = typeof body.hwid === "string" ? body.hwid.slice(0, 8) : "no-hwid";
  console.log(`[keys] ${result.ok ? "ok" : result.reason} (${who}) ${typeof body.key === "string" ? body.key.slice(0, 9) : ""}`);
  return json(res, result.ok ? 200 : 403, result);
}

async function handleAdminPage(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const html = await readFile(join(HERE, "admin.html"), "utf8");
    return send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
  } catch {
    return send(res, 500, "admin.html missing");
  }
}

async function handleAdminKeys(req, res) {
  if (!requireAdmin(req, res)) return;
  const store = await getStore();

  if (req.method === "GET") {
    return json(res, 200, { stats: keys.stats(store), keys: keys.list(store) });
  }

  if (req.method !== "POST") return json(res, 405, { error: "method" });

  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "bad-json" });

  const count = Math.min(Math.max(Number(body.count) || 1, 1), 200);
  const created = [];

  for (let i = 0; i < count; i += 1) {
    created.push(
      keys.createEntry(store, {
        note: typeof body.note === "string" ? body.note.slice(0, 40) : "",
        maxUses: Number(body.uses) || 1,
        days: Number(body.days) || 0,
        createdBy: "admin",
      }).key
    );
  }

  await persist();
  publishSite(store);
  console.log(`[keys] generated ${created.length} key(s)`);
  return json(res, 200, { keys: created });
}

/* Before anything destructive, a copy of the store is written to keys-backups/ next to it, so a
   revoke-all / delete-all / delete can be undone by hand. The newest 20 are kept. */
const BACKUP_DIR = join(dirname(resolve(String(cfg.keyStore))), "keys-backups");

async function backupStore(label) {
  try {
    const store = await getStore();
    await mkdir(BACKUP_DIR, { recursive: true });
    // milliseconds in the name, so two destructive calls in the same second cannot overwrite
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 23);
    const file = join(BACKUP_DIR, `keys-${stamp}-${label}.json`);
    await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const files = (await readdir(BACKUP_DIR)).filter((name) => name.startsWith("keys-")).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 20))) {
      await rm(join(BACKUP_DIR, old), { force: true });
    }
    console.log(`[keys] backup ${file}`);
  } catch (err) {
    console.error("[keys] backup failed:", err.message);
  }
}

async function handleAdminRevokeAll(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "method" });

  const store = await getStore();
  await backupStore("revoke-all");
  let revoked = 0;
  for (const entry of keys.list(store)) {
    if (!entry.revoked) {
      entry.revoked = true;
      revoked += 1;
    }
  }
  if (revoked) {
    await persist();
    publishSite(store);
  }

  console.log(`[keys] revoke-all -> ${revoked}`);
  return json(res, 200, { ok: true, revoked });
}

async function handleAdminDelete(req, res, all = false) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "method" });

  const store = await getStore();

  if (all) {
    const removed = keys.list(store).length;
    await backupStore("delete-all");
    store.keys = {};
    await persist();
    publishSite(store);
    console.log(`[keys] delete-all -> ${removed}`);
    return json(res, 200, { ok: true, removed });
  }

  const body = await readJson(req);
  if (!body || typeof body.key !== "string") return json(res, 400, { error: "key required" });

  await backupStore("delete");
  const ok = keys.remove(store, body.key);
  if (ok) {
    await persist();
    publishSite(store);
  }

  console.log(`[keys] delete ${body.key} -> ${ok ? "ok" : "not-found"}`);
  return json(res, ok ? 200 : 404, { ok });
}

async function handleAdminRevoke(req, res, unbindOnly = false) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "method" });

  const body = await readJson(req);
  if (!body || typeof body.key !== "string") return json(res, 400, { error: "key required" });

  const store = await getStore();
  const ok = unbindOnly ? keys.unbind(store, body.key) : keys.revoke(store, body.key);
  if (ok) {
    await persist();
    publishSite(store);
  }

  console.log(`[keys] ${unbindOnly ? "unbind" : "revoke"} ${body.key} -> ${ok ? "ok" : "not-found"}`);
  return json(res, ok ? 200 : 404, { ok });
}

/* -------------------------------- server ------------------------------- */

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, cfg.baseUrl);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";

  res.on("finish", () => {
    if (!url.pathname.startsWith("/api/")) {
      console.log(`${res.statusCode} ${req.method} ${url.pathname} ${Date.now() - started}ms`);
    }
  });

  try {
    if (limited(ip) && (url.pathname.startsWith("/auth/") || url.pathname === "/download" || url.pathname === "/api/license/auth")) {
      return send(res, 429, "slow down");
    }

    switch (url.pathname) {
      case "/api/config":
        return json(res, 200, {
          authEnabled,
          name: "asus.wtf",
          guildId: cfg.guildId || null,
          inviteUrl: cfg.inviteUrl || null,
        });
      case "/api/me":
        return handleMe(req, res);
      case "/auth/discord":
        return handleAuthStart(req, res, url);
      case "/auth/discord/callback":
        return handleCallback(req, res, url);
      case "/auth/logout":
        return handleLogout(req, res);
      case "/api/auth/register":
        return handleAuthRegister(req, res);
      case "/api/auth/login":
        return handleAuthLogin(req, res);
      case "/api/auth/me":
        return handleAuthMeApi(req, res);
      case "/api/auth/activate":
        return handleAuthActivate(req, res);
      case "/api/auth/google":
        return handleAuthGoogle(req, res);
      case "/download":
        return handleDownload(req, res);
      case "/download/free":
        return handleDownloadFree(req, res);
      case "/download/premium":
        return handleDownloadPremium(req, res);
      case "/api/license/auth":
        return handleLicenseAuth(req, res);
      case "/api/license/ping":
        return json(res, 200, { ok: true, service: "asus.wtf keys" });
      case "/admin":
        return handleAdminPage(req, res);
      case "/api/admin/keys":
        return handleAdminKeys(req, res);
      case "/api/admin/revoke":
        return handleAdminRevoke(req, res, false);
      case "/api/admin/unbind":
        return handleAdminRevoke(req, res, true);
      case "/api/admin/revoke-all":
        return handleAdminRevokeAll(req, res);
      case "/api/admin/delete":
        return handleAdminDelete(req, res, false);
      case "/api/admin/delete-all":
        return handleAdminDelete(req, res, true);
      default:
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
        return handleStatic(req, res, url);
    }
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) send(res, 500, "internal error");
    else res.end();
  }
});

async function handleAuthRegister(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  const body = await readJson(req);
  if (!body || !body.email || !body.password) return json(res, 400, { ok: false, error: "missing" });
  try {
    const { user } = await auth.findUserByEmail(body.email);
    if (user) return json(res, 409, { ok: false, error: "exists" });
    const created = await auth.createUser({ email: body.email, password: body.password, name: body.name || body.email.split("@")[0] });
    return json(res, 200, { ok: true, user: { id: created.id, email: created.email, name: created.name } });
  } catch (e) {
    return json(res, 500, { ok: false, error: "err" });
  }
}

async function handleAuthLogin(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  const body = await readJson(req);
  if (!body || !body.email || !body.password) return json(res, 400, { ok: false, error: "missing" });
  try {
    const { user } = await auth.findUserByEmail(body.email);
    if (!user) return json(res, 401, { ok: false, error: "bad" });
    if (!(await auth.verifyPassword(user, body.password))) return json(res, 401, { ok: false, error: "bad" });
    return json(res, 200, { ok: true, token: auth.signToken({ sub: user.id, type: "account", exp: Date.now() + cfg.sessionDays * 86400000 }, cfg.sessionSecret), user: { id: user.id, email: user.email, name: user.name, premium: !!user.premium } }, {
      "Set-Cookie": accountCookie(user),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: "err" });
  }
}

async function handleAuthMeApi(req, res) {
  const acc = await currentAccount(req);
  if (!acc) return json(res, 401, { ok: false });
  return json(res, 200, { ok: true, user: { id: acc.id, email: acc.email, name: acc.name, premium: !!acc.premium, key: acc.key || null } });
}

async function handleAuthActivate(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  const acc = await currentAccount(req);
  if (!acc) return json(res, 401, { ok: false });
  const body = await readJson(req);
  if (!body || !body.key) return json(res, 400, { ok: false, error: "missing" });
  const store = await getStore();
  const result = keys.authorize(store, body.key, acc.id);
  if (!result.ok) return json(res, 403, { ok: false, reason: result.reason });
  await persist();
  await auth.setUserKey(acc.id, body.key);
  return json(res, 200, { ok: true });
}

function handleAuthGoogle(req, res) {
  return redirect(res, "/");
}

async function handleDownloadFree(req, res) {
  let info;
  try { info = await stat(cfg.freeJar); }
  catch { return json(res, 404, { error: "build not found" }); }
  res.writeHead(200, {
    "Content-Type": "application/java-archive",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename="${cfg.freeJarName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  return createReadStream(cfg.freeJar).pipe(res);
}

async function handleDownloadPremium(req, res) {
  const acc = await currentAccount(req);
  if (!acc) return redirect(res, "/login.html");
  if (!acc.premium || !acc.key) return send(res, 403, page("Premium required", "Activate a valid license key in your dashboard to download the premium build.", { href: "/dashboard/", label: "Go to dashboard" }), { "Content-Type": "text/html; charset=utf-8" });
  let info;
  try { info = await stat(cfg.premiumJar); }
  catch { return json(res, 404, { error: "build not found" }); }
  res.writeHead(200, {
    "Content-Type": "application/java-archive",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename="${cfg.premiumJarName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  return createReadStream(cfg.premiumJar).pipe(res);
}

server.listen(cfg.port, () => {
  console.log(`asus.wtf serving ${SITE}`);
  console.log(`  http://localhost:${cfg.port}`);
  console.log(`  auth: ${authEnabled ? "discord oauth2" : "disabled (open downloads)"}`);
  console.log(`  redirect uri: ${redirectUri}`);
  if (cfg.guildId) console.log(`  guild gate: ${cfg.guildId}${cfg.roleIds.length ? ` roles ${cfg.roleIds.join(", ")}` : ""}`);
  console.log(`  keys: ${cfg.keyStore}`);
  console.log(`  admin: ${cfg.adminPassword ? `/admin as "${cfg.adminUser}"` : "closed (set ADMIN_PASSWORD)"}`);
});
