"use client";

import { useEffect, useState, useRef, use } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripRecruiterNameCard } from "@/lib/utils/html-to-text";
// ThemeToggle now lives in the shared Sidebar (rendered by
// /(dashboard)/layout.tsx) so the detail page no longer imports it.

// Per-job detail page. Layout matches mockup/job-detail.html:
//   • Sidebar (ScraperAI brand, nav, user footer) — anchor links back to /.
//   • Topbar with breadcrumb "← All Jobs / <title>".
//   • Detail header — title, then a full-width Contact card whose top
//     strip is "Company · Location · Job-type" and whose body is a
//     4-column Name / Title / Email / LinkedIn grid.
//   • Description card (full width).
//   • Generate / Re-generate row + generated email card with Send action.
//   • Email history list at the bottom.

// Shared types — see types/index.ts. Locally-scoped aliases keep the
// rest of the file's code (which uses these by bare name) untouched.
import type {
  DetailCandidate as Candidate,
  JobRow,
  EmailRow,
  JobDetailResponse as ApiResponse,
} from "@/types";

type Generated = { subject: string; body: string };

const cacheKey = (jobId: string) => `gen_email_${jobId}`;

const STAGE_LABELS: Record<number, string> = {
  1: "Trigger",
  2: "Case Study",
  3: "Final follow-up",
};

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // Auto-fetch lifecycle — `refetchingDesc` is true while the page is
  // silently pulling the full JD from LinkedIn (see autoFetchDescription +
  // the effect below). No manual button — it just happens on page load.
  const [refetchingDesc, setRefetchingDesc] = useState(false);
  // Update the generated draft + persist the edit to localStorage so a
  // refresh / re-mount picks up the user's tweaks. Subject and body
  // edits both flow through this so the cache stays in sync.
  const updateGenerated = (patch: Partial<Generated>) => {
    setGenerated((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(
          cacheKey(jobId),
          JSON.stringify({ ...next, ts: generatedAt ?? Date.now() })
        );
      } catch {
        /* quota / unavailable — ignore */
      }
      return next;
    });
  };
  // Refine-with-prompt modal — opens on click, captures a free-form
  // user instruction, and on Apply triggers a fresh generation that
  // ignores the existing draft (one-shot; textarea clears on close).
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  // Saved-prompts library — fetched from /api/prompts on mount.
  // `selectedPromptId === ""` means no saved prompt picked, so the
  // first-time generate() call goes through with no customPrompt
  // override (baseline Manatanu prompt alone).
  const [savedPrompts, setSavedPrompts] = useState<
    { id: string; name: string; body: string }[]
  >([]);
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentInfo, setSentInfo] = useState<{
    to: string;
    subject: string;
  } | null>(null);
  // jobsCount badge moved to the shared Sidebar (sources from
  // DashboardContext.savedJobs.length) so no per-page fetch needed.

  // Hydrate the cached generated email (if any) before the first server
  // round-trip so the user sees their last draft immediately on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem(cacheKey(jobId));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Generated & { ts?: number };
      if (parsed?.subject || parsed?.body) {
        setGenerated({ subject: parsed.subject, body: parsed.body });
        if (parsed.ts) setGeneratedAt(parsed.ts);
      }
    } catch {
      /* corrupt cache — ignore */
    }
  }, [jobId]);

  // Pull the saved prompts library so the dropdown next to Generate
  // email has something to show. One-time fetch on mount; the /prompts
  // page is the source of truth for adds/edits/deletes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/prompts", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json?.success && Array.isArray(json.data)) {
          setSavedPrompts(json.data);
        }
      } catch {
        /* ignore — dropdown just stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the job + its email_tracking history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const json = (await res.json()) as ApiResponse;
        if (cancelled) return;
        setData(json);
      } catch (err) {
        if (cancelled) return;
        setData({ success: false, error: String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // /api/jobs count fetch removed — DashboardContext provides the
  // live count via savedJobs.length, which the Sidebar consumes.

  // generate() drives all four cases via two optional inputs:
  //   • basePromptBody → a selected saved prompt becomes the BASE (replaces the
  //     fixed Manatanu prompt). Omitted → fixed Manatanu prompt is the base.
  //   • instructions   → typed "Add instructions" text, layered on top of the
  //     base as a highest-priority override.
  // So: (prompt + instructions), (prompt only), (fixed + instructions), or
  // (fixed only) — matching the dropdown × instructions matrix.
  const generate = async (opts?: {
    instructions?: string;
    basePromptBody?: string;
  }) => {
    if (!data?.job) return;
    const instructions = opts?.instructions?.trim() || undefined;
    const basePromptBody = opts?.basePromptBody?.trim() || undefined;
    const candidate = candidateFromJob(data.job);
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job: {
            title: data.job.title,
            company: data.job.company,
            description: data.job.description ?? "",
            url: data.job.url ?? "",
            location: data.job.location ?? "",
            jobType: data.job.job_type ?? "",
          },
          contactName: candidate.name,
          companyName: data.job.company,
          stage: 1,
          customPrompt: instructions, // typed override instructions (optional)
          basePromptBody, // selected saved prompt as the base (optional)
        }),
      });
      const json = await res.json();
      if (!json.success || !json.data) {
        setGenError(json.error || "Generate failed");
        return;
      }
      const next: Generated = {
        subject: json.data.subject ?? "",
        body: json.data.body ?? "",
      };
      const now = Date.now();
      setGenerated(next);
      setGeneratedAt(now);
      try {
        localStorage.setItem(
          cacheKey(jobId),
          JSON.stringify({ ...next, ts: now })
        );
      } catch {
        /* quota / unavailable — ignore */
      }
    } catch (err) {
      setGenError(String(err));
    } finally {
      setGenerating(false);
    }
  };

  // Send the currently-shown subject + body via /api/send-email. Once
  // successful: clear the cached draft and re-fetch so the email_tracking
  // list below reflects the new row.
  const send = async () => {
    if (!data?.job || !generated) return;
    const candidate = candidateFromJob(data.job);
    if (!candidate.email) {
      setSendError("No contact email on this job — can't send.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: candidate.email,
          subject: generated.subject,
          body: generated.body,
          stage: 1,
          jobId: data.job.job_id,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setSendError(json.error || "Send failed");
        return;
      }
      setSentInfo({ to: candidate.email, subject: generated.subject });
      try {
        localStorage.removeItem(cacheKey(jobId));
      } catch {
        /* ignore */
      }
      try {
        const refresh = await fetch(`/api/jobs/${jobId}`);
        const refreshed = (await refresh.json()) as ApiResponse;
        if (refreshed.success) setData(refreshed);
      } catch {
        /* non-blocking */
      }
    } catch (err) {
      setSendError(String(err));
    } finally {
      setSending(false);
    }
  };

  // Auto-fetch the full JD from LinkedIn. Runs once on page load (see the
  // effect below) whenever the saved description is missing or is just the
  // "{title} at {company}" stub — re-runs the same cheerio → ScrapingBee
  // chain parse-gmail uses, PATCHes jobs_v2 so the result persists, and
  // updates the on-screen view. Fully automatic — no button, no toast.
  const autoFetchDescription = async () => {
    if (!data?.job?.url) return;
    setRefetchingDesc(true);
    try {
      const res = await fetch("/api/fetch-job-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: data.job.url }),
      });
      const json = (await res.json()) as {
        success: boolean;
        description?: string;
        location?: string;
        error?: string;
      };
      if (!json.success) return;
      const newDesc = (json.description || "").trim();
      if (!newDesc || newDesc.length < 100) return;
      // Persist via PATCH so the row is fresh for next visit / email gen.
      const newLocation = (json.location || "").trim();
      const patchBody: Record<string, string> = { description: newDesc };
      // Only overwrite location if we got a real one AND the current one
      // looks like a stub ("N/A" / "—" / empty). Method-1 (Apify) rows
      // carry trusted locations we don't want to clobber.
      const currentLoc = (data.job.location || "").trim();
      if (newLocation && (!currentLoc || currentLoc === "N/A" || currentLoc === "—")) {
        patchBody.location = newLocation;
      }
      try {
        await fetch(`/api/jobs/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
      } catch {
        /* non-blocking — UI update below still happens */
      }
      // Refresh local view so the new description renders immediately.
      setData((prev) => {
        if (!prev || !prev.job) return prev;
        const updatedJob: JobRow = {
          ...prev.job,
          description: newDesc,
          ...(patchBody.location ? { location: patchBody.location } : {}),
        };
        return { ...prev, job: updatedJob };
      });
    } catch {
      /* swallow — auto-fetch is best-effort; the page still shows what it has */
    } finally {
      setRefetchingDesc(false);
    }
  };

  // Fire the auto-fetch once per mount, as soon as the job has loaded and
  // its saved description looks like an empty / "{title} at {company}" stub.
  const autoFetchedRef = useRef(false);
  useEffect(() => {
    if (loading || autoFetchedRef.current) return;
    const j = data?.job;
    if (!j || !j.url) return;
    const d = (j.description || "").trim();
    const stub = `${j.title || ""} at ${j.company || ""}`.trim();
    if (!d || d.length < 150 || d === stub) {
      autoFetchedRef.current = true;
      autoFetchDescription();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, data]);

  // ── Loading + error shells ───────────────────────────────────────────
  if (loading) {
    return (
      <>
        <div className="px-7 pt-7">
          <div className="h-7 w-2/3 bg-[var(--surface-2)] rounded animate-pulse" />
          <div className="h-32 surface mt-6 animate-pulse" />
          <div className="h-64 surface mt-6 animate-pulse" />
        </div>
      </>
    );
  }
  if (!data?.success || !data.job) {
    return (
      <>
        <div className="px-7 pt-7">
          <h1 className="text-2xl font-semibold">Job not found</h1>
          <p className="text-[color:var(--muted)] mt-2">
            {data?.error || "Unknown error"}
          </p>
        </div>
      </>
    );
  }

  const job = data.job;
  const candidate = candidateFromJob(job);
  const cleanCompany = job.company.replace(/\s*\(.*\)/, "").trim();
  const lastGenerated = formatRelative(generatedAt);
  const description = (job.description || "").trim();

  return (
    <>
      {/* ── Top breadcrumb ───────────────────────────────────────────── */}
      <header className="px-3 py-3 border-b border-[var(--border)] bg-[var(--background)]/85 backdrop-blur-md sticky top-0 z-20">
        <div className="text-[12px] text-[color:var(--muted)] inline-flex items-center gap-1.5">
          <a
            href="/jobs"
            className="hover:text-[color:var(--foreground)] transition-colors"
          >
            ← All Jobs
          </a>
          <span className="text-[color:var(--muted-2)]">/</span>
          <span className="truncate max-w-[40ch]">{job.title}</span>
        </div>
      </header>

      {/* ── Detail header: title + contact card ───────────────────────── */}
      <div className="px-7 pt-7">
        <h1 className="text-[30px] font-semibold leading-[1.2] tracking-[-0.015em] break-words">
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--foreground)] hover:text-[color:var(--accent)] transition-colors"
            >
              {job.title}
            </a>
          ) : (
            <span className="text-[color:var(--foreground)]">{job.title}</span>
          )}
        </h1>

        {/* Full-width contact card. Top strip is the company-initial
            avatar + meta line (with bottom border), bottom is a
            4-column Name/Title/Email/LinkedIn grid that drops to 2
            columns under md and 1 column on small phones. */}
        <div className="surface mt-[22px] px-[22px] py-[18px]">
          <div className="flex items-center gap-3 pb-3.5 mb-4 border-b border-[var(--border)]">
            {/* Company-initial tile — accent-soft bg with the first
                letter of the company. Pure visual anchor, no link. */}
            <div className="w-9 h-9 rounded-md bg-[var(--accent-soft)] text-[color:var(--accent)] flex items-center justify-center text-[14px] font-semibold shrink-0 uppercase border border-[color:var(--accent)]/20">
              {(cleanCompany || "?").trim().charAt(0)}
            </div>
            <p className="text-[14px] text-[color:var(--muted)] min-w-0 truncate">
              <span className="text-[color:var(--foreground)] font-medium">
                {cleanCompany}
              </span>
              {hasValue(job.location) && (
                <>
                  <span className="mx-1.5">·</span>
                  {job.location}
                </>
              )}
              {hasValue(job.job_type) && (
                <>
                  <span className="mx-1.5">·</span>
                  {job.job_type}
                </>
              )}
            </p>
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-[18px]">
            <ContactField label="Name" value={candidate.name} />
            <ContactField label="Title" value={candidate.title} />
            <ContactField
              label="Email"
              value={candidate.email}
              href={candidate.email ? `mailto:${candidate.email}` : undefined}
            />
            <ContactField
              label="LinkedIn"
              value={candidate.linkedin}
              href={candidate.linkedin || undefined}
              external
              displayOverride={
                candidate.linkedin
                  ? candidate.linkedin.replace(/^https?:\/\//, "")
                  : undefined
              }
            />
          </dl>
        </div>
      </div>

      {/* ── Description + generator + history ─────────────────────────── */}
      <div className="px-7 pt-2">
        <SectionHeading>Description</SectionHeading>
        <div className="surface mt-2.5 p-7 text-[15px] leading-[1.75]">
          {refetchingDesc ? (
            <span className="text-[color:var(--muted-2)]">
              Fetching the full description from LinkedIn…
            </span>
          ) : description ? (
            <DescriptionMarkdown source={description} />
          ) : (
            <span className="text-[color:var(--muted-2)]">
              No description scraped.
            </span>
          )}
        </div>

        {/* Generate button row.
            - "Generate email" (no draft yet)  → fires generate() with
              the dropdown's prompt (or no override if "— None —").
            - Dropdown (right of button, only visible when no draft yet)
              picks a saved prompt to seed the first generation.
              Selected body flows in as `customPrompt` — same override
              mechanism the Refine modal uses. "— None (baseline) —"
              leaves customPrompt undefined so the LLM uses only the
              baseline Manatanu prompt.
            - "Re-generate"   (draft present)  → opens the inline prompt
              panel below, so the user can optionally steer the next run
              with a custom instruction (or just hit Regenerate empty for
              a default re-roll). */}
        <div className="mt-[22px] flex items-end gap-3 flex-wrap">
          <button
            onClick={() => {
              if (!generated) {
                const picked = savedPrompts.find(
                  (p) => p.id === selectedPromptId
                );
                // Dropdown saved prompt → it becomes the base prompt. No
                // selection → fixed Manatanu prompt alone.
                generate({ basePromptBody: picked?.body });
                return;
              }
              setPromptOpen((v) => !v);
            }}
            disabled={generating || !candidate.email}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
              promptOpen
                ? "bg-[var(--accent)] text-[color:var(--foreground)]"
                : "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)]"
            }`}
            title={
              candidate.email
                ? generated
                  ? "Re-generate the email (opens prompt panel)"
                  : "Generate a Stage 1 cold email"
                : "No contact email — enrich first"
            }
          >
            {generating
              ? "Generating…"
              : generated
              ? "Re-generate"
              : "Generate email"}
          </button>
          {/* Prompt picker — shown for BOTH Generate and Re-generate, sitting
              next to the button. Drives selectedPromptId, which both the
              first-generate and the Re-generate panel read as the base prompt. */}
          {savedPrompts.length > 0 && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prompt-picker"
                className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)]"
              >
                Choose Custom prompt
              </label>
              <select
                id="prompt-picker"
                value={selectedPromptId}
                onChange={(e) => setSelectedPromptId(e.target.value)}
                disabled={generating}
                title="Pick a saved prompt as the base (or leave on the fixed Manatanu prompt). Used for both Generate and Re-generate."
                className="px-3 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--foreground)] focus:outline-none focus:border-[color:var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors max-w-[220px]"
              >
                <option value="">Choose Custom prompt</option>
                {savedPrompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {lastGenerated && (
            <span className="ml-auto self-center text-[12px] text-[color:var(--muted)]">
              Last generated · {lastGenerated}
            </span>
          )}
          {genError && !promptOpen && (
            <span className="text-[12px] text-red-400 pb-2">{genError}</span>
          )}
        </div>

        {/* Inline refine panel — only renders when promptOpen and a
            draft already exists. The user can type free-form
            instructions (or pick a quick chip), then either Cancel or
            Regenerate. Empty prompt = plain re-generation. */}
        {promptOpen && generated && (
          <div className="surface mt-3 p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-[color:var(--accent)] text-[14px]">✨</span>
                <h2 className="text-[14px] font-semibold text-[color:var(--foreground)] tracking-[-0.01em]">
                  Add instructions for the LLM
                </h2>
              </div>
              <button
                onClick={() => {
                  if (generating) return;
                  setPromptOpen(false);
                  setPromptDraft("");
                }}
                disabled={generating}
                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Base prompt is chosen via the "Choose Custom prompt" dropdown
                next to the Re-generate button above; the typed instructions
                below layer on top of whatever is selected there. */}

            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              placeholder="e.g. Make it more casual, mention my Pinecone experience first, keep it under 80 words…"
              rows={4}
              autoFocus
              disabled={generating}
              className="w-full px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13px] text-[color:var(--text)] placeholder:text-[color:var(--muted-2)] focus:outline-none focus:border-[color:var(--accent)] transition-colors resize-y leading-relaxed"
            />

            {/* Quick chips — append to the textarea so the user can
                stack multiple directives in one prompt. */}
            <div className="flex gap-2 flex-wrap mt-3">
              {[
                { label: "+ More casual", text: "Make it more casual." },
                { label: "+ Shorter", text: "Make it shorter — under 100 words." },
                { label: "+ Add CTA", text: "Add a stronger call to action." },
                { label: "+ More formal", text: "Make it more formal." },
              ].map((chip) => (
                <button
                  key={chip.label}
                  onClick={() =>
                    setPromptDraft((d) =>
                      d.trim()
                        ? `${d.trimEnd()} ${chip.text}`
                        : chip.text
                    )
                  }
                  disabled={generating}
                  className="text-[11.5px] px-2.5 py-1 rounded-md bg-[var(--surface-2)] text-[color:var(--muted)] border border-[var(--border)] hover:text-[color:var(--foreground)] hover:border-[var(--border-strong)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-[var(--border)] flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11.5px] text-[color:var(--muted-2)]">
                Base prompt + your instructions → LLM
              </span>
              <div className="flex items-center gap-2">
                {genError && (
                  <span className="text-[12px] text-red-400 mr-2">
                    {genError}
                  </span>
                )}
                <button
                  onClick={() => {
                    if (generating) return;
                    setPromptOpen(false);
                    setPromptDraft("");
                  }}
                  disabled={generating}
                  className="px-3.5 py-2 rounded-md text-[13px] font-medium text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (generating) return;
                    // Base = selected saved prompt (if any), else fixed Manatanu;
                    // typed instructions layered on top as a high-priority override.
                    const picked = savedPrompts.find(
                      (p) => p.id === selectedPromptId
                    );
                    await generate({
                      instructions: promptDraft,
                      basePromptBody: picked?.body,
                    });
                    setPromptOpen(false);
                    setPromptDraft("");
                  }}
                  disabled={generating}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {generating ? "Regenerating…" : "Regenerate ↗"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Generated email card */}
        {generated && (
          <div className="surface mt-3.5 px-[22px] py-[22px]">
            {/* Subject — always inline-editable. Edits flow through
                updateGenerated() so they persist to localStorage and
                are picked up by the Send action below. */}
            <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)]">
              Subject
            </label>
            <input
              type="text"
              value={generated.subject}
              onChange={(e) => updateGenerated({ subject: e.target.value })}
              className="w-full mt-1.5 px-3 py-2 text-[15px] font-medium bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[color:var(--foreground)] focus:outline-none focus:border-[color:var(--accent)] transition-colors"
            />

            <div className="mt-[18px]">
              <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)]">
                Body
              </label>
              {/* Always-on inline editor. The user can click anywhere
                  inside the rendered email and start typing — fix typos,
                  rephrase a sentence, add a bullet, etc. Edits flow
                  through updateGenerated() so they persist to
                  localStorage and ship verbatim when Send is clicked. */}
              <EditableEmailBody
                body={generated.body}
                onChange={(newBody) => updateGenerated({ body: newBody })}
              />
            </div>

            {/* Divider strip — gradient line, accent on the left fading
                to transparent on the right. Subtler than a flat border
                while still separating the body from the send actions. */}
            <div className="mt-[22px] pt-[18px] relative flex items-center gap-3.5 flex-wrap">
              <div
                aria-hidden="true"
                className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-[var(--accent)]/40 via-[var(--border)] to-transparent"
              />
              {sentInfo ? (
                <span className="text-[12px] text-[color:var(--accent)]">
                  ✓ Sent to {sentInfo.to}
                </span>
              ) : (
                <>
                  <button
                    onClick={send}
                    disabled={sending || !candidate.email}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[color:var(--foreground)] text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {sending ? "Sending…" : "Send Email"}
                  </button>
                  {candidate.email && (
                    <span className="text-[12px] text-[color:var(--muted)]">
                      To{" "}
                      <span className="text-[color:var(--foreground)] font-medium">
                        {candidate.email}
                      </span>
                    </span>
                  )}
                </>
              )}
              {sendError && (
                <span className="text-[12px] text-red-400">{sendError}</span>
              )}
            </div>
          </div>
        )}

        {/* Email history */}
        {data.emails && data.emails.length > 0 && (
          <div className="mt-9">
            <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
              <SectionHeading>Email History</SectionHeading>
              <span className="text-[12px] text-[color:var(--muted)]">
                {data.emails.length}{" "}
                {data.emails.length === 1 ? "email" : "emails"}
              </span>
            </div>
            <div className="surface overflow-hidden">
              {data.emails.map((e) => (
                <HistoryRow key={e.id} email={e} />
              ))}
            </div>
          </div>
        )}

        {/* Bottom breathing room — matches the mockup's trailing 60px. */}
        <div className="h-[60px]" />
      </div>
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function candidateFromJob(job: JobRow): Candidate {
  const e = job.enrichment ?? {};
  return {
    email: e.email ?? null,
    name: e.name ?? null,
    title: e.title ?? null,
    linkedin: e.linkedin ?? null,
  };
}

