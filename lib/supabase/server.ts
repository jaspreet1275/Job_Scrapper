import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side Supabase client for use in Server Components, Route
// Handlers, and Server Actions. Reads/writes auth cookies through
// Next's cookies() store so the session stays in sync across requests.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll throws when called from a Server Component (cookies
            // are read-only there). Safe to ignore — middleware refreshes
            // sessions on every request, so the cookie will be re-set on
            // the next round-trip.
          }
        },
      },
    }
  );
}
