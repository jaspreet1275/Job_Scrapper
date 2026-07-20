import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/auth/logout — clears the Supabase auth cookies and redirects
// the caller back to /login. The browser SDK could call signOut directly
// from the client, but routing through here ensures both the server-side
// cookie store and the client-side SDK end up in the same state.
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const url = new URL("/login", request.url);
  return NextResponse.redirect(url, { status: 303 });
}
