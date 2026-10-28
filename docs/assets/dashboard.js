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
import * as license from "./license-client.js?v=20261028c";

// Namespace access, not named imports: a browser holding a cached older
// license-client.js would otherwise fail to link the whole module.
const { forget, formatKeyInput, recall, reasonText, remember, verifyKey } = license;
const verifyStoredHash =
  license.verifyStoredHash || (async (hash) => license.verifyHash(hash));

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
  licensePill: $("#licensePill"),
  fullBadge: $("#fullBadge"),
  fullStatus: $("#fullStatus"),
  fullDownload: $("#fullDownload"),
  keyForm: $("#keyForm"),
  licenseKey: $("#licenseKey"),
  redeem: $("#redeem"),
  keyMsg: $("#keyMsg"),
  forgetKey: $("#forgetKey"),
};

let currentUser = null;
let licenseFor = null;

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

function licenseExpiryText(expiresAt) {
  if (!expiresAt) return "lifetime";
  const date = new Date(expiresAt);
  if (isNaN(date.getTime())) return "lifetime";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function unlockFullBuild(result) {
  if (els.licensePill) {
    els.licensePill.textContent = "Full access";
    els.licensePill.classList.add("pill-ok");
  }
  if (els.fullBadge) {
    els.fullBadge.textContent = "Unlocked";
    els.fullBadge.className = "pill pill-ok";
  }
  if (els.fullStatus) {
    els.fullStatus.textContent = `Key active · ${
      result.expiresAt ? `expires ${licenseExpiryText(result.expiresAt)}` : "lifetime"
    }`;
  }
  if (els.fullDownload) els.fullDownload.hidden = false;
  if (els.keyForm) els.keyForm.hidden = true;
  if (els.forgetKey) els.forgetKey.hidden = false;
  if (els.keyMsg) setMessage(els.keyMsg, "");
}

function lockFullBuild(text) {
  if (els.licensePill) {
    els.licensePill.textContent = "Free access";
    els.licensePill.classList.remove("pill-ok");
  }
  if (els.fullBadge) {
    els.fullBadge.textContent = "Locked";
    els.fullBadge.className = "pill pill-locked";
  }
  if (els.fullStatus) {
    els.fullStatus.textContent = text || "Enter a working key to unlock the full build.";
  }
  if (els.fullDownload) els.fullDownload.hidden = true;
  if (els.keyForm) els.keyForm.hidden = false;
  if (els.forgetKey) els.forgetKey.hidden = true;
}

async function restoreLicense(user) {
  const saved = recall(user.id);
  if (!saved) {
    lockFullBuild();
    return;
  }
  // Always re-check against the freshest list: a key revoked since the last
  // visit must lock the build again, not stay unlocked from a cached file.
  const result = await verifyStoredHash(saved);
  if (result.ok) {
    unlockFullBuild(result);
    return;
  }
  forget(user.id);
  lockFullBuild(reasonText(result.reason));
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

  if (licenseFor !== user.id) {
    licenseFor = user.id;
    restoreLicense(user);
  }

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

if (els.licenseKey) {
  els.licenseKey.addEventListener("input", () => {
    const formatted = formatKeyInput(els.licenseKey.value);
    if (formatted !== els.licenseKey.value) els.licenseKey.value = formatted;
  });
}

if (els.keyForm) {
  els.keyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser) return;

    setMessage(els.keyMsg, "");
    setBusy(els.redeem, true, "Checking…");
    try {
      const result = await verifyKey(els.licenseKey.value);
      if (!result.ok) {
        setMessage(els.keyMsg, reasonText(result.reason));
        return;
      }
      remember(currentUser.id, result.hash);
      els.licenseKey.value = "";
      unlockFullBuild(result);
      setMessage(els.keyMsg, "Key accepted — the full build is unlocked.", true);
    } finally {
      setBusy(els.redeem, false);
    }
  });
}

if (els.forgetKey) {
  els.forgetKey.addEventListener("click", () => {
    if (currentUser) forget(currentUser.id);
    lockFullBuild();
    setMessage(els.keyMsg, "Key removed from this browser. The full build is locked again.");
  });
}

if (els.resend) {
  els.resend.addEventListener("click", async () => {
    if (!currentUser) return;
    setMessage(els.accountMsg, "");
    setBusy(els.resend, true, "Sending…");
    try {
      await resendVerification(currentUser.email);
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
}).catch(() => {
  location.replace("../login.html");
});

// Pick up "I clicked the confirmation mail" without a full page reload.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !currentUser) return;
  const fresh = await reloadUser();
  if (fresh) {
    render(fresh);
    renderAvatarOnly(fresh);
  }
});
