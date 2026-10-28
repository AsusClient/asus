/* =========================================================================
   asus.wtf — account helpers shared by login / register / reset / dashboard.

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

  /** True once supabase-config.js holds a project URL and public key. */
  function isConfigured(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    var url = typeof cfg.url === "string" ? cfg.url.trim() : "";
    var key = typeof cfg.anonKey === "string" ? cfg.anonKey.trim() : "";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
    if (key.length < 20) return false;
    return !/^paste/i.test(key);
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

  /** Supabase auth errors -> a sentence a visitor can act on. */
  function friendlyError(error) {
    var code = String((error && error.code) || "").toLowerCase();
    var message = String((error && error.message) || (typeof error === "string" ? error : "")).trim();
    var probe = (code + " " + message).toLowerCase();

    if (code === "app/not-configured") {
      return "Accounts aren't connected yet — the site owner needs to finish the Supabase setup.";
    }
    if (/invalid login credentials|invalid_credentials/.test(probe)) {
      return "Email or password is incorrect.";
    }
    if (/email not confirmed|email_not_confirmed/.test(probe)) {
      return "Confirm your email first — the link is in your inbox.";
    }
    if (/user already registered|already been registered|user_already_exists/.test(probe)) {
      return "An account already uses that email. Sign in instead.";
    }
    if (/password should be at least|weak_password/.test(probe)) {
      return "That password is too weak — use at least " + MIN_PASSWORD + " characters.";
    }
    if (/email rate limit|over_email_send_rate_limit|over_request_rate_limit|too many requests/.test(probe)) {
      return "Too many attempts. Wait a minute and try again.";
    }
    if (/provider is not enabled|provider_disabled|unsupported provider/.test(probe)) {
      return "Google sign-in isn't switched on for this project yet.";
    }
    if (/signups? not allowed|signup_disabled/.test(probe)) {
      return "New sign-ups are switched off for this project.";
    }
    if (/invalid email|email_address_invalid|validation_failed/.test(probe)) {
      return "That email address isn't valid.";
    }
    if (/auth session missing|session_not_found|refresh token not found/.test(probe)) {
      return "Your session expired. Sign in again.";
    }
    if (/otp.*expired|token.*expired|link is invalid or has expired/.test(probe)) {
      return "That link has expired. Request a new email.";
    }
    if (/new password should be different|same_password/.test(probe)) {
      return "Pick a password you haven't used here before.";
    }
    if (/invalid api key|invalid apikey|no api key/.test(probe)) {
      return "That Supabase key isn't valid — re-copy the anon public key from Project Settings → API.";
    }
    if (/failed to fetch|networkerror|network request failed/.test(probe)) {
      return "Network error — check your connection and try again.";
    }
    if (message && !/^(error|auth)/i.test(message) && message.length < 160) return message;
    return "Something went wrong. Try again.";
  }

  function displayName(user) {
    if (!user) return "Guest";
    var meta = user.user_metadata || {};
    var candidates = [meta.full_name, meta.name, meta.display_name, user.name, user.displayName];
    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof candidates[i] === "string" && candidates[i].trim()) return candidates[i].trim();
    }
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
    var provider =
      (user && user.app_metadata && user.app_metadata.provider) ||
      (user && user.provider) ||
      "";
    if (provider === "google") return "Google";
    if (provider === "email") return "Email & password";
    return "Account";
  }

  function memberSince(user) {
    var raw = user && (user.created_at || user.createdAt);
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
