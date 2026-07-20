import type { ReactNode } from "react";
import { DashboardProvider } from "@/contexts/DashboardContext";
import { Sidebar } from "@/components/layout/Sidebar";

// Shared layout for every page in the /(dashboard) route group:
//   /             → Scrape Jobs
//   /jobs         → All Jobs (list)
//   /jobs/[id]    → Job detail
//   /analytics    → Analytics
//
// Wraps children with the DashboardProvider so cross-page state
// (savedJobs, autoMode, sidebarOpen drawer toggle, etc.) is shared
// across navigations without re-fetching. Renders the Sidebar once
// here so every page below inherits it — no more duplicating the
// sidebar markup inside dashboard-client.tsx and the detail page's
// own Shell component.
//
// The page-specific TopBar (with its page-aware buttons + page title)
// still lives inside each page's content — pages render their own
// header strip below the sidebar.
export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <DashboardProvider>
      <div className="min-h-screen text-[color:var(--foreground)] flex">
        <Sidebar />
        {/* Children render to the right of the sidebar. The shifted
            ml on desktop matches whichever width the sidebar is at;
            mobile drawer overlays so no margin needed. */}
        <div className="flex-1 min-w-0 md:ml-64 transition-[margin] duration-200 ease-out">
          {children}
        </div>
      </div>
    </DashboardProvider>
  );
}
