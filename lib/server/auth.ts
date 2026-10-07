// lib/server/auth.ts
// SERVER-ONLY. Verifies the signed-in user behind an API request. The browser
// sends its Supabase access token as a Bearer header; we validate it with Supabase
// and hand back a client scoped to that user, so every query the route makes is
// automatically restricted by row-level security to that user's own rows.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AuthedUser {
  user: { id: string; email: string | undefined };
  client: SupabaseClient;
}

export async function authenticate(
  request: Request,
): Promise<AuthedUser | Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return Response.json(
      { error: "Sync is not configured on this server." },
      { status: 500 },
    );
  }

  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return Response.json({ error: "Please sign in first." }, { status: 401 });
  }

  const client = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return Response.json(
      { error: "Your session has expired. Please sign in again." },
      { status: 401 },
    );
  }
  return { user: { id: data.user.id, email: data.user.email }, client };
}
