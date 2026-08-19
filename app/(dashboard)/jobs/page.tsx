import { Suspense } from "react";
import DashboardClient from "../../dashboard-client";

// /jobs — All Jobs view. Renders the same DashboardClient as the root
// route; the component derives "saved-all" from the pathname and
// shows the table / card-list view. The detail page lives at
// /jobs/[jobId] (dynamic segment, separate file).
export default function AllJobsPage() {
  return (
    <Suspense fallback={null}>
      <DashboardClient />
    </Suspense>
  );
}
