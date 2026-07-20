"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Job } from "@/types";

// Shared dashboard state that's read in multiple places across the
// /(dashboard) route group — sidebar count badge, topbar Auto-Scrape
// button, Auto-Scrape confirm modal, Scrape page hero stats, etc.
//
// Page-specific state (which platforms are selected on Via Search,
// which Gmail jobs are queued for review, the current All-Jobs page
// number, etc.) intentionally stays inside the page component — only
// truly cross-page state belongs here.

export interface DashboardContextValue {
  // ─── Jobs (savedJobs) ───────────────────────────────────────────────
  savedJobs: Job[];
  savedJobsLoading: boolean;
  setSavedJobs: (
    next: Job[] | ((prev: Job[]) => Job[])
  ) => void;
  /** Persist a new savedJobs list to localStorage + state. */
  persistSavedJobs: (next: Job[]) => void;

  // ─── Auto-Scrape ────────────────────────────────────────────────────
  autoMode: boolean;
  setAutoMode: (next: boolean) => void;
  autoModeModalOpen: boolean;
  setAutoModeModalOpen: (next: boolean) => void;
  openAutoModeModal: () => void;
  closeAutoModeModal: () => void;
  /**
   * Topbar Auto-Scrape button click handler. Off when on (immediate),
   * opens confirm modal when off (so the user reads what auto-mode
   * actually does before flipping on).
   */
  onAutoScrapeClick: () => void;
  /** Confirm Auto-Scrape ON from inside the modal. */
  confirmAutoScrapeOn: () => void;

  // ─── Sidebar drawer (mobile) ────────────────────────────────────────
  sidebarOpen: boolean;
  setSidebarOpen: (next: boolean) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

/** Bare-domain helper so handlers don't recreate the URL string. */
function syncAutoModeToDb(enabled: boolean) {
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auto_mode_enabled: enabled }),
  }).catch((e) =>
    console.warn("[auto-mode] settings sync failed:", e)
  );
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  // ─── Jobs ─────────────────────────────────────────────────────────
  const [savedJobs, setSavedJobsState] = useState<Job[]>([]);
  const [savedJobsLoading, setSavedJobsLoading] = useState(true);

  // Set + mirror to localStorage. Components used to write to nlocal
  // storage themselves — now they go through this so the cache stays
  // in sync without scattering writes everywhere.
  const persistSavedJobs = useCallback((next: Job[]) => {
    setSavedJobsState(next);
    try {
      localStorage.setItem("savedJobs", JSON.stringify(next));
    } catch {
      /* quota / SSR / unavailable — ignore */
    }
  }, []);

  // Setter that accepts either a value or an updater — for `prev =>`
  // patterns inside callbacks. Mirrors to localStorage on every write
  // so a refresh restores the latest state.
  const setSavedJobs = useCallback(
    (next: Job[] | ((prev: Job[]) => Job[])) => {
      setSavedJobsState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          localStorage.setItem("savedJobs", JSON.stringify(resolved));
        } catch {
          /* quota / unavailable — ignore */
        }
        return resolved;
      });
    },
    []
  );

  // Fetch jobs from DB on first mount. Falls back to localStorage if
  // the API is unreachable so the user doesn't stare at an empty list
  // during a deploy or transient outage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/jobs");
        if (res.ok) {
          const json = await res.json();
          if (cancelled) return;
          if (json?.success && Array.isArray(json.jobs)) {
            setSavedJobsState(json.jobs as Job[]);
            setSavedJobsLoading(false);
            try {
              localStorage.setItem(
                "savedJobs",
                JSON.stringify(json.jobs)
              );
            } catch {
              /* ignore */
            }
            return;
          }
        }
      } catch (err) {
        console.warn(
          "[jobs] /api/jobs unreachable — falling back to localStorage:",
          err
        );
      }
      if (cancelled) return;
      const stored = localStorage.getItem("savedJobs");
      if (stored) {
        try {
          const list = JSON.parse(stored) as Job[];
          if (Array.isArray(list)) setSavedJobsState(list);
        } catch {
          /* corrupt cache — ignore */
        }
      }
      setSavedJobsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Auto-Scrape ───────────────────────────────────────────────────
  // Pure per-session state — defaults to OFF on every page load, regardless
  // of what's in DB. The dashboard's Auto-Scrape loop is a FOREGROUND tab
  // feature (scrapes while this tab is open); we don't want it to spin up
  // automatically just because someone opened the dashboard to check
  // something. Server-side scheduling is handled by GitHub Actions cron
  // reading settings.daily_schedule_times — independent of this toggle.
  const [autoMode, setAutoModeState] = useState(false);
  const [autoModeModalOpen, setAutoModeModalOpen] = useState(false);

  const setAutoMode = useCallback((next: boolean) => {
    setAutoModeState(next);
    syncAutoModeToDb(next);
  }, []);

  const openAutoModeModal = useCallback(() => {
    setAutoModeModalOpen(true);
  }, []);
  const closeAutoModeModal = useCallback(() => {
    setAutoModeModalOpen(false);
  }, []);

  const onAutoScrapeClick = useCallback(() => {
    setAutoModeState((wasOn) => {
      if (wasOn) {
        // Turning OFF — immediate, no confirm.
        syncAutoModeToDb(false);
        return false;
      }
      // Turning ON — open modal, let confirmAutoScrapeOn() actually flip.
      setAutoModeModalOpen(true);
      return wasOn; // unchanged until user confirms
    });
  }, []);

  const confirmAutoScrapeOn = useCallback(() => {
    setAutoModeModalOpen(false);
    setAutoModeState(true);
    syncAutoModeToDb(true);
  }, []);

  // ─── Sidebar drawer ────────────────────────────────────────────────
  // Default open on desktop, closed on first mobile render so the
  // drawer doesn't cover the page on landing.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
    }
  }, []);

  // ─── Build the value once per relevant change ──────────────────────
  const value = useMemo<DashboardContextValue>(
    () => ({
      savedJobs,
      savedJobsLoading,
      setSavedJobs,
      persistSavedJobs,
      autoMode,
      setAutoMode,
      autoModeModalOpen,
      setAutoModeModalOpen,
      openAutoModeModal,
      closeAutoModeModal,
      onAutoScrapeClick,
      confirmAutoScrapeOn,
      sidebarOpen,
      setSidebarOpen,
    }),
    [
      savedJobs,
      savedJobsLoading,
      setSavedJobs,
      persistSavedJobs,
      autoMode,
      setAutoMode,
      autoModeModalOpen,
      openAutoModeModal,
      closeAutoModeModal,
      onAutoScrapeClick,
      confirmAutoScrapeOn,
      sidebarOpen,
    ]
  );

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

/**
 * Read the dashboard context. Throws if used outside a provider —
 * which is intentional, since that signals a wiring bug (a page
 * rendering outside the /(dashboard) route group).
 */
export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error(
      "useDashboard() must be used inside <DashboardProvider> " +
        "(provided by app/(dashboard)/layout.tsx)."
    );
  }
  return ctx;
}
