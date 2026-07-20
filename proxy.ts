import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 renamed the `middleware` file convention to `proxy`. The
// function itself is still the same shape — runs on every matched route
// before rendering. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

// Skip the proxy for static assets and image optimisation to keep it
// cheap. Everything else (pages + API routes) flows through it; the
// public-path whitelist inside updateSession() decides what bypasses auth.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
