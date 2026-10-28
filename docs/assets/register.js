/* =========================================================================
   asus.wtf — create account page
   ========================================================================= */

import { configured, onAuth, signInGoogle, signUpEmail } from "./auth-client.js";
import { lockForms, mountConfigNotice, setBusy, setMessage, setupEyes } from "./auth-ui.js";

const core = window.AsusAuthCore;
const $ = (selector) => document.querySelector(selector);

const params = new URLSearchParams(location.search);
const next = core.safeNext(params.get("next"), "dashboard/");

const form = $("#registerForm");
const nameInput = $("#name");
const emailInput = $("#email");
const passwordInput = $("#password");
const confirmInput = $("#confirm");
const meter = $("#pwMeter");
const hint = $("#pwHint");
const message = $("#msg");
const submit = $("#submit");
const google = $("#google");

const signInLink = document.querySelector(".auth-foot a");
if (signInLink) signInLink.href = core.withNext("login.html", params.get("next") || "");

const HINTS = {
  empty: "Use 8 or more characters — a passphrase works well.",
  weak: "Weak — add length, then mix in a number or symbol.",
  fair: "Fair — a few more characters makes it much harder to guess.",
  good: "Good — long enough to be annoying to crack.",
  strong: "Strong — long and varied. You're done.",
};

setupEyes();

if (!configured) {
  mountConfigNotice($("#configNotice"));
  lockForms();
}

onAuth((user) => {
  if (user) location.replace(next);
}).catch(() => {
  /* a failed SDK boot reports itself on submit */
});

const paintStrength = () => {
  const score = core.passwordScore(passwordInput.value);
  meter.dataset.score = String(score);
  hint.textContent = HINTS[core.scoreLabel(score)] || HINTS.empty;
  hint.dataset.score = String(score);
};

passwordInput.addEventListener("input", paintStrength);
paintStrength();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;

  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const confirm = confirmInput.value;

  const emailIssue = core.emailProblem(email);
  const passwordIssue = core.passwordProblem(password);
  const confirmIssue = password && password !== confirm ? "The two passwords don't match." : null;
  const problem = emailIssue || passwordIssue || confirmIssue;

  emailInput.classList.toggle("is-bad", Boolean(emailIssue));
  passwordInput.classList.toggle("is-bad", Boolean(passwordIssue));
  confirmInput.classList.toggle("is-bad", Boolean(confirmIssue));

  if (problem) {
    setMessage(message, problem);
    if (emailIssue) emailInput.focus();
    else if (passwordIssue) passwordInput.focus();
    else confirmInput.focus();
    return;
  }

  setMessage(message, "");
  setBusy(submit, true, "Creating account…");
  try {
    await signUpEmail({ name, email, password });
    location.replace(next);
  } catch (error) {
    setMessage(message, core.friendlyError(error));
    setBusy(submit, false);
  }
});

google.addEventListener("click", async () => {
  if (!configured) return;
  setMessage(message, "");
  setBusy(google, true, "Opening Google…");
  try {
    await signInGoogle();
    location.replace(next);
  } catch (error) {
    setMessage(message, core.friendlyError(error));
    setBusy(google, false);
  }
});
