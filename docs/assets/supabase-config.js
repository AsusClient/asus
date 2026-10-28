/* =========================================================================
   asus.wtf — Supabase project config

   Both values are PUBLIC. The anon key is meant to ship in client code; it
   grants only what your Row Level Security policies allow, and Auth endpoints
   are gated by the provider settings in the dashboard. There is no secret
   key anywhere in this folder — never add the service_role key here.

   `url` is the project's API URL (https://<ref>.supabase.co), NOT the
   supabase.com/dashboard address. Both come from Project Settings → API.
   Setup steps: docs/AUTH-SETUP.md.
   ========================================================================= */

window.ASUS_SUPABASE_CONFIG = {
  url: "https://edgmirpscrwqniddciwh.supabase.co",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkZ21pcnBzY3J3cW5pZGRjaXdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMjQwNTYsImV4cCI6MjEwODgwMDA1Nn0.CWkV7Eqd9fsPxfbKH_5unu4aZXBlG3rulANxxzCnxZ4",
};
