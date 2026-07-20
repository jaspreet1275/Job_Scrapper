import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

// Check RocketReach account credits remaining
async function getCredits(): Promise<{ remaining: number; used: number; allocated: number }> {
  try {
    const res = await axios.get(
      "https://api.rocketreach.co/v2/api/account",
      {
        headers: { "Api-Key": process.env.ROCKETREACH_API_KEY },
        timeout: 8000,
      }
    );
    const usage = res.data?.credit_usage || [];
    const standard = usage.find((u: { credit_type: string }) => u.credit_type === "standard_lookup");
    if (standard) {
      return {
        remaining: standard.remaining || 0,
        used: standard.used || 0,
        allocated: standard.allocated || 0,
      };
    }
  } catch (err) {
    console.error("[rr-lookup] Credit check failed:", (err as Error).message);
  }
  return { remaining: 0, used: 0, allocated: 0 };
}

// GET: Check credits only (no lookup)
export async function GET() {
  const credits = await getCredits();
  return NextResponse.json({ success: true, credits });
}

// POST: Search company first if no profileId, then lookup to get verified email
export async function POST(req: NextRequest) {
  try {
    const { profileId, companyName } = await req.json();

    // Check credits first
    const credits = await getCredits();
    if (credits.remaining < 1) {
      return NextResponse.json({
        success: false,
        error: `No RocketReach credits remaining (${credits.used}/${credits.allocated} used).`,
        credits,
      });
    }

    let lookupId = profileId;

    // If no profileId given, search first to find the decision maker
    if (!lookupId && companyName) {
      const searchRes = await axios.post(
        "https://api.rocketreach.co/v2/api/search",
        {
          query: {
            current_employer: [companyName],
            current_title: ["CTO", "Founder", "CEO", "VP Engineering", "Head of Engineering"],
          },
          page_size: 3,
        },
        {
          headers: {
            "Api-Key": process.env.ROCKETREACH_API_KEY,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      const profiles = searchRes.data?.profiles || [];
      if (profiles.length === 0) {
        return NextResponse.json({
          success: false,
          error: `No decision maker found for "${companyName}".`,
          credits,
        });
      }
      lookupId = profiles[0].id;
    }

    if (!lookupId) {
      return NextResponse.json({ success: false, error: "No profile ID provided" });
    }

    // Now lookup the profile (costs 1 credit)
    const lookupRes = await axios.get(
      `https://api.rocketreach.co/v2/api/lookupProfile?id=${lookupId}`,
      { headers: { "Api-Key": process.env.ROCKETREACH_API_KEY }, timeout: 15000 }
    );

    const data = lookupRes.data || {};
    const emails = data.emails || [];
    const validEmail = emails.find((e: { smtp_valid: string }) => e.smtp_valid === "valid");
    const bestEmail = validEmail || emails[0];

    // Check credits after the lookup
    const creditsAfter = await getCredits();

    return NextResponse.json({
      success: true,
      data: {
        name: data.name || "N/A",
        title: data.current_title || "N/A",
        linkedin: data.linkedin_url || "N/A",
        email: bestEmail?.email || "N/A",
        emailVerified: bestEmail?.smtp_valid || "unknown",
      },
      credits: creditsAfter,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("[rr-lookup] Error:", error.response?.data);
      return NextResponse.json(
        { success: false, error: `RocketReach: ${JSON.stringify(error.response?.data)}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
