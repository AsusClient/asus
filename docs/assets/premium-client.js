/* =========================================================================
   asus.wtf — premium access on top of the account system

   Backed by public.profiles (see docs/sql/premium.sql). Reading your own row
   is allowed by RLS; listing and granting is allowed only for accounts listed
   in public.site_admins.

   Every call fails soft: before the SQL has been run the table does not
   exist, and the dashboard must keep working as if nobody were premium.

   Exports: myProfile, isSiteAdmin, listProfiles, setPremium
   ========================================================================= */

import * as auth from "./auth-client.js";

const TABLE = "profiles";

async function db() {
  // Namespace access: an older cached auth-client.js without supabaseClient()
  // then degrades to "no premium" instead of breaking the whole page.
  if (typeof auth.supabaseClient !== "function") throw new Error("auth client outdated");
  return auth.supabaseClient();
}

/** The signed-in account's profile, or null when unavailable. */
export async function myProfile(userId) {
  if (!userId) return null;
  try {
    const supabase = await db();
    const { data, error } = await supabase
      .from(TABLE)
      .select("id,email,is_premium,premium_since")
      .eq("id", userId)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

/** True only for accounts listed in public.site_admins. */
export async function isSiteAdmin() {
  try {
    const supabase = await db();
    const { data, error } = await supabase.rpc("is_site_admin");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Every account, newest first. RLS returns [] when the caller isn't an admin. */
export async function listProfiles() {
  const supabase = await db();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id,email,full_name,is_premium,premium_since,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Grants or removes premium. Throws when RLS refuses. */
export async function setPremium(userId, premium, note = "") {
  const supabase = await db();
  const patch = premium
    ? {
        is_premium: true,
        premium_since: new Date().toISOString(),
        premium_note: note || null,
      }
    : { is_premium: false, premium_since: null, premium_note: null };

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", userId)
    .select("id,is_premium,premium_since")
    .maybeSingle();
  if (error) throw error;
  return data;
}
