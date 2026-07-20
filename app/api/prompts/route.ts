import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// Saved prompt library — backs the /prompts page and the dropdown next
// to "Generate email" on the job detail page. Selected prompt body is
// sent as `customPrompt` to /api/generate-email, where it's appended as
// a USER OVERRIDE block to the baseline Manatanu email prompt.
//
// GET  /api/prompts          → list all
// POST /api/prompts { name, body } → create new

interface PromptRow {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("prompts")
      .select("id, name, body, created_at, updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, data: (data ?? []) as PromptRow[] });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name?: unknown; body?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const promptBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!name || !promptBody) {
      return NextResponse.json(
        { success: false, error: "Both `name` and `body` are required and non-empty" },
        { status: 400 }
      );
    }

    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("prompts")
      .insert({ name, body: promptBody })
      .select()
      .single();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
