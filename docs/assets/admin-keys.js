/* =========================================================================
   asus.wtf — admin: key generator

   Keys are minted by the local key server (site/server/server.mjs), because
   that is the only place they can be created without breaking the game client
   and the published download gate. The page is https and the server is http on
   localhost, so the server answers the private-network CORS preflight.

   Optional: the same action can grant premium to one account, so a key and the
   website access it implies are handed out together.
   ========================================================================= */

import { setPremium } from "./premium-client.js";

const SESSION_KEY = "asus.keygen.session";
const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000,
};

let els = null;
let opts = {};
let latest = [];

function say(text, ok = false) {
  if (!els) return;
  els.msg.textContent = text || "";
  els.msg.classList.toggle("ok", Boolean(text) && ok);
}

function state(text, ok = false) {
  if (!els) return;
  els.state.textContent = text;
  els.state.className = `tag ${ok ? "premium" : "free"}`;
}

function normalizeBase(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

function baseUrl() {
  return normalizeBase(els.server.value);
}

/**
 * localhost and 127.0.0.1 are different sockets: on Windows localhost often
 * resolves to ::1 while the server may only be reachable over IPv4. Trying both
 * turns a confusing "unreachable" into a working call.
 */
function candidates() {
  const primary = baseUrl();
  if (!primary) return [];
  const out = [primary];
  try {
    const url = new URL(primary);
    const swap =
      url.hostname === "localhost"
        ? "127.0.0.1"
        : url.hostname === "127.0.0.1"
        ? "localhost"
        : "";
    if (swap) {
      const alt = new URL(primary);
      alt.hostname = swap;
      out.push(alt.origin);
    }
  } catch {
    /* not parseable — the raw value is all we have */
  }
  return out;
}

/** Shows the same-origin generator on the key server, which needs no CORS. */
function showLocal(base) {
  if (!els.local) return;
  els.local.href = `${base || "http://localhost:3000"}/admin`;
  els.local.classList.remove("hidden");
}

/**
 * True when the port answers at all. A cross-origin read is impossible here
 * (the point is to fail), so this only proves a listener exists.
 */
async function listening(base) {
  try {
    await fetch(`${base}/api/license/ping`, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

function saved() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}");
  } catch {
    return {};
  }
}

function remember() {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ base: els.server.value, user: els.user.value, pass: els.pass.value })
    );
  } catch {
    /* private mode: values just won't survive a reload */
  }
}

function authorization() {
  const pair = `${els.user.value}:${els.pass.value}`;
  return `Basic ${btoa(unescape(encodeURIComponent(pair)))}`;
}

