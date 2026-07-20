// Pure decision function for the "Smart Send" button on the LinkedIn Jobs
// table. One button per row replaces the old single-purpose "📧 Send" — it
// inspects the job's existing send history + reply state and picks the next
// legitimate action automatically:
//
//   no sends yet              → Send         (Stage 1 / Trigger)
//   Stage 1 sent < 3 days     → Wait Xd      (cooldown — disabled)
//   Stage 1 sent ≥ 3 days     → Re-send      (Stage 2 / Case Study)
//   Stage 2 sent < 4 days     → Wait Xd      (cooldown — disabled)
//   Stage 2 sent ≥ 4 days     → Last Hello   (Stage 3 / Breakup)
//   Stage 3 sent              → Done         (terminal — disabled)
//   Reply received            → Replied      (terminal — disabled)
//   No enrichment / no email  → No email     (blocked)
//
// Same delays as the previously-disabled cron-followups: 3 days from S1 to
// S2, 4 more days from S2 to S3 (7 total). Keeping these in one place means
// the cron can be re-enabled later without diverging from manual behaviour.

export interface SendDeciderInput {
  status?: string;
  stagesSent?: number[];
  lastEmailSentAt?: string;
  hasReplied?: boolean;
  enriched?: {
    candidates?: { email?: string }[];
  } | null;
  email?: string;
}

export type SendDecision =
  | { state: "ready"; stage: 1 | 2 | 3; label: string; tone: "primary" | "warning" | "final" }
  | { state: "cooldown"; stage: 2 | 3; daysLeft: number; label: string }
  | { state: "replied"; label: string }
  | { state: "done"; label: string }
  | { state: "blocked"; label: string; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_2_DELAY_MS = 3 * DAY_MS; // Stage 1 → 3-day wait → Stage 2
const STAGE_3_DELAY_MS = 4 * DAY_MS; // Stage 2 → 4-day wait → Stage 3

export function decideNextSend(
  job: SendDeciderInput,
  now: Date = new Date()
): SendDecision {
  // 0. No email anywhere — must enrich first.
  const candidateEmail = job.enriched?.candidates?.[0]?.email;
  const email = candidateEmail || job.email;
  if (!email || email === "N/A") {
    return { state: "blocked", label: "No email", reason: "Enrich the lead to find a contact email first." };
  }

  // 1. Reply received — terminal, always wins regardless of stage history.
  if (job.hasReplied || job.status === "replied") {
    return { state: "replied", label: "🔒 Replied" };
  }

  const stages = job.stagesSent ?? [];
  const lastSentMs = job.lastEmailSentAt ? new Date(job.lastEmailSentAt).getTime() : 0;
  const elapsedMs = lastSentMs ? now.getTime() - lastSentMs : 0;

  // 2. Stage 3 already sent — done. No more sends, no manual override.
  if (stages.includes(3)) {
    return { state: "done", label: "✓ Done" };
  }

  // 3. Never sent — Stage 1 (Trigger).
  if (stages.length === 0) {
    return { state: "ready", stage: 1, label: "Send", tone: "primary" };
  }

  // 4. Stage 1 sent but not Stage 2 — check 3-day cooldown for Stage 2.
  if (stages.includes(1) && !stages.includes(2)) {
    if (elapsedMs < STAGE_2_DELAY_MS) {
      const daysLeft = Math.max(1, Math.ceil((STAGE_2_DELAY_MS - elapsedMs) / DAY_MS));
      return { state: "cooldown", stage: 2, daysLeft, label: `⏳ Wait ${daysLeft}d` };
    }
    return { state: "ready", stage: 2, label: "Re-send", tone: "warning" };
  }

  // 5. Stage 2 sent but not Stage 3 — check 4-day cooldown for Stage 3.
  if (stages.includes(2) && !stages.includes(3)) {
    if (elapsedMs < STAGE_3_DELAY_MS) {
      const daysLeft = Math.max(1, Math.ceil((STAGE_3_DELAY_MS - elapsedMs) / DAY_MS));
      return { state: "cooldown", stage: 3, daysLeft, label: `⏳ Wait ${daysLeft}d` };
    }
    return { state: "ready", stage: 3, label: "Last Hello", tone: "final" };
  }

  // Should not be reachable, but keep the type system happy.
  return { state: "blocked", label: "—", reason: "Unhandled send state." };
}
