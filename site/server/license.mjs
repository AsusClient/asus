/* =========================================================================
   asus.wtf — key store
   Shared by server.mjs (HTTP API) and genkey.mjs (offline CLI).
   Plain JSON on disk: keys.json next to this file, atomic writes, no deps.
   ========================================================================= */

import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_STORE = join(HERE, "keys.json");

const PREFIX = "ASUS";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const GROUPS = 4;
const GROUP_LEN = 5;

/* -------------------------------- format -------------------------------- */

export function newKey() {
  const chars = [];
  for (let i = 0; i < GROUPS * GROUP_LEN; i += 1) {
    chars.push(ALPHABET[randomBytes(1)[0] % ALPHABET.length]);
  }
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(""));
  }
  return `${PREFIX}-${groups.join("-")}`;
}

export function normalizeKey(input) {
  if (typeof input !== "string") return "";
  const cleaned = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^ASUS/, "");
  if (cleaned.length !== GROUPS * GROUP_LEN) return "";
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) {
    groups.push(cleaned.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  }
  const key = `${PREFIX}-${groups.join("-")}`;
  return /^ASUS-[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/.test(key) ? key : "";
}

export const maskKey = (key) => `${key.slice(0, 9)}-*****-*****-*****`;

/* --------------------------------- store -------------------------------- */

export async function loadStore(file = DEFAULT_STORE) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.keys) throw new Error("bad store");
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return { version: 1, keys: {} };
    throw err;
  }
}

export async function saveStore(store, file = DEFAULT_STORE) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/* ------------------------------- operations ----------------------------- */

export function createEntry(store, options = {}) {
  const {
    key = newKey(),
    note = "",
    maxUses = 1,
    days = 0,
    createdBy = "cli",
  } = options;

  const now = Date.now();
  const entry = {
    key,
    note,
    createdAt: now,
    expiresAt: days > 0 ? now + days * 86_400_000 : null,
    maxUses: Math.max(1, Number(maxUses) || 1),
    hwids: [],
    revoked: false,
    lastSeenAt: null,
    lastHwid: null,
  };

  store.keys[key] = entry;
  return entry;
}

function find(store, rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return { key: "", entry: null };
  return { key, entry: store.keys[key] || null };
}

/**
 * Bind (first use) or re-check a key against a machine id.
 * Returns { ok, reason, key, expiresAt, plan, remainingUses }.
 */
export function authorize(store, rawKey, hwid) {
  const { key, entry } = find(store, rawKey);
  if (!key) return { ok: false, reason: "malformed" };
  if (!entry) return { ok: false, reason: "unknown" };

  const now = Date.now();

  if (entry.revoked) return { ok: false, reason: "revoked" };
  if (entry.expiresAt && entry.expiresAt < now) return { ok: false, reason: "expired" };
  if (!hwid || typeof hwid !== "string") return { ok: false, reason: "no-hwid" };

  const bound = Array.isArray(entry.hwids) ? entry.hwids : [];

  if (!bound.length) {
    entry.hwids = [hwid];
  } else if (!bound.includes(hwid)) {
    if (bound.length >= (entry.maxUses || 1)) {
      return {
        ok: false,
        reason: "in-use",
        key,
        remainingUses: 0,
        expiresAt: entry.expiresAt,
      };
    }
    entry.hwids.push(hwid);
  }

  entry.lastSeenAt = now;
  entry.lastHwid = hwid;

  return {
    ok: true,
    reason: "ok",
    key,
    plan: entry.note || "standard",
    expiresAt: entry.expiresAt,
    remainingUses: Math.max(0, (entry.maxUses || 1) - entry.hwids.length),
  };
}

export function revoke(store, rawKey) {
  const { entry } = find(store, rawKey);
  if (!entry) return false;
  entry.revoked = true;
  return true;
}

export function unbind(store, rawKey) {
  const { entry } = find(store, rawKey);
  if (!entry) return false;
  entry.hwids = [];
  entry.lastHwid = null;
  return true;
}

export function remove(store, rawKey) {
  const { key, entry } = find(store, rawKey);
  if (!entry) return false;
  delete store.keys[key];
  return true;
}

export function list(store) {
  return Object.values(store.keys).sort((a, b) => b.createdAt - a.createdAt);
}

export function stats(store) {
  const all = list(store);
  const now = Date.now();
  return {
    total: all.length,
    active: all.filter((e) => !e.revoked && (!e.expiresAt || e.expiresAt > now)).length,
    bound: all.filter((e) => (e.hwids || []).length > 0).length,
    revoked: all.filter((e) => e.revoked).length,
  };
}
