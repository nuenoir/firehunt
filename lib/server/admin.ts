// lib/server/admin.ts
// SERVER-ONLY. A Supabase client that uses the service-role key and therefore
// BYPASSES row-level security. Use it only for jobs that genuinely need to act
// outside a user's session (the daily digest, rate-limit counters, owner lookup).
// Never import this from client components; the key is not a NEXT_PUBLIC_ variable
// so it simply doesn't exist in the browser.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
