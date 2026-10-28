/* =========================================================================
   asus.wtf — Supabase project config

   Both values are PUBLIC. The anon key is meant to ship in client code; it
   grants only what your Row Level Security policies allow, and Auth endpoints
   are gated by the provider settings in the dashboard. There is no secret
   key anywhere in this folder — never add the service_role key here.

   Where to find them: Supabase dashboard → Project Settings → API.
   Setup steps: docs/AUTH-SETUP.md. Until both values are filled in, the
   account pages render a "not connected" notice instead of a broken form.
   ========================================================================= */

window.ASUS_SUPABASE_CONFIG = {
  url: "",
  anonKey: "",
};
