/* =========================================================================
   asus.wtf — password reset (landed here from the Supabase recovery mail)
   ========================================================================= */

import { configured, onAuth, updatePassword } from "./auth-client.js";
import { lockForms, mountConfigNotice, setBusy, setMessage, setupEyes } from "./auth-ui.js";

const core = window.AsusAuthCore;
const $ = (selector) => document.querySelector(selector);

const form = $("#resetForm");
const passwordInput = $("#password");
const confirmInput = $("#confirm");
const meter = $("#pwMeter");
const hint = $("#pwHint");
const message = $("#msg");
const submit = $("#submit");
const linkNotice = $("#linkNotice");

const HINTS = {
  empty: "Use 8 or more characters — a passphrase works well.",
  weak: "Weak — add length, then mix in a number or symbol.",
  fair: "Fair — a few more characters makes it much harder to guess.",
  good: "Good — long enough to be annoying to crack.",
  strong: "Strong — long and varied. You're done.",
};

let hasSession = false;

setupEyes();

function paintStrength() {
  const score = core.passwordScore(passwordInput.value);
  meter.dataset.score = String(score);
  hint.textContent = HINTS[core.scoreLabel(score)] || HINTS.empty;
  hint.dataset.score = String(score);
}

passwordInput.addEventListener("input", paintStrength);
paintStrength();

function showLinkProblem(text) {
  linkNotice.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = "That link can't be used.";
  const body = document.createElement("p");
  body.textContent = text;
  linkNotice.append(strong, body);
  linkNotice.hidden = false;
  form.querySelectorAll("input, button").forEach((element) => {
    element.disabled = true;
  });
}

if (!configured) {
  mountConfigNotice($("#configNotice"));
  lockForms();
}

// Supabase puts failures in the URL fragment (e.g. an expired link).
const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
if (hash.get("error_description") || hash.get("error")) {
  showLinkProblem(
    core.friendlyError({
      code: hash.get("error_code") || "",
      message: hash.get("error_description") || "The reset link is invalid or has expired.",
    })
  );
}

onAuth((user) => {
  if (!user) return;
  hasSession = true;
  linkNotice.hidden = true;
}).catch(() => {
  /* the submit handler reports a failed SDK boot */
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;

  const password = passwordInput.value;
  const confirm = confirmInput.value;
  const passwordIssue = core.passwordProblem(password);
  const confirmIssue = password && password !== confirm ? "The two passwords don't match." : null;

  passwordInput.classList.toggle("is-bad", Boolean(passwordIssue));
  confirmInput.classList.toggle("is-bad", Boolean(confirmIssue));

  if (passwordIssue || confirmIssue) {
    setMessage(message, passwordIssue || confirmIssue);
    (passwordIssue ? passwordInput : confirmInput).focus();
    return;
  }

  if (!hasSession) {
    setMessage(message, "Open this page from the reset link in your inbox, or request a new one.");
    return;
  }

  setMessage(message, "");
  setBusy(submit, true, "Saving…");
  try {
    await updatePassword(password);
    setMessage(message, "Password updated. Taking you to the dashboard…", true);
    setTimeout(() => location.replace("dashboard/"), 1200);
  } catch (error) {
    setMessage(message, core.friendlyError(error));
    setBusy(submit, false);
  }
});
