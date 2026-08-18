"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import * as XLSX from "xlsx";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PerformanceChart } from "@/components/analytics/PerformanceChart";
import { DateRangePicker } from "@/components/analytics/DateRangePicker";
import { useDashboard } from "@/contexts/DashboardContext";

// Map a Next.js pathname to the dashboard's internal `activePage` value
// (kept around because dozens of branches depend on the string). Single
// source of truth: the URL. /jobs -> "saved-all", /analytics -> "analytics",
// anything else -> "scrape".
function pathnameToPage(pathname: string | null): string {
  if (!pathname) return "scrape";
  if (pathname === "/jobs" || pathname.startsWith("/jobs/")) return "saved-all";
  if (pathname === "/analytics") return "analytics";
  return "scrape";
}

// Reverse — used when other UI (e.g. an empty-state CTA) wants to
// switch tabs without going through the sidebar.
function pageToPath(page: string): string {
  if (page === "saved-all") return "/jobs";
  if (page === "analytics") return "/analytics";
  return "/";
}
// Smart Send button moved to /jobs/[jobId]; the dashboard table now just
// shows a 'View' link, so send-stage-decider is no longer imported here.

const PLATFORMS = [
  { id: "indeed", name: "Indeed", emoji: "💼" },
  { id: "upwork", name: "Upwork", emoji: "🟢" },
  { id: "linkedin", name: "LinkedIn", emoji: "🔵" },
  { id: "remoteok", name: "RemoteOK", emoji: "🌍" },
];

const JOB_ROLES = [
  "Python Developer",
  "Laravel Developer",
  "Web Designer",
  "Data Scientist",
  "Data Analyst",
  "React Developer",
  "Node.js Developer",
  "Full Stack Developer",
  "AI/ML Engineer",
  "DevOps Engineer",
];

const QUICK_TAGS = ["Remote only", "Budget $500+", "Entry level", "Full time", "Part time", "Freelance"];

// Sidebar reduced to a single 'All Jobs' tab — the per-platform tabs
// (LinkedIn / Indeed / Upwork / RemoteOK) collapsed into one paginated
// list. Users still filter by platform via the in-page dropdowns; the
// sidebar is now a navigation, not a slicer.
const SIDEBAR_ITEMS = [
  { id: "scrape", label: "Scrape Jobs", icon: "⛏" },
  { id: "saved-all", label: "All Jobs", icon: "📋" },
  { id: "analytics", label: "Analytics", icon: "📊" },
];

// Status lifecycle (driven by real tracking events):
//   enriched → email found by RocketReach/Snov/Apollo
//   sent     → Stage 1/2/3 email actually sent
//   opened   → tracking pixel hit
//   replied  → reply landed in inbox (terminal — followups suppressed)
//
// Old DB rows from before the cleanup may carry 'new', 'contacted',
// 'call_booked', 'deal_won', 'dead' — those are mapped via aliasStatus()
// at render/filter time so they fold into the four states above.
const LEAD_STATUSES = [
  { id: "enriched", label: "Enriched", color: "purple" },
  { id: "sent", label: "Sent", color: "blue" },
  { id: "opened", label: "Opened", color: "cyan" },
  { id: "replied", label: "Replied", color: "yellow" },
];

// Maps any legacy or new status value to one of the four supported ids.
// Returns null for rows that pre-date enrichment (e.g. status='new') so
// the badge column shows '—' instead of an unsupported label.
function aliasStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s === "contacted") return "sent";
  if (s === "new" || s === "call_booked" || s === "deal_won" || s === "dead") {
    return null;
  }
  return s;
}

// ─────── Auto Mode constants (client-side automation pipeline) ───────
// In follow-up TEST MODE we drop the cycle from 30 min to 1 min so the full
// Trigger → Case Study → Breakup sequence can be demoed in ~5 min total.
const AUTO_INTERVAL_MS =
  process.env.NEXT_PUBLIC_FOLLOWUP_TEST_MODE === "true"
    ? 1 * 60 * 1000 // 1 minute (test mode)
    : 30 * 60 * 1000; // 30 minutes (production)
const AUTO_MAX_ENRICH = 30;              // jobs to enrich per cycle (effectively "all" given typical scrape volume)
const AUTO_MAX_SEND = 20;                // emails per cycle (target range 10-20)
const AUTO_DAILY_SEND_CAP = 50;          // daily ceiling — Phase 3.3 plan, prevents Gmail throttling
const AUTO_DAILY_SENT_KEY = "autoDailySent"; // localStorage: { date: "YYYY-MM-DD", count: N }
const AUTO_STEP_DELAY_MS = 2000;

// Daily-send counter (auto resets at midnight via date check)
const todayStr = () => new Date().toISOString().split("T")[0];
const getDailySent = (): number => {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(AUTO_DAILY_SENT_KEY);
    if (!raw) return 0;
    const data = JSON.parse(raw) as { date: string; count: number };
    return data.date === todayStr() ? data.count : 0;
  } catch {
    return 0;
  }
};
const writeDailySent = (count: number): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTO_DAILY_SENT_KEY, JSON.stringify({ date: todayStr(), count }));
};

// Method 1 scrape config — run every cycle alongside Method 2 (Gmail).
// Set AUTO_METHOD1_INTERVAL_MS to a non-zero value (e.g. 60 * 60 * 1000) to throttle if Apify cost is a concern.
const AUTO_METHOD1_INTERVAL_MS = 0; // 0 = run every cycle (no gate)
const AUTO_METHOD1_PLATFORMS = ["linkedin"] as const;
const AUTO_METHOD1_FILTERS = ["Freelance"] as const;
const AUTO_METHOD1_LAST_KEY = "autoMethod1LastScrapeAt";

// Follow-up gap constants used to live here for the auto-mode multi-stage
// send loop. That block is /* DISABLED */ during the manual-testing phase,
// so the constants were dead code. The same delays now live in
// lib/send-stage-decider.ts and drive the Smart Send button on the per-job
// detail page. Restore here only if auto-mode send is re-enabled.
const AUTO_MAX_REPLY_CHECK = 20; // how many threads to poll for replies per cycle
const JOBS_PAGE_SIZE = 15;       // rows per page on the All Jobs table

// Build a compact pager — first page, ellipsis, the local 1-2 around the
// current page, ellipsis, last page. Mirrors the mockup pattern. Returns
// at most ~7 entries no matter how many pages exist.
function buildPageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total];
  if (current >= total - 3) {
    return [1, "…", total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, "…", current - 1, current, current + 1, "…", total];
}

// Shared types live in `types/index.ts` — see that file for field-level
// docs. Bare-name usage in this file (Job, Candidate, EnrichedLead) is
// preserved so existing call-sites don't need to change.
import type { Job, Candidate, EnrichedLead } from "@/types";
// Local aliases satisfy the "unused import" lint when these types are
// only referenced via in-scope JSX prop / state generics that get
// erased by the TS compiler.
export type { Job as _Job, Candidate as _Candidate, EnrichedLead as _EnrichedLead };

