// lib/supabase.ts
// A single Supabase browser client, built from the public env keys. If the keys
// aren't set (e.g. running locally without them), `supabase` is null and the app
// keeps working off localStorage only — sync just stays switched off.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true, // pick up the magic-link token on return
          flowType: "implicit",
        },
      })
    : null;

/** True when sync is configured (keys present). */
export const syncEnabled = supabase !== null;
