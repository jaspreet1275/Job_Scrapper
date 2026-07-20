"use client";

import { useCallback, useEffect, useState } from "react";

// /prompts — Manage the saved prompt library that the job detail page's
// "Generate email" dropdown reads from. Each prompt has a short name
// (shown in the dropdown) and a body (appended as USER OVERRIDE block
// to the baseline Manatanu prompt when generating an email).

interface Prompt {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

// "2026-05-21T18:42:31Z" → "May 21, 2026". Used in the row footer so the
// user can tell at a glance which prompt was last touched without
// hovering anything.
function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer modal state — reused for both create and edit. When
  // `editingId` is null the modal saves a new prompt; when set, it
  // PATCHes that specific row. One state tree drives both flows so the
  // body / cancel / submit handlers don't have to branch.
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prompts", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to load prompts");
        return;
      }
      setPrompts(json.data ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditingId(null);
    setName("");
    setBody("");
    setError(null);
    setComposerOpen(true);
  }

  function openEdit(p: Prompt) {
    setEditingId(p.id);
    setName(p.name);
    setBody(p.body);
    setError(null);
    setComposerOpen(true);
  }

  const closeComposer = useCallback(() => {
    if (saving) return;
    setComposerOpen(false);
    setEditingId(null);
    setName("");
    setBody("");
    setError(null);
  }, [saving]);

  // ESC closes the modal — common UX expectation for any centred dialog.
  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeComposer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerOpen, closeComposer]);

  async function save() {
    const n = name.trim();
    const b = body.trim();
    if (!n || !b || saving) return;
    setSaving(true);
    setError(null);
    try {
      const isEdit = !!editingId;
      const res = await fetch(
        isEdit ? `/api/prompts/${editingId}` : "/api/prompts",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n, body: b }),
        }
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Save failed");
        return;
      }
      setComposerOpen(false);
      setEditingId(null);
      setName("");
      setBody("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deletePrompt(id: string) {
    if (!confirm("Delete this prompt? This cannot be undone.")) return;
    setError(null);
    try {
      const res = await fetch(`/api/prompts/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Delete failed");
        return;
      }
      if (editingId === id) closeComposer();
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="min-h-screen">
      {/* Top bar — title + description on the left, primary CTA on the
          right. The "Add New Prompt" button is the only entry point for
          creating; the composer lives in a modal so this page stays a
          clean library view. */}
      <div className="px-7 pt-7 pb-5 border-b border-[var(--border)] flex items-start justify-between gap-4 flex-wrap">
        <div className="max-w-2xl">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-[color:var(--foreground)]">
            Prompts
          </h1>
          <p className="text-[13px] text-[color:var(--muted)] mt-1 leading-relaxed">
            Saved prompt templates. Pick one from the dropdown next to{" "}
            <span className="text-[color:var(--foreground)] font-medium">
              Generate email
            </span>{" "}
            on any job to steer the outreach with your saved instructions.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium transition-colors shrink-0"
        >
          <span className="text-[15px] leading-none">+</span>
          Add New Prompt
        </button>
      </div>

      <div className="px-7 py-6">
        {error && !composerOpen && (
          <div
            className="mb-4 text-[13px] rounded-md px-3 py-2 max-w-3xl"
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger)",
              border: "1px solid var(--danger)",
            }}
          >
            {error}
          </div>
        )}

        {/* Three render branches: loading skeleton, empty state with CTA,
            and the populated grid + search + tips. */}
        {loading ? (
          <div className="surface p-8 text-[13px] text-[color:var(--muted)] text-center max-w-3xl">
            Loading…
          </div>
        ) : prompts.length === 0 ? (
          <div className="surface p-12 text-center max-w-2xl mx-auto">
            <div className="mx-auto w-14 h-14 rounded-full bg-[var(--accent-soft)] inline-flex items-center justify-center text-[22px] text-[color:var(--accent)] mb-4">
              ✨
            </div>
            <h3 className="text-[15px] font-semibold text-[color:var(--foreground)] mb-1.5 tracking-[-0.01em]">
              No prompts yet
            </h3>
            <p className="text-[13px] text-[color:var(--muted)] mb-5 max-w-sm mx-auto leading-relaxed">
              Save reusable instructions like &ldquo;casual tone, under 80
              words&rdquo; or &ldquo;mention our eval-pipeline angle&rdquo; to
              steer outreach drafts without rewriting them each time.
            </p>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium transition-colors"
            >
              <span className="text-[15px] leading-none">+</span>
              Add your first prompt
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)]">
                Saved prompts
              </h2>
              <span className="text-[11.5px] text-[color:var(--muted-2)]">
                {prompts.length} {prompts.length === 1 ? "prompt" : "prompts"}
              </span>
            </div>
            {/* Single vertical column, each card stretched to full
                content width. Stacked top-to-bottom so the body text
                stays readable instead of getting compressed into a
                narrow two-column rail. */}
            <ul className="space-y-3">
              {prompts.map((p) => (
                <li
                  key={p.id}
                  className="surface p-5 transition-colors hover:border-[color:var(--border-strong)]"
                >
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    <h3 className="text-[14.5px] font-semibold text-[color:var(--foreground)] tracking-[-0.01em] leading-snug">
                      {p.name}
                    </h3>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(p)}
                        className="px-2.5 py-1 rounded-md text-[11.5px] font-medium text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deletePrompt(p.id)}
                        className="px-2.5 py-1 rounded-md text-[11.5px] font-medium text-[color:var(--muted)] hover:text-[color:var(--danger)] hover:bg-[var(--danger-soft)] transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <p className="text-[13px] text-[color:var(--muted)] whitespace-pre-wrap leading-relaxed line-clamp-3">
                    {p.body}
                  </p>
                  <div className="mt-3.5 pt-3 border-t border-[var(--border)] flex items-center justify-between gap-3">
                    <span className="text-[11px] text-[color:var(--muted-2)]">
                      Updated {fmtDate(p.updated_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Composer drawer — slides out from the RIGHT edge. Same content
          as the original centred modal, just anchored to the side and
          given a wider working area for long prompt bodies. Backdrop
          click + Escape close it; ignored while saving so the user
          doesn't accidentally dismiss an in-flight POST. */}
      {composerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60 backdrop-blur-sm animate-fadeIn"
          onClick={closeComposer}
        >
          <div
            className="w-full max-w-2xl h-full rounded-l-xl flex flex-col animate-slideInRight"
            style={{
              background: "var(--surface)",
              borderLeft: "1px solid var(--border)",
              boxShadow: "var(--shadow-pop)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-[var(--border)] shrink-0">
              <div>
                <h3 className="text-[17px] font-semibold text-[color:var(--foreground)] tracking-[-0.01em]">
                  {editingId ? "Edit prompt" : "Add a new prompt"}
                </h3>
                <p className="text-[12px] text-[color:var(--muted-2)] mt-1">
                  {editingId
                    ? "Update the saved instructions for this prompt."
                    : "Save a reusable instruction set for the email LLM."}
                </p>
              </div>
              <button
                onClick={closeComposer}
                disabled={saving}
                className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="px-6 py-6 overflow-y-auto flex-1 flex flex-col">
              <label
                htmlFor="prompt-name"
                className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)] mb-1.5"
              >
                Name
              </label>
              <input
                id="prompt-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Casual + short"
                disabled={saving}
                autoFocus
                className="w-full px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[14px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-2)] focus:outline-none focus:border-[color:var(--accent)] transition-colors mb-5"
              />

              <label
                htmlFor="prompt-body"
                className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--muted-2)] mb-1.5"
              >
                Body — instructions for the LLM
              </label>
              {/* flex-1 so the textarea stretches to fill the drawer's
                  vertical space — the user gets a roomy editor instead
                  of being capped at 7 rows. */}
              <textarea
                id="prompt-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="e.g. Keep it under 80 words. Lead with one specific eval-pipeline angle drawn from the JD. Avoid corporate jargon. No emojis."
                disabled={saving}
                className="w-full flex-1 min-h-[240px] px-3 py-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[13.5px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-2)] focus:outline-none focus:border-[color:var(--accent)] transition-colors resize-none leading-relaxed"
              />

              {error && (
                <div
                  className="mt-3 text-[13px] rounded-md px-3 py-2"
                  style={{
                    background: "var(--danger-soft)",
                    color: "var(--danger)",
                    border: "1px solid var(--danger)",
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-end gap-2 shrink-0">
              <button
                onClick={closeComposer}
                disabled={saving}
                className="px-3.5 py-2 rounded-md text-[13px] font-medium text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !name.trim() || !body.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving
                  ? "Saving…"
                  : editingId
                  ? "Save changes"
                  : "Save prompt"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
