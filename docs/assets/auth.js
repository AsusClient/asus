/* =========================================================================
   asus.wtf — account chip on the landing page

   Loads after app.js. Adds "Sign in" to the nav, or the signed-in visitor's
   chip linking to the dashboard. With an empty supabase-config.js it simply
   stays on the signed-out state — no errors, no dead script tags.
   ========================================================================= */

import { onAuth } from "./auth-client.js";

// If Supabase falls back to the site root (redirect URL not allow-listed yet),
// the token fragment lands here. Forward it to the page that can finish it.
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
if (fragment.get("access_token") || fragment.get("error_description")) {
  const type = fragment.get("type");
  if (type === "recovery") location.replace(`reset.html${location.hash}`);
  else if (type) location.replace(`confirm.html${location.hash}`);
}

const actions = document.querySelector(".nav-actions");
if (actions) {
  const core = window.AsusAuthCore;
  const navLinks = document.querySelector("#navLinks");

  const signIn = document.createElement("a");
  signIn.className = "btn btn-ghost";
  signIn.href = "login.html";
  signIn.textContent = "Sign in";

  actions.insertBefore(signIn, actions.querySelector(".btn-primary"));

  // The ghost buttons are hidden on phones; the account entry rides in the menu instead.
  let mobileAccount = null;
  if (navLinks && navLinks.lastElementChild) {
    mobileAccount = document.createElement("a");
    mobileAccount.className = "nav-account-link";
    mobileAccount.href = "login.html";
    mobileAccount.textContent = "Sign in";
    navLinks.insertBefore(mobileAccount, navLinks.lastElementChild);
  }

  const chipFor = (user) => {
    const chip = document.createElement("a");
    chip.className = "auth-chip";
    chip.href = "dashboard/";
    chip.title = "Open your dashboard";

    const photo = user && user.photoURL;
    if (photo) {
      const img = document.createElement("img");
      img.src = photo;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        img.replaceWith(initialsNode(user));
      });
      chip.append(img);
    } else {
      chip.append(initialsNode(user));
    }

    const name = document.createElement("span");
    name.className = "auth-name";
    name.textContent = core.displayName(user);
    chip.append(name);

    const open = document.createElement("span");
    open.className = "auth-open";
    open.textContent = "Dashboard";
    chip.append(open);

    return chip;
  };

  const initialsNode = (user) => {
    const span = document.createElement("span");
    span.className = "auth-initials";
    span.textContent = core.initials(user);
    return span;
  };

  onAuth((user) => {
    if (!user) {
      signIn.hidden = false;
      if (mobileAccount) {
        mobileAccount.href = "login.html";
        mobileAccount.textContent = "Sign in";
      }
      const existing = actions.querySelector(".auth-chip");
      if (existing) existing.remove();
      return;
    }
    signIn.hidden = true;
    if (mobileAccount) {
      mobileAccount.href = "dashboard/";
      mobileAccount.textContent = "Dashboard";
    }
    const existing = actions.querySelector(".auth-chip");
    if (existing) existing.remove();
    actions.insertBefore(chipFor(user), actions.querySelector(".btn-primary"));
  }).catch(() => {
    /* an offline SDK import leaves the static Sign in link in place */
  });
}
