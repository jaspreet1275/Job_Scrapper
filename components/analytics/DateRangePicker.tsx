"use client";

import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

// Date picker for the Analytics page. Two modes:
//
//   mode="single" (default) — Outreach Funnel uses this.
//     Click any date → emits onChange with from === to.
//
//   mode="range" — Performance chart uses this.
//     Click 1 → marks start; click 2 → marks end + closes.
//     Click the same date twice → single-day range.
//
// Dates are passed in/out as YYYY-MM-DD strings to keep the Analytics
// state IST-friendly and trivially comparable to the timeline API.

interface Props {
  mode?: "single" | "range";
  from: string; // YYYY-MM-DD — equals `to` in single mode
  to: string;   // YYYY-MM-DD
  onChange: (next: { from: string; to: string }) => void;
  /** Latest selectable date (default: today). Cron + scraped data never
   *  lives in the future, so disable forward picks. */
  maxDate?: string;
  /** Anchor the popover left or right of the trigger button. Defaults
   *  to "right" (popover hangs from the right edge) which is what the
   *  Outreach Funnel section wanted; the chart section places its
   *  picker on the left and uses anchor="left". */
  anchor?: "left" | "right";
  /** Optional fixed label for the trigger button (e.g. "Custom"). When
   *  unset the button shows the formatted from/to range. */
  label?: string;
  /** Render the trigger button in its accent / active style — used when
   *  a parent (chip group) wants to mark this picker as the selected
   *  preset. Visual only. */
  active?: boolean;
}

