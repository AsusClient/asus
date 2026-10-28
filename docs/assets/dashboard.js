/* =========================================================================
   asus.wtf — dashboard (sign-in required)
   ========================================================================= */

import {
  configured,
  onAuth,
  reloadUser,
  resendVerification,
  sendReset,
  signOutNow,
} from "./auth-client.js";
import { setBusy, setMessage } from "./auth-ui.js";

const core = window.AsusAuthCore;
const $ = (selector) => document.querySelector(selector);

if (!configured) {
  location.replace("../login.html");
}

const els = {
  dashName: $("#dashName"),
  navName: $("#navName"),
  navAvatar: $("#navAvatar"),
  accountAvatar: $("#accountAvatar"),
  accountName: $("#accountName"),
  accountEmail: $("#accountEmail"),
  accountProvider: $("#accountProvider"),
  accountVerified: $("#accountVerified"),
  accountSince: $("#accountSince"),
  accountMsg: $("#accountMsg"),
  resend: $("#resend"),
  changePassword: $("#changePassword"),
  signOut: $("#signOut"),
  signOutMain: $("#signOutMain"),
};

let currentUser = null;

function paintAvatar(element, user) {
  if (!element) return;
  element.replaceChildren();

  if (user && user.photoURL) {
    const img = document.createElement("img");
    img.src = user.photoURL;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      element.replaceChildren(document.createTextNode(core.initials(user)));
    });
    element.append(img);
    return;
  }
  element.textContent = core.initials(user);
}

function paintVerification(user) {
  if (!els.accountVerified) return;
  els.accountVerified.replaceChildren();

  const pill = document.createElement("span");
  pill.className = "pill";
  if (user.emailVerified) {
    pill.classList.add("pill-ok");
    pill.textContent = "Verified";
  } else {
    pill.classList.add("pill-warn");
    pill.textContent = "Not verified";
  }
  els.accountVerified.append(pill);
  if (els.resend) els.resend.hidden = Boolean(user.emailVerified);
}

function render(user) {
  currentUser = user;
  const name = core.displayName(user);

  if (els.dashName) els.dashName.textContent = name;
  if (els.navName) els.navName.textContent = name;
  paintAvatar(els.navAvatar, user);

  if (els.accountName) els.accountName.textContent = name;
  if (els.accountEmail) els.accountEmail.textContent = user.email || "—";
  if (els.accountProvider) els.accountProvider.textContent = core.providerName(user);
  if (els.accountSince) els.accountSince.textContent = core.memberSince(user);
  paintVerification(user);

  const emailAccount = core.providerName(user) === "Email & password";
  if (els.changePassword) els.changePassword.hidden = !emailAccount;

  document.title = `${name} — asus.wtf dashboard`;
}

function renderAvatarOnly(user) {
  paintAvatar(els.navAvatar, user);
  paintAvatar(els.accountAvatar, user);
}

const signOut = async (button) => {
  setBusy(button, true, "Signing out…");
  try {
    await signOutNow();
  } catch {
    /* navigate anyway — a dead session shouldn't trap the visitor here */
  }
  location.replace("../index.html");
};

[els.signOut, els.signOutMain].forEach((button) => {
  if (button) button.addEventListener("click", () => signOut(button));
});

if (els.resend) {
  els.resend.addEventListener("click", async () => {
    if (!currentUser) return;
    setMessage(els.accountMsg, "");
    setBusy(els.resend, true, "Sending…");
    try {
      await resendVerification();
      setMessage(els.accountMsg, `Verification email sent to ${currentUser.email}.`, true);
    } catch (error) {
      setMessage(els.accountMsg, core.friendlyError(error));
    } finally {
      setBusy(els.resend, false);
    }
  });
}

if (els.changePassword) {
  els.changePassword.addEventListener("click", async () => {
    if (!currentUser) return;
    setMessage(els.accountMsg, "");
    setBusy(els.changePassword, true, "Sending…");
    try {
      await sendReset(currentUser.email);
      setMessage(els.accountMsg, `Reset link sent to ${currentUser.email}.`, true);
    } catch (error) {
      setMessage(els.accountMsg, core.friendlyError(error));
    } finally {
      setBusy(els.changePassword, false);
    }
  });
}

onAuth((user) => {
  if (!user) {
    location.replace("../login.html?next=" + encodeURIComponent("dashboard/"));
    return;
  }
  render(user);
  renderAvatarOnly(user);

  // Pick up "I clicked the verification mail" without a full page reload.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !currentUser) return;
    const fresh = await reloadUser();
    if (fresh) {
      render(fresh);
      renderAvatarOnly(fresh);
    }
  });
}).catch(() => {
  location.replace("../login.html");
});
