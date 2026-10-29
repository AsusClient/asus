/* =========================================================================
   asus.wtf — admin: grant / remove premium for registered accounts

   The account signed in here must be listed in public.site_admins (see
   docs/sql/premium.sql). RLS decides the truth, so a non-admin sees an empty
   list even if they reach this page.
   ========================================================================= */

import { configured, onAuth, signInEmail, signOutNow } from "./auth-client.js";
import * as premium from "./premium-client.js";
import { mountKeyGenerator, setKeyGenAccounts } from "./admin-keys.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  gate: $("#gate"),
  denied: $("#denied"),
  panel: $("#panel"),
  loginForm: $("#loginForm"),
  email: $("#email"),
  password: $("#password"),
  loginBtn: $("#loginBtn"),
  gateMsg: $("#gateMsg"),
  deniedText: $("#deniedText"),
  deniedMsg: $("#deniedMsg"),
  whoami: $("#whoami"),
  signOut: $("#signOut"),
  search: $("#search"),
  refresh: $("#refresh"),
  tableBody: $("#tableBody"),
  msg: $("#msg"),
  statTotal: $("#statTotal"),
  statPremium: $("#statPremium"),
};

let rows = [];
let signedInId = null;

function show(which) {
  els.gate.classList.toggle("hidden", which !== "gate");
  els.denied.classList.toggle("hidden", which !== "denied");
  els.panel.classList.toggle("hidden", which !== "panel");
  els.signOut.classList.toggle("hidden", !signedInId);
}

function say(element, text, ok = false) {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("ok", Boolean(text) && ok);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function nameOf(row) {
  const name = (row.full_name || "").trim();
  return name || (row.email || "").split("@")[0] || "Account";
}

function isMissingTable(error) {
  const code = String((error && error.code) || "");
  const text = String((error && error.message) || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || text.includes("could not find the table") || text.includes("does not exist");
}

function renderStats() {
  const total = rows.length;
  const count = rows.filter((row) => row.is_premium).length;
  if (els.statTotal) els.statTotal.textContent = String(total);
  if (els.statPremium) els.statPremium.textContent = String(count);
}

function actionButton(row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `small ${row.is_premium ? "remove" : "grant"}`;
  button.textContent = row.is_premium ? "Remove premium" : "Give premium";
  button.addEventListener("click", () => toggle(row, button));
  return button;
}

function renderTable() {
  if (!els.tableBody) return;
  const query = (els.search && els.search.value ? els.search.value : "").trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (!query) return true;
    return `${row.email || ""} ${row.full_name || ""}`.toLowerCase().includes(query);
  });

  els.tableBody.replaceChildren();

  if (!visible.length) {
    els.tableBody.className = "empty";
    els.tableBody.textContent = rows.length ? "No account matches that search." : "No accounts yet.";
    return;
  }

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Account", "Joined", "Access", ""].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  });
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const row of visible) {
    const tr = document.createElement("tr");

    const who = document.createElement("td");
    who.className = "who";
    const strong = document.createElement("strong");
    strong.textContent = nameOf(row);
    const email = document.createElement("span");
    email.textContent = row.email || "—";
    who.append(strong, email);

    const joined = document.createElement("td");
    joined.className = "when";
    joined.textContent = formatDate(row.created_at);

    const access = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = `tag ${row.is_premium ? "premium" : "free"}`;
    tag.textContent = row.is_premium ? `Premium${row.premium_since ? ` · ${formatDate(row.premium_since)}` : ""}` : "Free";
    access.append(tag);

    const actions = document.createElement("td");
    actions.style.textAlign = "right";
    actions.append(actionButton(row));

    tr.append(who, joined, access, actions);
    body.append(tr);
  }

  table.append(head, body);
  els.tableBody.className = "table";
  els.tableBody.append(table);
}

async function toggle(row, button) {
  const next = !row.is_premium;
  button.disabled = true;
  button.textContent = next ? "Granting…" : "Removing…";
  say(els.msg, "");
  try {
    await premium.setPremium(row.id, next);
    row.is_premium = next;
    row.premium_since = next ? new Date().toISOString() : null;
    renderStats();
    renderTable();
    say(els.msg, next ? `Premium granted to ${row.email || "that account"}.` : `Premium removed from ${row.email || "that account"}.`, next);
  } catch (error) {
    say(els.msg, isMissingTable(error)
      ? "Run docs/sql/premium.sql in Supabase first — the profiles table doesn't exist yet."
      : "That change was refused. Make sure this account is in public.site_admins.");
    button.disabled = false;
    button.textContent = next ? "Give premium" : "Remove premium";
  }
}

async function load() {
  say(els.msg, "");
  els.tableBody.className = "empty";
  els.tableBody.textContent = "Loading…";
  try {
    rows = await premium.listProfiles();
    renderStats();
    renderTable();
    setKeyGenAccounts(rows);
  } catch (error) {
    els.tableBody.className = "empty";
    els.tableBody.textContent = isMissingTable(error)
      ? "The profiles table is missing. Run docs/sql/premium.sql in Supabase, then refresh."
      : "Could not load accounts.";
    say(els.msg, isMissingTable(error) ? "Run docs/sql/premium.sql in Supabase → SQL Editor." : "Check your connection and refresh.");
  }
}

async function enter(user) {
  signedInId = user.id;
  els.whoami.textContent = user.email || "Signed in";
  // Stay blank until RLS has answered: never flash the panel to a non-admin.
  els.gate.classList.add("hidden");
  els.denied.classList.add("hidden");
  els.panel.classList.add("hidden");
  els.signOut.classList.remove("hidden");
  const admin = await premium.isSiteAdmin();
  if (!admin) {
    show("denied");
    if (els.deniedText) {
      els.deniedText.textContent = `${user.email || "This account"} is signed in but is not listed in public.site_admins.`;
    }
    say(els.deniedMsg, "Add the email in Supabase → SQL Editor → public.site_admins, then reload.");
    return;
  }
  show("panel");
  // Minting needs the local key server; the rest of the page works without it.
  mountKeyGenerator({ profiles: () => rows, reload: load });
  await load();
}

if (!configured) {
  say(els.gateMsg, "Accounts aren't connected yet — fill in assets/supabase-config.js.");
  if (els.loginBtn) els.loginBtn.disabled = true;
} else {
  onAuth((user) => {
    if (!user) {
      signedInId = null;
      els.whoami.textContent = "Signed out";
      show("gate");
      return;
    }
    enter(user);
  }).catch(() => {
    say(els.gateMsg, "Could not reach the account service. Reload and try again.");
  });
}

if (els.loginForm) {
  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    say(els.gateMsg, "");
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "Signing in…";
    try {
      await signInEmail({ email: els.email.value.trim(), password: els.password.value });
      els.password.value = "";
    } catch (error) {
      const core = window.AsusAuthCore;
      say(els.gateMsg, core && core.friendlyError ? core.friendlyError(error) : "Sign-in failed.");
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "Sign in";
    }
  });
}

if (els.signOut) {
  els.signOut.addEventListener("click", async () => {
    try {
      await signOutNow();
    } catch {
      /* leave anyway */
    }
    signedInId = null;
    els.whoami.textContent = "Signed out";
    show("gate");
  });
}

if (els.search) els.search.addEventListener("input", renderTable);
if (els.refresh) {
  els.refresh.addEventListener("click", () => {
    if (signedInId) load();
  });
}
