# Account system setup (Supabase)

GitHub Pages is static, so there is no server of ours to check passwords on.
Accounts run on **Supabase Auth**: email + password and Google sign-in, with
the session kept in the browser. Passwords are stored and verified by Supabase;
this repository only carries the public project URL and anon key.

Everything is already wired. The only missing piece is your Supabase project.

---

## 1. Create the project

1. Open <https://supabase.com/dashboard> and sign in.
2. **New project** → name it `asus-wtf` → pick the region closest to you.
3. Let it finish provisioning (a minute or two). The database password it asks
   for is not used by the site — store it somewhere safe anyway.

## 2. Email + password

**Authentication → Providers → Email** is on by default.

- Keep **Confirm email** on for real use: new accounts get a confirmation mail
  and cannot sign in until they click it.
- Turn it off while testing if you want sign-up to land straight on the
  dashboard.
- Emails come from Supabase's default templates; edit them under
  **Authentication → Email Templates** (sender, subject, wording).

## 3. Google sign-in

Supabase has no shared Google credentials, so this needs a Google Cloud OAuth
client once (this is true for every non-Firebase provider):

1. <https://console.cloud.google.com> → **APIs & Services → OAuth consent
   screen** → External → app name `asus.wtf`, support email, save.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorized JavaScript origins: `https://asusclient.github.io`
4. Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
5. Copy the **Client ID** and **Client secret**.
6. Supabase → **Authentication → Providers → Google** → enable, paste both,
   **Save**.

Without this step the Google button reports that the provider isn't enabled;
email/password still works.

## 4. Copy the two public values

**Project Settings → API**:

- **Project URL** — `https://<ref>.supabase.co`
- **anon public** key

Paste them into [`assets/supabase-config.js`](assets/supabase-config.js). You can
do it right in the browser with
[this edit link](https://github.com/AsusClient/asus/edit/main/docs/assets/supabase-config.js),
then commit to `main` and Pages redeploys by itself:

```js
window.ASUS_SUPABASE_CONFIG = {
  url: "https://abcdefgh.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIs…",
};
```

Both values are public by design — the anon key is meant to ship in client code
and is limited by Row Level Security. **Never put the `service_role` key in this
folder**; it bypasses RLS.

## 5. Allow the site's URLs

**Authentication → URL Configuration**:

- **Site URL**: `https://asusclient.github.io/asus/`
- **Redirect URLs**, add both:
  - `https://asusclient.github.io/asus/**`
  - `http://localhost:8123/**` (only needed for local testing)

Confirmation links, password-reset links and the return from Google all check
this list. Without it you get "requested path is invalid" after clicking a mail
link.

## 6. Try it

1. Open <https://asusclient.github.io/asus/register.html>.
2. Register with an email (confirm it if Confirm email is on), or use Google.
3. You land on `/asus/dashboard/`; the landing-page nav chip now shows your name.
4. Use **Forgot password?** on the login page — the link opens `/asus/reset.html`.
5. Open `/asus/dashboard/` while signed out; it redirects to sign-in.

## Local testing

ES modules and the Supabase SDK need a real origin, not `file://`:

```bash
python -m http.server 8123 --directory docs
# open http://localhost:8123/register.html
```

## What the account does and does not do

- It gates the **dashboard** — the page with the download and install steps.
- It does **not** gate the jar file. GitHub Pages serves static files to anyone
  with the URL, so `assets/asus-wtf-1.0.10.jar` is still a direct download. If
  you want the file itself protected, it has to move behind a small server or a
  signed-URL service.
- It is **not** a client licence. The mod still asks for an `ASUS-…` key; site
  accounts and keys are separate systems.

## Housekeeping

- Manage or delete users under **Authentication → Users**.
- The free plan covers normal use for a site this size; check the dashboard's
  usage page for current limits.
- If you later add a database table (downloads, keys, profiles), enable RLS and
  write policies before exposing it — the anon key is public.

## Files involved

| File | Purpose |
| --- | --- |
| `assets/supabase-config.js` | Project URL + anon key (the only file you edit) |
| `assets/auth-core.js` | Validation, error messages, formatting helpers |
| `assets/auth-client.js` | Supabase SDK wrapper (sign up/in, Google, reset, sign out) |
| `assets/auth-ui.js` | Shared form helpers and the "not connected" notice |
| `assets/auth.js` | Landing-page account chip |
| `assets/login.js`, `assets/register.js` | The two forms |
| `assets/reset.js` | Password reset page |
| `assets/dashboard.js` | Session guard and dashboard rendering |
