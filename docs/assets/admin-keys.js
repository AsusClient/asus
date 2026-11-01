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

function expiry() {
  if (els.never.checked) return null;
  const amount = Number(els.amount.value);
  if (!amount || amount <= 0) return null;
  return Date.now() + amount * (UNIT_MS[els.unit.value] || UNIT_MS.d);
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
      expiresAtMs: expiry(),
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

    const until = expiry();
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
    count: document.querySelector("#keyCount"),
    uses: document.querySelector("#keyUses"),
    note: document.querySelector("#keyNote"),
    grant: document.querySelector("#keyGrant"),
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

  els.never.addEventListener("change", () => {
    els.amount.disabled = els.never.checked;
  });
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
