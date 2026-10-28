# Account system setup

The site is hosted on GitHub Pages, so there is no server of ours to check
passwords on. Accounts run on **Firebase Authentication** (Google's identity
service): email + password and Google sign-in, with the session kept in the
browser. Passwords never touch this repository or any code of ours — Firebase
stores and verifies them.

Everything is already wired. All that is missing is the project's public web
keys, which only you can create.

---

## 1. Create the Firebase project

1. Open <https://console.firebase.google.com> and sign in with the Google
   account that should own the project.
2. **Add project** → name it (for example `asus-wtf`) → continue. Analytics is
   optional; the site does not use it.

## 2. Turn on the two sign-in methods

In the left sidebar: **Build → Authentication → Get started**.

- **Sign-in method → Email/Password** → Enable → Save.
  Leave *Email link (passwordless sign-in)* off.
- **Sign-in method → Google** → Enable → pick a support email → Save.

## 3. Copy the web config

1. Click the gear → **Project settings → General**.
2. Scroll to **Your apps** → click the **Web** icon `</>`.
3. Register the app (nickname `asus-wtf-web`; do **not** tick Firebase Hosting).
4. Copy the `firebaseConfig` object it shows.

Paste the values into [`assets/firebase-config.js`](assets/firebase-config.js) —
you can do it right in the browser with
[this edit link](https://github.com/AsusClient/asus/edit/main/docs/assets/firebase-config.js),
then commit to `main` and Pages redeploys by itself:

```js
window.ASUS_FIREBASE_CONFIG = {
  apiKey: "AIza…",
  authDomain: "asus-wtf.firebaseapp.com",
  projectId: "asus-wtf",
  storageBucket: "asus-wtf.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};
```

These six values are public by design — they identify the project, they do not
grant access to anything. Committing them is normal.

## 4. Allow the GitHub Pages domain

**Authentication → Settings → Authorized domains → Add domain**:

```
asusclient.github.io
```

`localhost` is already on the list, which is what makes local testing work.
Without this step every sign-in fails with `auth/unauthorized-domain`.

## 5. Point GitHub Pages at the folder

Repo → **Settings → Pages**:

- Source: **Deploy from a branch**
- Branch: `main`, folder: **`/docs`**

That is the settings page you linked (`github.com/AsusClient/asus/settings/pages`).
The site is then served at <https://asusclient.github.io/asus/>.

## 6. Try it

1. Open <https://asusclient.github.io/asus/register.html>.
2. Register with an email, or press **Continue with Google**.
3. You land on `/asus/dashboard/`; the nav chip on the landing page now says
   your name and links back to it.
4. **Sign out** returns you to the site. Opening `/asus/dashboard/` while
   signed out redirects to the sign-in page.

---

## Local testing

ES modules and the Firebase SDK need a real origin, not `file://`:

```bash
python -m http.server 8000 --directory docs
# then open http://localhost:8000/register.html
```

## What the account does and does not do

- It gates the **dashboard** — the page with the download and install steps.
- It does **not** gate the jar file. GitHub Pages serves static files to anyone
  with the URL, so `assets/asus-wtf-1.0.10.jar` is still a direct download. If
  you ever want the file itself protected, it has to move behind a small server
  or a signed URL service.
- It is **not** a client licence. The mod still asks for an `ASUS-…` key; site
  accounts and keys are separate systems.

## Housekeeping

- Verification and password-reset emails come from Firebase's default
  templates; edit them under **Authentication → Templates** (sender name,
  reply-to, wording).
- To remove an account, delete the user in **Authentication → Users**.
- Everything used here (email/password + Google, reasonable monthly active
  users) is inside Firebase's free tier; check the console for current limits.

## Files involved

| File | Purpose |
| --- | --- |
| `assets/firebase-config.js` | Your public project keys (the only file you edit) |
| `assets/auth-core.js` | Validation, error messages, formatting helpers |
| `assets/auth-client.js` | Firebase SDK wrapper (sign up/in, Google, reset, sign out) |
| `assets/auth-ui.js` | Shared form helpers and the "not connected" notice |
| `assets/auth.js` | Landing-page account chip |
| `assets/login.js`, `assets/register.js` | The two forms |
| `assets/dashboard.js` | Session guard and dashboard rendering |