function hasValue(v: string | null | undefined): boolean {
  return Boolean(v && v !== "N/A");
}

function formatRelative(ts: number | null): string | null {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Format a scraped job description into a section-headed layout.
//
// Most descriptions arrive as a single wall of text where section
// headers like `Skills & Requirements:` are glued directly to the body
// text (".essential.Skills & Requirements :Pytorch..."). This walks the
// string, detects "Capitalised Phrase:" patterns inline, injects a
// paragraph break before each one, wraps the heading in **bold**, and
// ensures exactly one space after the colon — so ReactMarkdown then
// renders distinct paragraphs with bold headings (matches the mockup).
//
// Heading rules:
//   - Starts with a capital letter
//   - Up to ~5 word tokens (each token: capitalised word, &, /, -, or a
//     short lowercase connector like "of"/"and"/"the"/"with"/"to"/"or"/
//     "in")
//   - Total length ≤ 60 chars
//   - Ends with a colon
function preprocessDescription(raw: string): string {
  if (!raw) return raw;

  // (0) Drop a leaked "Meet the hiring team" recruiter-name card. Older
  // rows were scraped before the scrape-time strip existed, so repair them
  // here at render time too.
  let text = stripRecruiterNameCard(raw);

  // (A) Repair bold markers whose whitespace sits INSIDE the ** ** — the
  // LinkedIn editor often bolds a trailing space ("**Job title: **"), and
  // Markdown only renders **x** when no space hugs the markers, so move it
  // outside. The [^*\n] content guard stops adjacent bold spans merging.
  text = text
    .replace(/\*\*([^*\n]+?)(\s+)\*\*/g, "**$1**$2")
    .replace(/\*\*(\s+)([^*\n]+?)\*\*/g, "$1**$2**");

  // (A2) Re-glue numbered section headings LinkedIn's HTML split across
  // blocks — "3.\n\n**Responsibilities**\n\n:" must collapse back to the
  // single list item "3. **Responsibilities**:" so it numbers + renders
  // correctly instead of leaving an orphan "3." and a stray ":".
  text = text.replace(
    /(^|\n)(\d{1,2})\.\n+([^\n:]{1,70}?)\n+:(?=\s|$)/g,
    "$1$2. $3:"
  );

  // (A3) Heading cleanup — when LinkedIn's HTML split a bold section
  // heading from a trailing colon that landed on its own line
  // ("**Responsibilities**\n\n:"), glue the ":" back onto the heading.
  // NB: no ":**"-stripping here — that would wreck a valid "**Heading:**".
  text = text.replace(/(\*\*[^\n*]+\*\*)\n+:(?=\s|$)/g, "$1:");

  // (B) If the description already has real line structure (it came through
  // the HTML→Markdown converter), skip the glued-heading heuristic below —
  // running it on structured text mangles list items, e.g. it would split
  // "1. About Our Client:" into an orphan "1." plus a separate heading.
  if ((text.match(/\n/g) || []).length >= 6) return text;

  const HEADING =
    "[A-Z][a-zA-Z]+(?:\\s+(?:&|\\/|\\-|of|and|or|to|the|in|with|[A-Z][a-zA-Z]*)){0,4}\\s*:";

  // Tighten "Word :" → "Word:" so the bolded heading reads cleanly even
  // when the source had stray whitespace before the colon.
  const tighten = (s: string) => s.replace(/\s+:$/, ":");

  // Pass 1: every inline heading (preceded by some body text) gets
  // promoted to its own paragraph + bolded. `(\S)` ensures we only
  // match when the heading is glued to prior content; standalone
  // headings on their own line fall through to Pass 2.
  text = text.replace(
    new RegExp(`(\\S)\\s*(${HEADING})\\s*`, "g"),
    (m, before: string, heading: string) => {
      if (heading.length > 60) return m;
      return `${before}\n\n**${tighten(heading)}** `;
    }
  );

  // Pass 2: if the very first thing in the text is a heading, bold it
  // too (Pass 1 needs a leading non-whitespace char, so it skips this
  // case).
  text = text.replace(
    new RegExp(`^\\s*(${HEADING})\\s*`),
    (m, heading: string) => {
      if (heading.length > 60) return m;
      return `**${tighten(heading)}** `;
    }
  );

  return text;
}

// ─── Sub-components ───────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)]">
      {children}
    </h2>
  );
}

