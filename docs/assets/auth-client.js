/* =========================================================================
   asus.wtf — Supabase Auth client

   ES module. The SDK is imported lazily, so a site with an empty
   supabase-config.js makes no network calls to the CDN at all.

   Exports: configured, onAuth, signUpEmail, signInEmail, signInGoogle,
            signOutNow, sendReset, resendVerification, reloadUser,
            updatePassword
   ========================================================================= */

const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";

const core = window.AsusAuthCore;
const config = window.ASUS_SUPABASE_CONFIG || {};

export const configured = Boolean(core && core.isConfigured(config));

let client = null;

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalize(error) {
  if (!error) return codedError("unknown", "Something went wrong.");
  const normalized = new Error(error.message || "Something went wrong.");
  normalized.code = error.code || "unknown";
  normalized.status = error.status;
  return normalized;
}

/** Absolute URL inside this deployment (works from /asus/ on GitHub Pages). */
function absolute(path) {
  return new URL(path, document.baseURI).href;
}

async function init() {
  if (!configured) throw codedError("app/not-configured");
  if (!client) {
    client = import(SDK)
      .then(({ createClient }) =>
        createClient(config.url.trim(), config.anonKey.trim(), {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        })
      )
      .catch((error) => {
        client = null;
        throw normalize(error);
      });
  }
  return client;
}

/**
 * Subscribe to the signed-in user. Calls back once immediately with null when
 * accounts are not configured, so callers never wait on a promise that can't
 * resolve.
 */
export async function onAuth(callback) {
  if (!configured) {
    callback(null);
    return () => {};
  }
  const supabase = await init();

  // Rely on INITIAL_SESSION rather than getSession(): when the page was reached
  // from a confirmation / recovery / OAuth redirect, the client is still
  // parsing tokens, and an early null would bounce the visitor to /login.
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback((session && session.user) || null);
  });
  return () => {
    if (data && data.subscription) data.subscription.unsubscribe();
  };
}

/**
 * Creates the account. Returns { user, needsConfirmation }; when the project
 * requires email confirmation there is no session yet.
 */
export async function signUpEmail({ name, email, password }) {
  try {
    const supabase = await init();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: name ? { full_name: name } : {},
        emailRedirectTo: absolute("dashboard/"),
      },
    });
    if (error) throw error;

    const user = (data && data.user) || null;
    const session = (data && data.session) || null;
    // Supabase hides whether the address already existed, so both a fresh
    // sign-up and a duplicate land here with no session.
    return { user, needsConfirmation: !session };
  } catch (error) {
    throw normalize(error);
  }
}

export async function signInEmail({ email, password }) {
  try {
    const supabase = await init();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return (data && data.user) || null;
  } catch (error) {
    throw normalize(error);
  }
}

/** Starts the hosted Google flow; the browser leaves this page. */
export async function signInGoogle() {
  try {
    const supabase = await init();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: absolute("dashboard/") },
    });
    if (error) throw error;
    return (data && data.url) || null;
  } catch (error) {
    throw normalize(error);
  }
}

export async function signOutNow() {
  try {
    const supabase = await init();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } catch (error) {
    throw normalize(error);
  }
}

/** Sends a reset link. Resolves even for unknown addresses (no account probing). */
export async function sendReset(email) {
  try {
    const supabase = await init();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: absolute("reset.html"),
    });
    if (error) throw error;
  } catch (error) {
    throw normalize(error);
  }
}

export async function resendVerification(email) {
  try {
    const supabase = await init();
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) throw error;
  } catch (error) {
    throw normalize(error);
  }
}

/** Fresh user record (used to notice a just-clicked confirmation link). */
export async function reloadUser() {
  try {
    const supabase = await init();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return (data && data.user) || null;
  } catch {
    return null;
  }
}

/** Sets a new password for the session created by a recovery link. */
export async function updatePassword(password) {
  try {
    const supabase = await init();
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    return (data && data.user) || null;
  } catch (error) {
    throw normalize(error);
  }
}