async function request(method, body) {
  const list = candidates();
  if (!list.length) throw new Error("Enter the server address, e.g. http://localhost:3000");

  let failure = null;
  for (const base of list) {
    try {
      const response = await fetch(`${base}/api/admin/keys`, {
        method,
        headers: {
          Authorization: authorization(),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (base !== baseUrl()) els.server.value = base; // the host that actually answered
      return { base, response };
    } catch (error) {
      failure = error;
    }
  }
  throw failure || new Error("unreachable");
}

async function probe() {
  try {
    const { response } = await request("GET");
    if (response.ok) {
      state("server online", true);
      els.local?.classList.add("hidden");
    } else if (response.status === 401) state("password rejected");
    else state(`server error ${response.status}`);
  } catch {
    state("server unreachable");
    showLocal(baseUrl());
  }
}

/**
 * Any duration the panel is given. A bare number uses the unit dropdown; a
 * suffix wins over it ("90m"), units stack ("1d12h"), and never/0 is lifetime.
 */
function parseDuration(raw, fallbackUnit) {
  const text = String(raw || "").toLowerCase().replace(/,/g, ".").replace(/\s+/g, "");
  if (!text || text === "0") return null;
  if (["never", "life", "lifetime", "forever", "perm", "perma"].includes(text)) return null;
  if (/^[0-9]*\.?[0-9]+$/.test(text)) {
    const amount = Number(text);
    return amount > 0 ? amount * (UNIT_MS[fallbackUnit] || UNIT_MS.d) : null;
  }
  let total = 0;
  let seen = "";
  let match;
  const units = /([0-9]*\.?[0-9]+)(mo|s|m|h|d|w|y)/g;
  while ((match = units.exec(text))) {
    total += Number(match[1]) * (UNIT_MS[match[2]] || UNIT_MS.d);
    seen += match[0];
  }
  if (!seen || seen !== text) {
    throw new Error("That isn't a duration. Try 30, 1.5, 90m, 2d, 1d12h or never.");
  }
  return total > 0 ? total : null;
}

/** Milliseconds from now until the key dies, or null for a lifetime key. */
function expiry() {
  if (els.never.checked) return null;
  return parseDuration(els.amount.value, els.unit.value);
}

/** The "expires …" line, so a typo is visible before anything is minted. */
function paintDuration() {
  if (!els || !els.durHint) return;
  try {
    const ms = expiry();
    els.durHint.className = "dur-hint";
    els.durHint.textContent = els.never.checked
      ? "never expires (Never expires is ticked)"
      : ms
      ? `expires ${new Date(Date.now() + ms).toLocaleString()}`
      : "never expires";
  } catch (error) {
    els.durHint.className = "dur-hint bad";
    els.durHint.textContent = error.message;
  }
}

/** Premium by email on its own, without minting a key. */
async function grantOnly() {
  const email = els.grant.value.trim().toLowerCase();
  if (!email) {
    say("Type the account email first.");
    return;
  }
  const profile = (opts.profiles ? opts.profiles() : []).find(
    (row) => String(row.email || "").toLowerCase() === email
  );
  if (!profile) {
    say(`No account matches ${email}.`);
    return;
  }
  if (els.grantBtn) els.grantBtn.disabled = true;
  try {
    await setPremium(profile.id, true, "granted from the admin panel");
    if (opts.reload) await opts.reload();
    els.grant.value = "";
    say(`Premium granted to ${profile.email}.`, true);
  } catch {
    say(`Granting premium to ${email} failed.`);
  } finally {
    if (els.grantBtn) els.grantBtn.disabled = false;
  }
}

function paintKeys(keys) {
  latest = keys;
  els.out.textContent = keys.join("\n");
  els.out.classList.toggle("hidden", !keys.length);
  els.copy.disabled = !keys.length;
}

async function copyAll() {
  if (!latest.length) return;
  try {
    await navigator.clipboard.writeText(latest.join("\n"));
    say(`Copied ${latest.length} key(s).`, true);
  } catch {
    say("Copy failed — select the text above instead.");
  }
}

async function generate() {
  const count = Math.min(Math.max(Number(els.count.value) || 1, 1), 50);
  const uses = Math.min(Math.max(Number(els.uses.value) || 1, 1), 20);
  const note = els.note.value.trim().slice(0, 40);
  const email = els.grant.value.trim().toLowerCase();

  let until;
  try {
    until = expiry();
  } catch (error) {
    say(error.message);
    paintDuration();
    return;
  }

  say("");
  paintKeys([]);
  els.generate.disabled = true;
  els.generate.textContent = "Generating…";
  remember();

  try {
    const { response } = await request("POST", {
      count,
      uses,
      note,
      expiresAtMs: until,
    });

    if (response.status === 401) {
      state("password rejected");
      say("That admin password was rejected. It's ADMIN_PASSWORD in site/server/config.json.");
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || !Array.isArray(data.keys) || !data.keys.length) {
      state(`server error ${response.status}`);
      say(data.error ? `Server said: ${data.error}` : "The server didn't return any keys.");
      return;
    }

    state("server online", true);
    els.local?.classList.add("hidden");
    paintKeys(data.keys);

    const life = until ? `expires ${new Date(until).toLocaleString()}` : "never expires";
    let message = `Generated ${data.keys.length} key(s), ${life}.`;

    if (email) {
      const profile = (opts.profiles ? opts.profiles() : []).find(
        (row) => String(row.email || "").toLowerCase() === email
      );
      if (!profile) {
        message += ` No account matches ${email}, so premium was not granted.`;
      } else {
        try {
          await setPremium(profile.id, true, note || "key issued");
          if (opts.reload) await opts.reload();
          els.grant.value = "";
          message += ` Premium granted to ${profile.email}.`;
        } catch {
          message += ` The key works, but granting premium to ${email} failed.`;
        }
      }
    }

    say(message, true);
  } catch {
    state("server unreachable");
    const base = baseUrl() || "http://localhost:3000";
    showLocal(base);
    if (await listening(base)) {
      say(
        `The key server is running on ${base}, but this page isn't allowed to call it. ` +
          "Open the local generator (button above) — same admin login, no browser restrictions."
      );
    } else {
      say(
        `No answer from ${base}. Start the server with: node site/server/server.mjs — ` +
          "if it's already running, this browser blocked the call to your PC, so use the local generator button."
      );
    }
  } finally {
    if (els) {
      els.generate.disabled = false;
      els.generate.textContent = "Generate";
    }
  }
}

export function mountKeyGenerator(options = {}) {
  if (els) {
    opts = { ...opts, ...options };
    return;
  }
  opts = options;

  els = {
    server: document.querySelector("#keyServer"),
    user: document.querySelector("#keyUser"),
    pass: document.querySelector("#keyPass"),
    amount: document.querySelector("#keyAmount"),
    unit: document.querySelector("#keyUnit"),
    never: document.querySelector("#keyNever"),
    durHint: document.querySelector("#keyDurHint"),
    count: document.querySelector("#keyCount"),
    uses: document.querySelector("#keyUses"),
    note: document.querySelector("#keyNote"),
    grant: document.querySelector("#keyGrant"),
    grantBtn: document.querySelector("#keyGrantBtn"),
    generate: document.querySelector("#keyGenerate"),
    copy: document.querySelector("#keyCopyAll"),
    msg: document.querySelector("#keyMsg"),
    out: document.querySelector("#keyOut"),
    state: document.querySelector("#genState"),
    emails: document.querySelector("#accountEmails"),
    local: document.querySelector("#keyLocal"),
  };

  if (!els.generate) return;

  const kept = saved();
  if (kept.base) els.server.value = kept.base;
  if (kept.user) els.user.value = kept.user;
  if (kept.pass) els.pass.value = kept.pass;

  // The amount stays typeable even with "Never expires" ticked: the tick only
  // overrides the value, so the box can never end up dead with no explanation.
  els.never.addEventListener("change", paintDuration);
  els.amount.addEventListener("input", paintDuration);
  els.unit.addEventListener("change", paintDuration);
  els.grantBtn?.addEventListener("click", grantOnly);
  paintDuration();
  els.generate.addEventListener("click", generate);
  els.copy.addEventListener("click", copyAll);
  els.pass.addEventListener("keydown", (event) => {
    if (event.key === "Enter") generate();
  });

  if (kept.pass) probe();
}

/** Keeps the "Give premium to" autocomplete in step with the account list. */
export function setKeyGenAccounts(rows) {
  if (!els || !els.emails) return;
  els.emails.replaceChildren();
  (rows || []).forEach((row) => {
    if (!row.email) return;
    const option = document.createElement("option");
    option.value = row.email;
    els.emails.append(option);
  });
}
