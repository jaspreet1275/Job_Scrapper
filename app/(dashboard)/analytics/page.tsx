import { Suspense } from "react";
import DashboardClient from "../../dashboard-client";

// /analytics — Analytics view. DashboardClient reads the pathname
// and switches activePage to "analytics".
export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <DashboardClient />
    </Suspense>
  );
}