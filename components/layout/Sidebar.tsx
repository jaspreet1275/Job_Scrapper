"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useDashboard } from "@/contexts/DashboardContext";
import { createClient } from "@/lib/supabase/client";

// Sidebar — shared across every page in the /(dashboard) route group.
// Pulls savedJobs.length (for the All Jobs count badge) and the
// sidebar open/close state from DashboardContext, so the same instance
// works on /, /jobs, /jobs/[id], /analytics.

const SIDEBAR_ITEMS = [
  { id: "scrape", label: "Scrape Jobs", icon: "⛏", href: "/" },
  { id: "saved-all", label: "All Jobs", icon: "📋", href: "/jobs" },
  { id: "analytics", label: "Analytics", icon: "📊", href: "/analytics" },
  { id: "prompts", label: "Prompts", icon: "✨", href: "/prompts" },
] as const;

function pathnameToActiveId(pathname: string | null): string {
  if (!pathname) return "scrape";
  if (pathname === "/jobs" || pathname.startsWith("/jobs/")) return "saved-all";
  if (pathname === "/analytics") return "analytics";
  if (pathname === "/prompts" || pathname.startsWith("/prompts/")) return "prompts";
  return "scrape";
}

export function Sidebar() {
  const { savedJobs, sidebarOpen, setSidebarOpen } = useDashboard();
  const pathname = usePathname();
  const activeId = pathnameToActiveId(pathname);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Pull the logged-in user's email so the sidebar footer shows whose
  // session this is. Fetched once on mount; the middleware guarantees
  // there IS a user by the time this client component renders.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setUserEmail(data.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-close the mobile drawer when the user picks a tab — otherwise
  // they have to dismiss the drawer manually after each navigation.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
    }
  }, [pathname, setSidebarOpen]);

  return (
    <>
      {/* Mobile backdrop — only visible on small screens when the sidebar
          is open as a drawer. Tap dismisses. */}
      {sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(false)}
          className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-30 cursor-default"
          aria-label="Close menu"
        />
      )}

      <aside
        className={`fixed top-0 left-0 h-full bg-[var(--surface)] border-r border-[var(--border)] z-40 flex flex-col w-64 transition-[transform,width] duration-200 ease-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } md:translate-x-0 ${sidebarOpen ? "md:w-64" : "md:w-[68px]"}`}
      >
        {/* Brand — Manatanu logo + product name. Both logo variants are
            transparent PNGs, so the lockup sits straight on the sidebar
            surface with no tile behind it. Which one shows is decided purely
            in CSS off `data-theme` (see globals.css) rather than in React —
            that keeps the server and client markup identical, so there is no
            hydration mismatch and no wrong-logo flash before hydration. */}
        <div className="mb-1 border-b border-[var(--border)]">
          {/* Full-width card: Manatanu logo on top, product name below —
              one branded lockup. Logo fills the card width so it reads big. */}
          <div
            className={`brand-logo-card rounded-lg overflow-hidden flex flex-col ${
              sidebarOpen
                ? "items-start pl-1.5 pr-1.5 py-2.5 gap-0.5"
                : "items-center px-1.5 py-1.5"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/manatanu-logo.png"
              alt="Manatanu Infotech"
              className="brand-logo-img brand-logo-img-light block h-auto object-contain mb-2"
              style={
                sidebarOpen
                  ? { width: "87%", maxHeight: 56 }
                  : { width: 40, maxHeight: 40 }
              }
            />
            {/* Dark-theme twin — same geometry, white wordmark. Hidden in
                light mode by CSS; alt="" so screen readers announce the
                brand once, not twice. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/manatanu-logo-dark.png"
              alt=""
              aria-hidden="true"
              className="brand-logo-img brand-logo-img-dark h-auto object-contain mb-2"
              style={
                sidebarOpen
                  ? { width: "87%", maxHeight: 56 }
                  : { width: 40, maxHeight: 40 }
              }
            />
            {sidebarOpen && (
              <h1 className="text-[22px] font-bold text-[color:var(--accent)] tracking-tight leading-none pl-8">
                Jobs Scraper AI
              </h1>
            )}
          </div>
        </div>

        {/* Collapse toggle — desktop only. On mobile the sidebar is a
            full-width drawer; the hamburger + backdrop handle open/close
            so this in-sidebar toggle would just be confusing. */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="hidden md:flex absolute -right-3 top-7 w-6 h-6 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--border-strong)] items-center justify-center text-[10px] transition-colors"
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? "◀" : "▶"}
        </button>

        {/* Nav — proper Next.js <Link> components for path-based routing.
            Active state derives from usePathname so it stays in sync
            with the URL on every navigation. */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {SIDEBAR_ITEMS.map((item) => {
            const isActive = activeId === item.id;
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors duration-150 ${
                  isActive
                    ? "bg-[var(--accent-soft)] text-[color:var(--foreground)]"
                    : "text-[color:var(--muted)] hover:bg-[var(--surface-2)] hover:text-[color:var(--foreground)]"
                }`}
                title={!sidebarOpen ? item.label : undefined}
              >
                <span className="text-base shrink-0 leading-none">
                  {item.icon}
                </span>
                {sidebarOpen && (
                  <div className="flex items-center justify-between flex-1 overflow-hidden">
                    <span className="text-[13px] font-medium tracking-tight truncate">
                      {item.label}
                    </span>
                    {item.id === "saved-all" && savedJobs.length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/20 text-[color:var(--accent)] font-medium ml-2">
                        {savedJobs.length}
                      </span>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer — user info + theme toggle + logout. */}
        <div className="px-3 py-4 border-t border-[var(--border)]">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] flex items-center justify-center text-[color:var(--muted)] text-xs font-semibold shrink-0 uppercase">
              {userEmail ? userEmail.charAt(0) : "U"}
            </div>
            {sidebarOpen && (
              <>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="text-[13px] font-medium text-[color:var(--foreground)] truncate leading-tight">
                    {userEmail ? userEmail.split("@")[0] : "User"}
                  </p>
                  <p className="text-[11px] text-[color:var(--muted-2)] truncate">
                    {userEmail || "Signed out"}
                  </p>
                </div>
                <ThemeToggle />
                {/* Logout — POSTs to /api/auth/logout which clears the
                    Supabase cookies server-side and 303-redirects to
                    /login. Using a form instead of fetch so the browser
                    follows the redirect natively. */}
                <form action="/api/auth/logout" method="post">
                  <button
                    type="submit"
                    title="Sign out"
                    className="w-8 h-8 rounded-md flex items-center justify-center text-[color:var(--muted)] hover:bg-[var(--surface-2)] hover:text-[color:var(--danger)] transition-colors"
                    aria-label="Sign out"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