// "2026-05-21" → local Date at noon. react-day-picker emits LOCAL Date
// objects from clicks (e.g. `new Date(2026, 4, 13)` = May 13 00:00 local).
// We MUST round-trip through local components — otherwise IST midnight
// converts to the previous UTC day and toISO() would read "2026-05-12"
// when the user clicked 13.
function parseISO(date: string): Date {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtPretty(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function fmtLabel(from: string, to: string, mode: "single" | "range"): string {
  if (mode === "single" || from === to) return fmtPretty(from);
  return `${fmtPretty(from)} – ${fmtPretty(to)}`;
}

export function DateRangePicker({
  mode = "single",
  from,
  to,
  onChange,
  maxDate,
  anchor = "right",
  label,
  active = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Range mode click tracking. react-day-picker v10's range onSelect is
  // unreliable for "wait for the second click" — its first click can
  // already report a completed {from:X, to:X} range, which would close
  // the popover immediately. So we count clicks OURSELVES:
  //   • rangeStart === null  → next click is the START
  //   • rangeStart !== null  → next click is the END → emit + close
  // `hoverDate` drives the live preview band between the start and the
  // date currently under the cursor.
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  useEffect(() => {
    if (open && mode === "range") {
      setRangeStart(null);
      setHoverDate(null);
    }
  }, [open, mode]);

  // Click outside → close. The popover is mounted inside this wrapper so
  // any click whose target is NOT inside the wrapper dismisses it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Escape closes too — table-stakes for a popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const today = parseISO(maxDate ?? toISO(new Date()));
  const yesterday = new Date(today.getTime() - 86400000);

  // Compute "this week" (today + 6 prior) and "previous week" (7 days
  // back from "this week's" start). Used by the range-mode footer.
  const thisWeekStart = new Date(today.getTime() - 6 * 86400000);
  const prevWeekEnd = new Date(thisWeekStart.getTime() - 86400000);
  const prevWeekStart = new Date(prevWeekEnd.getTime() - 6 * 86400000);
  const last30Start = new Date(today.getTime() - 29 * 86400000);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          active
            ? "inline-flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer rounded-md font-medium transition-colors bg-[var(--accent)] text-white border border-[var(--accent)] hover:bg-[var(--accent-hover)]"
            : "surface inline-flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:border-[color:var(--border-strong)] focus:border-[color:var(--accent)] focus:outline-none transition-colors"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={active}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={active ? "text-white" : "text-[color:var(--muted)]"}
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span
          className={
            active
              ? "text-white font-medium tabular-nums"
              : "text-[color:var(--foreground)] font-medium tabular-nums"
          }
        >
          {label ?? fmtLabel(from, to, mode)}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={active ? "text-white/80" : "text-[color:var(--muted-2)]"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={mode === "range" ? "Pick a date range" : "Pick a date"}
          className={`absolute mt-2 z-50 rounded-xl p-3 ${anchor === "right" ? "right-0" : "left-0"}`}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {mode === "single" ? (
            <DayPicker
              mode="single"
              selected={parseISO(from)}
              onSelect={(date) => {
                if (!date) return;
                const v = toISO(date);
                onChange({ from: v, to: v });
                setOpen(false);
              }}
              disabled={{ after: today }}
              defaultMonth={parseISO(from)}
              showOutsideDays
              classNames={dayPickerClasses}
            />
          ) : (
            <DayPicker
              mode="range"
              // `selected` is purely for VISUAL feedback — we drive the
              // actual selection through onDayClick below. Before the
              // first click it's empty; after the first click it shows a
              // live band from the start to whatever the cursor hovers.
              selected={
                rangeStart
                  ? {
                      from: rangeStart,
                      to: hoverDate && hoverDate >= rangeStart ? hoverDate : rangeStart,
                    }
                  : undefined
              }
              onDayClick={(day, modifiers) => {
                // Ignore disabled (future) days.
                if (modifiers.disabled) return;
                if (!rangeStart) {
                  // FIRST click → mark the start, keep popover open.
                  setRangeStart(day);
                  setHoverDate(day);
                  return;
                }
                // SECOND click → order the two dates, emit, close.
                const a = day < rangeStart ? day : rangeStart;
                const b = day < rangeStart ? rangeStart : day;
                onChange({ from: toISO(a), to: toISO(b) });
                setRangeStart(null);
                setHoverDate(null);
                setOpen(false);
              }}
              onDayMouseEnter={(day) => {
                if (rangeStart) setHoverDate(day);
              }}
              disabled={{ after: today }}
              defaultMonth={parseISO(to)}
              showOutsideDays
              classNames={dayPickerClasses}
            />
          )}
          {/* Footer presets — keys differ per mode. Single-date covers
              just today/yesterday; range gets the weekly + 30-day picks
              the chart cares about. */}
          <div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              {mode === "single" ? (
                <>
                  <button
                    onClick={() => {
                      const t = toISO(today);
                      onChange({ from: t, to: t });
                      setOpen(false);
                    }}
                    className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => {
                      const y = toISO(yesterday);
                      onChange({ from: y, to: y });
                      setOpen(false);
                    }}
                    className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    Yesterday
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      onChange({ from: toISO(thisWeekStart), to: toISO(today) });
                      setOpen(false);
                    }}
                    className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    This week
                  </button>
                  <button
                    onClick={() => {
                      onChange({
                        from: toISO(prevWeekStart),
                        to: toISO(prevWeekEnd),
                      });
                      setOpen(false);
                    }}
                    className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    Previous week
                  </button>
                  <button
                    onClick={() => {
                      onChange({
                        from: toISO(last30Start),
                        to: toISO(today),
                      });
                      setOpen(false);
                    }}
                    className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--muted)] hover:text-[color:var(--foreground)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    Last 30 days
                  </button>
                </>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-[11.5px] px-2.5 py-1 rounded-md text-[color:var(--accent)] hover:bg-[var(--accent-soft)] transition-colors font-medium"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Shared classNames between the single and range DayPicker instances so
// the look stays consistent and we don't repeat the long list twice.
const dayPickerClasses = {
  root: "rdp-root",
  caption_label: "text-[13px] font-semibold text-[color:var(--foreground)]",
  button_previous: "text-[color:var(--muted)] hover:text-[color:var(--foreground)]",
  button_next: "text-[color:var(--muted)] hover:text-[color:var(--foreground)]",
  weekday:
    "text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted-2)] py-1",
  day: "text-[12.5px] text-[color:var(--foreground)]",
  day_button: "rounded-md hover:bg-[var(--surface-2)]",
  selected: "bg-[var(--accent)] text-white",
  range_start: "bg-[var(--accent)] text-white rounded-l-md",
  range_end: "bg-[var(--accent)] text-white rounded-r-md",
  range_middle: "bg-[var(--accent-soft)] text-[color:var(--foreground)]",
  today: "font-semibold text-[color:var(--accent)]",
  outside: "text-[color:var(--muted-2)] opacity-60",
  disabled: "text-[color:var(--muted-2)] line-through opacity-50 cursor-not-allowed",
};
