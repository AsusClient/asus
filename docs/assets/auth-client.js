/* =========================================================================
   asus.wtf — Firebase Auth client

   ES module. The SDK is imported lazily, so a site with an empty
   firebase-config.js makes no network calls to gstatic at all.

   Exports: configured, onAuth, signUpEmail, signInEmail, signInGoogle,
            signOutNow, sendReset, resendVerification
   ========================================================================= */

const SDK = "https://www.gstatic.com/firebasejs/13.1.0";

const core = window.AsusAuthCore;
const config = window.ASUS_FIREBASE_CONFIG || {};

export const configured = Boolean(core && core.isConfigured(config));

let session = null;

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalize(error) {
  if (error && typeof error.code === "string" && error.code) return error;
  return codedError("app/unknown", (error && error.message) || "Something went wrong.");
}

async function init() {
  if (!configured) throw codedError("app/not-configured");
  if (!session) {
    session = (async () => {
      const [appModule, authModule] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
      ]);
      const app = appModule.initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket || undefined,
        messagingSenderId: config.messagingSenderId || undefined,
        appId: config.appId,
      });
      const auth = authModule.getAuth(app);
      try {
        await authModule.setPersistence(auth, authModule.browserLocalPersistence);
      } catch {
        /* persistence is best-effort; the session still works for this tab */
      }
      return { auth, m: authModule };
    })().catch((error) => {
      session = null;
      throw error;
    });
  }
  return session;
}

/**
 * Subscribe to the signed-in user. Calls back once with null immediately when
 * accounts are not configured, so callers never wait on a promise that can't
 * resolve.
 */
export async function onAuth(callback) {
  if (!configured) {
    callback(null);
    return () => {};
  }
  const { auth, m } = await init();
  return m.onAuthStateChanged(auth, (user) => callback(user || null));
}

export async function signUpEmail({ name, email, password }) {
  try {
    const { auth, m } = await init();
    const credential = await m.createUserWithEmailAndPassword(auth, email, password);
    const cleanName = String(name || "").trim();
    if (cleanName) {
      try {
        await m.updateProfile(credential.user, { displayName: cleanName });
      } catch {
        /* a missing display name falls back to the email local part */
      }
    }
    try {
      await m.sendEmailVerification(credential.user);
    } catch {
      /* verification mail is a courtesy; the dashboard can resend it */
    }
    return credential.user;
  } catch (error) {
    throw normalize(error);
  }
}

export async function signInEmail({ email, password }) {
  try {
    const { auth, m } = await init();
    const credential = await m.signInWithEmailAndPassword(auth, email, password);
    return credential.user;
  } catch (error) {
    throw normalize(error);
  }
}

export async function signInGoogle() {
  try {
    const { auth, m } = await init();
    const provider = new m.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const credential = await m.signInWithPopup(auth, provider);
    return credential.user;
  } catch (error) {
    throw normalize(error);
  }
}

export async function signOutNow() {
  try {
    const { auth, m } = await init();
    await m.signOut(auth);
  } catch (error) {
    throw normalize(error);
  }
}

/** Sends a reset link. Resolves even for unknown addresses (no account probing). */
export async function sendReset(email) {
  try {
    const { auth, m } = await init();
    await m.sendPasswordResetEmail(auth, email);
  } catch (error) {
    const code = error && error.code;
    if (code === "auth/user-not-found") return;
    throw normalize(error);
  }
}

export async function resendVerification() {
  try {
    const { auth, m } = await init();
    if (!auth.currentUser) throw codedError("auth/user-not-found");
    await m.sendEmailVerification(auth.currentUser);
  } catch (error) {
    throw normalize(error);
  }
}

/** Force a refresh of emailVerified after the visitor clicks the mail link. */
export async function reloadUser() {
  try {
    const { auth, m } = await init();
    if (auth.currentUser) await auth.currentUser.reload();
    return auth.currentUser || null;
  } catch {
    return null;
  }
}
