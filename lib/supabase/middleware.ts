import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that must be reachable WITHOUT a Supabase session:
//   /login              — the login page itself
//   /api/auth/*         — logout endpoint (login uses the browser SDK)
//   /api/cron/*         — Vercel cron, gated by CRON_SECRET header
//   /api/gmail-callback — Google OAuth return, can't carry our cookie
//   /api/track-open     — open-tracking pixel hits. The recipient's email
//                          client (Gmail's image proxy) has no session, so this
//                          MUST bypass auth — otherwise the pixel is 307-redirected
//                          to /login and the open is never recorded.
//   /api/inbound/       — Resend inbound reply webhook; Resend isn't a logged-in
//                          user either, so reply detection breaks if it's protected.
//   /_next/*, /favicon  — static assets / framework
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api/auth/",
  "/api/cron/",
  "/api/gmail-callback",
  "/api/track-open",
  "/api/inbound/",
  // Cron pipeline endpoints — the GitHub Actions workflow POSTs to these
  // without a session cookie. If they sit behind the auth wall every cron
  // fire 307-redirects to /login and parse-gmail / scrape-jobs / enrich-lead
  // silently do nothing. Public here so the pipeline actually runs.
  "/api/parse-gmail",
  "/api/scrape-jobs",
  "/api/enrich-lead",
  "/_next/",
  "/favicon",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + ".")
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do NOT run any code between createServerClient() and
  // supabase.auth.getUser(). getUser() refreshes the token; any work in
  // between can cause stale-session bugs per Supabase docs.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where the user was trying to go, so we can bounce them
    // back after a successful login.
    url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Already-logged-in users hitting /login get sent to the dashboard.
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
