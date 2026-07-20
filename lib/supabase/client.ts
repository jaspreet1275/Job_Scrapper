import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Use this from Client Components (e.g.,
// the login form) to call auth methods like signInWithPassword. The SSR
// helper wires cookie storage to document.cookie so that the same session
// is visible to the server client on the next request.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