// Markdown renderer for the job description. Element-level overrides so
// the output picks up the dashboard's tokens (white headings, accent
// links, surface-2 inline code, etc.) instead of unstyled HTML defaults.
// Generated-email body preview. /api/generate-email returns a complete
// inline-CSS HTML document for the Manatanu brand template; rendering it
// Inline-editable email body. Renders the generated HTML directly in
// a contentEditable div so the user can click anywhere inside the
// rendered email and start typing — fix typos, rephrase, add lines.
// On every edit the inner HTML is read back, stitched into the
// original document skeleton, and pushed to onChange.
//
// For plain-text bodies (legacy / non-HTML outputs) it falls back to a
// resizable <textarea> so the same "click to edit" UX still applies.
function EditableEmailBody({
  body,
  onChange,
}: {
  body: string;
  onChange: (next: string) => void;
}) {
  const trimmed = body.trimStart().slice(0, 200).toLowerCase();
  const isHtml =
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    /<body\b/i.test(trimmed);

  // Plain-text path — just a tall textarea, same UX (click + type).
  if (!isHtml) {
    return (
      <textarea
        value={body}
        onChange={(e) => onChange(e.target.value)}
        rows={16}
        className="w-full mt-4 px-4 py-3 rounded-md border border-[var(--border)] bg-white text-[14px] leading-[1.6] text-[#333] focus:outline-none focus:border-[color:var(--accent)] resize-y transition-colors"
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      />
    );
  }

  // HTML path. Extract just the <body> inner so it can be edited
  // naturally (browsers ignore <html> / <head> when rendered inside
  // another element). On edit, splice the modified inner back into
  // the original full document so the doctype + skeleton + inline
  // <style> survive. The Send pipeline always receives a complete
  // HTML document this way.
// Preview-only swap: the real send pipeline needs "cid:manatanu-logo"
  // (an inline attachment reference, valid only inside a sent email), but
  // a browser preview has no attachment to resolve it against. Swap it for
  // the same file served normally from /public just for on-screen display.
  const CID_LOGO_SRC = "cid:manatanu-logo";
  const PREVIEW_LOGO_SRC = "/manatanu-logo.jpg";

  const bodyInner = (() => {
    const m = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const inner = m ? m[1] : body;
    return inner.split(CID_LOGO_SRC).join(PREVIEW_LOGO_SRC);
  })();
  // Initial editor HTML is set once via a ref-based effect so React
  // doesn't re-mount the contentEditable on every keystroke (which
  // would reset the caret position). Only re-syncs when the parent
  // replaces the entire body (e.g. Re-generate).
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedRef = useRef<string>("");
  useEffect(() => {
    if (!editorRef.current) return;
    if (bodyInner !== lastSyncedRef.current) {
      editorRef.current.innerHTML = bodyInner;
      lastSyncedRef.current = bodyInner;
    }
  }, [bodyInner]);

  return (
    <div className="mt-4 rounded-md overflow-hidden border border-[var(--border)] bg-white">
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => {
                  const editedInner = e.currentTarget.innerHTML;
                  lastSyncedRef.current = editedInner;
                  // Swap the preview path back to the cid: reference before this
                  // reaches state/localStorage/Send — the actual email must keep
                  // using the inline-attachment src, never the browser-only path.
                  const newInner = editedInner
                    .split(PREVIEW_LOGO_SRC)
                    .join(CID_LOGO_SRC);
                  // Splice the edited body back into the original document.
                  // Preserves <!doctype>, <head>, <style>, etc.
                  const next = /<body[^>]*>[\s\S]*?<\/body>/i.test(body)
                    ? body.replace(
                        /(<body[^>]*>)[\s\S]*?(<\/body>)/i,
                        `$1${newInner}$2`
                      )
                    : newInner;
                  onChange(next);
                }}
        spellCheck={false}
        className="px-5 py-4 min-h-[420px] outline-none focus:outline-none"
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "14px",
          lineHeight: "1.6",
          color: "#333333",
          background: "#ffffff",
        }}
      />
    </div>
  );
}

