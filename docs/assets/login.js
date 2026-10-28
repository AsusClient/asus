/* =========================================================================
   asus.wtf — sign in page
   ========================================================================= */

import { configured, onAuth, signInEmail, signInGoogle, sendReset } from "./auth-client.js";
import { lockForms, mountConfigNotice, setBusy, setMessage, setupEyes } from "./auth-ui.js";

const core = window.AsusAuthCore;
const $ = (selector) => document.querySelector(selector);

const params = new URLSearchParams(location.search);
const next = core.safeNext(params.get("next"), "dashboard/");

const form = $("#loginForm");
const emailInput = $("#email");
const passwordInput = $("#password");
const message = $("#msg");
const submit = $("#submit");
const google = $("#google");
const forgot = $("#forgot");

const createLink = document.querySelector(".auth-foot a");
if (createLink) createLink.href = core.withNext("register.html", params.get("next") || "");

setupEyes();

if (!configured) {
  mountConfigNotice($("#configNotice"));
  lockForms();
}

if (params.get("reset") === "1") {
  setMessage(message, "Password updated. Sign in with the new one.", true);
}

onAuth((user) => {
  if (user) location.replace(next);
}).catch(() => {
  /* the form still works; a failed SDK boot reports itself on submit */
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const problem = core.emailProblem(email) || core.passwordProblem(password);

  emailInput.classList.toggle("is-bad", Boolean(core.emailProblem(email)));
  passwordInput.classList.toggle("is-bad", Boolean(core.passwordProblem(password)));

  if (problem) {
    setMessage(message, problem);
    (core.emailProblem(email) ? emailInput : passwordInput).focus();
    return;
  }

  setMessage(message, "");
  setBusy(submit, true, "Signing in…");
  try {
    await signInEmail({ email, password });
    location.replace(next);
  } catch (error) {
    setMessage(message, core.friendlyError(error));
    setBusy(submit, false);
  }
});

google.addEventListener("click", async () => {
  if (!configured) return;
  setMessage(message, "");
  setBusy(google, true, "Redirecting to Google…");
  try {
    // Supabase sends the browser to Google and back; do not navigate here.
    await signInGoogle();
  } catch (error) {
    setMessage(message, core.friendlyError(error));
    setBusy(google, false);
  }
});

forgot.addEventListener("click", async () => {
  if (!configured) return;
  const email = emailInput.value.trim();
  const problem = core.emailProblem(email);
  if (problem) {
    emailInput.classList.add("is-bad");
    setMessage(message, "Type your email first, then press Forgot password.");
    emailInput.focus();
    return;
  }
  emailInput.classList.remove("is-bad");
  setBusy(forgot, true, "Sending…");
  try {
    await sendReset(email);
    setMessage(message, "If that address has an account, a reset link is on its way.", true);
  } catch (error) {
    setMessage(message, core.friendlyError(error));
  } finally {
    setBusy(forgot, false);
  }
});
