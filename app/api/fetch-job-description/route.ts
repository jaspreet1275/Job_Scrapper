import { NextRequest, NextResponse } from "next/server";
import { fetchLinkedInJobDetails } from "@/lib/scrapers/linkedin-fetcher";
import { fetchLinkedInJobDetailsScrapingBee } from "@/lib/scrapers/scrapingbee";
import { isLinkedInLoginWall } from "@/lib/utils/html-to-text";

// Background fetcher used by the dashboard's auto-enrich-on-save flow AND
// by the manual "Refresh description" button on the job detail page.
// Accepts ANY LinkedIn URL and returns BOTH description + location from a
// single fetch (cheerio first, ScrapingBee fallback). The location field is a
// Method-2-only fallback — Method 1 (Apify) jobs already carry their own
// location and the caller is expected to NOT overwrite a real value.
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string" || !url.includes("linkedin.com")) {
      return NextResponse.json({ success: false, error: "Valid LinkedIn URL required" });
    }

    // Pass 1: free cheerio (best when URL is /jobs/view/{id}/)
    let { description: desc, location } = await fetchLinkedInJobDetails(url);
    // Login-wall guard — drop the auth-gate blurb before measuring length,
    // matching the parse-gmail orchestrator's logic. Stops "Login to
    // LinkedIn …" from short-circuiting the ScrapingBee fallback.
    if (desc && isLinkedInLoginWall(desc)) desc = "";
    let via = desc ? "cheerio" : "";

    // Pass 2: paid ScrapingBee fallback if cheerio came back short or empty.
    // Same one fetch returns both description AND location — no extra cost.
    // 300 chars (was 500) matches the parse-gmail orchestrator's threshold —
    // both should be aggressive about firing the paid fallback because
    // LinkedIn is increasingly clamping the public-page preview short.
    if (!desc || desc.length < 300 || !location) {
      const sb = await fetchLinkedInJobDetailsScrapingBee(url);
      const sbDesc =
        sb.description && !isLinkedInLoginWall(sb.description)
          ? sb.description
          : "";
      if (sbDesc && sbDesc.length > desc.length) {
        desc = sbDesc;
        via = "scrapingbee";
      }
      if (!location && sb.location) {
        location = sb.location;
      }
    }

    // Last-line guard — even if both layers above missed something, never
    // return login-wall text to the caller; better to return empty so the
    // UI can show "Description unavailable, try again later."
    if (desc && isLinkedInLoginWall(desc)) desc = "";

    return NextResponse.json({
      success: true,
      description: desc || "",
      location: location || "",
      length: desc.length,
      via,
    });
  } catch (err) {
    console.error("[fetch-job-description] error:", err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
