import { Suspense } from "react";
import DashboardClient from "../dashboard-client";

// Root route — Scrape Jobs view. The shared DashboardClient component
// reads `usePathname()` to decide which tab to render. Splitting each
// tab into its own route file (this one, /jobs/page.tsx,
// /analytics/page.tsx) gives us proper path-based URLs without
// duplicating any state or markup.
export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <DashboardClient />
    </Suspense>
  );
}