// Using `react-markdown` + `remark-gfm` so scraped descriptions that
// happen to contain bullets, bold, or links render as expected — the
// previous paragraph-split fallback turned everything into a wall of
// muted body text.
function DescriptionMarkdown({ source }: { source: string }) {
  const prepared = preprocessDescription(source);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="text-[color:var(--text)] [&:not(:first-child)]:mt-4">
            {children}
          </p>
        ),
        strong: ({ children }) => (
          <strong className="text-[color:var(--foreground)] font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        h1: ({ children }) => (
          <h1 className="text-[18px] font-semibold text-[color:var(--foreground)] mt-5 first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-[16px] font-semibold text-[color:var(--foreground)] mt-5 first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-[15px] font-semibold text-[color:var(--foreground)] mt-4 first:mt-0">
            {children}
          </h3>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-5 mt-3 space-y-1.5 marker:text-[color:var(--muted-2)]">
            {children}
          </ul>
        ),
        ol: ({ children, start }) => (
          <ol
            start={start}
            className="list-decimal pl-5 mt-3 space-y-1.5 marker:text-[color:var(--muted-2)]"
          >
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="text-[color:var(--text)] leading-[1.6]">{children}</li>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[color:var(--accent)] hover:underline"
          >
            {children}
          </a>
        ),
        code: ({ children }) => (
          <code className="px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[13px] font-mono text-[color:var(--text)]">
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="mt-3 p-3 rounded-md bg-[var(--surface-2)] border border-[var(--border)] overflow-x-auto text-[13px] leading-relaxed">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="mt-3 pl-3 border-l-2 border-[var(--accent)]/40 text-[color:var(--muted)] italic">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-5 border-[var(--border)]" />,
        table: ({ children }) => (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-[13px] border-collapse">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="text-left px-3 py-2 border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[color:var(--muted-2)] font-medium">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 border-b border-[var(--border)]">
            {children}
          </td>
        ),
      }}
    >
      {prepared}
    </ReactMarkdown>
  );
}

