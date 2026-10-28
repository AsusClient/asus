/* =========================================================================
   asus.wtf — account helpers shared by login / register / dashboard.

   Classic script: defines window.AsusAuthCore (and module.exports under Node,
   which is how the checks in tools/ get at it). No dependencies.
   ========================================================================= */

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AsusAuthCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MIN_PASSWORD = 8;

  /** True once firebase-config.js holds real project values. */
  function isConfigured(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    return ["apiKey", "authDomain", "projectId", "appId"].every(function (key) {
      var value = cfg[key];
      return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        !/^paste/i.test(value.trim())
      );
    });
  }

  function emailProblem(email) {
    var value = String(email == null ? "" : email).trim();
    if (!value) return "Enter your email address.";
    if (!EMAIL_RE.test(value)) return "That email address doesn't look right.";
    return null;
  }

  function passwordProblem(password) {
    var value = String(password == null ? "" : password);
    if (!value) return "Enter a password.";
    if (value.length < MIN_PASSWORD) return "Use at least " + MIN_PASSWORD + " characters.";
    return null;
  }

  /** 0 (empty) to 4 (strong). Length leads, variety adds. */
  function passwordScore(password) {
    var value = String(password == null ? "" : password);
    if (!value) return 0;
    var score = 0;
    if (value.length >= MIN_PASSWORD) score += 1;
    if (value.length >= 12) score += 1;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;
    return Math.min(4, score);
  }

  function scoreLabel(score) {
    return ["empty", "weak", "fair", "good", "strong"][score] || "weak";
  }

  /** Firebase error codes -> a sentence a visitor can act on. */
  function friendlyError(error) {
    var code =
      (error && (error.code || error.message)) ||
      (typeof error === "string" ? error : "") ||
      "";

    if (/^auth\/(invalid-api-key|api-key-not-valid)/.test(code)) {
      return "That Firebase API key isn't valid — re-copy the web config from Project settings → Your apps.";
    }

    var raw =
      error && typeof error.message === "string" ? error.message.trim() : "";
    var fallback =
      !raw || /^Firebase:\s*Error/i.test(raw) || /^auth\//.test(raw)
        ? "Something went wrong. Try again."
        : raw;

    switch (code) {
      case "app/not-configured":
        return "Accounts aren't connected yet — the site owner needs to finish the Firebase setup.";
      case "auth/invalid-email":
        return "That email address isn't valid.";
      case "auth/missing-email":
        return "Enter your email address.";
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Email or password is incorrect.";
      case "auth/missing-password":
        return "Enter your password.";
      case "auth/user-disabled":
        return "That account has been disabled.";
      case "auth/email-already-in-use":
        return "An account already uses that email. Sign in instead.";
      case "auth/weak-password":
        return "That password is too weak — use at least " + MIN_PASSWORD + " characters.";
      case "auth/too-many-requests":
        return "Too many attempts. Wait a minute and try again.";
      case "auth/network-request-failed":
        return "Network error — check your connection and try again.";
      case "auth/popup-closed-by-user":
      case "auth/cancelled-popup-request":
        return "Google sign-in was cancelled.";
      case "auth/popup-blocked":
        return "Your browser blocked the Google popup. Allow popups for this site and try again.";
      case "auth/unauthorized-domain":
        return "This domain isn't authorised for sign-in yet. Add it under Firebase → Authentication → Settings → Authorized domains.";
      case "auth/operation-not-allowed":
        return "That sign-in method is switched off in the Firebase console.";
      case "auth/account-exists-with-different-credential":
        return "That email already has an account with another sign-in method. Use that one instead.";
      case "auth/requires-recent-login":
        return "For security, sign in again before doing that.";
      case "auth/internal-error":
        return "The account service hiccuped. Try again in a moment.";
      default:
        return fallback;
    }
  }

  function displayName(user) {
    if (!user) return "Guest";
    var named = typeof user.displayName === "string" ? user.displayName.trim() : "";
    if (named) return named;
    var email = typeof user.email === "string" ? user.email.trim() : "";
    if (email) return email.split("@")[0];
    return "Account";
  }

  function initials(user) {
    var name = displayName(user).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
    if (!name) return "A";
    var parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function providerName(user) {
    var entry =
      user && user.providerData && user.providerData.length ? user.providerData[0] : null;
    var id = entry && entry.providerId ? entry.providerId : "";
    if (id === "google.com") return "Google";
    if (id === "password") return "Email & password";
    return "Account";
  }

  function memberSince(user) {
    var raw = user && user.metadata && user.metadata.creationTime;
    if (!raw) return "—";
    var date = new Date(raw);
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  /**
   * Only same-site relative paths are allowed as a post-login destination,
   * so ?next= can't be pointed at another origin.
   */
  function safeNext(raw, fallback) {
    var value = String(raw == null ? "" : raw).trim();
    var home = fallback || "dashboard/";
    if (!value) return home;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return home;
    if (value.charAt(0) === "/" || value.charAt(0) === "\\") return home;
    if (value.indexOf("..") === 0) return home;
    return value;
  }

  /** Append ?next=<path> to a link, keeping an existing query string intact. */
  function withNext(href, next) {
    if (!next) return href;
    var hashAt = href.indexOf("#");
    var hash = hashAt >= 0 ? href.slice(hashAt) : "";
    var base = hashAt >= 0 ? href.slice(0, hashAt) : href;
    var join = base.indexOf("?") >= 0 ? "&" : "?";
    return base + join + "next=" + encodeURIComponent(next) + hash;
  }

  return {
    MIN_PASSWORD: MIN_PASSWORD,
    isConfigured: isConfigured,
    emailProblem: emailProblem,
    passwordProblem: passwordProblem,
    passwordScore: passwordScore,
    scoreLabel: scoreLabel,
    friendlyError: friendlyError,
    displayName: displayName,
    initials: initials,
    providerName: providerName,
    memberSince: memberSince,
    safeNext: safeNext,
    withNext: withNext,
  };
});
