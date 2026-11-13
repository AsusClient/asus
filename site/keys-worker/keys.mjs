#!/usr/bin/env node
/* =========================================================================
   asus.wtf — key admin for the hosted (Cloudflare Worker) store

   The clients distributed from site/assets now validate against the public
   key API, not the localhost server, so keys issued from the local /admin
   panel do not reach them. Use this instead:

     node site/keys-worker/keys.mjs list
     node site/keys-worker/keys.mjs new 5 --uses 2 --days 30 --note beta
     node site/keys-worker/keys.mjs revoke ASUS-XXXXX-XXXXX-XXXXX-XXXXX
     node site/keys-worker/keys.mjs unbind ASUS-XXXXX-XXXXX-XXXXX-XXXXX
     node site/keys-worker/keys.mjs delete ASUS-XXXXX-XXXXX-XXXXX-XXXXX
     node site/keys-worker/keys.mjs import [site/server/keys.json]

   Credentials come from ASUS_ADMIN_USER / ASUS_ADMIN_PASSWORD, falling back
   to the local site/server/config.json (gitignored). ASUS_KEY_API overrides
   the endpoint.
   ========================================================================= */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_API = "https://site-9d16d28e8e6c4fc881e1636264073bc8.freebuff.page";

function credentials() {
  const api = (process.env.ASUS_KEY_API || DEFAULT_API).replace(/\/+$/, "");
  let user = process.env.ASUS_ADMIN_USER || "";
  let pass = process.env.ASUS_ADMIN_PASSWORD || "";
  if (!user || !pass) {
    try {
      const cfg = JSON.parse(readFileSync(join(ROOT, "site", "server", "config.json"), "utf8"));
      user = user || cfg.ADMIN_USER || "admin";
      pass = pass || cfg.ADMIN_PASSWORD || "";
    } catch {
      /* no local config: rely on the environment */
    }
  }
  return { api, user, pass };
}

async function call(path, method = "GET", body) {
  const { api, user, pass } = credentials();
  if (!pass) {
    console.error("No admin password: set ASUS_ADMIN_PASSWORD or site/server/config.json ADMIN_PASSWORD.");
    process.exit(2);
  }
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    console.error(`HTTP ${response.status}:`, JSON.stringify(parsed));
    process.exit(1);
  }
  return parsed;
}

const args = process.argv.slice(2);
const command = args.shift() || "list";

function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value ?? fallback;
}

const pad = (value, width) => String(value).padEnd(width);
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

if (command === "list") {
  const data = await call("/api/admin/keys");
  const rows = data.keys || [];
  if (!rows.length) {
    console.log("store is empty");
    process.exit(0);
  }
  const now = Date.now();
  console.log(pad("KEY", 30), pad("USES", 7), pad("EXPIRES", 11), pad("STATUS", 9), "NOTE");
  for (const entry of rows) {
    const status = entry.revoked
      ? "revoked"
      : entry.expiresAt && entry.expiresAt < now
        ? "expired"
        : entry.hwids.length
          ? "active"
          : "unused";
    console.log(pad(entry.key, 30), pad(`${entry.hwids.length}/${entry.maxUses}`, 7), pad(day(entry.expiresAt), 11), pad(status, 9), entry.note || "");
  }
  const stats = data.stats || {};
  console.log(`\n${stats.total || rows.length} key(s): ${stats.active || 0} active, ${stats.bound || 0} bound, ${stats.revoked || 0} revoked`);
  process.exit(0);
}

if (command === "new") {
  const count = Number(args.find((a) => /^\d+$/.test(a)) || 0) || 1;
  const uses = Number(flag("--uses", 1)) || 1;
  const days = Number(flag("--days", 0)) || 0;
  const note = flag("--note", "");
  const { keys } = await call("/api/admin/keys", "POST", { count, uses, days, note });
  for (const key of keys) console.log(key);
  console.log(`\n${keys.length} key(s) issued on the hosted store${days ? `, expiring ${day(Date.now() + days * 86_400_000)}` : ""}`);
  process.exit(0);
}

if (command === "import") {
  const file = resolve(args[0] || join(ROOT, "site", "server", "keys.json"));
  const store = JSON.parse(readFileSync(file, "utf8"));
  const keys = Object.values(store.keys || {});
  const result = await call("/api/admin/import", "POST", { keys });
  console.log(`imported ${result.imported} key(s) from ${file}`);
  process.exit(0);
}

if (["revoke", "unbind", "delete"].includes(command)) {
  const key = args[0];
  if (!key) {
    console.error(`usage: node site/keys-worker/keys.mjs ${command} ASUS-XXXXX-XXXXX-XXXXX-XXXXX`);
    process.exit(2);
  }
  const result = await call(`/api/admin/${command}`, "POST", { key });
  console.log(`${command}: ${result.key || key}`);
  process.exit(0);
}

console.error("usage: keys.mjs list | new [n] [--uses n] [--days n] [--note t] | revoke|unbind|delete KEY | import [file]");
process.exit(2);
