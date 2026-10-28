/* =========================================================================
   asus.wtf — download gate

   Keys are checked against SHA-256 fingerprints published in licenses.js /
   licenses.json (written by the key server on every generate/revoke). The raw
   key never leaves the browser, and the published file contains no usable key.

   licenses.json is fetched with cache: "no-store" so a revocation is seen on
   the next page load instead of waiting out GitHub Pages' 10-minute cache.

   Exports: normalizeKey, formatKeyInput, verifyKey, verifyHash,
            verifyStoredHash, reasonText, remember, recall, forget
   ========================================================================= */

const KEY_RE = /^ASUS-[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/;
const STORAGE_PREFIX = "asus.license.";

// The server pushes the list the moment a key changes, but both GitHub Pages
// and raw.githubusercontent.com cache it. Read both and keep whichever is
// newer: a lagging CDN must never miss a new key or resurrect a deleted one.
const RAW_LICENSE_URL =
  "https://raw.githubusercontent.com/AsusClient/asus/main/docs/assets/licenses.json";

let freshDatabase = null;
let listPromise = null;

function currentDatabase() {
  return freshDatabase || window.ASUS_SITE_LICENSES;
}

async function fetchList(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.keys ? data : null;
  } catch {
    return null;
  }
}

function freshness(database) {
  if (!database) return -1;
  if (typeof database.revision === "number") return database.revision;
  const stamp = Date.parse(database.generatedAt || "");
  return Number.isFinite(stamp) ? stamp : -1;
}

/** Load the newest fingerprint list available, regardless of which CDN lags. */
export async function refreshLicenses() {
  if (listPromise) return listPromise;
  listPromise = (async () => {
    const stamp = Date.now().toString(36);
    const local = new URL("licenses.json", import.meta.url);
    local.searchParams.set("t", stamp);
    const copies = await Promise.all([
      fetchList(`${RAW_LICENSE_URL}?t=${stamp}`),
      fetchList(local.href),
    ]);

    let best = null;
    for (const copy of copies) {
      if (copy && (!best || freshness(copy) > freshness(best))) best = copy;
    }
    if (best) freshDatabase = best;
    return currentDatabase();
  })();
  return listPromise;
}

export function normalizeKey(raw) {
  const cleaned = String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^ASUS/, "");
  if (cleaned.length !== 20) return "";
  const groups = [];
  for (let i = 0; i < 20; i += 5) groups.push(cleaned.slice(i, i + 5));
  const key = `ASUS-${groups.join("-")}`;
  return KEY_RE.test(key) ? key : "";
}

/** Progressive formatting for the input field. */
export function formatKeyInput(raw) {
  let cleaned = String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^ASUS/, "")
    .slice(0, 20);
  const groups = [];
  for (let i = 0; i < cleaned.length; i += 5) groups.push(cleaned.slice(i, i + 5));
  return groups.length ? `ASUS-${groups.join("-")}` : "";
}

async function sha256Hex(text) {
  if (!window.crypto || !window.crypto.subtle) return "";
  const bytes = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Checks a stored fingerprint; used when restoring the unlocked state. */
export function verifyHash(hash) {
  const database = currentDatabase();
  if (!database || !database.keys) return { ok: false, reason: "unconfigured" };
  if (!hash) return { ok: false, reason: "unknown" };

  const entry = database.keys[String(hash).toLowerCase()];
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.status === "revoked") return { ok: false, reason: "revoked" };
  if (entry.status === "expired") return { ok: false, reason: "expired" };
  if (entry.expiresAt && entry.expiresAt < Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, hash: String(hash).toLowerCase(), expiresAt: entry.expiresAt || null };
}

export async function verifyKey(raw) {
  const key = normalizeKey(raw);
  if (!key) return { ok: false, reason: "malformed" };

  const hash = await sha256Hex(key);
  if (!hash) return { ok: false, reason: "unavailable" };

  await refreshLicenses();
  const result = verifyHash(hash);
  if (!result.ok) return result;
  return { ...result, hash };
}

/** Re-checks a remembered unlock against the freshest published list. */
export async function verifyStoredHash(hash) {
  await refreshLicenses();
  return verifyHash(hash);
}

export function reasonText(reason) {
  switch (reason) {
    case "malformed":
      return "That doesn't look like an ASUS key — it should be ASUS-XXXXX-XXXXX-XXXXX-XXXXX.";
    case "unknown":
      return "That key isn't on the list. Check for a typo and try again.";
    case "revoked":
      return "That key has been revoked.";
    case "expired":
      return "That key has expired.";
    case "unavailable":
      return "This browser can't verify keys. Try a current version of Chrome, Firefox, Edge or Safari.";
    case "unconfigured":
      return "Key checking isn't published yet — the site owner needs to run the key publish step.";
    default:
      return "That key couldn't be verified.";
  }
}

/* ------------------------- remembered unlock --------------------------- */

export function remember(userId, hash) {
  if (!userId || !hash) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + userId, hash);
  } catch {
    /* private mode: the unlock simply won't survive a reload */
  }
}

export function recall(userId) {
  if (!userId) return "";
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + userId) || "";
  } catch {
    return "";
  }
}

export function forget(userId) {
  if (!userId) return;
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    /* nothing to clear */
  }
}
