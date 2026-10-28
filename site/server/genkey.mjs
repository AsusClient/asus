#!/usr/bin/env node
/* =========================================================================
   asus.wtf — key generator (offline CLI)

   node genkey.mjs 10                    ten keys, 1 machine each
   node genkey.mjs 5 --uses 2 --days 30  multi-machine, 30 day expiry
   node genkey.mjs --list                show the store
   node genkey.mjs --revoke ASUS-...     burn a key
   node genkey.mjs --unbind ASUS-...     free its machines

   Writes the same keys.json the server reads. Pass --store <path> to point
   somewhere else (must match KEY_STORE in the server config).
   ========================================================================= */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as keys from "./license.mjs";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value ?? fallback;
}

const storePath = resolve(flag("--store", keys.DEFAULT_STORE));
const uses = Number(flag("--uses", 1)) || 1;
const days = Number(flag("--days", 0)) || 0;
const note = flag("--note", "");
const count = Number(args.find((a) => /^\d+$/.test(a)) || 0);

const store = await keys.loadStore(storePath);

const pad = (s, n) => String(s).padEnd(n);
const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

if (args.includes("--list")) {
  const all = keys.list(store);
  if (!all.length) {
    console.log("store is empty:", storePath);
    process.exit(0);
  }
  console.log(pad("KEY", 30), pad("USES", 7), pad("EXPIRES", 11), pad("STATUS", 9), "NOTE");
  for (const entry of all) {
    const status = entry.revoked
      ? "revoked"
      : entry.expiresAt && entry.expiresAt < Date.now()
        ? "expired"
        : (entry.hwids || []).length
          ? "active"
          : "unused";
    console.log(
      pad(entry.key, 30),
      pad(`${(entry.hwids || []).length}/${entry.maxUses}`, 7),
      pad(date(entry.expiresAt), 11),
      pad(status, 9),
      entry.note || ""
    );
  }
  console.log(`\n${all.length} key(s) in ${storePath}`);
  process.exit(0);
}

const revokeKey = flag("--revoke", "");
if (revokeKey) {
  const ok = keys.revoke(store, revokeKey);
  if (ok) await keys.saveStore(store, storePath);
  console.log(ok ? `revoked ${keys.normalizeKey(revokeKey)}` : "key not found");
  process.exit(ok ? 0 : 1);
}

const unbindKey = flag("--unbind", "");
if (unbindKey) {
  const ok = keys.unbind(store, unbindKey);
  if (ok) await keys.saveStore(store, storePath);
  console.log(ok ? `unbound ${keys.normalizeKey(unbindKey)}` : "key not found");
  process.exit(ok ? 0 : 1);
}

if (!count) {
  console.log("usage: node genkey.mjs <count> [--uses n] [--days n] [--note text] [--store path]");
  console.log("       node genkey.mjs --list | --revoke KEY | --unbind KEY");
  process.exit(1);
}

const made = [];
for (let i = 0; i < count; i += 1) {
  made.push(keys.createEntry(store, { maxUses: uses, days, note, createdBy: "cli" }).key);
}
await keys.saveStore(store, storePath);

console.log(made.join("\n"));
console.log(`\n${made.length} key(s) written to ${storePath}`);
if (days) console.log(`expires: ${date(Date.now() + days * 86_400_000)}`);
if (uses > 1) console.log(`usable on ${uses} machines each`);