export default function DashboardClient() {
  // Pathname is the source of truth for the active page. The sidebar
  // <Link>s switch routes; this hook re-runs on every navigation, so
  // `activePage` always matches the URL the user is looking at.
  const pathname = usePathname();
  const router = useRouter();
  const activePage = pathnameToPage(pathname);
  // Helper used by non-link CTAs (e.g. "head to Scrape Jobs" empty
  // state). Pushes to the right path; the pathname hook then updates
  // activePage automatically.
  const setActivePage = useCallback(
    (next: string) => {
      router.push(pageToPath(next));
    },
    [router]
  );
  // Cross-page state lives in DashboardContext (provided by
  // app/(dashboard)/layout.tsx). The destructure below replaces the
  // older local useStates so all references in this file pick up
  // unchanged — savedJobs, autoMode, sidebar drawer, etc.
  const {
    savedJobs,
    savedJobsLoading,
    setSavedJobs,
    autoMode,
    setAutoMode,
    autoModeModalOpen,
    setAutoModeModalOpen,
    sidebarOpen,
    setSidebarOpen,
  } = useDashboard();
  // Sub-tab inside the unified Scrape Jobs page: "search" (Apify-driven
  // platform search) or "gmail" (LinkedIn alert email parser).
  const [scrapeMethod, setScrapeMethod] = useState<"search" | "gmail">("gmail");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [platformDropdownOpen, setPlatformDropdownOpen] = useState(false);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [selectedFilters, setSelectedFilters] = useState<string[]>([]);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  // savedJobs + savedJobsLoading moved to DashboardContext (provider
  // fetches /api/jobs once on mount and exposes the list to every
  // page in the route group).
  const [selectedExportIndexes, setSelectedExportIndexes] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>("");
  const [step, setStep] = useState<string>("");
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailJobs, setGmailJobs] = useState<Job[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailMessage, setGmailMessage] = useState("");
  // Multi-Gmail account state. `gmailSlots` mirrors /api/gmail-accounts, one
  // entry per env-configured label (employee1, employee, …). `gmailModalOpen`
  // toggles the connect/disconnect panel; `parseSelection` is the dashboard's
  // "Select Email" dropdown value, persisted to settings.parse_gmail_selection.
  type GmailSlot = {
    label: string;
    display_name: string;
    email: string | null;
    is_connected: boolean;
    last_parsed_at: string | null;
  };
  const [gmailSlots, setGmailSlots] = useState<GmailSlot[]>([]);
  const [gmailModalOpen, setGmailModalOpen] = useState(false);
  const [parseSelection, setParseSelection] = useState<string>("both");
  const fetchGmailSlots = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail-accounts");
      const data = await res.json();
      if (data?.success && Array.isArray(data.data)) {
        const slots = data.data as GmailSlot[];
        setGmailSlots(slots);
        // Keep the legacy gmailConnected flag in sync with the multi-account
        // reality. Setup Instructions panel + any other piece of UI that
        // still reads gmailConnected then reflects "yes a Gmail is wired up"
        // when at least one slot is connected.
        if (slots.length > 0) {
          setGmailConnected(slots.some((s) => s.is_connected));
        }
      }
    } catch (e) {
      console.warn("[gmail-accounts] fetch failed:", e);
    }
  }, []);
  // Date filter for the Run Scrape Now button. Defaults to today; the
  // /api/parse-gmail backend reads only alert emails that ARRIVED on this
  // exact IST date, so picking a past day re-scans that day's inbox.
  const [scrapeDate, setScrapeDate] = useState<string>(todayStr());
  // Hidden native <input type="date"> is used purely for the picker UI;
  // this ref lets the visible calendar button trigger showPicker() on it.
  const scrapeDateInputRef = useRef<HTMLInputElement>(null);
  // The dashboard's per-row email modal was removed when the Smart Send
  // button moved to /jobs/[jobId]. Sending now happens entirely on the
  // detail page; this list view is summary-only.
  const [descModal, setDescModal] = useState<{ title: string; company: string; description: string; url?: string } | null>(null);

  // Saved Jobs filters
  const [savedSearch, setSavedSearch] = useState("");
  const [savedFilterPlatform, setSavedFilterPlatform] = useState("all");
  const [savedFilterStatus, setSavedFilterStatus] = useState("all");
  // Default to "with" (With Email) — actionable jobs with a contact email
  // are the primary view; users can flip to "All Jobs" or "No Email" as
  // needed.
  const [savedFilterEmail, setSavedFilterEmail] = useState("all");
  // Scraped date filter — an explicit YYYY-MM-DD pick (HTML
  // <input type="date">). Empty string = no filter; it filters
  // job.capturedDate (when this dashboard captured the row). Only rows
  // whose date EQUALS the picked day pass. Defaults to today so the
  // table opens on the current day's scrape.
  // const [savedFilterScrapedDate, setSavedFilterScrapedDate] = useState(() => {
  //   const d = new Date();
  //   const yyyy = d.getFullYear();
  //   const mm = String(d.getMonth() + 1).padStart(2, "0");
  //   const dd = String(d.getDate()).padStart(2, "0");
  //   return `${yyyy}-${mm}-${dd}`;
  // });

  const [savedFilterScrapedDate, setSavedFilterScrapedDate] = useState("");
  
  // All Jobs table pagination
  const [currentJobsPage, setCurrentJobsPage] = useState(1);

  // (RocketReach credit pill removed from UI — state + fetch deleted.)

  // Scrape page (Gmail) — backed by the singleton `settings` row.
  //   maxEmails           → settings.max_emails_per_run
  //   platform            → settings.platform_filter ('linkedin' | 'indeed' | 'upwork')
  //   scheduleHour        → settings.daily_schedule_hour (7 | 8 | null = manual only)
  //   lastScrapeAt        → settings.last_scrape_at (read-only; cron writes it)
  const [lastScrapeAt, setLastScrapeAt] = useState<string | null>(null);
  // Snapshot of savedJobs frozen when the user lands on Analytics, so the
  // report numbers stay STATIC while they read it — background enrichment
  // would otherwise keep mutating savedJobs and tick the bars up live.
  // Cleared on leaving the page so the next visit picks up a fresh count.
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<Job[] | null>(null);
  // ── Outreach-funnel date filter (Analytics page) ────────────────────────
  // Default to today's IST date so the funnel reads "today's activity" the
  // moment Analytics opens. Both inputs hold the same value initially —
  // setting them apart turns the filter into a date range. The same
  // todayStr() helper that's already used elsewhere keeps the day-bucketing
  // consistent across the page.
  const initialFunnelDate = todayStr();
  const [funnelFrom, setFunnelFrom] = useState<string>(initialFunnelDate);
  const [funnelTo, setFunnelTo] = useState<string>(initialFunnelDate);
  const [funnelData, setFunnelData] = useState<{
    sent: number;
    opened: number;
    openRate: number;
    replied: number;
    replyRate: number;
    from: string;
    to: string;
  } | null>(null);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  // ── Funnel drill-down modal (Emails Sent / Opened cards) ─────────────────
  // The "view" icon on the Emails Sent + Opened stat cards opens a popup that
  // lists the actual emails behind the count (job + recipient), fetched from
  // /api/analytics/events for the same date window the funnel uses.
  type FunnelEvent = {
    id: string;
    jobId: string | null;
    toEmail: string | null;
    subject: string | null;
    stage: number | null;
    status: string | null;
    sentAt: string | null;
    openedAt: string | null;
    jobTitle: string | null;
    jobUrl: string | null;
    platform: string | null;
  };
  const [eventsModal, setEventsModal] = useState<{
    type: "sent" | "opened";
    events: FunnelEvent[];
  } | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  // Fetch the per-email list for a card and open the modal. Uses the live
  // funnelFrom/funnelTo so the popup always matches the numbers on screen.
  const openEventsModal = useCallback(
    async (type: "sent" | "opened") => {
      setEventsModal({ type, events: [] });
      setEventsLoading(true);
      setEventsError(null);
      try {
        const res = await fetch(
          `/api/analytics/events?type=${type}&from=${funnelFrom}&to=${funnelTo}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (json?.success && Array.isArray(json.events)) {
          setEventsModal({ type, events: json.events as FunnelEvent[] });
        } else {
          setEventsError(json?.error || "Failed to load");
        }
      } catch (err) {
        setEventsError(String(err));
      } finally {
        setEventsLoading(false);
      }
    },
    [funnelFrom, funnelTo]
  );
  // Performance-chart range — defaults to the trailing 7 days ending
  // today. The chart re-fetches its buckets whenever either bound moves.
  const initialChartTo = initialFunnelDate;
  const initialChartFrom = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().split("T")[0];
  })();
  const [chartFrom, setChartFrom] = useState<string>(initialChartFrom);
  const [chartTo, setChartTo] = useState<string>(initialChartTo);
  const [scrapeSettings, setScrapeSettings] = useState({
    maxEmails: 25,
    platform: "linkedin" as "linkedin" | "indeed" | "upwork" | "remoteok",
    // Array of IST "HH:MM" strings — each one matches a slot the daily
    // cron-scrape workflow fires on. Empty array = scheduler off.
    scheduleTimes: [] as string[],
    // Technologies the user's LinkedIn job alerts are set for — saved to
    // settings.technologies as a record of what the inbox is tracking.
    technologies: [] as string[],
  });
  const [scrapeSettingsSaving, setScrapeSettingsSaving] = useState(false);
  const [scrapeSettingsSaved, setScrapeSettingsSaved] = useState(false);
  const [scrapeSettingsError, setScrapeSettingsError] = useState<string | null>(null);
  // Separate save state for the "Set Technologies" panel — independent of
  // the Scrape Settings save above (different button, different request).
  const [techSaving, setTechSaving] = useState(false);
  const [techSaved, setTechSaved] = useState(false);
  const [techError, setTechError] = useState<string | null>(null);
  // Recent Activity — fetched from /api/activity which derives entries
  // from jobs_v2.scraped_at + email_tracking.sent_at. Refetched after
  // every successful scrape so the log stays in sync.
  const [activityLog, setActivityLog] = useState<
    Array<{ time: string; kind: "scrape" | "send"; label: string; count: number }>
  >([]);

  // ─────── Auto Mode state ───────
  // Constants are at module scope (top of file) — keeps useCallback deps stable.
  // autoMode + autoModeModalOpen now live in DashboardContext (above);
  // the rest of the per-run UI state stays page-local since it isn't
  // shared across routes.
  const [autoStatus, setAutoStatus] = useState<"idle" | "running">("idle");
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [autoStats, setAutoStats] = useState({ parsed: 0, enriched: 0, sent: 0, replied: 0, errors: 0 });
  const [autoNextRunAt, setAutoNextRunAt] = useState<number | null>(null);
  const [dailySent, setDailySent] = useState(0); // emails sent today (auto resets at midnight)
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRunningRef = useRef(false);

  // incrementDailySent helper removed — its only call-site lived inside the
  // /* DISABLED */ auto multi-stage send block in this same file. The
  // dashboard email modal that also bumped the counter is gone too. If
  // auto-send is ever re-enabled, restore from git history.

  // Load daily count on mount + every minute (in case midnight rolls over)
  useEffect(() => {
    setDailySent(getDailySent());
    const t = setInterval(() => setDailySent(getDailySent()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // auto_mode_enabled sync on mount moved to DashboardContext.

  // ─── Open-tracking poller ───
  // Every 30s the dashboard pulls /api/get-opens (aggregated by trackingId) and
  // writes openedCount / firstOpenedAt / lastOpenedAt onto each matching saved
  // job. Auto-refresh means analytics + per-row counters update without a
  // manual reload while the recipient opens emails.
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const res = await fetch("/api/get-opens");
        const data = await res.json();
        if (cancelled || !data?.success || !Array.isArray(data.aggregates)) return;
        const byId = new Map<string, { openedCount: number; firstOpenedAt: string; lastOpenedAt: string }>();
        for (const a of data.aggregates as Array<{
          trackingId: string;
          openedCount: number;
          firstOpenedAt: string;
          lastOpenedAt: string;
        }>) {
          byId.set(a.trackingId, {
            openedCount: a.openedCount,
            firstOpenedAt: a.firstOpenedAt,
            lastOpenedAt: a.lastOpenedAt,
          });
        }
        if (byId.size === 0) return;
        setSavedJobs((prev) => {
          let dirty = false;
          const updated = prev.map((j) => {
            if (!j.trackingId) return j;
            const stat = byId.get(j.trackingId);
            if (!stat) return j;
            if (
              (j.openedCount || 0) === stat.openedCount &&
              j.lastOpenedAt === stat.lastOpenedAt
            ) {
              return j;
            }
            dirty = true;
            return {
              ...j,
              openedCount: stat.openedCount,
              firstOpenedAt: j.firstOpenedAt || stat.firstOpenedAt,
              lastOpenedAt: stat.lastOpenedAt,
              status:
                j.status === "contacted" || j.status === "new" || j.status === "enriched"
                  ? "opened"
                  : j.status,
            };
          });
          if (!dirty) return prev;
          localStorage.setItem("savedJobs", JSON.stringify(updated));
          return updated;
        });
      } catch {
        /* network error — try again on next tick */
      }
    };
    sync();
    const t = setInterval(sync, 30 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const platformDropdownRef = useRef<HTMLDivElement>(null);
  const roleDropdownRef = useRef<HTMLDivElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  // /api/jobs fetch moved to DashboardContext provider — savedJobs +
  // savedJobsLoading are now destructured at the top of this function.

  // ─────── Auto-fetch description in background after a job is saved ───────
  // Whenever savedJobs changes and contains a LinkedIn-source job whose description
  // is still short and hasn't been fetched yet, kick off a background call to
  // /api/fetch-job-description. The endpoint runs cheerio first then ScrapingBee,
  // so the dashboard column fills in without any button click.
  // We dedupe in-flight URLs via a ref so a re-render doesn't queue the same job twice.
  const fetchingDescUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (savedJobs.length === 0) return;
    const candidates = savedJobs.filter(
      (j) =>
        !j.descriptionFetched &&
        (j.description?.length || 0) < 500 &&
        !!j.url &&
        j.url.includes("linkedin.com")
    );
    if (candidates.length === 0) return;

    const MAX_PARALLEL = 3;
    const toFetch = candidates
      .filter((j) => !fetchingDescUrlsRef.current.has(`${j.url}::${j.title}`))
      .slice(0, MAX_PARALLEL);

    for (const job of toFetch) {
      const key = `${job.url}::${job.title}`;
      fetchingDescUrlsRef.current.add(key);

      (async () => {
        try {
          const res = await fetch("/api/fetch-job-description", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: job.url }),
          });
          const data = await res.json();
          setSavedJobs((prev) => {
            const updated = prev.map((j) => {
              if (j.title !== job.title || j.url !== job.url) return j;
              const next: Job = { ...j, descriptionFetched: true };
              // Update description only if the fetched one is longer.
              const got = data?.description || "";
              if (data?.success && got && got.length > (j.description?.length || 0)) {
                next.description = got;
              }
              // Update location only if the job is currently missing one.
              // Method 1 (Apify) jobs come with proper location — never overwrite.
              const fetchedLoc = data?.location || "";
              const currentLoc = (j.location || "").trim();
              const locMissing = !currentLoc || currentLoc === "N/A" || currentLoc === "—";
              if (data?.success && fetchedLoc && locMissing) {
                next.location = fetchedLoc;
              }
              return next;
            });
            localStorage.setItem("savedJobs", JSON.stringify(updated));
            return updated;
          });
        } catch (err) {
          console.error("[bg-desc] fetch failed:", err);
          setSavedJobs((prev) => {
            const updated = prev.map((j) =>
              j.title === job.title && j.url === job.url
                ? { ...j, descriptionFetched: true }
                : j
            );
            localStorage.setItem("savedJobs", JSON.stringify(updated));
            return updated;
          });
        } finally {
          fetchingDescUrlsRef.current.delete(key);
        }
      })();
    }
  }, [savedJobs]);

  // ─────── Auto-enrich in background after a job is saved ───────
  // Replaces the manual "🔍 Enrich" button. Whenever savedJobs has a job that
  // hasn't been enriched yet, fire /api/enrich-lead in the background. The
  // endpoint already does: website scrape (emails) → RocketReach Search (DM info)
  // → auto-RR-Lookup if email missing AND credits available → Snov verify.
  const enrichingCompaniesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Don't auto-enrich while the user is on Analytics — that page is a
    // snapshot/report; ticking the Enriched count up live as background
    // enrichment finishes makes the bar look like it's animating from 1.
    if (activePage === "analytics") return;
    if (savedJobs.length === 0) return;
    const candidates = savedJobs.filter((j) => {
      if (j.enriched) return false;
      const company = j.company?.replace(/\s*\(.*\)/, "").trim();
      if (!company || company === "N/A" || company === "Unknown" || company === "Upwork Client") return false;
      return true;
    });
    if (candidates.length === 0) return;

    // Sequential (1 at a time) — multiple parallel enrich calls were stacking
    // RR Search requests and triggering the free-tier rate limit (429).
    const MAX_PARALLEL = 1;
    const toRun = candidates
      .filter((j) => !enrichingCompaniesRef.current.has(`${j.title}::${j.company}`))
      .slice(0, MAX_PARALLEL);

    for (const job of toRun) {
      const key = `${job.title}::${job.company}`;
      enrichingCompaniesRef.current.add(key);
      const company = (job.company || "").replace(/\s*\(.*\)/, "").trim();
      const isGmail = job.platform?.toLowerCase().includes("gmail");

      (async () => {
        try {
          const res = await fetch("/api/enrich-lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyName: company,
              source: isGmail ? "gmail" : "search",
              // Pass the job_id so /api/enrich-lead persists the enrichment
              // JSONB + email_status='enriched' back into jobs_v2. Without
              // this the row would only ever be enriched in localStorage and
              // a fresh page load would reset it.
              jobId: job.dbId ?? job.jobId ?? null,
            }),
          });
          const data = await res.json();
          if (data?.success && data.data) {
            // Only mark a job "enriched" when an EMAIL was found — name/title
            // alone isn't a usable lead, so it must not flip the status badge
            // or inflate the Analytics enriched count. (Matches the server,
            // which now only persists enrichment when an email exists.)
            const dmEmail = data.data?.candidates?.[0]?.email;
            const hasEmail = !!dmEmail && dmEmail !== "N/A";
            if (hasEmail) {
              setSavedJobs((prev) => {
                const updated = prev.map((j) =>
                  j.title === job.title && j.company === job.company
                    ? {
                        ...j,
                        enriched: data.data,
                        status: j.status === "new" ? "enriched" : j.status,
                      }
                    : j
                );
                localStorage.setItem("savedJobs", JSON.stringify(updated));
                return updated;
              });
            }
          }
        } catch (err) {
          console.error("[bg-enrich] failed:", err);
        } finally {
          enrichingCompaniesRef.current.delete(key);
        }
      })();
    }
  }, [savedJobs, activePage]);

  // Snapshot management — freeze savedJobs the moment the user lands on
  // Analytics, clear it when they leave. The Analytics IIFE reads from this
  // snapshot when present so the report stays static even as background
  // enrichment / description refetches keep mutating the live savedJobs.
  useEffect(() => {
    if (activePage !== "analytics") {
      if (analyticsSnapshot !== null) setAnalyticsSnapshot(null);
      return;
    }
    if (analyticsSnapshot === null && savedJobs.length > 0) {
      setAnalyticsSnapshot(savedJobs);
    }
  }, [activePage, savedJobs, analyticsSnapshot]);

  // Refetch the Outreach Funnel counts whenever the user changes either
  // date input (or first lands on Analytics). AbortController stops a
  // stale response from clobbering newer state if the user clicks the
  // pickers in quick succession.
  useEffect(() => {
    if (activePage !== "analytics") return;
    const abort = new AbortController();
    setFunnelLoading(true);
    setFunnelError(null);
    fetch(
      `/api/analytics/funnel?from=${funnelFrom}&to=${funnelTo}`,
      { signal: abort.signal, cache: "no-store" }
    )
      .then((r) => r.json())
      .then((json) => {
        if (abort.signal.aborted) return;
        if (json?.success && json.data) {
          setFunnelData(json.data);
        } else {
          setFunnelError(json?.error || "Failed to load funnel");
        }
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        setFunnelError(String(err));
      })
      .finally(() => {
        if (abort.signal.aborted) return;
        setFunnelLoading(false);
      });
    return () => abort.abort();
  }, [activePage, funnelFrom, funnelTo]);

  // Persist saved jobs — ALWAYS dedupe before saving (no duplicates can ever slip through)
  const persistSaved = useCallback((jobs: Job[]) => {
    const unique: Job[] = [];
    for (const job of jobs) {
      const jobTitleNorm = (job.title || "").toLowerCase().trim();
      const jobCompanyNorm = (job.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
      const jobLocationNorm = (job.location || "").toLowerCase().trim().replace(/\s+/g, " ");
      const isDupe = unique.some((s) => {
        if (job.jobId && s.jobId && job.jobId !== "N/A" && s.jobId !== "N/A" && job.jobId === s.jobId) return true;
        if (job.url && s.url && job.url !== "N/A" && s.url !== "N/A" && job.url === s.url) return true;
        const sTitleNorm = (s.title || "").toLowerCase().trim();
        const sCompanyNorm = (s.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
        const sLocationNorm = (s.location || "").toLowerCase().trim().replace(/\s+/g, " ");
        return (
          jobTitleNorm && sTitleNorm && jobTitleNorm === sTitleNorm &&
          jobCompanyNorm && sCompanyNorm && jobCompanyNorm === sCompanyNorm &&
          jobLocationNorm === sLocationNorm &&
          jobTitleNorm !== "n/a" && jobCompanyNorm !== "n/a"
        );
      });
      if (!isDupe) unique.push(job);
    }
    setSavedJobs(unique);
    localStorage.setItem("savedJobs", JSON.stringify(unique));
  }, []);

  // Duplicate check — any of these matches counts as duplicate:
  // 1. Same jobId, 2. Same URL, 3. Same title + company + location.
  // Location is part of the fuzzy match now, so the SAME role posted in
  // two different locations is kept as two separate jobs, not collapsed.
  const isDuplicate = (job: Job, list: Job[]) => {
    const jobTitleNorm = (job.title || "").toLowerCase().trim();
    const jobCompanyNorm = (job.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
    const jobLocationNorm = (job.location || "").toLowerCase().trim().replace(/\s+/g, " ");

    return list.some((s) => {
      // Primary: match by jobId
      if (job.jobId && s.jobId && job.jobId !== "N/A" && s.jobId !== "N/A" && job.jobId === s.jobId) return true;
      // Secondary: match by URL
      if (job.url && s.url && job.url !== "N/A" && s.url !== "N/A" && job.url === s.url) return true;
      // Tertiary: same title + company + location (case-insensitive,
      // platform tag stripped). All three must match — a differing
      // location means a genuinely different posting, so it is kept.
      const sTitleNorm = (s.title || "").toLowerCase().trim();
      const sCompanyNorm = (s.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
      const sLocationNorm = (s.location || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (
        jobTitleNorm && sTitleNorm && jobTitleNorm === sTitleNorm &&
        jobCompanyNorm && sCompanyNorm && jobCompanyNorm === sCompanyNorm &&
        jobLocationNorm === sLocationNorm &&
        jobTitleNorm !== "n/a" && jobCompanyNorm !== "n/a"
      ) {
        return true;
      }
      return false;
    });
  };

  const saveJob = (job: Job) => {
    if (isDuplicate(job, savedJobs)) return;
    const today = new Date().toISOString().split("T")[0];
    // Optimistic local update first so the row's "Saved" badge flips
    // immediately — the user shouldn't have to wait on a network round
    // trip to see their click registered.
    persistSaved([
      ...savedJobs,
      { ...job, status: "new", capturedDate: today, emailsSent: 0 },
    ]);
    // Actually persist to jobs_v2 via the explicit save endpoint. Manual
    // scrape flows (Run Scrape Now / RemoteOK) hit the scrape APIs with
    // saveToDb=false, so this call is what makes the row real on the
    // server side (and lets the cron drain enrich it later).
    void fetch("/api/jobs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobs: [
          {
            title: job.title,
            jobId: job.jobId,
            company: job.company,
            email: job.email,
            location: job.location,
            jobType: job.jobType,
            description: job.description,
            url: job.url,
            postedAt: job.postedAt,
            platform: job.platform,
          },
        ],
      }),
    }).catch((e) => console.warn("[save-job] persist failed:", e));
  };

  // Save all search results at once (skip duplicates). Mirrors saveJob
  // — optimistic local update + explicit /api/jobs/save call so the rows
  // actually land in jobs_v2 (Via Search results, like Gmail manual ones,
  // never auto-persist on the scrape route side).
  const saveAllJobs = () => {
    const today = new Date().toISOString().split("T")[0];
    const newJobs = jobs
      .filter((job) => !isDuplicate(job, savedJobs))
      .map((job) => ({ ...job, status: "new", capturedDate: today, emailsSent: 0 }));
    if (newJobs.length === 0) return;
    persistSaved([...savedJobs, ...newJobs]);
    void fetch("/api/jobs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobs: newJobs.map((j) => ({
          title: j.title,
          jobId: j.jobId,
          company: j.company,
          email: j.email,
          location: j.location,
          jobType: j.jobType,
          description: j.description,
          url: j.url,
          postedAt: j.postedAt,
          platform: j.platform,
        })),
      }),
    }).catch((e) => console.warn("[save-all-search] persist failed:", e));
  };

  const removeJob = (index: number) => {
    const updated = savedJobs.filter((_, i) => i !== index);
    persistSaved(updated);
  };

  const toggleExportSelect = (index: number) => {
    setSelectedExportIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // toggleSelectAllOnPage — scoped to whatever rows are currently visible
  // in the table (after filters + pagination). Falls through to an inline
  // closure at the JSX site that captures `pagedJobs`; this stub is kept
  // here only so the contract is documented in one place. The "no selection
  // = export all" fallback in exportToExcel() means the header checkbox is
  // never the path to export every job — that's the default empty state.

  // Export: selected jobs if any selected, otherwise all
  const exportToExcel = () => {
    if (savedJobs.length === 0) return;

    const jobsToExport =
      selectedExportIndexes.size > 0
        ? savedJobs.filter((_, i) => selectedExportIndexes.has(i))
        : savedJobs;

    const data = jobsToExport.map((job, i) => ({
      "S.No": i + 1,
      "Job Name": job.title,
      "Job ID": job.jobId || "N/A",
      "Company": job.company?.replace(/\s*\(.*\)/, "").trim() || "N/A",
      "URL": job.url || "N/A",
      "Decision Maker": (() => {
        const idx = job.enriched?.selectedCandidateIndex ?? 0;
        return job.enriched?.candidates?.[idx]?.name || "N/A";
      })(),
      "DM Title": (() => {
        const idx = job.enriched?.selectedCandidateIndex ?? 0;
        return job.enriched?.candidates?.[idx]?.title || "N/A";
      })(),
      "DM Email": (() => {
        const idx = job.enriched?.selectedCandidateIndex ?? 0;
        return job.enriched?.candidates?.[idx]?.email || job.email || "N/A";
      })(),
      "Email Verified": (() => {
        const idx = job.enriched?.selectedCandidateIndex ?? 0;
        return job.enriched?.candidates?.[idx]?.emailVerified || "N/A";
      })(),
      "DM LinkedIn": (() => {
        const idx = job.enriched?.selectedCandidateIndex ?? 0;
        return job.enriched?.candidates?.[idx]?.linkedin || "N/A";
      })(),
      "Company Domain": job.enriched?.companyDomain || "N/A",
      "Company Size": job.enriched?.companySize || "N/A",
      "Company Country": job.enriched?.companyCountry || "N/A",
      "Company Industry": job.enriched?.companyIndustry || "N/A",
      "Company Phone": job.enriched?.companyPhone || "N/A",
      "Job Type": job.jobType,
      "Description": job.description || "N/A",
      "Posted Time": job.postedAt || "N/A",
      "Location": job.location,
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const colWidths = Object.keys(data[0]).map((key) => ({
      wch: Math.max(
        key.length + 2,
        ...data.map((row) => String(row[key as keyof typeof row] || "").length)
      ),
    }));
    ws["!cols"] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Saved Jobs");
    XLSX.writeFile(wb, "saved_jobs.xlsx");
  };

  // openEmailModal / sendEmail removed alongside the dashboard's per-row
  // email modal. Email composition + send now lives on /jobs/[jobId];
  // see app/jobs/[jobId]/page.tsx for the Generate / Re-generate flow.

  // (Manual enrichLead removed — enrichment now runs automatically in the
  //  background via the useEffect above. The "🔍 Enrich" button is gone.)

  // ─────────────── AUTO MODE PIPELINE ───────────────
  // Additive: reuses existing API endpoints. Does not modify any existing handler.
  // Pipeline per cycle: Gmail parse → enrich new jobs (max 5) → send stage-1 email (max 3).
  // All state writes go through setSavedJobs(prev => ...) + localStorage for safe concurrency.
  const addAutoLog = useCallback((msg: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    console.log("[auto]", msg);
    setAutoLog((prev) => [...prev.slice(-49), line]);
  }, []);

  // Match key used to locate a job inside the state array across awaits.
  // Mirrors isDuplicate rules (jobId → url → title+company), never by index.
  const matchJob = (a: Job, b: Job): boolean => {
    if (a.jobId && b.jobId && a.jobId !== "N/A" && b.jobId !== "N/A" && a.jobId === b.jobId) return true;
    if (a.url && b.url && a.url !== "N/A" && b.url !== "N/A" && a.url === b.url) return true;
    const at = (a.title || "").toLowerCase().trim();
    const bt = (b.title || "").toLowerCase().trim();
    const ac = (a.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
    const bc = (b.company || "").replace(/\s*\(.*\)/, "").toLowerCase().trim();
    return !!at && at === bt && !!ac && ac === bc && at !== "n/a" && ac !== "n/a";
  };

  const runAutoPipeline = useCallback(async () => {
    if (autoRunningRef.current) {
      addAutoLog("⏸️  Already running, skipping tick");
      return;
    }
    autoRunningRef.current = true;
    setAutoStatus("running");

    const stats = { parsed: 0, enriched: 0, sent: 0, replied: 0, errors: 0 };

    try {
      addAutoLog("▶️  Cycle start");

      // ============ STEP 0: Method 1 scrape (once per 24 hrs) ============
      const lastScrapeStr = localStorage.getItem(AUTO_METHOD1_LAST_KEY);
      const lastScrapeTs = lastScrapeStr ? parseInt(lastScrapeStr, 10) : 0;
      const sinceLastMs = Date.now() - lastScrapeTs;
      const shouldScrape = !lastScrapeTs || sinceLastMs >= AUTO_METHOD1_INTERVAL_MS;

      if (!shouldScrape) {
        const hoursLeft = Math.ceil((AUTO_METHOD1_INTERVAL_MS - sinceLastMs) / (60 * 60 * 1000));
        addAutoLog(`⏭️  Method 1: next scrape in ~${hoursLeft}h (click 🔄 reset to force)`);
      } else {
        addAutoLog(
          `🔎 Method 1: ${AUTO_METHOD1_PLATFORMS.join(",")} · ${JOB_ROLES.length} roles · filter=${AUTO_METHOD1_FILTERS.join(",")}`
        );
        // Only mark "done" if scrape actually reached filter stage at least once (regardless of dedup)
        let method1ReachedFilter = false;
        for (const platform of AUTO_METHOD1_PLATFORMS) {
          try {
            // Scrape
            const endpointMap: Record<string, string> = {
              upwork: "/api/scrape-upwork",
              remoteok: "/api/scrape-remoteok",
            };
            const scrapeEndpoint = endpointMap[platform] || "/api/scrape-jobs";
            addAutoLog(`   → scrape ${platform}...`);
            const scrapeRes = await fetch(scrapeEndpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                platform,
                roles: JOB_ROLES,
                filters: AUTO_METHOD1_FILTERS,
              }),
            });
            const scrapeData = await scrapeRes.json();
            if (!scrapeData.success) {
              addAutoLog(`   ❌ ${platform}: scrape failed — ${scrapeData.error || "unknown"}`);
              continue;
            }
            if (!Array.isArray(scrapeData.data) || scrapeData.data.length === 0) {
              addAutoLog(`   ⚠️  ${platform}: 0 raw jobs returned (${scrapeData.message || "actor empty"})`);
              continue;
            }
            addAutoLog(`   ✓ ${platform}: scraped ${scrapeData.data.length} raw`);

            // AI filter
            addAutoLog(`   → filter ${platform}...`);
            const filterRes = await fetch("/api/filter-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jobs: scrapeData.data,
                roles: JOB_ROLES,
                filters: AUTO_METHOD1_FILTERS,
                platform,
              }),
            });
            const filterData = await filterRes.json();
            if (!filterData.success || !Array.isArray(filterData.data)) {
              addAutoLog(`   ❌ ${platform}: filter failed — ${filterData.error || "unknown"}`);
              continue;
            }
            method1ReachedFilter = true;
            addAutoLog(`   ✓ ${platform}: filter kept ${filterData.data.length} of ${scrapeData.data.length}`);

            if (filterData.data.length === 0) {
              addAutoLog(`   ℹ️  ${platform}: AI filter rejected all — try a different role/filter combo`);
              continue;
            }

            const platformName = PLATFORMS.find((p) => p.id === platform)?.name || platform;
            const today = new Date().toISOString().split("T")[0];
            const filtered: Job[] = filterData.data.map((j: Job) => ({
              ...j,
              platform: platformName,
              status: "new",
              capturedDate: today,
              emailsSent: 0,
            }));

            // STEP A: intra-batch dedup (collapse duplicates within this scrape batch first).
            //         Without this, if the actor returns 4 copies of the same role in one run
            //         and none exist yet in savedJobs, all 4 slip through → duplicate rows.
            const intraBatchUniqueM1: Job[] = [];
            for (const j of filtered) {
              if (!isDuplicate(j, intraBatchUniqueM1)) intraBatchUniqueM1.push(j);
            }
            // STEP B: dedup the unique batch against everything already saved.
            const snapForMethod1 = JSON.parse(localStorage.getItem("savedJobs") || "[]") as Job[];
            const toAddM1 = intraBatchUniqueM1.filter((j) => !isDuplicate(j, snapForMethod1));
            if (toAddM1.length === 0) {
              addAutoLog(`   ℹ️  ${platform}: 0 new (all duplicates)`);
            } else {
              stats.parsed += toAddM1.length;
              const droppedInBatch = filtered.length - intraBatchUniqueM1.length;
              const droppedAgainstSaved = intraBatchUniqueM1.length - toAddM1.length;
              addAutoLog(
                `   ✅ ${platform}: +${toAddM1.length} new` +
                  (droppedInBatch > 0 ? ` · ${droppedInBatch} intra-dup` : "") +
                  (droppedAgainstSaved > 0 ? ` · ${droppedAgainstSaved} prior-dup` : "")
              );
              setSavedJobs((prev) => {
                const stillNew = toAddM1.filter((j) => !isDuplicate(j, prev));
                const merged = [...prev, ...stillNew];
                localStorage.setItem("savedJobs", JSON.stringify(merged));
                return merged;
              });
            }
          } catch (e) {
            stats.errors++;
            addAutoLog(`   ❌ ${platform} error: ${(e as Error).message}`);
          }
          await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));
        }
        // Only set the 24h gate if we actually made it through scrape+filter at least once.
        // If every platform errored, retry next cycle instead of waiting a day.
        if (method1ReachedFilter) {
          localStorage.setItem(AUTO_METHOD1_LAST_KEY, String(Date.now()));
          addAutoLog(`🔎 Method 1 done · next scrape in 24h`);
        } else {
          addAutoLog(`⚠️  Method 1: all platforms errored — will retry next cycle (no 24h lock set)`);
        }
      }

      await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));

      // ============ STEP 1: Parse Gmail → save new jobs ============
      addAutoLog("📬 Parsing Gmail alerts...");
      try {
        const res = await fetch("/api/parse-gmail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxEmails: 100 }),
        });
        const data = await res.json();

        // Three distinct outcomes — keep them visually distinct in the log
        // so the user can tell "Gmail returned nothing" apart from "Gmail
        // call failed". Previously every non-happy path collapsed into
        // "no alerts found", masking real auth / API errors (e.g. the
        // reply-check step in the same cycle showed "Gmail not connected"
        // while this one just said "no alerts found").
        if (!data.success) {
          stats.errors++;
          addAutoLog(
            `❌ Gmail parse failed: ${data.error || data.detail || "unknown error"}`
          );
        } else if (!Array.isArray(data.data) || data.data.length === 0) {
          addAutoLog(`ℹ️  Gmail: ${data.message || "no alerts found in last 2 days"}`);
        } else {
          const today = new Date().toISOString().split("T")[0];
          const parsed: Job[] = data.data.map((j: Job) => ({
            ...j,
            matchScore: 100,
            status: "new",
            capturedDate: today,
            emailsSent: 0,
          }));

          // STEP A: intra-batch dedup — Gmail digest emails often repeat the same role
          //         multiple times (different timestamps / locations). Collapse within the
          //         batch first so 4× "Software Engineer_Python · bebo Technologies" → 1.
          const intraBatchUniqueGmail: Job[] = [];
          for (const j of parsed) {
            if (!isDuplicate(j, intraBatchUniqueGmail)) intraBatchUniqueGmail.push(j);
          }
          // STEP B: dedup against savedJobs already in localStorage.
          const snapForGmail = JSON.parse(localStorage.getItem("savedJobs") || "[]") as Job[];
          const toAddGmail = intraBatchUniqueGmail.filter((j) => !isDuplicate(j, snapForGmail));
          if (toAddGmail.length === 0) {
            addAutoLog(
              `ℹ️  Gmail: parsed ${parsed.length} job(s), all duplicates of saved`
            );
          } else {
            stats.parsed += toAddGmail.length;
            const droppedInBatch = parsed.length - intraBatchUniqueGmail.length;
            const droppedAgainstSaved = intraBatchUniqueGmail.length - toAddGmail.length;
            addAutoLog(
              `✅ Gmail: +${toAddGmail.length} new job(s)` +
                (droppedInBatch > 0 ? ` · ${droppedInBatch} intra-dup` : "") +
                (droppedAgainstSaved > 0 ? ` · ${droppedAgainstSaved} prior-dup` : "")
            );
            setSavedJobs((prev) => {
              const stillNew = toAddGmail.filter((j) => !isDuplicate(j, prev));
              const merged = [...prev, ...stillNew];
              localStorage.setItem("savedJobs", JSON.stringify(merged));
              return merged;
            });
          }
        }
      } catch (e) {
        stats.errors++;
        addAutoLog(`❌ Gmail parse failed: ${(e as Error).message}`);
      }

      await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));

      // ============ STEP 2: Enrich "new" jobs ============
      const snapshot1: Job[] = JSON.parse(localStorage.getItem("savedJobs") || "[]");
      const toEnrich = snapshot1
        .filter((j) => j.status === "new" && !j.enriched)
        .slice(0, AUTO_MAX_ENRICH);

      if (toEnrich.length === 0) {
        addAutoLog(`ℹ️  Enrich: nothing to process`);
      } else {
        addAutoLog(`🔍 Enrich: ${toEnrich.length} job(s) queued`);
      }

      for (const job of toEnrich) {
        const company = job.company?.replace(/\s*\(.*\)/, "").trim();
        if (!company || company === "N/A" || company === "Upwork Client") {
          addAutoLog(`⏭️  Skip (no company): "${job.title}"`);
          continue;
        }
        try {
          const isGmail = job.platform?.toLowerCase().includes("gmail");
          const res = await fetch("/api/enrich-lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyName: company,
              source: isGmail ? "gmail" : "search",
              // Persist enrichment back into jobs_v2 so it survives reloads.
              jobId: job.dbId ?? job.jobId ?? null,
            }),
          });
          const data = await res.json();
          if (data.success && data.data) {
            // Email-gated: only count + mark "enriched" when an email was
            // found. No email = dead lead, so skip it (server discards it too).
            const dmEmail = data.data?.candidates?.[0]?.email;
            const hasEmail = !!dmEmail && dmEmail !== "N/A";
            if (hasEmail) {
              setSavedJobs((prev) => {
                const updated = [...prev];
                const idx = updated.findIndex((j) => matchJob(j, job));
                if (idx >= 0) {
                  updated[idx] = {
                    ...updated[idx],
                    enriched: data.data,
                    status: updated[idx].status === "new" ? "enriched" : updated[idx].status,
                  };
                  localStorage.setItem("savedJobs", JSON.stringify(updated));
                }
                return updated;
              });
              stats.enriched++;
              addAutoLog(`✅ Enriched: ${company} (${dmEmail})`);
            } else {
              addAutoLog(`⏭️  No email — skipped: ${company}`);
            }
          } else {
            addAutoLog(`⚠️  Enrich empty: ${company}`);
          }
        } catch (e) {
          stats.errors++;
          addAutoLog(`❌ Enrich failed (${company}): ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));
      }

      // ============ STEP 3: Reply check (Gmail thread poll) ============
      // MUST run before sending follow-ups so we don't email someone who already replied.
      const snapshotForReply: Job[] = JSON.parse(localStorage.getItem("savedJobs") || "[]");
      const unrepliedWithThread = snapshotForReply
        .filter((j) => !!j.lastThreadId && !j.hasReplied)
        .slice(0, AUTO_MAX_REPLY_CHECK);

      if (unrepliedWithThread.length === 0) {
        addAutoLog(`ℹ️  Reply check: nothing to poll`);
      } else {
        addAutoLog(`🔎 Reply check: ${unrepliedWithThread.length} thread(s)`);
        try {
          const res = await fetch("/api/check-replies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadIds: unrepliedWithThread.map((j) => j.lastThreadId),
            }),
          });
          const data = await res.json();
          if (data.success) {
            const repliedIds = new Set<string>(data.data?.repliedThreadIds || []);
            if (repliedIds.size > 0) {
              setSavedJobs((prev) => {
                const updated = prev.map((j) => {
                  if (j.lastThreadId && repliedIds.has(j.lastThreadId) && !j.hasReplied) {
                    const lastStage = j.stagesSent?.[j.stagesSent.length - 1];
                    return {
                      ...j,
                      hasReplied: true,
                      repliedAt: new Date().toISOString(),
                      repliedAfterStage: lastStage,
                      status: "replied",
                    };
                  }
                  return j;
                });
                localStorage.setItem("savedJobs", JSON.stringify(updated));
                return updated;
              });
              stats.replied += repliedIds.size;
              addAutoLog(`💬 Replies detected: ${repliedIds.size}`);
            } else {
              addAutoLog(`🔎 Reply check: 0 replies`);
            }
          } else {
            addAutoLog(`⚠️  Reply check failed: ${data.error}`);
          }
        } catch (e) {
          stats.errors++;
          addAutoLog(`❌ Reply check error: ${(e as Error).message}`);
        }
      }

      await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));

      // ============ STEP 4: DISABLED — manual-send phase ============
      // Auto-send (Stage 1 / 2 / 3) was burning through the daily cap before
      // the user could observe responses. Dashboard auto-mode now stops at
      // enrichment; the Smart Send button on each row drives sends manually.
      // The same change is mirrored on the cron side via ?skipSend=true.
      //
      // To re-enable auto-send: restore the multi-stage block from git
      // (commit before this change). Logic untouched, just gated off.
      addAutoLog(`⏸  Auto-send disabled (manual-testing phase) — use Smart Send button per row`);
      /* DISABLED — auto multi-stage send block
      const snapshot2: Job[] = JSON.parse(localStorage.getItem("savedJobs") || "[]");
      const now = Date.now();
      const candidates: Array<{ job: Job; stage: number }> = [];

      for (const j of snapshot2) {
        if (j.hasReplied) continue;
        if (!j.enriched) continue;
        const best = j.enriched?.candidates?.[j.enriched?.selectedCandidateIndex ?? 0];
        const email = best?.email || j.email;
        if (!email || email === "N/A" || email.trim() === "") continue;

        const stagesSent = j.stagesSent || [];
        const lastAt = j.lastEmailSentAt ? new Date(j.lastEmailSentAt).getTime() : 0;

        if (!stagesSent.includes(1)) {
          candidates.push({ job: j, stage: 1 });
        } else if (!stagesSent.includes(2) && now - lastAt >= FOLLOWUP_GAP_MS_STAGE2) {
          candidates.push({ job: j, stage: 2 });
        } else if (stagesSent.includes(2) && !stagesSent.includes(3) && now - lastAt >= FOLLOWUP_GAP_MS_STAGE3) {
          candidates.push({ job: j, stage: 3 });
        }
      }

      const alreadyToday = getDailySent();
      const dailyRemaining = Math.max(0, AUTO_DAILY_SEND_CAP - alreadyToday);
      const cycleQuota = Math.min(AUTO_MAX_SEND, dailyRemaining);
      const toSend = candidates.slice(0, cycleQuota);

      if (dailyRemaining === 0) {
        addAutoLog(`🚫 Daily cap hit (${alreadyToday}/${AUTO_DAILY_SEND_CAP}) — sends paused until midnight`);
      } else if (toSend.length === 0) {
        addAutoLog(`ℹ️  Send: nothing due (today ${alreadyToday}/${AUTO_DAILY_SEND_CAP})`);
      } else {
        const breakdown = toSend.reduce<Record<number, number>>((acc, c) => {
          acc[c.stage] = (acc[c.stage] || 0) + 1;
          return acc;
        }, {});
        const parts = Object.entries(breakdown).map(([s, n]) => `${n}×S${s}`).join(" ");
        addAutoLog(`📧 Send: ${toSend.length} queued (${parts}) · today ${alreadyToday}/${AUTO_DAILY_SEND_CAP}`);
      }

      for (const { job, stage } of toSend) {
        const best = job.enriched?.candidates?.[job.enriched?.selectedCandidateIndex ?? 0];
        const email = best?.email || job.email;
        const company = job.company?.replace(/\s*\(.*\)/, "").trim();
        const stageLabel = stage === 1 ? "Trigger" : stage === 2 ? "Case Study" : "Breakup";

        try {
          const genRes = await fetch("/api/generate-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job, contactName: best?.name, companyName: company, stage }),
          });
          const genData = await genRes.json();
          if (!genData.success || !genData.data) {
            stats.errors++;
            addAutoLog(`❌ Generate failed (S${stage} ${stageLabel}): ${company}`);
            continue;
          }

          const sendRes = await fetch("/api/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: email,
              subject: genData.data.subject,
              body: genData.data.body,
              stage,
              jobId: job.dbId ?? null,
              threadId: stage > 1 ? job.lastThreadId ?? null : null,
            }),
          });
          const sendData = await sendRes.json();
          if (sendData.success) {
            const threadId = sendData.data?.threadId as string | undefined;
            const trackingId = sendData.data?.trackingId as string | undefined;
            setSavedJobs((prev) => {
              const updated = [...prev];
              const idx = updated.findIndex((j) => matchJob(j, job));
              if (idx >= 0) {
                const existing = updated[idx];
                updated[idx] = {
                  ...existing,
                  status: "contacted",
                  emailsSent: (existing.emailsSent || 0) + 1,
                  stagesSent: Array.from(new Set([...(existing.stagesSent || []), stage])),
                  lastThreadId: threadId || existing.lastThreadId,
                  trackingId: trackingId || existing.trackingId,
                  lastEmailSentAt: new Date().toISOString(),
                  lastContactedAt: new Date().toISOString().split("T")[0],
                };
                localStorage.setItem("savedJobs", JSON.stringify(updated));
              }
              return updated;
            });
            stats.sent++;
            const newDaily = incrementDailySent();
            addAutoLog(`✅ Sent S${stage} ${stageLabel}: ${company} → ${email} · today ${newDaily}/${AUTO_DAILY_SEND_CAP}`);
          } else {
            stats.errors++;
            addAutoLog(`❌ Send failed (S${stage} ${stageLabel}, ${company}): ${sendData.error}`);
          }
        } catch (e) {
          stats.errors++;
          addAutoLog(`❌ Pipeline error (S${stage} ${company}): ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, AUTO_STEP_DELAY_MS));
      }
      */

      addAutoLog(
        `🏁 Cycle end · +${stats.parsed} parsed · +${stats.enriched} enriched · +${stats.sent} sent · +${stats.replied} replied · ${stats.errors} errors`
      );
      setAutoStats((prev) => ({
        parsed: prev.parsed + stats.parsed,
        enriched: prev.enriched + stats.enriched,
        sent: prev.sent + stats.sent,
        replied: (prev.replied || 0) + stats.replied,
        errors: prev.errors + stats.errors,
      }));
    } finally {
      autoRunningRef.current = false;
      setAutoStatus("idle");
      setAutoNextRunAt(Date.now() + AUTO_INTERVAL_MS);
    }
  }, [addAutoLog]);

  // Auto mode ON/OFF effect
  useEffect(() => {
    if (autoMode) {
      addAutoLog(`🤖 Auto Mode ON — interval ${AUTO_INTERVAL_MS / 60000} min`);
      setAutoNextRunAt(Date.now() + AUTO_INTERVAL_MS);
      // Run first cycle immediately
      runAutoPipeline();
      // Then every interval
      autoTimerRef.current = setInterval(() => {
        runAutoPipeline();
      }, AUTO_INTERVAL_MS);
    } else {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      setAutoNextRunAt(null);
      addAutoLog(`🛑 Auto Mode OFF`);
    }
    return () => {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode]);


  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (platformDropdownRef.current && !platformDropdownRef.current.contains(e.target as Node))
        setPlatformDropdownOpen(false);
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(e.target as Node))
        setRoleDropdownOpen(false);
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node))
        setFilterDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const togglePlatform = (id: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const toggleFilter = (filter: string) => {
    setSelectedFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter]
    );
  };

  const handleSearch = async () => {
    if (selectedPlatforms.length === 0 || selectedRoles.length === 0) {
      setError("Please select at least one platform and one job role!");
      return;
    }

    setError("");
    setInfo("");
    setJobs([]);
    setLoading(true);

    const collectedJobs: Job[] = [];
    const errors: string[] = [];
    const infos: string[] = [];

    // Sequential: scrape each platform one by one, show results as they come
    for (const platform of selectedPlatforms) {
      const platformName = PLATFORMS.find((p) => p.id === platform)?.name || platform;

      try {
        // Step 1 — Scrape (Upwork uses direct scraper, others use Apify)
        setStep(`🔍 Scraping jobs from ${platformName}... (${collectedJobs.length} jobs found so far)`);

        const endpointMap: Record<string, string> = {
          upwork: "/api/scrape-upwork",
          remoteok: "/api/scrape-remoteok",
        };
        const scrapeEndpoint = endpointMap[platform] || "/api/scrape-jobs";
        const scrapeRes = await fetch(scrapeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform, roles: selectedRoles, filters: selectedFilters }),
        });
        const scrapeData = await scrapeRes.json();

        if (!scrapeData.success) {
          errors.push(`${platformName}: ${scrapeData.error}`);
          continue;
        }
        if (!scrapeData.data || scrapeData.data.length === 0) {
          const msg = scrapeData.message || `${platformName}: No jobs found`;
          if (platform === "upwork") {
            infos.push(msg);
          } else {
            errors.push(msg);
          }
          continue;
        }

        console.log(`[${platformName}] Scraped ${scrapeData.data.length} jobs`);

        // Step 2 — AI Filter
        setStep(`✨ AI filtering ${platformName} results... (${collectedJobs.length} jobs found so far)`);

        const filterRes = await fetch("/api/filter-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobs: scrapeData.data,
            roles: selectedRoles,
            filters: selectedFilters,
            platform,
          }),
        });
        const filterData = await filterRes.json();

        if (!filterData.success) {
          errors.push(`${platformName}: Filter failed`);
          continue;
        }

        const platformJobs = filterData.data.map((job: Job) => ({
          ...job,
          platform: platformName,
        }));

        console.log(`[${platformName}] Filtered to ${platformJobs.length} jobs`);
        collectedJobs.push(...platformJobs);

        // Show results progressively — user sees jobs from each platform as they come in
        const sorted = [...collectedJobs].sort((a, b) => b.matchScore - a.matchScore);
        setJobs(sorted);
      } catch (err) {
        errors.push(`${platformName}: ${err instanceof Error ? err.message : "Failed"}`);
        continue;
      }
    }

    if (infos.length > 0) {
      setInfo(infos.join(" | "));
    }

    if (collectedJobs.length === 0 && errors.length > 0) {
      setError(`No matching jobs found. ${errors.join(" | ")}`);
    } else if (collectedJobs.length === 0 && infos.length > 0 && errors.length === 0) {
      // Only Upwork-style info, no hard error
      setInfo(infos.join(" | "));
    } else if (errors.length > 0) {
      setError(`Some platforms had issues: ${errors.join(" | ")}`);
    }

    setStep("");
    setLoading(false);
  };

  // Gmail Methods
  const checkGmailAuth = async () => {
    try {
      const res = await fetch("/api/gmail-auth");
      const data = await res.json();
      if (data.authenticated) {
        setGmailConnected(true);
      }
      return data;
    } catch { return { authenticated: false }; }
  };

  const connectGmail = async () => {
    const data = await checkGmailAuth();
    if (data.authenticated) {
      setGmailConnected(true);
      setGmailMessage("Gmail already connected!");
    } else if (data.authUrl) {
      window.open(data.authUrl, "_self");
    }
  };

  // Source-specific handler for the RemoteOK platform. Hits the free
  // RemoteOK API directly (no Gmail involvement) and persists the same
  // way LinkedIn alert jobs land in the dashboard, so the All Jobs table
  // and downstream enrichment treat them identically. Roles default to
  // the same broad set the Auto-Scrape pipeline uses; `filters:["Remote"]`
  // makes the backend keep only remote-tagged listings.
  const runScrapeRemoteOK = async () => {
    setGmailLoading(true);
    setGmailMessage("");
    setGmailJobs([]);
    try {
      // Same saveToDb=false rationale as the manual Gmail parse path:
      // the user picks what to save from the result list rather than the
      // backend persisting everything up front.
      //
      // RemoteOK target: every modern web / backend / mobile stack the
      // dashboard's "Set Technologies" panel surfaces. No location field
      // → backend skips the geo filter; the 3-layer role+spam filter is
      // what keeps the result set on real developer / engineer titles.
      const res = await fetch("/api/scrape-remoteok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roles: [
            "React Developer",
            "Node.js Developer",
            "Next.js Developer",
            "MERN Stack Developer",
            "JavaScript Developer",
            "TypeScript Developer",
            "Angular Developer",
            "Vue.js Developer",
            "Python Developer",
            "Django Developer",
            "Java Developer",
            "Spring Boot Developer",
            "PHP Developer",
            "Laravel Developer",
            ".NET Developer",
            "C# Developer",
            "Go Developer",
            "Ruby on Rails Developer",
            "React Native Developer",
            "Flutter Developer",
            "AI/ML Engineer",
            "Backend Developer",
            "Frontend Developer",
          ],
          filters: ["Remote"],
          saveToDb: false,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setGmailMessage(
          `RemoteOK scrape failed: ${data.error || "unknown error"}`
        );
      } else if (Array.isArray(data.data) && data.data.length > 0) {
        const jobsWithScore = data.data.map((j: Job) => ({
          ...j,
          matchScore: 100,
        }));
        const unique: Job[] = [];
        for (const j of jobsWithScore) {
          if (!isDuplicate(j, unique)) unique.push(j);
        }
        setGmailJobs(unique);
        const removed = jobsWithScore.length - unique.length;
        setGmailMessage(
          removed > 0
            ? `Found ${unique.length} jobs from RemoteOK (${removed} duplicate${
                removed > 1 ? "s" : ""
              } removed)`
            : `Found ${unique.length} jobs from RemoteOK`
        );
      } else {
        setGmailMessage(data.message || "No matching RemoteOK jobs found");
      }
    } catch (err) {
      setGmailMessage(`Error: ${err}`);
    } finally {
      setGmailLoading(false);
      refreshActivity();
      fetch("/api/settings")
        .then((r) => r.json())
        .then((d) => {
          if (d.success && d.data?.last_scrape_at)
            setLastScrapeAt(d.data.last_scrape_at);
        })
        .catch(() => {});
    }
  };

  // Run Scrape Now's single entry point — branches on the Platform dropdown
  // so the same button drives the right pipeline for the user's choice.
  // LinkedIn (and Indeed/Upwork as future Gmail-backed sources) still go
  // through the Gmail parser; RemoteOK skips Gmail entirely and uses the
  // public API. Other platforms fall back to the Gmail path until they get
  // their own dedicated source.
  const runScrapeNow = () => {
    if (scrapeSettings.platform === "remoteok") {
      return runScrapeRemoteOK();
    }
    return parseGmailAlerts();
  };

  const parseGmailAlerts = async () => {
    setGmailLoading(true);
    setGmailMessage("");
    setGmailJobs([]);
    try {
      // maxEmails=100 — Gmail API per-page cap. The frontend date filter is
      // currently hidden so we don't pass `date`; the backend defaults to
      // its built-in window (today IST), which is what we want for the
      // standard "scrape today's alerts" flow.
      // Manual "Run Scrape Now" — saveToDb=false so the user gets to
      // curate the result list with per-row Save / Save All instead of
      // everything silently landing in jobs_v2. Cron + Auto-Scrape keep
      // the default true behaviour because they hit /api/parse-gmail
      // directly without this flag.
      const res = await fetch("/api/parse-gmail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxEmails: 100, saveToDb: false }),
      });
      const data = await res.json();
      if (!data.success) {
        // Surface the real backend error instead of swallowing it under a
        // generic "No job alerts found" — that wording was misleading
        // when the actual failure was Gmail auth, a token refresh, etc.
        setGmailMessage(
          `Gmail parse failed: ${data.error || data.detail || "unknown error"}`
        );
      } else if (data.data?.length > 0) {
        const jobsWithScore = data.data.map((j: Job) => ({ ...j, matchScore: 100 }));

        // Dedupe within parse results — same jobId / URL / title+company
        const unique: Job[] = [];
        for (const j of jobsWithScore) {
          if (!isDuplicate(j, unique)) unique.push(j);
        }

        setGmailJobs(unique);
        const removed = jobsWithScore.length - unique.length;
        setGmailMessage(
          removed > 0
            ? `Found ${unique.length} jobs (${removed} duplicate${removed > 1 ? "s" : ""} removed)`
            : `Found ${unique.length} jobs from LinkedIn alerts`
        );
      } else {
        setGmailMessage(data.message || "No job alerts found");
      }
    } catch (err) {
      setGmailMessage(`Error: ${err}`);
    } finally {
      setGmailLoading(false);
      // Refresh the activity feed + last_scrape_at so the Recent
      // Activity panel and the "Last Run" hero stat reflect the just-
      // -finished scrape without a full page reload.
      refreshActivity();
      fetch("/api/settings")
        .then((r) => r.json())
        .then((d) => {
          if (d.success && d.data?.last_scrape_at)
            setLastScrapeAt(d.data.last_scrape_at);
        })
        .catch(() => {});
    }
  };

  // Check Gmail auth on page load
  useEffect(() => {
    checkGmailAuth();
  }, []);

  // Multi-Gmail: load the configured account slots + current selection from
  // settings on mount, then refresh the slot list whenever we return from
  // an OAuth callback (Google redirects back with ?gmail=connected&label=…).
  useEffect(() => {
    fetchGmailSlots();
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (
          d?.success &&
          typeof d?.data?.parse_gmail_selection === "string"
        ) {
          setParseSelection(d.data.parse_gmail_selection);
        }
      })
      .catch(() => {});

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("gmail") === "connected") {
        // Re-fetch slot list so the newly-connected account flips to "is_connected".
        fetchGmailSlots();
        // Strip the OAuth query params so refreshing the page doesn't loop.
        window.history.replaceState({}, "", window.location.pathname);
      }
    }
  }, [fetchGmailSlots]);

  // Auto-correct the parse selection whenever connected accounts change.
  // Two cases handle different user mistakes:
  //   1. Persisted selection is "both" but only one account is actually
  //      connected — switch to that connected label so the dropdown reflects
  //      what will really be read on Run Scrape Now.
  //   2. Persisted selection points to a label that just got disconnected —
  //      fall back to whichever account is still connected (or "both" when
  //      multiple remain).
  useEffect(() => {
    if (gmailSlots.length === 0) return;
    const connected = gmailSlots.filter((s) => s.is_connected);
    if (connected.length === 0) return;

    const selectedIsValid =
      parseSelection === "both"
        ? connected.length >= 2
        : connected.some((s) => s.label === parseSelection);

    if (selectedIsValid) return;

    const next =
      connected.length === 1 ? connected[0].label : "both";
    setParseSelection(next);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parse_gmail_selection: next }),
    }).catch((err) =>
      console.warn("[settings] selection auto-correct sync failed:", err)
    );
  }, [gmailSlots, parseSelection]);

  // Clear scraped Gmail jobs when leaving the Gmail sub-tab inside Scrape
  // Jobs (or leaving the page entirely). Avoids stale results bleeding
  // into a fresh search session.
  useEffect(() => {
    if (activePage !== "scrape" || scrapeMethod !== "gmail") {
      setGmailJobs([]);
      setGmailMessage("");
    }
  }, [activePage, scrapeMethod]);

  // Reset the All Jobs page when any filter / search query changes —
  // otherwise a user filtering down to 5 results while sitting on page 4
  // sees an empty table.
  useEffect(() => {
    setCurrentJobsPage(1);
  }, [savedSearch, savedFilterPlatform, savedFilterStatus, savedFilterEmail, savedFilterScrapedDate]);

  // Mobile sidebar init + auto-close-on-nav both moved to the
  // Sidebar component / DashboardContext provider.

  // (Removed: on-mount fetch of /api/rocketreach-lookup. That fetch
  // only existed to populate the RocketReach credit pill, which has
  // been deleted from the UI.)

  // URL <-> activePage sync removed. Each tab is now its own route
  // (/, /jobs, /analytics) and the pathname hook above derives
  // activePage on every navigation, so no manual mirroring is needed.

  // Hydrate the Scrape page from /api/settings — both the read-only
  // last_scrape_at and the user-editable knobs. Falls back to the
  // useState defaults if the row hasn't been migrated yet.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success || !d.data) return;
        if (d.data.last_scrape_at) setLastScrapeAt(d.data.last_scrape_at);
        const platformRaw = (d.data.platform_filter as string | null) ?? "linkedin";
        const platform: "linkedin" | "indeed" | "upwork" =
          platformRaw === "indeed" || platformRaw === "upwork"
            ? platformRaw
            : "linkedin";
        const timesRaw = d.data.daily_schedule_times;
        const scheduleTimes = Array.isArray(timesRaw)
          ? (timesRaw as unknown[]).filter(
              (t): t is string =>
                typeof t === "string" && /^\d{2}:\d{2}$/.test(t)
            )
          : [];
        const techRaw = d.data.technologies;
        setScrapeSettings({
          maxEmails: (d.data.max_emails_per_run as number) ?? 25,
          platform,
          scheduleTimes,
          technologies: Array.isArray(techRaw) ? (techRaw as string[]) : [],
        });
      })
      .catch(() => {});
  }, []);

  // Activity log — fetched on mount + after each scrape so the panel
  // reflects the canonical DB state, not just in-memory savedJobs.
  const refreshActivity = useCallback(() => {
    fetch("/api/activity")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && Array.isArray(d.entries)) setActivityLog(d.entries);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshActivity();
  }, [refreshActivity]);

  const saveScrapeSettings = async () => {
    setScrapeSettingsSaving(true);
    setScrapeSettingsError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_emails_per_run: scrapeSettings.maxEmails,
          platform_filter: scrapeSettings.platform,
          daily_schedule_times: scrapeSettings.scheduleTimes,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setScrapeSettingsError(json.error || "Save failed");
        return;
      }
      setScrapeSettingsSaved(true);
      setTimeout(() => setScrapeSettingsSaved(false), 2000);
    } catch (err) {
      setScrapeSettingsError(String(err));
    } finally {
      setScrapeSettingsSaving(false);
    }
  };

  // Separate save for the "Set Technologies" panel — posts ONLY the
  // technologies list, so it is fully independent of "Save Settings".
  const saveTechnologies = async () => {
    setTechSaving(true);
    setTechError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ technologies: scrapeSettings.technologies }),
      });
      const json = await res.json();
      if (!json.success) {
        setTechError(json.error || "Save failed");
        return;
      }
      setTechSaved(true);
      setTimeout(() => setTechSaved(false), 2000);
    } catch (err) {
      setTechError(String(err));
    } finally {
      setTechSaving(false);
    }
  };

  // (Manual rocketReachReEnrich removed — RR Lookup now fires automatically inside
  //  /api/enrich-lead when website scraping yields no email AND credits remain. The
  //  "🚀 RR" button is gone; the badge in the top bar still shows credits remaining.)

  const isJobSaved = (job: Job) =>
    savedJobs.some((s) => s.title === job.title && s.company === job.company);

  // Apply Search + Method + Status + Email filters once, reuse for the
  // table and pagination. Memo'd so we don't re-run the predicate on
  // every render (just when the inputs change).
  // Compare a job's stored date string against the date picked in the
  // filter. Both are normalised to YYYY-MM-DD so timezone-shifted ISO
  // strings (e.g. "2026-05-14T18:30:00Z") still match a 2026-05-14 pick.
  // Empty filter = no constraint.
  const matchesPickedDate = (dateStr: string | undefined, picked: string): boolean => {
    if (!picked) return true;
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}` === picked;
  };

  // Pure CTA badge texts that should never be a job title — kept here as
  // a defensive frontend filter so existing garbage rows that the older
  // Gmail parser saved ("Easy Apply", "Apply Now", "Actively recruiting",
  // …) stop showing up in the All Jobs table without requiring the user
  // to manually SQL-delete them. The new parser already rejects these
  // at extraction time; this is belt-and-suspenders for backfill rows.
  const PURE_CTA_TITLES_FE = new Set([
    "easy apply",
    "apply now",
    "apply",
    "save",
    "view",
    "view job",
    "see job",
    "actively recruiting",
    "promoted",
    "reposted",
    "featured",
    "new",
  ]);
  const filteredSavedJobs = (() => {
    const search = savedSearch.toLowerCase().trim();
    // Sort key for the table: capturedDate (= jobs_v2.scraped_at) descending,
    // so the table always shows the scrape sequence — newest scrape's jobs on
    // top, inbox order within a scrape (jobs-persist steps scraped_at down per
    // job). savedJobs itself drifts out of order because local scrape-merges
    // append fresh rows to the end; this sort is the single source of truth.
    // A date-only capturedDate (a row merged in THIS session, before its
    // /api/jobs round-trip) is padded to the last moment of its day so it
    // still sorts above same-day rows that already carry a full timestamp.
    const sortKey = (j: Job) => {
      const c = j.capturedDate || "";
      return c.length === 10 ? `${c}T99` : c;
    };
    return savedJobs.filter((job) => {
      // Drop garbage CTA-only-titled rows up front. These show up in
      // the table as bare "Easy Apply" strings with no company/location
      // because the older parser accepted them as job titles.
      const titleTrimmed = (job.title || "").trim().toLowerCase();
      if (PURE_CTA_TITLES_FE.has(titleTrimmed)) return false;
      if (search) {
        const candidate = job.enriched?.candidates?.[0];
        const haystack = [
          job.title,
          job.company,
          job.jobId || "",
          job.location,
          candidate?.name || "",
          candidate?.title || "",
          candidate?.email || "",
          job.email || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (savedFilterPlatform !== "all") {
        // Match on the job's source platform. DB rows carry lowercase
        // ("linkedin" / "remoteok"); rows freshly merged this session carry
        // the display name ("LinkedIn" / "RemoteOK"). Normalise to
        // letters-only lowercase so both forms compare cleanly.
        const p = (job.platform || "").toLowerCase().replace(/[^a-z]/g, "");
        if (savedFilterPlatform === "linkedin" && !p.includes("linkedin")) return false;
        if (savedFilterPlatform === "remoteok" && !p.includes("remoteok")) return false;
      }
      if (savedFilterStatus !== "all") {
        if (aliasStatus(job.status) !== savedFilterStatus) return false;
      }
      if (savedFilterEmail !== "all") {
        const candidate = job.enriched?.candidates?.[0];
        const email = candidate?.email || job.email;
        const hasEmail = email && email !== "N/A";
        if (savedFilterEmail === "with" && !hasEmail) return false;
        if (savedFilterEmail === "without" && hasEmail) return false;
      }
      // Scraped date pick (job.capturedDate — when WE captured it).
      if (savedFilterScrapedDate) {
        if (!matchesPickedDate(job.capturedDate, savedFilterScrapedDate)) return false;
      }
      return true;
    }).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  })();

  const totalJobsPages = Math.max(
    1,
    Math.ceil(filteredSavedJobs.length / JOBS_PAGE_SIZE)
  );

  // Bound the active page if the filtered set shrinks (e.g. user toggled
  // filters and there are now fewer pages than the page they were on).
  const activeJobsPage = Math.min(currentJobsPage, totalJobsPages);
  const pageStart = (activeJobsPage - 1) * JOBS_PAGE_SIZE;
  const pagedJobs = filteredSavedJobs.slice(pageStart, pageStart + JOBS_PAGE_SIZE);

  // Map each visible row back to its original savedJobs index so the
  // existing checkbox / removeJob logic (which is index-based) works
  // unchanged.
  const savedJobsIndex = (job: Job) => savedJobs.indexOf(job);

  // ─── Scrape page (Gmail) — derived stats / activity ───────────────────
  const todayKey = new Date().toISOString().split("T")[0];
  // capturedDate is a mix of full ISO timestamps (from /api/jobs) and
  // bare YYYY-MM-DD strings (locally merged) — compare just the date prefix.
  const todayCount = savedJobs.filter(
    (j) => (j.capturedDate || "").slice(0, 10) === todayKey
  ).length;
  const lastRunLabel = (() => {
    if (!lastScrapeAt) return "—";
    const d = new Date(lastScrapeAt);
    const datePart = d.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
    });
    const timePart = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${datePart}, ${timePart}`;
  })();
  // Activity log lives in `activityLog` state (fed from /api/activity).

  // Reusable JSX for the Scrape page — both Via Search and Via Gmail tabs
  // render the same Recent Activity panel and Scrape Settings panel.
  // Defined here (not extracted as components) so closures over the
  // state setters / handlers stay simple.
  const recentActivityPanel = (
    <div className="surface p-[22px]">
      <h2 className="text-[14px] font-semibold tracking-[-0.01em] mb-3.5">
        Recent Activity
      </h2>
      {activityLog.length === 0 ? (
        <p className="text-[12px] text-[color:var(--muted-2)]">
          No activity yet. Run a scrape to see entries here.
        </p>
      ) : (
        <div>
          {activityLog.map((entry, i) => {
            // Per-kind glyph: scrape entries get a download/inbox icon,
            // send entries get a paper-plane. Color matches the kind so
            // the eye can scan the log without reading every line.
            const isSend = entry.kind === "send";
            return (
              <div
                key={i}
                className={`flex items-center gap-3 py-2.5 text-[12px] ${
                  i < activityLog.length - 1
                    ? "border-b border-dashed border-[var(--border)]"
                    : ""
                }`}
              >
                <span
                  className={`w-7 h-7 inline-flex items-center justify-center rounded-md shrink-0 ${
                    isSend
                      ? "bg-blue-500/10 text-blue-400"
                      : "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                  }`}
                  aria-hidden="true"
                >
                  {isSend ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  )}
                </span>
                <span className="text-[11px] text-[color:var(--muted-2)] font-mono w-16 shrink-0">
                  {entry.time}
                </span>
                <span className="text-[color:var(--muted)] truncate">
                  {entry.label} —{" "}
                  <strong className="text-[color:var(--text)] font-medium">
                    {isSend
                      ? `${entry.count} email${entry.count === 1 ? "" : "s"}`
                      : `+${entry.count} new jobs`}
                  </strong>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // Technologies offered in the "Set Technologies" multi-select — the
  // common stacks/roles a LinkedIn job alert is usually configured for.
  const TECH_OPTIONS = [
    "React.js", "Node.js", "Next.js", "MERN Stack", "JavaScript",
    "TypeScript", "Angular", "Vue.js", "Python", "Django",
    "Java", "Spring Boot", "PHP", "Laravel", ".NET", "C#",
    "Go", "Ruby on Rails", "React Native", "Flutter",
    "AI / ML Engineer", "AI Developer", "Data Scientist", "DevOps", "WordPress",
    "GraphQL", "Full Stack Developer", "Backend Developer",
    "Frontend Developer",
  ];

  const scrapeSettingsPanel = (
    <div className="flex flex-col gap-4 self-start">
    <div className="surface p-[22px]">
      <h2 className="text-[14px] font-semibold tracking-[-0.01em]">
        Scrape Settings
      </h2>
      <p className="text-[12.5px] text-[color:var(--muted)] mt-1.5">
        Tune how the scraper reads your inbox.
      </p>

      <div className="mt-4">
        <label className="block text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)] mb-1.5">
          Max emails per run
        </label>
        <input
          type="number"
          min={1}
          max={200}
          value={scrapeSettings.maxEmails}
          onChange={(e) =>
            setScrapeSettings({
              ...scrapeSettings,
              maxEmails: Number(e.target.value) || 0,
            })
          }
          className="w-full px-3 py-2 rounded-md bg-[var(--surface)] border border-[var(--border)] text-[13px] focus:outline-none focus:border-[color:var(--accent)] transition-colors"
        />
      </div>

      <div className="mt-4">
        <label className="block text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)] mb-1.5">
          Platform
        </label>
        <select
          value={scrapeSettings.platform}
          onChange={(e) =>
            setScrapeSettings({
              ...scrapeSettings,
              platform: e.target.value as
                | "linkedin"
                | "indeed"
                | "upwork"
                | "remoteok",
            })
          }
          className="w-full px-3 py-2 rounded-md bg-[var(--surface)] border border-[var(--border)] text-[13px] cursor-pointer focus:outline-none focus:border-[color:var(--accent)] transition-colors"
        >
          <option value="linkedin">LinkedIn</option>
          <option value="remoteok">RemoteOK</option>
          <option value="indeed">Indeed</option>
          <option value="upwork">Upwork</option>
        </select>
      </div>

      <div className="mt-4">
        <label className="block text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)] mb-1.5">
          Daily schedule
        </label>
        {/* Multi-select grid — every selected time becomes an IST slot the
            daily cron-scrape workflow fires on. Empty = scheduler disabled,
            same as the old "Disabled (manual only)" option. */}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { value: "09:30", label: "9:30 AM" },
            { value: "10:00", label: "10:00 AM" },
            { value: "10:30", label: "10:30 AM" },
            { value: "12:30", label: "12:30 PM" },
            { value: "13:30", label: "1:30 PM" },
            { value: "14:30", label: "2:30 PM" },
            { value: "16:00", label: "4:00 PM" },
            { value: "16:30", label: "4:30 PM" },
            { value: "17:00", label: "5:00 PM" },
            { value: "18:00", label: "6:00 PM" },
            { value: "18:15", label: "6:15 PM" },
            { value: "18:30", label: "6:30 PM" },
            { value: "18:45", label: "6:45 PM" },
            { value: "19:00", label: "7:00 PM" },
          ].map((opt) => {
            const checked = scrapeSettings.scheduleTimes.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setScrapeSettings({
                    ...scrapeSettings,
                    scheduleTimes: checked
                      ? scrapeSettings.scheduleTimes.filter(
                          (t) => t !== opt.value
                        )
                      : [...scrapeSettings.scheduleTimes, opt.value].sort(),
                  });
                }}
                className={`text-[12px] px-2 py-1.5 rounded-md border transition-colors cursor-pointer ${
                  checked
                    ? "bg-[var(--accent-soft)] border-[color:var(--accent)] text-[color:var(--accent)]"
                    : "bg-[var(--surface-2)] border-[var(--border)] text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-[10.5px] text-[color:var(--muted-2)] mt-2 leading-snug">
          {scrapeSettings.scheduleTimes.length === 0
            ? "Scheduler disabled — manual / Auto-Scrape only."
            : `${scrapeSettings.scheduleTimes.length} time${
                scrapeSettings.scheduleTimes.length === 1 ? "" : "s"
              } selected — daily auto-scrape will fire at each (IST).`}
        </p>
      </div>

      <button
        onClick={saveScrapeSettings}
        disabled={scrapeSettingsSaving}
        className="w-full justify-center mt-[22px] inline-flex items-center gap-2 px-3.5 py-2.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {scrapeSettingsSaving
          ? "Saving…"
          : scrapeSettingsSaved
          ? "✓ Saved"
          : "Save Settings"}
      </button>
      {scrapeSettingsError && (
        <p className="text-[11px] text-red-400 mt-2 leading-snug">
          {scrapeSettingsError}
        </p>
      )}
      <p className="text-[11px] text-[color:var(--muted-2)] mt-2 leading-snug">
        Settings sync to the database. Schedule changes take effect on
        the next cron fire (7 AM and 8 AM IST UTC triggers; the gate
        picks the configured one).
      </p>

    </div>

    {/* ─── Set Technologies (separate card — DB record only) ─────────
        Multi-select of the technologies the user's LinkedIn job alerts
        are set for. Selection is persisted to settings.technologies and
        re-hydrated on next dashboard load — no other side effects. */}
    <div className="surface p-[22px]">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[color:var(--muted-2)] mb-2">
        Set Technologies
      </h3>
      <p className="text-[12.5px] text-[color:var(--muted)] leading-snug mb-3">
        Pick the technologies your LinkedIn job alerts are set for, then
        save — the dashboard keeps a record of what you&apos;re tracking.
      </p>
      <div className="flex flex-wrap gap-2">
        {TECH_OPTIONS.map((tech) => {
          const selected = scrapeSettings.technologies.includes(tech);
          return (
            <button
              key={tech}
              type="button"
              onClick={() =>
                setScrapeSettings((prev) => ({
                  ...prev,
                  technologies: selected
                    ? prev.technologies.filter((t) => t !== tech)
                    : [...prev.technologies, tech],
                }))
              }
              className={`text-[12px] px-2.5 py-1 rounded-md border transition-colors ${
                selected
                  ? "bg-[var(--accent)] text-[color:var(--foreground)] border-[var(--accent)]"
                  : "bg-[var(--surface-2)] text-[color:var(--muted)] border-[var(--border)] hover:text-[color:var(--foreground)]"
              }`}
            >
              {tech}
            </button>
          );
        })}
      </div>
      <button
        onClick={saveTechnologies}
        disabled={techSaving}
        className="w-full justify-center mt-4 inline-flex items-center gap-2 px-3.5 py-2.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {techSaving
          ? "Saving…"
          : techSaved
          ? "✓ Saved"
          : `Save Technologies${
              scrapeSettings.technologies.length
                ? ` (${scrapeSettings.technologies.length})`
                : ""
            }`}
      </button>
      {techError && (
        <p className="text-[11px] text-red-400 mt-2 leading-snug">
          {techError}
        </p>
      )}
    </div>
    </div>
  );

  return (
    // The /(dashboard)/layout.tsx renders the sidebar + outer flex
    // wrapper; this component now renders only the page topbar +
    // content. Fragment because there are sibling top-level nodes
    // (modals, floating auto-mode panel) below the main content.
    <>
        {/* Top Bar */}
        <div className="bg-[var(--background)]/85 backdrop-blur-md border-b border-[var(--border)] px-4 py-3 sticky top-0 z-20">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {/* Hamburger — opens the sidebar drawer on mobile. Hidden
                  on desktop where the sidebar is always docked. */}
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors -ml-1"
                aria-label="Open menu"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </svg>
              </button>
              <h2 className="text-[20px] font-semibold text-[color:var(--foreground)] tracking-tight truncate">
                {SIDEBAR_ITEMS.find((i) => i.id === activePage)?.label}
              </h2>
              {/* Total count pill next to the All Jobs title — matches the
                  recruitment-ops reference. */}
              {activePage.startsWith("saved-") && savedJobs.length > 0 && (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30">
                  {savedJobs.length}
                </span>
              )}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              {activePage === "scrape" && scrapeMethod === "search" && selectedPlatforms.length > 0 && (
                <span className="text-xs px-3 py-1 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  {selectedPlatforms.length} platform{selectedPlatforms.length > 1 ? "s" : ""}
                </span>
              )}
              {activePage === "saved" && savedJobs.length > 0 && (
                <button
                  onClick={exportToExcel}
                  className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 hover:bg-[var(--accent)]/25 transition-colors cursor-pointer"
                >
                  ↓ Export Excel
                </button>
              )}
              <button
                onClick={() => {
                  // Turning OFF doesn't need a confirm. Turning ON
                  // pops the modal so the user sees what auto-mode
                  // actually does before opting in.
                  if (autoMode) {
                    setAutoMode(false);
                    fetch("/api/settings", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ auto_mode_enabled: false }),
                    }).catch((e) =>
                      console.warn("[auto-mode] settings sync failed:", e)
                    );
                    return;
                  }
                  setAutoModeModalOpen(true);
                }}
                title={
                  autoMode
                    ? "Click to stop the auto-scrape loop"
                    : "Click to start the auto-scrape loop"
                }
                className={`inline-flex items-center gap-2 text-[13px] font-semibold px-4 py-2 rounded-md cursor-pointer transition-colors ${
                  autoMode
                    ? "bg-[var(--accent)] text-[color:var(--foreground)] hover:bg-[var(--accent-hover)]"
                    : "bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/40 hover:bg-[var(--accent)]/25"
                }`}
              >
                {/* Small live dot when running, static glyph when idle */}
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    autoMode ? "bg-white animate-pulse" : "bg-[color:var(--accent)]"
                  }`}
                />
                Auto-Scrape
              </button>
              {/* Theme toggle — sits next to Auto-Scrape so it's always
                  reachable without opening the sidebar. */}
              <ThemeToggle />
            </div>
          </div>
        </div>

        {/* =================== SCRAPE JOBS — METHOD PICKER =================== */}
        {/* Segmented control — surface-2 base, accent-soft for the active
            tab. Replaces the older blue/purple gradient that didn't match
            the rest of the dashboard. */}
        {/* Via Gmail / Via Search toggle — currently HIDDEN so the Scrape Jobs
            page only shows the Gmail flow. Code is preserved (wrapped in
            `false &&`) so it can be flipped back on later by removing it. */}
        {false && activePage === "scrape" && (
          <div className="px-4 pt-6">
            <div className="inline-flex rounded-lg bg-[var(--surface-2)] border border-[var(--border)] p-1 gap-1">
              <button
                onClick={() => setScrapeMethod("gmail")}
                className={`inline-flex items-center gap-1.5 text-[13px] px-3.5 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                  scrapeMethod === "gmail"
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30"
                    : "text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                }`}
              >
                📧 Via Gmail
              </button>
              <button
                onClick={() => setScrapeMethod("search")}
                className={`inline-flex items-center gap-1.5 text-[13px] px-3.5 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                  scrapeMethod === "search"
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30"
                    : "text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                }`}
              >
                🔍 Via Search
              </button>
            </div>
          </div>
        )}

        {/* =================== JOB SEARCH PAGE =================== */}
        {/* Layout matches the recruitment-ops aesthetic — single config
            card grouping the three picker rows + the primary CTA, with
            results rendered below in a separate card. Replaces the older
            blue/purple-accented variant. */}
        {activePage === "scrape" && scrapeMethod === "search" && (
          <div className="px-4 py-4 grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5">
            {/* ── LEFT COLUMN — picker card + banners + results + activity ── */}
            <div className="space-y-5 min-w-0">
            {/* Picker card — Platform / Job Role / Filters / CTA. */}
            <div className="surface p-7">
              <div className="flex gap-4 items-start mb-6">
                <div className="w-12 h-12 rounded-[10px] bg-[var(--accent-soft)] text-[color:var(--accent)] flex items-center justify-center text-[22px] shrink-0">
                  🔍
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[color:var(--foreground)] leading-tight">
                    Search jobs across platforms
                  </h1>
                  <p className="text-[14px] text-[color:var(--muted)] mt-2 leading-[1.5]">
                    Pick one or more platforms, the roles you&apos;re hiring
                    for, and the filters to narrow the search. ScraperAI
                    will run the scrapers and surface the matching postings
                    below.
                  </p>
                </div>
              </div>

              {/* Platform */}
              <div className="mt-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)] mb-2">
                  Select Platform
                </h2>
                <div ref={platformDropdownRef} className="relative">
                  <button
                    onClick={() => setPlatformDropdownOpen((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--text)] hover:border-[var(--border-strong)] focus:outline-none focus:border-[color:var(--accent)] transition-colors"
                  >
                    <span
                      className={
                        selectedPlatforms.length === 0
                          ? "text-[color:var(--muted-2)]"
                          : ""
                      }
                    >
                      {selectedPlatforms.length === 0
                        ? "Select platforms…"
                        : `${selectedPlatforms.length} platform${
                            selectedPlatforms.length > 1 ? "s" : ""
                          } selected`}
                    </span>
                    <span
                      className={`text-[color:var(--muted-2)] transition-transform duration-200 ${
                        platformDropdownOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▼
                    </span>
                  </button>
                  {platformDropdownOpen && (
                    <div className="absolute z-20 mt-1.5 w-full bg-[var(--surface)] border border-[var(--border)] rounded-md shadow-xl overflow-hidden">
                      <div className="flex gap-2 px-3 py-2 border-b border-[var(--border)]">
                        <button
                          onClick={() =>
                            setSelectedPlatforms(PLATFORMS.map((p) => p.id))
                          }
                          className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 hover:bg-[var(--accent-soft-strong)] transition-colors font-medium"
                        >
                          Select All
                        </button>
                        <button
                          onClick={() => setSelectedPlatforms([])}
                          className="text-[11px] px-2.5 py-1 rounded-md text-[color:var(--danger)] border border-[color:var(--danger)]/40 hover:bg-[var(--danger-soft)] transition-colors font-medium"
                        >
                          Clear All
                        </button>
                      </div>
                      {PLATFORMS.map((platform) => (
                        <label
                          key={platform.id}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPlatforms.includes(platform.id)}
                            onChange={() => togglePlatform(platform.id)}
                            className="accent-[var(--accent)] w-3.5 h-3.5"
                          />
                          <span className="text-base leading-none">
                            {platform.emoji}
                          </span>
                          <span
                            className={`text-[13px] ${
                              selectedPlatforms.includes(platform.id)
                                ? "text-[color:var(--foreground)] font-medium"
                                : "text-[color:var(--muted)]"
                            }`}
                          >
                            {platform.name}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedPlatforms.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-2.5">
                    {selectedPlatforms.map((id) => {
                      const p = PLATFORMS.find((pl) => pl.id === id);
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 text-[12px] font-medium"
                        >
                          {p?.emoji} {p?.name}
                          <button
                            onClick={() => togglePlatform(id)}
                            className="ml-0.5 text-[color:var(--accent)]/70 hover:text-[color:var(--accent)] text-[10px]"
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Job Role */}
              <div className="mt-5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)] mb-2">
                  Select Job Role
                </h2>
                <div ref={roleDropdownRef} className="relative">
                  <button
                    onClick={() => setRoleDropdownOpen((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--text)] hover:border-[var(--border-strong)] focus:outline-none focus:border-[color:var(--accent)] transition-colors"
                  >
                    <span
                      className={
                        selectedRoles.length === 0
                          ? "text-[color:var(--muted-2)]"
                          : ""
                      }
                    >
                      {selectedRoles.length === 0
                        ? "Select job roles…"
                        : `${selectedRoles.length} role${
                            selectedRoles.length > 1 ? "s" : ""
                          } selected`}
                    </span>
                    <span
                      className={`text-[color:var(--muted-2)] transition-transform duration-200 ${
                        roleDropdownOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▼
                    </span>
                  </button>
                  {roleDropdownOpen && (
                    <div className="absolute z-20 mt-1.5 w-full bg-[var(--surface)] border border-[var(--border)] rounded-md shadow-xl overflow-hidden max-h-60 overflow-y-auto">
                      {JOB_ROLES.map((role) => (
                        <label
                          key={role}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedRoles.includes(role)}
                            onChange={() => toggleRole(role)}
                            className="accent-[var(--accent)] w-3.5 h-3.5"
                          />
                          <span
                            className={`text-[13px] ${
                              selectedRoles.includes(role)
                                ? "text-[color:var(--foreground)] font-medium"
                                : "text-[color:var(--muted)]"
                            }`}
                          >
                            {role}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedRoles.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-2.5">
                    {selectedRoles.map((role) => (
                      <span
                        key={role}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 text-[12px] font-medium"
                      >
                        {role}
                        <button
                          onClick={() => toggleRole(role)}
                          className="ml-0.5 text-[color:var(--accent)]/70 hover:text-[color:var(--accent)] text-[10px]"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Filters */}
              <div className="mt-5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)] mb-2">
                  Apply Filters
                </h2>
                <div ref={filterDropdownRef} className="relative">
                  <button
                    onClick={() => setFilterDropdownOpen((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--text)] hover:border-[var(--border-strong)] focus:outline-none focus:border-[color:var(--accent)] transition-colors"
                  >
                    <span
                      className={
                        selectedFilters.length === 0
                          ? "text-[color:var(--muted-2)]"
                          : ""
                      }
                    >
                      {selectedFilters.length === 0
                        ? "Select filters…"
                        : `${selectedFilters.length} filter${
                            selectedFilters.length > 1 ? "s" : ""
                          } selected`}
                    </span>
                    <span
                      className={`text-[color:var(--muted-2)] transition-transform duration-200 ${
                        filterDropdownOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▼
                    </span>
                  </button>
                  {filterDropdownOpen && (
                    <div className="absolute z-20 mt-1.5 w-full bg-[var(--surface)] border border-[var(--border)] rounded-md shadow-xl overflow-hidden">
                      {QUICK_TAGS.map((tag) => (
                        <label
                          key={tag}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedFilters.includes(tag)}
                            onChange={() => toggleFilter(tag)}
                            className="accent-[var(--accent)] w-3.5 h-3.5"
                          />
                          <span
                            className={`text-[13px] ${
                              selectedFilters.includes(tag)
                                ? "text-[color:var(--foreground)] font-medium"
                                : "text-[color:var(--muted)]"
                            }`}
                          >
                            {tag}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedFilters.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-2.5">
                    {selectedFilters.map((filter) => (
                      <span
                        key={filter}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 text-[12px] font-medium"
                      >
                        {filter}
                        <button
                          onClick={() => toggleFilter(filter)}
                          className="ml-0.5 text-[color:var(--accent)]/70 hover:text-[color:var(--accent)] text-[10px]"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* CTA */}
              <button
                onClick={handleSearch}
                disabled={loading}
                className="w-full mt-7 py-3 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] text-[14px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
                    Searching…
                  </>
                ) : (
                  <>Scrape Jobs</>
                )}
              </button>
            </div>
            {/* End picker card */}

            {/* Loading / info / error banners — surface tokens. */}
            {loading && step && (
              <div className="surface px-4 py-3 text-[13px] text-[color:var(--accent)] text-center">
                <span className="animate-pulse">{step}</span>
              </div>
            )}
            {info && (
              <div className="px-4 py-3 rounded-md text-[13px] bg-amber-500/10 border border-amber-500/30 text-amber-300">
                💡 {info}
              </div>
            )}
            {error && (
              <div className="px-4 py-3 rounded-md text-[13px] bg-red-500/10 border border-red-500/30 text-red-400">
                ❌ {error}
              </div>
            )}

            {/* Job Results */}
            {jobs.length > 0 && (
              <div className="surface p-[22px]">
                <div className="flex items-center justify-between mb-3.5 flex-wrap gap-3">
                  <h2 className="text-[14px] font-semibold tracking-[-0.01em]">
                    ✅ {jobs.length} Matching Jobs
                  </h2>
                  <button
                    onClick={() => {
                      saveAllJobs();
                      setJobs([]);
                    }}
                    className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/40 hover:bg-[var(--accent-soft-strong)] transition-colors font-medium"
                  >
                    💾 Save All to List
                  </button>
                </div>
                <div className="space-y-2.5">
                  {jobs.map((job, index) => {
                    const alreadySaved = savedJobs.some(
                      (s) =>
                        (s.jobId &&
                          job.jobId &&
                          s.jobId !== "N/A" &&
                          s.jobId === job.jobId) ||
                        (s.url &&
                          job.url &&
                          s.url !== "N/A" &&
                          s.url === job.url)
                    );
                    return (
                      <div
                        key={index}
                        className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3.5 hover:border-[var(--border-strong)] transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-[14px] font-medium text-[color:var(--foreground)]">
                                {job.title}
                              </h3>
                              {alreadySaved ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] uppercase tracking-wider font-medium">
                                  Saved
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 uppercase tracking-wider font-medium">
                                  New
                                </span>
                              )}
                            </div>
                            <p className="text-[12.5px] text-[color:var(--muted)] mt-0.5">
                              {job.company}
                              {job.platform && (
                                <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--surface)] text-[color:var(--muted-2)] border border-[var(--border)]">
                                  {job.platform}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1.5">
                            <span className="bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-medium whitespace-nowrap">
                              {job.matchScore}% Match
                            </span>
                            <span className="bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-medium whitespace-nowrap">
                              {job.jobType}
                            </span>
                          </div>
                        </div>

                        <p className="text-[12px] text-[color:var(--muted)] mb-3 leading-relaxed line-clamp-2">
                          {job.description}
                        </p>

                        <div className="flex items-center justify-between flex-wrap gap-3">
                          <span className="text-[11.5px] text-[color:var(--muted-2)]">
                            📍 {job.location}
                          </span>
                          <div className="flex gap-1.5 flex-wrap">
                            <button
                              onClick={() => {
                                saveJob(job);
                                setJobs((prev) =>
                                  prev.filter((_, i) => i !== index)
                                );
                              }}
                              disabled={isJobSaved(job)}
                              className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
                                isJobSaved(job)
                                  ? "bg-[var(--surface)] text-[color:var(--muted-2)] cursor-default"
                                  : "bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/40 hover:bg-[var(--accent-soft-strong)]"
                              }`}
                            >
                              {isJobSaved(job) ? "✔ Saved" : "Save"}
                            </button>
                            {job.url && job.url !== "" && job.url !== "N/A" && (
                              <a
                                href={job.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] hover:text-[color:var(--foreground)] whitespace-nowrap"
                              >
                                View →
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recent Activity — same panel as Via Gmail; kept on the
                left column so the right side stays a clean settings rail. */}
            {recentActivityPanel}
            </div>
            {/* ── RIGHT COLUMN — Scrape Settings (shared) ─────────────── */}
            {scrapeSettingsPanel}
          </div>
        )}

        {/* =================== METHOD 2: GMAIL PAGE =================== */}
        {/* Layout matches mockup/scrape.html — left: hero card with email
            icon + 3 stats + action row, then activity log; right: scrape
            settings panel. Existing handlers (connectGmail, parseGmailAlerts,
            autoMode toggle, save / view / delete on parsed jobs) are intact;
            only the visual chrome was rebuilt. */}
        {activePage === "scrape" && scrapeMethod === "gmail" && (
          <div className="px-4 py-4 grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5">
            {/* ── LEFT COLUMN ─────────────────────────────────────────── */}
            <div className="space-y-5 min-w-0">
              {/* Hero card — accent-tinted gradient on the left edge
                  (top-to-bottom on mobile) gives the panel a brand
                  signature without adding a heavy border. */}
              <div className="surface p-7 relative overflow-hidden">
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[var(--accent)] via-[var(--accent)] to-transparent opacity-70"
                />
                <div className="flex gap-4 items-start">
                  <div className="w-12 h-12 rounded-[10px] bg-[var(--accent-soft)] text-[color:var(--accent)] flex items-center justify-center text-[22px] shrink-0">
                    ✉
                  </div>
                  <div className="flex-1 min-w-0">
                    <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[color:var(--foreground)] leading-tight">
                      {scrapeSettings.platform === "remoteok"
                        ? "Pull jobs from RemoteOK"
                        : "Pull jobs from your Gmail inbox"}
                    </h1>
                    <p className="text-[14px] text-[color:var(--muted)] mt-2 leading-[1.5]">
                      {scrapeSettings.platform === "remoteok"
                        ? "ScraperAI hits the free RemoteOK API directly, pulls the latest remote jobs matching your role list, and saves each one to your dashboard. No Gmail required. Run it on demand below."
                        : "Connect Gmail once and ScraperAI will read LinkedIn / Naukri / Indeed alert emails, extract the job posting data, and save each one to your dashboard. Auto-scrape runs daily; or run it on demand below."}
                    </p>
                  </div>
                </div>

                {/* Stats — Last Run / Jobs Found Today / Total Saved. */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-6">
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3.5">
                    <div className="text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)]">
                      Last Run
                    </div>
                    <div className="text-[22px] font-semibold mt-1.5 text-[color:var(--foreground)]">
                      {lastRunLabel}
                    </div>
                  </div>
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3.5">
                    <div className="text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)]">
                      Jobs Found Today
                    </div>
                    <div className="text-[22px] font-semibold mt-1.5 text-[color:var(--accent)]">
                      +{todayCount}
                    </div>
                  </div>
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3.5">
                    <div className="text-[11px] uppercase tracking-[0.1em] text-[color:var(--muted-2)]">
                      Total Saved
                    </div>
                    <div className="text-[22px] font-semibold mt-1.5 text-[color:var(--foreground)]">
                      {savedJobs.length}
                    </div>
                  </div>
                </div>

                {/* Action row — Run Scrape Now always present. When the
                    Platform dropdown is on LinkedIn (Gmail-backed source),
                    we also show the Gmails-Connected status button + the
                    Select Email dropdown right next to it. RemoteOK is a
                    pure-API source, so for that platform the Gmail bits
                    are hidden and Run Scrape Now is enabled unconditionally
                    — no inbox to connect. The smart-text button's label
                    flexes with the connected count: 0 → "Connect Gmail",
                    1 → "1 Gmail Connected", 2+ → "N Gmails Connected". */}
                <div className="mt-7 flex items-center gap-2.5 flex-wrap">
                  {(() => {
                    const platform = scrapeSettings.platform;
                    const isGmailBacked =
                      platform === "linkedin" ||
                      platform === "indeed" ||
                      platform === "upwork";
                    const usingMultiGmail = gmailSlots.length > 0;
                    const connectedCount = usingMultiGmail
                      ? gmailSlots.filter((s) => s.is_connected).length
                      : gmailConnected
                      ? 1
                      : 0;
                    const anyConnected = connectedCount > 0;
                    // RemoteOK doesn't need a connected Gmail — Run Scrape
                    // Now is just gated on whether a request is in flight.
                    // For Gmail-backed platforms the legacy gating (at
                    // least one account connected) still applies.
                    const canRun = isGmailBacked ? anyConnected : true;

                    // Smart-text button label.
                    const statusLabel =
                      connectedCount === 0
                        ? "🔗 Connect Gmail"
                        : connectedCount === 1
                        ? "1 Gmail Connected"
                        : `${connectedCount} Gmails Connected`;

                    // For the legacy single-account fallback (no env labels
                    // configured yet), the status button still opens the
                    // modal — which itself shows a helpful "no slots
                    // configured" message — so the user has one consistent
                    // entry point either way.
                    const handleStatusClick = () => setGmailModalOpen(true);

                    return (
                      <>
                        {/* Run Scrape Now — always shown. Light/disabled
                            when no Gmail is connected on a Gmail-backed
                            platform; on RemoteOK it's always active. */}
                        <button
                          onClick={runScrapeNow}
                          disabled={!canRun || gmailLoading}
                          title={
                            !isGmailBacked
                              ? `Pull jobs from the ${
                                  platform === "remoteok" ? "RemoteOK" : platform
                                } API`
                              : anyConnected
                              ? "Parse alerts from the selected Gmail(s)"
                              : "Connect a Gmail first"
                          }
                          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-[13px] font-medium transition-colors ${
                            canRun
                              ? "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] disabled:opacity-50 disabled:cursor-not-allowed"
                              : "bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 opacity-60 cursor-not-allowed"
                          }`}
                        >
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${
                              canRun
                                ? `bg-white ${
                                    gmailLoading ? "animate-pulse" : ""
                                  }`
                                : "bg-[color:var(--accent)]"
                            }`}
                          />
                          {gmailLoading ? "Running…" : "Run Scrape Now"}
                        </button>

                        {/* Gmail-only chrome: status button + select dropdown.
                            Hidden entirely on RemoteOK / other pure-API
                            platforms because there's no inbox involved. */}
                        {isGmailBacked && (
                          <>
                        {/* Smart-text status button. Same modal whether
                            you want to connect a fresh account or manage
                            existing ones. */}
                        <button
                          type="button"
                          onClick={handleStatusClick}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--muted)] hover:bg-[var(--surface-3)] cursor-pointer transition-colors"
                          title={
                            anyConnected
                              ? "Manage connected Gmail accounts"
                              : "Click to connect a Gmail account"
                          }
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${
                              anyConnected
                                ? "bg-[color:var(--accent)]"
                                : "bg-[color:var(--muted-2)]"
                            }`}
                          />
                          {statusLabel}
                        </button>
                          </>
                        )}
                      </>
                    );
                  })()}

                  {/* Select Email — controls which connected Gmail(s) the
                      parse-gmail route reads from. Persists to
                      settings.parse_gmail_selection so the cron path picks
                      up the same choice. Only rendered for Gmail-backed
                      platforms (RemoteOK hides this entirely — there's no
                      inbox to pick) AND once an account slot is connected;
                      until then there's nothing to choose. */}
                  {scrapeSettings.platform !== "remoteok" &&
                    gmailSlots.length > 0 &&
                    gmailSlots.some((s) => s.is_connected) && (() => {
                    const connectedSlots = gmailSlots.filter((s) => s.is_connected);
                    // "Both" option is only meaningful when 2+ accounts are
                    // actually connected. With a single connected account,
                    // "Both" would mislead the user into thinking the second
                    // inbox is also being read.
                    const showBothOption = connectedSlots.length >= 2;
                    return (
                      <select
                        value={parseSelection}
                        onChange={async (e) => {
                          const next = e.target.value;
                          setParseSelection(next);
                          await fetch("/api/settings", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ parse_gmail_selection: next }),
                          }).catch((err) =>
                            console.warn("[settings] selection sync failed:", err)
                          );
                        }}
                        className="inline-flex items-center px-3 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--foreground)] cursor-pointer"
                        title="Which connected Gmail(s) to read alerts from"
                      >
                        {showBothOption && (
                          <option value="both">Both Gmails</option>
                        )}
                        {gmailSlots.map((s) => (
                          <option
                            key={s.label}
                            value={s.label}
                            disabled={!s.is_connected}
                          >
                            {s.display_name}
                            {s.email ? ` (${s.email})` : ""}
                            {!s.is_connected ? " — not connected" : ""}
                          </option>
                        ))}
                      </select>
                    );
                  })()}

                  {/* Date filter — HIDDEN (wrapped in `false &&`). The Run
                      Scrape Now button no longer takes a date — it uses the
                      backend's default window. Flip the `false` to `true` to
                      bring the picker back. */}
                  {false && (
                  <div
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--muted)] ${
                      gmailLoading ? "opacity-50" : ""
                    }`}
                    title="Scrape Gmail alert emails that arrived on this date"
                  >
                    <span className="text-[11px] uppercase tracking-[0.08em] text-[color:var(--muted-2)]">
                      Date
                    </span>
                    <span className="text-[13px] text-[color:var(--foreground)] font-medium">
                      {scrapeDate === todayStr()
                        ? "Today"
                        : new Date(scrapeDate).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (gmailLoading) return;
                        const el = scrapeDateInputRef.current;
                        if (el && typeof el.showPicker === "function") {
                          el.showPicker();
                        } else {
                          el?.focus();
                        }
                      }}
                      disabled={gmailLoading}
                      title="Pick a date"
                      className="inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--foreground)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      aria-label="Open date picker"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect width="18" height="18" x="3" y="4" rx="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" />
                      </svg>
                    </button>
                    <input
                      ref={scrapeDateInputRef}
                      type="date"
                      value={scrapeDate}
                      max={todayStr()}
                      onChange={(e) =>
                        setScrapeDate(e.target.value || todayStr())
                      }
                      disabled={gmailLoading}
                      aria-hidden="true"
                      tabIndex={-1}
                      style={{
                        position: "absolute",
                        width: 1,
                        height: 1,
                        opacity: 0,
                        pointerEvents: "none",
                      }}
                    />
                  </div>
                  )}
                </div>
              </div>

              {/* Setup Instructions — only when not connected AND we're on
                  a Gmail-backed platform. RemoteOK uses a public API so the
                  Gmail wiring guide is irrelevant. */}
              {!gmailConnected && scrapeSettings.platform !== "remoteok" && (
                <div className="surface p-[22px]">
                  <h2 className="text-[14px] font-semibold tracking-[-0.01em] mb-3.5">
                    Setup Instructions
                  </h2>
                  <ol className="text-[13px] text-[color:var(--muted)] space-y-1.5 list-decimal list-inside leading-relaxed">
                    <li>
                      Go to{" "}
                      <a
                        href="https://www.linkedin.com/jobs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[color:var(--accent)] underline"
                      >
                        LinkedIn Jobs
                      </a>
                    </li>
                    <li>
                      Search keywords like &quot;React developer remote&quot;,
                      &quot;Python developer&quot;, etc.
                    </li>
                    <li>Click &quot;Set alert&quot; → Select &quot;Daily&quot; frequency</li>
                    <li>Alerts will arrive in your Gmail inbox</li>
                    <li>Click &quot;Connect Gmail&quot; above to authorize access</li>
                    <li>Click &quot;Run Scrape Now&quot; to read and extract jobs</li>
                  </ol>
                </div>
              )}

              {/* Recent Activity — shared between Via Search + Via Gmail.
                  See `recentActivityPanel` for the actual JSX. */}
              {recentActivityPanel}

              {/* Parse-result banner (after Run Scrape Now). */}
              {gmailMessage && (
                <div
                  className={`p-3.5 rounded-md text-[13px] border ${
                    gmailJobs.length > 0
                      ? "bg-blue-500/10 border-blue-500/30 text-blue-300"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-300"
                  }`}
                >
                  💡 {gmailMessage}
                </div>
              )}

              {/* Parsed jobs awaiting save (existing review-then-save flow). */}
              {gmailJobs.length > 0 && (
                <div className="surface p-[22px]">
                  <div className="flex items-center justify-between mb-3.5 flex-wrap gap-3">
                    <h2 className="text-[14px] font-semibold tracking-[-0.01em]">
                      📬 {gmailJobs.length} Jobs from Gmail Alerts
                    </h2>
                    <button
                      onClick={() => {
                        const today = new Date().toISOString().split("T")[0];
                        const newOnes = gmailJobs
                          .filter((j) => !isDuplicate(j, savedJobs))
                          .map((j) => ({
                            ...j,
                            status: "new",
                            capturedDate: today,
                            emailsSent: 0,
                          }));
                        if (newOnes.length > 0) {
                          // Optimistic local update so the All Jobs sidebar
                          // count flips immediately.
                          persistSaved([...savedJobs, ...newOnes]);
                          // Then push the same batch to jobs_v2 via the
                          // explicit save endpoint — manual scrape returned
                          // these rows with saveToDb=false, so this is the
                          // only thing that makes them real server-side.
                          void fetch("/api/jobs/save", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              jobs: newOnes.map((j) => ({
                                title: j.title,
                                jobId: j.jobId,
                                company: j.company,
                                email: j.email,
                                location: j.location,
                                jobType: j.jobType,
                                description: j.description,
                                url: j.url,
                                postedAt: j.postedAt,
                                platform: j.platform,
                              })),
                            }),
                          }).catch((e) =>
                            console.warn("[save-all] persist failed:", e)
                          );
                        }
                        setGmailMessage(
                          `Saved ${newOnes.length} new jobs (${
                            gmailJobs.length - newOnes.length
                          } duplicates skipped)`
                        );
                        setGmailJobs([]);
                      }}
                      className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/40 hover:bg-[var(--accent-soft-strong)] transition-colors font-medium"
                    >
                      💾 Save All to List
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    {gmailJobs.map((job, i) => {
                      const alreadySaved = savedJobs.some(
                        (s) =>
                          (s.jobId && job.jobId && s.jobId === job.jobId) ||
                          (s.url && job.url && s.url === job.url)
                      );
                      return (
                        <div
                          key={i}
                          className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3.5 hover:border-[var(--border-strong)] transition-colors"
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="flex-1 min-w-0">
                              <h4 className="text-[color:var(--foreground)] font-medium text-[14px]">
                                {job.title}
                              </h4>
                              <p className="text-[color:var(--muted)] text-[12.5px] mt-0.5">
                                {job.company} · {job.location}
                              </p>
                              {job.description && (
                                <p className="text-[color:var(--muted-2)] text-[11.5px] mt-1.5 line-clamp-2">
                                  {job.description}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-1.5 flex-wrap items-center">
                              {alreadySaved ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] uppercase tracking-wider font-medium">
                                  Saved
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/30 uppercase tracking-wider font-medium">
                                  New
                                </span>
                              )}
                              <button
                                onClick={() => {
                                  saveJob(job);
                                  setGmailJobs((prev) =>
                                    prev.filter((_, idx) => idx !== i)
                                  );
                                }}
                                className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--accent)]/40 hover:bg-[var(--accent-soft-strong)]"
                              >
                                Save
                              </button>
                              {job.url && (
                                <a
                                  href={job.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] hover:text-[color:var(--foreground)]"
                                >
                                  View →
                                </a>
                              )}
                              <button
                                onClick={() =>
                                  setGmailJobs(
                                    gmailJobs.filter((_, idx) => idx !== i)
                                  )
                                }
                                className="inline-flex items-center justify-center text-[11px] px-2.5 py-1 rounded-md bg-[var(--surface)] text-[color:var(--muted)] border border-[var(--border)] hover:text-[color:var(--danger)]"
                                title="Delete"
                                aria-label="Delete job"
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
                                  aria-hidden="true"
                                >
                                  <path d="M3 6h18" />
                                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6" />
                                  <path d="M14 11v6" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── RIGHT COLUMN — Scrape Settings (shared across tabs) ─── */}
            {scrapeSettingsPanel}
          </div>
        )}

        {/* =================== SAVED JOBS PAGE (per-platform) =================== */}
        {activePage.startsWith("saved-") && (
          // Side gutters: 16px — small breathing room between sidebar /
          // right edge and the content, without leaving the wide empty
          // band the original max-w-6xl had.
          <div className="px-4 py-4">
            {/* All-Jobs tab now shows everything — the per-platform sidebar
                tabs collapsed into one. Three render branches: loading
                skeleton (initial DB fetch), empty state (no jobs), or
                the actual filters + table. */}
            {savedJobsLoading ? (
              <div className="space-y-3">
                {/* Search bar skeleton */}
                <div className="surface px-4 py-3">
                  <div className="h-5 w-1/3 bg-[var(--surface-2)] rounded animate-pulse" />
                </div>
                {/* Actions strip skeleton */}
                <div className="surface px-4 py-3 flex items-center justify-between gap-3">
                  <div className="h-5 w-40 bg-[var(--surface-2)] rounded animate-pulse" />
                  <div className="flex gap-2">
                    <div className="h-9 w-28 bg-[var(--surface-2)] rounded-md animate-pulse" />
                    <div className="h-9 w-20 bg-[var(--surface-2)] rounded-md animate-pulse" />
                  </div>
                </div>
                {/* Filter row skeleton */}
                <div className="flex gap-2 mb-3">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-9 w-32 bg-[var(--surface-2)] rounded-md animate-pulse"
                    />
                  ))}
                </div>
                {/* Table skeleton — 8 placeholder rows match the page size. */}
                <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
                  <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)]">
                    <div className="h-3 w-1/2 bg-[var(--surface-2)] rounded animate-pulse" />
                  </div>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-4 px-4 py-3.5 border-b border-[var(--border)] last:border-b-0"
                    >
                      <div className="h-4 w-4 bg-[var(--surface-2)] rounded animate-pulse" />
                      <div className="h-4 w-6 bg-[var(--surface-2)] rounded animate-pulse" />
                      <div className="h-4 flex-1 max-w-xs bg-[var(--surface-2)] rounded animate-pulse" />
                      <div className="h-4 w-32 bg-[var(--surface-2)] rounded animate-pulse hidden md:block" />
                      <div className="h-4 w-24 bg-[var(--surface-2)] rounded animate-pulse hidden md:block" />
                      <div className="h-5 w-16 bg-[var(--surface-2)] rounded-md animate-pulse hidden lg:block" />
                      <div className="h-5 w-16 bg-[var(--surface-2)] rounded-md animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ) : savedJobs.length === 0 ? (
              <div className="mt-12 text-center text-[color:var(--muted-2)]">
                <p className="text-4xl mb-3">💾</p>
                <p className="text-lg">
                  No jobs yet — head to{" "}
                  <button
                    onClick={() => setActivePage("scrape")}
                    className="text-[color:var(--accent)] hover:underline"
                  >
                    Scrape Jobs
                  </button>{" "}
                  to pull some in.
                </p>
              </div>
            ) : (
              <>
                {/* Actions strip — saved-count on the left, Export on the
                    right. Lives at the very top so the primary stat + the
                    primary CTA are the first things the user sees. */}
                <div className="surface mb-4 px-4 py-3 flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-[14px] text-[color:var(--foreground)]">
                      <span className="font-semibold">{savedJobs.length}</span>{" "}
                      <span className="text-[color:var(--muted)]">
                        job{savedJobs.length === 1 ? "" : "s"} saved
                      </span>
                      {selectedExportIndexes.size > 0 && (
                        <span className="ml-1.5 text-[color:var(--muted)]">
                          ({selectedExportIndexes.size} selected)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={exportToExcel}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] font-medium text-sm transition-colors"
                    >
                      <span className="text-[12px]">↓</span>
                      {selectedExportIndexes.size > 0
                        ? `Export ${selectedExportIndexes.size} Selected`
                        : "Export All"}
                    </button>
                  </div>
                </div>

                {/* Filter dropdowns row — sits below the actions strip, above
                    the table. Standalone selects with the surface border look
                    so they read as inputs, not chips. */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <select
                    value={savedFilterPlatform}
                    onChange={(e) => setSavedFilterPlatform(e.target.value)}
                    className="surface px-3 py-2 text-[13px] cursor-pointer focus:border-[color:var(--accent)] focus:outline-none"
                  >
                    <option value="all">All Platforms</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="remoteok">Remote OK</option>
                  </select>
                  <select
                    value={savedFilterStatus}
                    onChange={(e) => setSavedFilterStatus(e.target.value)}
                    className="surface px-3 py-2 text-[13px] cursor-pointer focus:border-[color:var(--accent)] focus:outline-none"
                  >
                    <option value="all">All Statuses</option>
                    {LEAD_STATUSES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <select
                    value={savedFilterEmail}
                    onChange={(e) => setSavedFilterEmail(e.target.value)}
                    className="surface px-3 py-2 text-[13px] cursor-pointer focus:border-[color:var(--accent)] focus:outline-none"
                  >
                    <option value="all">All Jobs</option>
                    <option value="with">With Email</option>
                    <option value="without">No Email</option>
                  </select>
                  {/* Scraped date picker — filter by when this dashboard
                      captured the row (capturedDate). */}
                  <label className="surface inline-flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer focus-within:border-[color:var(--accent)]">
                    <span className="text-[color:var(--muted)] select-none">Scraped:</span>
                    <input
                      type="date"
                      value={savedFilterScrapedDate}
                      onChange={(e) => setSavedFilterScrapedDate(e.target.value)}
                      className="bg-transparent outline-none text-[13px] text-[color:var(--foreground)] [color-scheme:light] dark:[color-scheme:dark]"
                      title="Filter by scraped date (when this dashboard captured it)"
                    />
                  </label>
                  {(savedSearch ||
                    savedFilterPlatform !== "all" ||
                    savedFilterStatus !== "all" ||
                    savedFilterEmail !== "all" ||
                    savedFilterScrapedDate) && (
                    <button
                      onClick={() => {
                        // Clear EVERYTHING — including the email filter and
                        // the today-by-default scraped-date pick. Defaults
                        // re-apply on the next page mount only; clicking Clear
                        // is the explicit "show me every job in the table" path.
                        setSavedSearch("");
                        setSavedFilterPlatform("all");
                        setSavedFilterStatus("all");
                        setSavedFilterEmail("all");
                        setSavedFilterScrapedDate("");
                      }}
                      className="text-[12px] px-3 py-2 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                    >
                      ✕ Clear filters
                    </button>
                  )}
                </div>

                {/* Search input — moved below the filter row so the four
                    dropdowns own the top of the controls area. Capped at
                    max-w-xl (~36rem) so the field reads as a sibling of
                    the dropdowns, not a header-style full-width banner. */}
                <div className="surface mb-4 px-4 py-2.5 max-w-xl">
                  <div className="flex items-center gap-3">
                    <span className="text-[color:var(--muted-2)]">🔍</span>
                    <input
                      type="text"
                      placeholder={`Search ${
                        SIDEBAR_ITEMS.find((s) => s.id === activePage)?.label ?? "jobs"
                      }...`}
                      value={savedSearch}
                      onChange={(e) => setSavedSearch(e.target.value)}
                      className="flex-1 bg-transparent outline-none text-[14px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-2)]"
                    />
                  </div>
                </div>

                {/* Mobile card list — full table doesn't fit gracefully
                    on small phones, so we stack the same data into
                    one surface per row. Hidden on md+ where the table
                    takes over. */}
                <div className="md:hidden space-y-2.5">
                  {pagedJobs.map((job) => {
                    const index = savedJobsIndex(job);
                    const isSelected = selectedExportIndexes.has(index);
                    const id = aliasStatus(job.status);
                    const meta = id
                      ? LEAD_STATUSES.find((s) => s.id === id)
                      : null;
                    const statusStyles: Record<string, string> = {
                      enriched:
                        "bg-[var(--accent-soft)] text-[color:var(--accent)] border-[color:var(--accent)]/30",
                      sent:
                        "bg-[var(--info-soft)] text-[color:var(--info)] border-[color:var(--info)]/30",
                      opened:
                        "bg-[var(--warning-soft)] text-[color:var(--warning)] border-[color:var(--warning)]/30",
                      replied:
                        "bg-[var(--accent)] text-white border-[color:var(--accent)]",
                    };
                    const cleanCompany = job.company
                      ?.replace(/\s*\(.*\)/, "")
                      .trim();
                    const showLocation =
                      job.location && job.location !== "N/A";
                    return (
                      <div
                        key={index}
                        className={`surface p-3.5 transition-colors ${
                          isSelected
                            ? "ring-1 ring-[color:var(--accent)]/50"
                            : ""
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleExportSelect(index)}
                            className="accent-[var(--accent)] w-3.5 h-3.5 cursor-pointer mt-1 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            {/* Title — same link / fallback as the table */}
                            {job.url && job.url !== "N/A" ? (
                              <a
                                href={job.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[14px] font-medium text-[color:var(--accent)] hover:underline break-words leading-snug block"
                              >
                                {job.title}
                              </a>
                            ) : (
                              <span className="text-[14px] font-medium text-[color:var(--foreground)] break-words leading-snug block">
                                {job.title}
                              </span>
                            )}
                            <p className="text-[12px] text-[color:var(--muted)] mt-1 truncate">
                              <span className="text-[color:var(--foreground)]">
                                {cleanCompany || "—"}
                              </span>
                              {showLocation && (
                                <>
                                  <span className="mx-1.5 text-[color:var(--muted-2)]">
                                    ·
                                  </span>
                                  {job.location}
                                </>
                              )}
                            </p>
                          </div>
                          {/* Compact icon-only actions, same as desktop. */}
                          <div className="flex gap-1.5 items-center shrink-0">
                            {job.jobId && (
                              <a
                                href={`/jobs/${job.jobId}`}
                                className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                                title="View"
                                aria-label="View job"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              </a>
                            )}
                            <button
                              onClick={() => removeJob(index)}
                              className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--danger)] hover:bg-[var(--danger-soft)] transition-colors"
                              title="Delete"
                              aria-label="Delete job"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M3 6h18" />
                                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        {/* Bottom row: pills + posted date. */}
                        <div className="flex items-center justify-between gap-2 flex-wrap mt-3 pt-3 border-t border-[var(--border)]">
                          <div className="flex gap-1.5 flex-wrap">
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wider border bg-[var(--surface-2)] text-[color:var(--muted)] border-[var(--border)]">
                              {job.jobType}
                            </span>
                            {meta && id && (
                              <span
                                className={`text-[10px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wider border inline-block ${statusStyles[id]}`}
                              >
                                {meta.label}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-[color:var(--muted-2)] font-mono">
                            {job.postedAt || "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Desktop table — recruitment-ops mockup styling. Hidden
                    on mobile where the card list above takes over. Header
                    is non-sticky so it never overlaps row #1; the visual
                    distinction (uppercase, muted color, surface bg, thicker
                    border) keeps it from being mistaken for a data row. */}
                <div className="hidden md:block overflow-x-auto rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
                  <table className="w-full text-[13px] border-collapse">
                    <thead>
                      <tr>
                        <th className="bg-[var(--surface-2)] px-4 py-3 border-b-2 border-[var(--border)] w-9">
                          <input
                            type="checkbox"
                            checked={
                              pagedJobs.length > 0 &&
                              pagedJobs.every((j) =>
                                selectedExportIndexes.has(savedJobsIndex(j))
                              )
                            }
                            onChange={() => {
                              // Scope the header toggle to the rows visible
                              // on the current page (filtered + paged) only.
                              // Multi-page selection is a deliberate chain of
                              // per-page toggles; leaving nothing checked
                              // falls through to "Export All" in exportToExcel().
                              const pageIndexes = pagedJobs.map(savedJobsIndex);
                              setSelectedExportIndexes((prev) => {
                                const next = new Set(prev);
                                const allOnPageSelected = pageIndexes.every((i) =>
                                  next.has(i)
                                );
                                if (allOnPageSelected) {
                                  for (const i of pageIndexes) next.delete(i);
                                } else {
                                  for (const i of pageIndexes) next.add(i);
                                }
                                return next;
                              });
                            }}
                            className="accent-[var(--accent)] w-3.5 h-3.5 cursor-pointer align-middle"
                          />
                        </th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Job Name</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Company</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Emails</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Job Type</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Status</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)]">Posted</th>
                        <th className="bg-[var(--surface-2)] text-left px-4 py-3 text-[11px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em] border-b-2 border-[var(--border)] w-[90px]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* savedJobsIndex() maps each row back to the original
                          savedJobs array for the checkbox / removeJob actions. */}
                      {pagedJobs.map((job, rowIndex) => {
                        const index = savedJobsIndex(job);
                        return (
                        <tr
                          key={job.jobId || job.url || `row-${index}-${rowIndex}`}
                          className={`h-14 border-b border-[var(--border)] last:border-b-0 transition-colors ${
                            selectedExportIndexes.has(index)
                              ? "bg-[var(--accent-soft)]"
                              : "even:bg-[var(--surface-2)]/40 hover:bg-[var(--surface-2)]"
                          }`}
                        >
                          <td className="px-4 py-3.5 align-top">
                            <input
                              type="checkbox"
                              checked={selectedExportIndexes.has(index)}
                              onChange={() => toggleExportSelect(index)}
                              className="accent-[var(--accent)] w-3.5 h-3.5 cursor-pointer align-middle"
                            />
                          </td>
                          {/* Job Name — clamped to 2 lines to keep row
                              heights uniform; full title in tooltip + on the
                              detail page. */}
                          <td className="px-4 py-3.5 align-top max-w-[280px] leading-snug">
                            {job.url && job.url !== "N/A" ? (
                              <a
                                href={job.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[color:var(--foreground)] hover:text-[color:var(--accent)] hover:underline font-medium line-clamp-2 break-words transition-colors"
                                title={job.title}
                              >
                                {job.title}
                              </a>
                            ) : (
                              <span className="text-[color:var(--foreground)] font-medium line-clamp-2 break-words" title={job.title}>{job.title}</span>
                            )}
                          </td>
                          {/* Company + location stacked. Location drops the
                              "(Remote)" suffix — that's already shown in the
                              Job Type column. Location stays searchable (search
                              still matches job.location). */}
                          <td className="px-4 py-3.5 align-top max-w-[180px] text-[color:var(--foreground)]">
                            {(() => {
                              const companyClean = job.company?.replace(/\s*\(.*\)/, "").trim();
                              const locClean = job.location?.replace(/\s*\(.*\)/, "").trim();
                              return (
                                <>
                                  <div className="truncate" title={companyClean}>
                                    {companyClean || "—"}
                                  </div>
                                  {locClean && locClean !== "N/A" && (
                                    <div className="flex items-center gap-1 text-[11px] text-[color:var(--muted-2)] mt-1 truncate" title={locClean}>
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="11"
                                        height="11"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="shrink-0 opacity-60"
                                      >
                                        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                                        <circle cx="12" cy="10" r="3" />
                                      </svg>
                                      <span className="truncate">{locClean}</span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </td>
                          {/* Emails — the enrichment email for this job
                              (replaces the old Location column). */}
                          <td className="px-4 py-3.5 align-top max-w-[200px] text-[12px]">
                            {job.email && job.email !== "N/A" ? (
                              <a
                                href={`mailto:${job.email}`}
                                className="text-[color:var(--foreground)] hover:text-[color:var(--accent)] hover:underline truncate block transition-colors"
                                title={job.email}
                              >
                                {job.email}
                              </a>
                            ) : (
                              <span className="text-[color:var(--muted-2)]">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3.5 align-top">
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wider border bg-[var(--surface-2)] text-[color:var(--muted)] border-[var(--border)]">
                              {job.jobType}
                            </span>
                          </td>
                          {/* Description / Name / Title / Email / LinkedIn URL columns
                              moved to the per-job detail page — click View
                              in the Action column to see them in a focused layout. */}
                          <td className="px-4 py-3.5 align-top">
                            {(() => {
                              const id = aliasStatus(job.status);
                              if (!id) {
                                return <span className="text-[color:var(--muted-2)] text-xs">—</span>;
                              }
                              const meta = LEAD_STATUSES.find((s) => s.id === id);
                              if (!meta) {
                                return <span className="text-[color:var(--muted-2)] text-xs">—</span>;
                              }
                              // Per-status colour pill — distinct hues so the
                              // column scans quickly. Soft tinted bg + matching
                              // border + the same hue as text. Each colour reads
                              // OK in both light and dark themes (mid-shade -500
                              // family with low-alpha backgrounds).
                              const styles: Record<string, string> = {
                                enriched: "bg-sky-500/15 text-sky-500 border-sky-500/40",
                                sent: "bg-indigo-500/15 text-indigo-500 border-indigo-500/40",
                                opened: "bg-amber-500/15 text-amber-500 border-amber-500/40",
                                replied: "bg-emerald-500/15 text-emerald-500 border-emerald-500/40",
                              };
                              return (
                                <span
                                  className={`text-[11px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wider border inline-block ${
                                    styles[id] ??
                                    "bg-[var(--surface-2)] text-[color:var(--muted)] border-[var(--border)]"
                                  }`}
                                  title="Auto-updated from email tracking"
                                >
                                  {meta.label}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3.5 align-top text-[color:var(--muted-2)] text-[12px]">{job.postedAt || "—"}</td>
                          {/* URL column removed — Job Name itself is now the
                              clickable link to the source posting. */}
                          <td className="px-4 py-3.5 align-top">
                            {/* Compact icon-only actions — matches the
                                recruitment-ops mockup. Eye opens the per-job
                                detail page, trash removes the row from the
                                local state. */}
                            <div className="flex gap-1.5 items-center">
                              {job.jobId && (
                                <a
                                  href={`/jobs/${job.jobId}`}
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                                  title="View"
                                  aria-label="View job"
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                </a>
                              )}
                              <button
                                onClick={() => removeJob(index)}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--danger)] hover:bg-[var(--danger-soft)] transition-colors"
                                title="Delete"
                                aria-label="Delete job"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M3 6h18" />
                                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6" />
                                  <path d="M14 11v6" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination footer — sits OUTSIDE the desktop table
                    wrap so it renders for both the mobile card list
                    and the desktop table. Flex-wraps so the page
                    button cluster drops below the "Showing X of Y"
                    text on narrow phones instead of overflowing. */}
                {filteredSavedJobs.length > 0 && (
                  <div className="flex items-center justify-between gap-3 px-1 py-3 mt-3 text-[12px] text-[color:var(--muted)] flex-wrap">
                    <span>
                      Showing {pageStart + 1}–
                      {Math.min(pageStart + JOBS_PAGE_SIZE, filteredSavedJobs.length)}{" "}
                      of {filteredSavedJobs.length}
                    </span>
                    {totalJobsPages > 1 && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          onClick={() => setCurrentJobsPage((p) => Math.max(1, p - 1))}
                          disabled={activeJobsPage === 1}
                          className="w-7 h-7 inline-flex items-center justify-center rounded-md bg-[var(--surface-2)] text-[color:var(--muted)] text-[12px] hover:text-[color:var(--foreground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title="Previous page"
                        >
                          ‹
                        </button>
                        {buildPageList(activeJobsPage, totalJobsPages).map((entry, i) =>
                          entry === "…" ? (
                            <span
                              key={`ellipsis-${i}`}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md bg-[var(--surface-2)] text-[color:var(--muted-2)] text-[12px]"
                            >
                              …
                            </span>
                          ) : (
                            <button
                              key={entry}
                              onClick={() => setCurrentJobsPage(entry)}
                              className={`w-7 h-7 inline-flex items-center justify-center rounded-md text-[12px] font-medium transition-colors ${
                                entry === activeJobsPage
                                  ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                                  : "bg-[var(--surface-2)] text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                              }`}
                            >
                              {entry}
                            </button>
                          )
                        )}
                        <button
                          onClick={() =>
                            setCurrentJobsPage((p) => Math.min(totalJobsPages, p + 1))
                          }
                          disabled={activeJobsPage === totalJobsPages}
                          className="w-7 h-7 inline-flex items-center justify-center rounded-md bg-[var(--surface-2)] text-[color:var(--muted)] text-[12px] hover:text-[color:var(--foreground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title="Next page"
                        >
                          ›
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* =================== ANALYTICS PAGE =================== */}
        {activePage === "analytics" && (
          <div className="px-4 py-4">
            {(() => {
              // Freeze the input — once the user lands on Analytics we read
              // from the snapshot (see effect above) so background enrichment
              // / refetches don't tick the report numbers up live.
              const jobs = analyticsSnapshot ?? savedJobs;

              // Calculate metrics
              const today = new Date().toISOString().split("T")[0];
              // "This Week" = today + 6 prior days = 7 dates inclusive.
              // Subtracting 7 days would also include the 8th date (today−7),
              // so use 6 to land on exactly 7 calendar days.
              const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().split("T")[0];

              // capturedDate is a mix of full ISO timestamps (rows hydrated
              // from /api/jobs → scraped_at) and bare YYYY-MM-DD strings
              // (rows merged locally during a scrape). Compare just the date
              // prefix so both formats match today.
              const todayLeads = jobs.filter(
                (j) => (j.capturedDate || "").slice(0, 10) === today
              ).length;
              const weekLeads = jobs.filter((j) => (j.capturedDate || "") >= weekAgo).length;
              const totalLeads = jobs.length;
              const enrichedCount = jobs.filter((j) => j.enriched).length;
              // Funnel counts (sent / opened / open-rate / replied / reply-rate)
              // moved to /api/analytics/funnel so they can be filtered by IST
              // date window. The hooks above set `funnelData` and the Outreach
              // Funnel section consumes it directly.

              // By country (from enriched data)
              const byCountry: Record<string, number> = {};
              jobs.forEach((j) => {
                if (j.enriched?.companyCountry && j.enriched.companyCountry !== "N/A") {
                  byCountry[j.enriched.companyCountry] = (byCountry[j.enriched.companyCountry] || 0) + 1;
                }
              });

              // By company size buckets
              const SIZE_BUCKETS = [
                { label: "1-10 (Startup)", min: 1, max: 10 },
                { label: "11-50 (Small)", min: 11, max: 50 },
                { label: "51-200 (Medium)", min: 51, max: 200 },
                { label: "201-1000 (Large)", min: 201, max: 1000 },
                { label: "1000+ (Enterprise)", min: 1001, max: Infinity },
                { label: "Unknown", min: 0, max: 0 },
              ];
              const bySize: Record<string, number> = {};
              SIZE_BUCKETS.forEach((b) => (bySize[b.label] = 0));
              jobs.forEach((j) => {
                const size = parseInt(j.enriched?.companySize || "0", 10);
                if (!size || isNaN(size)) {
                  bySize["Unknown"]++;
                } else {
                  const bucket = SIZE_BUCKETS.find((b) => size >= b.min && size <= b.max);
                  if (bucket) bySize[bucket.label]++;
                }
              });

              return (
                <>
                  {/* ── Section 1: pipeline counts ────────────────────────
                      Wraps the three pipeline counts in a single outer
                      surface so they read as a distinct group. Inner tiles
                      sit on a tinted background to differentiate from the
                      outer card without nesting the same colour twice. */}
                  <div className="surface p-5 mb-5">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {[
                        {
                          // Orange — pipeline freshness. Categorical, not the
                          // brand accent: it has to stay distinct from the
                          // blue "This Week" card sitting next to it.
                          label: "Today",
                          value: todayLeads,
                          sub: "new jobs",
                          icon: "✦",
                          accent: "#ED7419",
                        },
                        {
                          // Pure blue — distinct from any other "blue" on the
                          // page (sky/indigo are reserved for the funnel row).
                          label: "This Week",
                          value: weekLeads,
                          sub: "captured",
                          icon: "▣",
                          accent: "#3b82f6",
                        },
                        {
                          // Yellow — clear yellow rather than amber, so it
                          // doesn't sit too close to the orange "Opened" card.
                          label: "Total Jobs",
                          value: totalLeads,
                          sub: `${enrichedCount} enriched`,
                          icon: "◇",
                          accent: "#eab308",
                        },
                      ].map((m) => (
                        <div
                          key={m.label}
                          className="rounded-lg p-4 flex flex-col gap-2 border"
                          style={{
                            background: `${m.accent}14`,
                            borderColor: `${m.accent}38`,
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--muted-2)]">
                              {m.label}
                            </p>
                            <span
                              className="w-7 h-7 rounded-md inline-flex items-center justify-center text-[14px]"
                              style={{
                                background: `${m.accent}26`,
                                color: m.accent,
                              }}
                            >
                              {m.icon}
                            </span>
                          </div>
                          <p
                            className="text-[26px] font-semibold leading-none"
                            style={{ color: m.accent }}
                          >
                            {m.value}
                          </p>
                          <p className="text-[12px] text-[color:var(--muted)]">
                            {m.sub}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ── Section 2: outreach funnel ────────────────────────
                      Numbers are pulled live from /api/analytics/funnel
                      (bucketed by IST date) for the selected window. The
                      DateRangePicker drives both endpoints; clicking the
                      same date twice yields a single-day filter. */}
                  <div className="surface p-5 mb-6">
                    <div className="flex items-center gap-3 flex-wrap mb-4">
                      <DateRangePicker
                        mode="single"
                        from={funnelFrom}
                        to={funnelTo}
                        maxDate={initialFunnelDate}
                        anchor="left"
                        onChange={({ from, to }) => {
                          setFunnelFrom(from);
                          setFunnelTo(to);
                        }}
                      />
                      {funnelLoading && (
                        <span className="text-[11px] text-[color:var(--muted-2)]">
                          updating…
                        </span>
                      )}
                      {funnelError && (
                        <span className="text-[11px] text-[color:var(--danger)]">
                          {funnelError}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      {([
                        {
                          // Indigo — outreach starts; distinct from pure blue
                          // ("This Week") and from cyan ("Open Rate").
                          label: "Emails Sent",
                          value: funnelData?.sent ?? 0,
                          icon: "↗",
                          accent: "#6366f1",
                          viewType: "sent" as const,
                        },
                        {
                          // Orange — engagement; distinct from yellow ("Total").
                          label: "Opened",
                          value: funnelData?.opened ?? 0,
                          icon: "◐",
                          accent: "#f97316",
                          viewType: "opened" as const,
                        },
                        {
                          // Cyan — efficiency rate; sits between green and blue
                          // on the wheel so it doesn't clash with either neighbour.
                          label: "Open Rate",
                          value: `${funnelData?.openRate ?? 0}%`,
                          icon: "%",
                          accent: "#06b6d4",
                        },
                        {
                          // Pink (rose) — replies / relationship signal.
                          label: "Replied",
                          value: funnelData?.replied ?? 0,
                          icon: "↩",
                          accent: "#ec4899",
                        },
                        {
                          // Violet — final-funnel conversion rate; one stop
                          // around the wheel from pink so the pair reads as
                          // a related-but-distinct conversion couplet.
                          label: "Reply Rate",
                          value: `${funnelData?.replyRate ?? 0}%`,
                          icon: "%",
                          accent: "#a855f7",
                        },
                      ] as Array<{
                        label: string;
                        value: string | number;
                        icon: string;
                        accent: string;
                        viewType?: "sent" | "opened";
                      }>).map((m) => (
                        <div
                          key={m.label}
                          className="rounded-lg p-4 border"
                          style={{
                            background: `${m.accent}14`,
                            borderColor: `${m.accent}38`,
                          }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--muted-2)]">
                              {m.label}
                            </p>
                            <div className="flex items-center gap-1.5">
                              {m.viewType && (
                                <button
                                  type="button"
                                  onClick={() => openEventsModal(m.viewType!)}
                                  title={`View ${m.label.toLowerCase()}`}
                                  aria-label={`View ${m.label}`}
                                  className="w-7 h-7 rounded-md inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
                                >
                                  {/* eye icon */}
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="15"
                                    height="15"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                </button>
                              )}
                              <span
                                className="w-7 h-7 rounded-md inline-flex items-center justify-center text-[13px] font-semibold"
                                style={{
                                  background: `${m.accent}26`,
                                  color: m.accent,
                                }}
                              >
                                {m.icon}
                              </span>
                            </div>
                          </div>
                          <p
                            className="text-[22px] font-semibold leading-none"
                            style={{ color: m.accent }}
                          >
                            {m.value}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Timeline chart — daily enriched / sent / opened counts
                      pulled live from Supabase via the timeline API. The
                      chip group + Custom picker live INSIDE the chart's
                      surface via the controls slot, so the date filter
                      reads as part of the chart it drives. */}
                  <div className="mb-6">
                    {(() => {
                      // Compute the two preset windows in the user's local
                      // calendar (matches how the picker emits dates). All
                      // three chips compare against these strings, so a
                      // sub-second drift between picks won't desync the
                      // "active" highlight.
                      const ymd = (d: Date) => {
                        const y = d.getFullYear();
                        const mo = String(d.getMonth() + 1).padStart(2, "0");
                        const da = String(d.getDate()).padStart(2, "0");
                        return `${y}-${mo}-${da}`;
                      };
                      const localToday = new Date();
                      // "Last 7 Days" preset — today + 6 prior days (7 inclusive).
                      const last7Start = new Date(localToday);
                      last7Start.setDate(last7Start.getDate() - 6);
                      // "Last 15 Days" preset — today + 14 prior days (15 inclusive),
                      // both windows ending TODAY (not a trailing calendar week).
                      const last15Start = new Date(localToday);
                      last15Start.setDate(last15Start.getDate() - 14);
                      // Iso var names kept (thisWeek*/lastWeek*) so the active-state
                      // checks + onClick handlers below don't need renaming.
                      const thisWeekFromIso = ymd(last7Start);
                      const thisWeekToIso = ymd(localToday);
                      const lastWeekFromIso = ymd(last15Start);
                      const lastWeekToIso = ymd(localToday);
                      const isThisWeek =
                        chartFrom === thisWeekFromIso && chartTo === thisWeekToIso;
                      const isLastWeek =
                        chartFrom === lastWeekFromIso && chartTo === lastWeekToIso;
                      const isCustom = !isThisWeek && !isLastWeek;

                      // Pill / chip styling — accent fill when active,
                      // surface outline otherwise. The "Custom" entry is
                      // the DateRangePicker itself (it brings the popover);
                      // its `active` prop matches this same accent style.
                      const baseChip =
                        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors";
                      const activeChip =
                        "bg-[var(--accent)] text-white border border-[var(--accent)] hover:bg-[var(--accent-hover)]";
                      const inactiveChip =
                        "surface text-[color:var(--foreground)] hover:border-[color:var(--border-strong)]";

                      const controls = (
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={() => {
                              setChartFrom(thisWeekFromIso);
                              setChartTo(thisWeekToIso);
                            }}
                            aria-pressed={isThisWeek}
                            className={`${baseChip} ${isThisWeek ? activeChip : inactiveChip}`}
                          >
                            Last 7 Days
                          </button>
                          <button
                            onClick={() => {
                              setChartFrom(lastWeekFromIso);
                              setChartTo(lastWeekToIso);
                            }}
                            aria-pressed={isLastWeek}
                            className={`${baseChip} ${isLastWeek ? activeChip : inactiveChip}`}
                          >
                            Last 15 Days
                          </button>
                          <DateRangePicker
                            mode="range"
                            // Placeholder until a custom range is active;
                            // once the user picks one, drop the label so
                            // the picker shows the real "May 12 – May 20"
                            // range it selected.
                            label={isCustom ? undefined : "Pick a date range"}
                            active={isCustom}
                            from={chartFrom}
                            to={chartTo}
                            maxDate={initialFunnelDate}
                            anchor="left"
                            onChange={({ from, to }) => {
                              setChartFrom(from);
                              setChartTo(to);
                            }}
                          />
                        </div>
                      );

                      return (
                        <PerformanceChart
                          from={chartFrom}
                          to={chartTo}
                          controls={controls}
                        />
                      );
                    })()}
                  </div>

                  {/* By Country (one card spanning) — only renders when
                      enrichment populated companyCountry on at least one
                      lead. */}
                  {Object.keys(byCountry).length > 0 && (
                    <div className="surface p-5 mb-6">
                      <h3 className="text-[13px] font-semibold text-[color:var(--foreground)] mb-4">
                        Leads by Country
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                        {Object.entries(byCountry)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 10)
                          .map(([c, count]) => {
                            const total = Object.values(byCountry).reduce(
                              (a, b) => a + b,
                              0
                            );
                            return (
                              <div key={c} className="flex items-center gap-3">
                                <span className="text-[12.5px] text-[color:var(--text)] w-40 truncate">
                                  {c}
                                </span>
                                <div className="flex-1 h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-[var(--accent)] rounded-full"
                                    style={{
                                      width: `${(count / total) * 100}%`,
                                    }}
                                  />
                                </div>
                                <span className="text-[12.5px] font-medium text-[color:var(--foreground)] w-8 text-right tabular-nums">
                                  {count}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}

                </>
              );
            })()}
          </div>
        )}

      {/* Multi-Gmail accounts modal — opened from the "Gmails Connected"
          button. Lists every env-configured account slot with its current
          status, an OAuth-redirect Connect button when disconnected, and
          a Disconnect button when connected. Closes on backdrop click. */}
      {gmailModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={() => setGmailModalOpen(false)}
        >
          <div
            className="surface relative w-[min(520px,100%)] rounded-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setGmailModalOpen(false)}
              className="absolute top-3 right-3 text-[color:var(--muted)] hover:text-[color:var(--foreground)] text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
            <h2 className="text-[16px] font-semibold text-[color:var(--foreground)] mb-1">
              Connected Gmail Accounts
            </h2>
            <p className="text-[12px] text-[color:var(--muted)] mb-4">
              Connect one or more Gmail inboxes. The Run Scrape Now button
              parses LinkedIn job alerts from whichever account(s) you select
              in the dropdown.
            </p>
            {gmailSlots.length === 0 ? (
              <div className="text-[13px] text-[color:var(--muted)] py-4">
                No account slots configured. Set
                <code className="mx-1 px-1 py-0.5 rounded bg-[var(--surface-2)] text-[12px]">
                  GMAIL_&lt;LABEL&gt;_CLIENT_ID
                </code>
                and
                <code className="mx-1 px-1 py-0.5 rounded bg-[var(--surface-2)] text-[12px]">
                  _CLIENT_SECRET
                </code>
                env vars to enable slots.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {gmailSlots.map((slot) => (
                  <li
                    key={slot.label}
                    className="flex items-center gap-3 py-3"
                  >
                    <span className="text-2xl">📧</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-[color:var(--foreground)]">
                        {slot.display_name}
                      </div>
                      <div className="text-[12px] text-[color:var(--muted)] truncate">
                        {slot.is_connected
                          ? slot.email ?? "(unknown email)"
                          : "Not connected"}
                        {slot.last_parsed_at && (
                          <>
                            {" · last parsed "}
                            {new Date(slot.last_parsed_at).toLocaleString(
                              "en-IN",
                              {
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {slot.is_connected ? (
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            !confirm(
                              `Disconnect ${slot.email ?? slot.display_name}?`
                            )
                          )
                            return;
                          await fetch(
                            `/api/gmail-accounts?label=${encodeURIComponent(
                              slot.label
                            )}`,
                            { method: "DELETE" }
                          );
                          fetchGmailSlots();
                        }}
                        className="text-[12px] px-3 py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await fetch(
                            `/api/gmail-auth?label=${encodeURIComponent(slot.label)}`
                          );
                          const data = await res.json();
                          if (data?.authUrl) {
                            window.location.href = data.authUrl;
                          } else if (data?.authenticated) {
                            fetchGmailSlots();
                          } else {
                            alert(
                              `Could not start OAuth for '${slot.label}': ${data?.error ?? "unknown error"}`
                            );
                          }
                        }}
                        className="text-[12px] px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                      >
                        Connect
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => setGmailModalOpen(false)}
              className="mt-4 w-full px-4 py-2 rounded-md border border-[var(--border)] text-[13px] text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Auto-Scrape confirm modal — shown when toggling auto-mode ON.
          Replaces the native browser confirm() so the dialog inherits
          the dashboard's tokens (light/dark theme aware, brand accent).
          Cancel / backdrop click closes without changing state. */}
      {autoModeModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={() => setAutoModeModalOpen(false)}
        >
          <div
            className="surface w-full max-w-[520px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] flex items-center justify-center text-[18px] shrink-0">
                ⏱
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-[16px] font-semibold text-[color:var(--foreground)]">
                  Turn on Auto-Scrape?
                </h2>
                <p className="text-[12.5px] text-[color:var(--muted)] mt-1 leading-relaxed">
                  Every 30 minutes the pipeline will run end-to-end on
                  its own. Make sure you&apos;re ready to use real API
                  credits before flipping this on.
                </p>
              </div>
            </div>

            <ul className="mt-4 space-y-2 text-[12.5px] text-[color:var(--text)]">
              <li className="flex gap-2.5">
                <span className="text-[color:var(--accent)] mt-0.5">0.</span>
                <span>
                  <strong className="font-medium">LinkedIn scrape</strong>{" "}
                  once a day — all roles, Freelance filter.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-[color:var(--accent)] mt-0.5">1.</span>
                <span>
                  <strong className="font-medium">Parse Gmail</strong>{" "}
                  alerts and save new jobs to the dashboard.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-[color:var(--accent)] mt-0.5">2.</span>
                <span>
                  <strong className="font-medium">
                    Enrich up to {AUTO_MAX_ENRICH}
                  </strong>{" "}
                  new jobs (Name / Title / Email / LinkedIn).
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-[color:var(--accent)] mt-0.5">3.</span>
                <span>
                  <strong className="font-medium">Reply check</strong> —
                  poll Gmail threads; sequences that got a reply are
                  halted automatically.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-[color:var(--accent)] mt-0.5">4.</span>
                <span>
                  <strong className="font-medium">
                    Send up to {AUTO_MAX_SEND} emails per cycle
                  </strong>{" "}
                  across Trigger / Case Study / Breakup stages.
                </span>
              </li>
            </ul>

            <div className="mt-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-700 dark:text-amber-300 leading-relaxed">
              <p>
                <strong>Daily cap:</strong> {AUTO_DAILY_SEND_CAP} sends /
                day total (resets at midnight, prevents Gmail spam
                throttling).
              </p>
              <p className="mt-1.5">
                <strong>Heads-up:</strong> keep this browser tab open
                — auto-mode runs in the foreground.
              </p>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2.5 flex-wrap">
              <button
                onClick={() => setAutoModeModalOpen(false)}
                className="px-3.5 py-2 rounded-md text-[13px] font-medium text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setAutoModeModalOpen(false);
                  setAutoMode(true);
                  // Mirror to Supabase so the GH Actions crons read
                  // the same truth (fire-and-forget; UI doesn't wait).
                  fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ auto_mode_enabled: true }),
                  }).catch((e) =>
                    console.warn("[auto-mode] settings sync failed:", e)
                  );
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium transition-colors"
              >
                Turn on Auto-Scrape
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Description Modal — full job description popup (Esc / outside click closes) */}
      {descModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setDescModal(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-[color:var(--foreground)] truncate">{descModal.title}</h3>
                <p className="text-sm text-gray-400 mt-0.5">
                  {descModal.company}
                  {" · "}
                  <span className="text-gray-500">{descModal.description.length} chars</span>
                </p>
              </div>
              <button
                onClick={() => setDescModal(null)}
                className="ml-4 text-gray-400 hover:text-[color:var(--foreground)] text-2xl leading-none cursor-pointer"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1">
              <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
                {descModal.description}
              </p>
            </div>
            <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-between bg-gray-950/50">
              {descModal.url && descModal.url !== "N/A" ? (
                <a
                  href={descModal.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 underline"
                >
                  ↗ Open original posting
                </a>
              ) : (
                <span className="text-xs text-gray-600">No URL</span>
              )}
              <button
                onClick={() => setDescModal(null)}
                className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Funnel drill-down modal — lists the emails behind the Emails Sent /
          Opened cards for the selected date window. Job title links to the
          original posting (same as All Jobs); recipient + time shown per row. */}
      {eventsModal && (() => {
        // Accent matches the source card: indigo for Sent, orange for Opened.
        const isOpened = eventsModal.type === "opened";
        const accent = isOpened ? "#f97316" : "#6366f1";
        const fmtTime = (iso: string | null) =>
          iso
            ? new Date(iso).toLocaleString("en-IN", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
                timeZone: "Asia/Kolkata",
              })
            : "—";
        return (
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4"
            onClick={() => setEventsModal(null)}
          >
            <div
              className="bg-[var(--surface)] border border-[var(--border-strong)] rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Accent glow strip */}
              <div className="h-1 w-full" style={{ background: accent }} />

              {/* Header */}
              <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0"
                    style={{ background: `${accent}22`, color: accent }}
                  >
                    {isOpened ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 2-7 20-4-9-9-4Z" />
                        <path d="M22 2 11 13" />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-[color:var(--foreground)] leading-tight">
                      {isOpened ? "Opened Emails" : "Emails Sent"}
                    </h3>
                    <p className="text-xs text-[color:var(--muted-2)] mt-0.5">
                      {funnelFrom === funnelTo ? funnelFrom : `${funnelFrom} → ${funnelTo}`}
                    </p>
                  </div>
                  {!eventsLoading && !eventsError && (
                    <span
                      className="ml-1 text-xs font-semibold px-2.5 py-1 rounded-full shrink-0"
                      style={{ background: `${accent}22`, color: accent }}
                    >
                      {eventsModal.events.length}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setEventsModal(null)}
                  className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer text-xl leading-none"
                  title="Close"
                >
                  ×
                </button>
              </div>

              {/* Body */}
              <div className="px-4 py-3 overflow-y-auto flex-1">
                {eventsLoading && (
                  <div className="flex items-center justify-center gap-2 py-12 text-sm text-[color:var(--muted)]">
                    <span
                      className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
                      style={{ color: accent }}
                    />
                    Loading…
                  </div>
                )}
                {eventsError && !eventsLoading && (
                  <p className="text-sm text-[color:var(--danger)] text-center py-12">
                    {eventsError}
                  </p>
                )}
                {!eventsLoading && !eventsError && eventsModal.events.length === 0 && (
                  <div className="text-center py-12">
                    <p className="text-sm text-[color:var(--muted)]">
                      No emails {isOpened ? "opened" : "sent"} in this window.
                    </p>
                  </div>
                )}
                {!eventsLoading && !eventsError && eventsModal.events.length > 0 && (
                  <ul className="space-y-2">
                    {eventsModal.events.map((ev) => {
                      const when = isOpened ? ev.openedAt : ev.sentAt;
                      const hasLink = !!ev.jobUrl && ev.jobUrl !== "N/A";
                      const avatarChar = (ev.toEmail || "?").charAt(0).toUpperCase();
                      return (
                        <li
                          key={ev.id}
                          className="group rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3 hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            {/* Recipient avatar */}
                            <span
                              className="w-9 h-9 rounded-full inline-flex items-center justify-center text-xs font-bold shrink-0"
                              style={{ background: `${accent}1f`, color: accent }}
                            >
                              {avatarChar}
                            </span>

                            <div className="min-w-0 flex-1">
                              {hasLink ? (
                                <a
                                  href={ev.jobUrl!}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm font-medium text-[color:var(--foreground)] hover:text-[color:var(--accent)] truncate block group-hover:underline"
                                  title={ev.jobTitle || "Open posting"}
                                >
                                  {ev.jobTitle || "(untitled job)"}
                                  <span className="text-[color:var(--muted-2)] ml-1">↗</span>
                                </a>
                              ) : (
                                <span className="text-sm font-medium text-[color:var(--foreground)] truncate block">
                                  {ev.jobTitle || "(untitled job)"}
                                </span>
                              )}
                              <p className="text-xs text-[color:var(--muted)] mt-0.5 truncate flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70">
                                  <rect width="20" height="16" x="2" y="4" rx="2" />
                                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                                </svg>
                                {ev.toEmail || "—"}
                              </p>
                            </div>

                            <div className="text-right shrink-0 flex flex-col items-end gap-1.5">
                              {ev.platform && (
                                <span className="text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[var(--surface)] border border-[var(--border)] text-[color:var(--muted)]">
                                  {ev.platform}
                                </span>
                              )}
                              <span className="text-[11px] text-[color:var(--muted-2)] flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                                {fmtTime(when)}
                              </span>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-3 border-t border-[var(--border)] flex items-center justify-end bg-[var(--surface-2)]/30">
                <button
                  onClick={() => setEventsModal(null)}
                  className="text-xs font-medium px-4 py-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--border-strong)] text-[color:var(--foreground)] transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Email modal removed — composition + send moved to /jobs/[jobId]. */}

      {/* ─────────── Auto Mode Log Panel (floating bottom-right) ─────────── */}
      {autoMode && (
        <div className="fixed bottom-4 right-4 z-40 w-[360px] bg-gray-900/95 backdrop-blur-sm border border-purple-500/40 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between bg-purple-500/10">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-purple-200">🤖 Auto Mode</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full ${
                  autoStatus === "running"
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)] animate-pulse"
                    : "bg-gray-700 text-gray-400"
                }`}
              >
                {autoStatus === "running" ? "running" : "idle"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {autoNextRunAt && autoStatus !== "running" && (
                <span className="text-[10px] text-gray-400">
                  next: {new Date(autoNextRunAt).toLocaleTimeString()}
                </span>
              )}
              <button
                onClick={() => {
                  if (autoStatus === "running") {
                    alert("Cycle is running — wait or toggle Auto Mode OFF first.");
                    return;
                  }
                  if (
                    !confirm(
                      `🗑️  Clear ALL test data?\n\n` +
                      `This will permanently delete:\n` +
                      `  • All ${savedJobs.length} saved jobs\n` +
                      `  • All enrichment data\n` +
                      `  • All threadIds (reply detection will reset)\n` +
                      `  • Method 1 last-scrape timestamp\n` +
                      `  • Today's send counter\n\n` +
                      `Daily/Total counters in Analytics will go back to zero.\n` +
                      `Use this to start a CLEAN testing run.\n\n` +
                      `Continue?`
                    )
                  ) return;
                  // Wipe state + localStorage (everything that affects testing)
                  setSavedJobs([]);
                  localStorage.removeItem("savedJobs");
                  localStorage.removeItem(AUTO_METHOD1_LAST_KEY);
                  localStorage.removeItem(AUTO_DAILY_SENT_KEY);
                  setAutoStats({ parsed: 0, enriched: 0, sent: 0, replied: 0, errors: 0 });
                  setDailySent(0);
                  setAutoLog([]);
                  addAutoLog(`🗑️  Test data cleared — fresh slate`);
                }}
                title="Wipe ALL saved jobs + counters for a clean test run"
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30 cursor-pointer"
              >
                🗑️ Clear all        
              </button>
            </div>
          </div>
          <div className="px-3 py-2 grid grid-cols-5 gap-2 text-center border-b border-gray-800 bg-gray-950/40">
            <div>
              <div className="text-sm font-semibold text-blue-300">{autoStats.parsed}</div>
              <div className="text-[10px] text-gray-500">parsed</div>
            </div>
            <div>
              <div className="text-sm font-semibold text-purple-300">{autoStats.enriched}</div>
              <div className="text-[10px] text-gray-500">enriched</div>
            </div>
            <div>
              <div className="text-sm font-semibold text-green-300">{autoStats.sent}</div>
              <div className="text-[10px] text-gray-500">sent</div>
            </div>
            <div>
              <div className="text-sm font-semibold text-yellow-300">{autoStats.replied}</div>
              <div className="text-[10px] text-gray-500">replied</div>
            </div>
            <div>
              <div className={`text-sm font-semibold ${autoStats.errors > 0 ? "text-red-300" : "text-gray-500"}`}>
                {autoStats.errors}
              </div>
              <div className="text-[10px] text-gray-500">errors</div>
            </div>
          </div>
          <div className="px-3 py-1.5 text-[10px] border-b border-gray-800 bg-gray-950/20 flex justify-between items-center">
            <span className="text-gray-400">📧 Daily sent</span>
            <span
              className={`font-mono ${
                dailySent >= AUTO_DAILY_SEND_CAP
                  ? "text-red-300"
                  : dailySent >= AUTO_DAILY_SEND_CAP * 0.8
                  ? "text-yellow-300"
                  : "text-green-300"
              }`}
            >
              {dailySent} / {AUTO_DAILY_SEND_CAP}
              {dailySent >= AUTO_DAILY_SEND_CAP && <span className="ml-2 text-red-400">CAP HIT</span>}
            </span>
          </div>
          <div className="px-3 py-1.5 text-[10px] text-gray-400 border-b border-gray-800 bg-gray-950/20 flex justify-between items-center">
            <span>🔎 Method 1: LinkedIn · all roles · Freelance</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">
                {(() => {
                  const last = typeof window !== "undefined" ? localStorage.getItem(AUTO_METHOD1_LAST_KEY) : null;
                  if (!last) return "next: on first cycle";
                  const next = parseInt(last, 10) + AUTO_METHOD1_INTERVAL_MS;
                  const hrsLeft = Math.max(0, Math.ceil((next - Date.now()) / (60 * 60 * 1000)));
                  return hrsLeft > 0 ? `next: ~${hrsLeft}h` : "next: this cycle";
                })()}
              </span>
              <button
                onClick={() => {
                  if (!confirm("Reset Method 1 24h gate?\nNext auto cycle will run a fresh LinkedIn scrape (uses Apify credits).")) return;
                  localStorage.removeItem(AUTO_METHOD1_LAST_KEY);
                  addAutoLog(`🔄 Method 1 gate reset — will scrape next cycle`);
                  // Force re-render of the timer label
                  setAutoLog((prev) => [...prev]);
                }}
                title="Clear the 24h gate so Method 1 runs on the next cycle"
                className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 border border-orange-500/30 cursor-pointer"
              >
                🔄 Reset
              </button>
              <button
                onClick={async () => {
                  if (autoStatus === "running") {
                    alert("Cycle already running — wait or toggle Auto Mode OFF/ON.");
                    return;
                  }
                  if (!confirm("Run Method 1 scrape RIGHT NOW?\nThis triggers a full Auto Mode cycle immediately (uses Apify credits).")) return;
                  localStorage.removeItem(AUTO_METHOD1_LAST_KEY);
                  addAutoLog(`▶️  Manual trigger — forcing cycle`);
                  runAutoPipeline();
                }}
                title="Run a full cycle immediately (Method 1 + Gmail + Enrich + Send)"
                className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 cursor-pointer"
              >
                ▶️ Run now
              </button>
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto px-3 py-2 font-mono text-[10px] text-gray-300 space-y-0.5">
            {autoLog.length === 0 ? (
              <div className="text-gray-500 italic">Waiting for first cycle...</div>
            ) : (
              autoLog.slice(-40).map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-words">
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