function ContactField({
  label,
  value,
  href,
  external,
  displayOverride,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
  external?: boolean;
  displayOverride?: string;
}) {
  const has = hasValue(value);
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)]">
        {label}
      </dt>
      <dd className="mt-1.5 text-[14px] leading-[1.4] break-words">
        {!has ? (
          <span className="text-[color:var(--muted-2)]">—</span>
        ) : href ? (
          <a
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="text-[color:var(--accent)] hover:underline"
          >
            {displayOverride ?? value}
          </a>
        ) : (
          <span className="text-[color:var(--foreground)]">{displayOverride ?? value}</span>
        )}
      </dd>
    </div>
  );
}

function HistoryRow({ email }: { email: EmailRow }) {
  const [expanded, setExpanded] = useState(false);
  const stageLabel = STAGE_LABELS[email.stage] || `Stage ${email.stage}`;
  const sentAt = email.sent_at ? new Date(email.sent_at) : null;
  const openedAt = email.opened_at ? new Date(email.opened_at) : null;
  const tone =
    email.status === "replied"
      ? "replied"
      : email.status === "opened"
      ? "info"
      : "info";
  // Only allow expanding when there's an actual stored body to show.
  const hasBody = !!(email.body && email.body.trim());
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      {/* Header — click anywhere to expand/collapse the sent email body. */}
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`w-full px-[18px] py-3.5 flex items-center justify-between gap-3 text-left transition-colors ${
          hasBody
            ? "cursor-pointer hover:bg-[var(--surface-2)]/50"
            : "cursor-default"
        }`}
      >
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)]">
            Stage {email.stage} · {stageLabel}
          </div>
          <div className="text-[13.5px] mt-0.5 truncate">{email.subject}</div>
          {sentAt && (
            <div className="text-[11px] text-[color:var(--muted-2)] mt-1">
              Sent · {sentAt.toLocaleString()}
              {openedAt && ` · Opened ${openedAt.toLocaleString()}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusPill tone={tone} label={email.status} />
          {hasBody && (
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
              className={`text-[color:var(--muted)] transition-transform duration-200 ${
                expanded ? "rotate-180" : ""
              }`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>
      </button>

      {/* Expanded — the actual email body as it was sent (plain-text record). */}
      {expanded && hasBody && (
        <div className="px-[18px] pb-4 pt-1">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)] mb-2">
              Email content
            </p>
            <p className="text-[13px] text-[color:var(--foreground)] whitespace-pre-wrap leading-relaxed break-words">
              {email.body}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "info" | "replied";
  label: string;
}) {
  const cls =
    tone === "replied"
      ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
      : "bg-blue-500/15 text-blue-300 border-blue-500/30";
  return (
    <span
      className={`text-[11px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wider border inline-block whitespace-nowrap ${cls}`}
    >
      {label}
    </span>
  );
}

