/* =========================================================================
   asus.wtf — email confirmation landing

   Supabase sends the confirmation link through here (emailRedirectTo). As
   soon as the session is live the visitor is forwarded to the dashboard.
   ========================================================================= */

import { configured, onAuth } from "./auth-client.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  icon: $("#statusIcon"),
  kicker: $("#statusKicker"),
  title: $("#statusTitle"),
  text: $("#statusText"),
  progress: $("#statusProgress"),
  actions: $("#statusActions"),
};

const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
const query = new URLSearchParams(location.search);
const linkError =
  hash.get("error_description") ||
  hash.get("error") ||
  query.get("error_description") ||
  query.get("error");

let settled = false;

function addAction(label, href, primary) {
  const link = document.createElement("a");
  link.className = primary ? "btn btn-primary" : "btn btn-ghost";
  link.href = href;
  link.textContent = label;
  els.actions.append(link);
  els.actions.hidden = false;
}

function success() {
  if (settled) return;
  settled = true;

  els.icon.className = "auth-status-icon is-ok";
  els.icon.replaceChildren();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m5 12.5 4.2 4.2L19 7");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  els.icon.append(svg);

  els.kicker.textContent = "Email confirmed";
  els.title.textContent = "You're in";
  els.text.textContent = "Opening your dashboard…";

  window.setTimeout(() => location.replace("dashboard/"), 1100);
}

function fail(title, text, options) {
  if (settled) return;
  settled = true;

  els.icon.className = "auth-status-icon is-bad";
  els.icon.replaceChildren();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 8v5m0 3.2v.2M12 3.5 21 20H3z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  els.icon.append(svg);

  els.kicker.textContent = "Link problem";
  els.title.textContent = title;
  els.text.textContent = text;
  els.progress.hidden = true;

  (options || []).forEach(([label, href, primary]) => addAction(label, href, primary));
}

if (!configured) {
  fail(
    "Accounts aren't connected",
    "The site owner still needs to finish the Supabase setup.",
    [["Back to site", "index.html", true]]
  );
} else if (linkError) {
  fail(
    "That link has expired",
    "Confirmation links only work once and time out. Sign in — if the account still needs confirming, the dashboard can resend the mail.",
    [
      ["Go to sign in", "login.html", true],
      ["Create an account", "register.html", false],
    ]
  );
} else {
  onAuth((user) => {
    if (user) {
      success();
      return;
    }
    window.setTimeout(() => {
      if (settled) return;
      fail(
        "This link has already been used",
        "Open the dashboard if you're signed in, or sign in with your email and password.",
        [
          ["Go to dashboard", "dashboard/", true],
          ["Sign in", "login.html", false],
        ]
      );
    }, 1800);
  }).catch(() => {
    fail(
      "Couldn't check the link",
      "The account service didn't answer. Try opening the dashboard or signing in again.",
      [
        ["Sign in", "login.html", true],
        ["Go to dashboard", "dashboard/", false],
      ]
    );
  });
}
