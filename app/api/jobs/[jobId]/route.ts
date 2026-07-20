import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// GET /api/jobs/<jobId>
//
// Fetches a single jobs_v2 row by its text PK (LinkedIn / Apify job_id) and
// joins all matching email_tracking rows so the per-job detail page can
// render description, decision-maker info, and email lifecycle in one trip.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await ctx.params;
  if (!jobId) {
    return NextResponse.json(
      { success: false, error: "Missing jobId" },
      { status: 400 }
    );
  }

  try {
    const db = getSupabaseAdmin();

    const { data: job, error: jobErr } = await db
      .from("jobs_v2")
      .select("*")
      .eq("job_id", jobId)
      .maybeSingle();

    if (jobErr) {
      return NextResponse.json(
        { success: false, error: jobErr.message },
        { status: 500 }
      );
    }
    if (!job) {
      return NextResponse.json(
        { success: false, error: "Job not found" },
        { status: 404 }
      );
    }

    const { data: emails } = await db
      .from("email_tracking")
      .select(
        "id, stage, status, to_email, subject, body, thread_id, tracking_id, sent_at, opened_at, replied_at, reply_from, reply_snippet, created_at"
      )
      .eq("job_id", jobId)
      .order("stage", { ascending: true });

    return NextResponse.json({
      success: true,
      job,
      emails: emails ?? [],
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}

// PATCH /api/jobs/<jobId>
//
// Whitelisted in-place update for a single jobs_v2 row. Currently used by
// the detail page's "Refresh description" button after it calls
// /api/fetch-job-description — once a fresh JD comes back we POST it
// back here so the row persists for everyone (subsequent loads, email
// generation prompt context, etc.). Keep the whitelist tight; the
// dashboard should not be able to mass-edit jobs from this endpoint.
const ALLOWED_PATCH_FIELDS = new Set([
  "description",
  "location",
  "title",
  "company",
]);

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await ctx.params;
  if (!jobId) {
    return NextResponse.json(
      { success: false, error: "Missing jobId" },
      { status: 400 }
    );
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_PATCH_FIELDS.has(k) && typeof v === "string") {
        patch[k] = v;
      }
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: "No allowed fields in body" },
        { status: 400 }
      );
    }
    patch.updated_at = new Date().toISOString();

    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("jobs_v2")
      .update(patch)
      .eq("job_id", jobId)
      .select()
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { success: false, error: "Job not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, job: data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
