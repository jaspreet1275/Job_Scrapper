"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// 7-day (configurable) area chart for the Analytics page. Three series:
// Enriched (from jobs_v2.enriched_at), Sent (email_tracking.sent_at), and
// Opened (email_tracking.opened_at) — all bucketed by IST calendar date
// server-side at /api/analytics/timeline.
//
// Visual: each series is drawn as a strong line on top of a soft
// vertical gradient fill (top→transparent). Subtle but reads more
// modern than plain lines. A dashed reference line highlights today's
// column so the eye lands on the latest data point.

interface Bucket {
  date: string; // YYYY-MM-DD (IST)
  enriched: number;
  sent: number;
  opened: number;
}

const SERIES = [
  {
    key: "enriched",
    label: "Enriched",
    color: "var(--accent)",
    // Solid hex needed for <stop stopColor>; CSS vars don't resolve
    // inside <linearGradient>. Must stay in sync with var(--accent).
    fillColor: "#1E88E5",
  },
  // Teal, not blue — the accent series above is blue now, and two blues
  // side by side were indistinguishable at 2px stroke width.
  { key: "sent", label: "Sent", color: "#14b8a6", fillColor: "#14b8a6" },
  { key: "opened", label: "Opened", color: "#8b5cf6", fillColor: "#8b5cf6" },
] as const;

// "2026-05-21" → { day: "Wed", date: "May 21" }. Built manually rather
// than via Date so we never accidentally shift the day by ±1 because of
// browser-timezone parsing quirks around "YYYY-MM-DD" strings.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parseISTDate(date: string): { day: string; label: string } | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  // UTC noon avoids any DST / off-by-one when computing the weekday.
  const utc = new Date(Date.UTC(y, mo - 1, d, 12));
  return {
    day: WEEKDAYS[utc.getUTCDay()],
    label: `${MONTHS[mo - 1]} ${d}`,
  };
}
function fmtAxis(date: unknown): string {
  if (typeof date !== "string") return "";
  const p = parseISTDate(date);
  return p ? `${p.day} ${p.label.split(" ")[1]}` : date;
}
function fmtTooltipLabel(label: unknown): string {
  if (typeof label !== "string") return String(label ?? "");
  const p = parseISTDate(label);
  return p ? `${p.day}, ${p.label}` : label;
}

interface PerformanceChartProps {
  /** Inclusive IST start date, YYYY-MM-DD. */
  from: string;
  /** Inclusive IST end date, YYYY-MM-DD. */
  to: string;
  /** Optional control row rendered inside the chart's surface, below the
   *  title and legend. Use this to keep date-range chips / pickers
   *  visually attached to the chart they drive. */
  controls?: React.ReactNode;
}

export function PerformanceChart({ from, to, controls }: PerformanceChartProps) {
  const [data, setData] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/analytics/timeline?from=${from}&to=${to}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) {
          setError(json.error || "Failed to load timeline");
          return;
        }
        setData(json.data as Bucket[]);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  // Reference line targets the LAST date in the picked window — usually
  // today when the user is viewing the trailing range, but it tracks the
  // selected range's end when they pick a previous week.
  const todayDate = data && data.length > 0 ? data[data.length - 1].date : null;

  const total = (data ?? []).reduce(
    (acc, b) => {
      acc.enriched += b.enriched;
      acc.sent += b.sent;
      acc.opened += b.opened;
      return acc;
    },
    { enriched: 0, sent: 0, opened: 0 }
  );

  return (
    <div className="surface p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--muted-2)]">
            Performance
          </p>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--foreground)] mt-1">
            {from === to ? fmtTooltipLabel(from) : `${fmtTooltipLabel(from)} → ${fmtTooltipLabel(to)}`}
          </h2>
          <p className="text-[12.5px] text-[color:var(--muted)] mt-1">
            Daily enriched, sent, and opened — bucketed by IST date.
          </p>
          {controls && <div className="mt-3">{controls}</div>}
        </div>
        {/* Legend pills — each gets a coloured dot, label, and the
            running total for the window. Compact + scannable. */}
        <div className="flex items-center gap-2 flex-wrap">
          {SERIES.map((s) => (
            <div
              key={s.key}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
              style={{ background: "var(--surface-2)" }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              <span className="text-[11.5px] text-[color:var(--muted)]">
                {s.label}
              </span>
              <span className="text-[12px] font-semibold tabular-nums text-[color:var(--foreground)]">
                {loading ? "—" : total[s.key]}
              </span>
            </div>
          ))}
        </div>
      </div>

      {error ? (
        <div
          className="text-[13px] rounded-md px-3 py-2"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger)",
            border: "1px solid var(--danger)",
          }}
        >
          {error}
        </div>
      ) : (
        <div className="h-[280px] w-full">
          {loading || !data ? (
            <div className="h-full w-full flex items-center justify-center text-[13px] text-[color:var(--muted-2)]">
              Loading…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 12, right: 18, left: -12, bottom: 4 }}
              >
                <defs>
                  {SERIES.map((s) => (
                    <linearGradient
                      key={s.key}
                      id={`pc-grad-${s.key}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={s.fillColor}
                        stopOpacity={0.22}
                      />
                      <stop
                        offset="95%"
                        stopColor={s.fillColor}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke="var(--border)"
                  strokeDasharray="3 4"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtAxis}
                  tick={{
                    fill: "var(--muted)",
                    fontSize: 11,
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={6}
                  padding={{ left: 8, right: 8 }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "var(--muted)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                />
                {todayDate && (
                  <ReferenceLine
                    x={todayDate}
                    stroke="var(--border-strong)"
                    strokeDasharray="2 4"
                    strokeWidth={1}
                    ifOverflow="visible"
                  />
                )}
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 12,
                    color: "var(--foreground)",
                    boxShadow: "var(--shadow-pop)",
                    padding: "8px 12px",
                  }}
                  labelStyle={{
                    color: "var(--foreground)",
                    fontWeight: 600,
                    marginBottom: 6,
                    fontSize: 12,
                  }}
                  itemStyle={{ padding: "2px 0", fontSize: 12 }}
                  labelFormatter={fmtTooltipLabel}
                  cursor={{
                    stroke: "var(--border-strong)",
                    strokeWidth: 1,
                    strokeDasharray: "3 3",
                  }}
                />
                {SERIES.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2.25}
                    fill={`url(#pc-grad-${s.key})`}
                    fillOpacity={1}
                    dot={false}
                    activeDot={{
                      r: 5,
                      fill: s.color,
                      stroke: "var(--surface)",
                      strokeWidth: 2,
                    }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}
