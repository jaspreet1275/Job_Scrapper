import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { fetchLinkedInJobDescriptionScrapingBee } from "@/lib/scrapers/scrapingbee";
import { persistScrapedJobs } from "@/lib/db/jobs-persist";

const ACTOR_IDS: Record<string, string> = {
  indeed: "misceres~indeed-scraper",
  upwork: "getdataforme~upwork-actor",
  linkedin: "curious_coder~linkedin-jobs-scraper",
};

interface NormalizedJob {
  title: string;
  jobId: string;
  company: string;
  email: string;
  location: string;
  jobType: string;
  description: string;
  url: string;
  postedAt: string;
  platform: string;
}

function buildKeywords(roles: string[]): string {
  return roles.join(" OR ");
}

function isRemoteFilter(filters: string[]): boolean {
  return filters.some((f) => f.toLowerCase().includes("remote"));
}

function extractEmail(text: string): string {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "N/A";
}

function buildInput(
  platform: string,
  roles: string[],
  filters: string[]
): Record<string, unknown> {
  const keywords = buildKeywords(roles);
  const remote = isRemoteFilter(filters);

  switch (platform) {
    case "indeed":
      return {
        position: keywords,
        country: "US",
        location: remote ? "remote" : "",
        maxItems: 15,
        parseCompanyDetails: false,
        saveOnlyUniqueItems: true,
        followApplyRedirects: false,
        sort: "date",
        fromage: "1",
      };

    case "upwork":
      return {
        queries: [keywords],   
        maxItems: 50,
        sortby: "newest",      
      };

    case "linkedin": {
      const params = new URLSearchParams();
      params.set("keywords", keywords);
      params.set("f_TPR", "r86400"); // last 24 hours
      if (remote) params.set("f_WT", "2");
      if (filters.includes("Entry level")) params.set("f_E", "2");
      if (filters.includes("Full time")) params.set("f_JT", "F");
      else if (filters.includes("Part time")) params.set("f_JT", "P");
      else if (filters.includes("Freelance")) params.set("f_JT", "C");
      params.set("sortBy", "DD");
      return {
        urls: [`https://www.linkedin.com/jobs/search/?${params.toString()}`],
        maxJobs: 15,
      };
    }

    default:
      return {};
  }
}

// --- Keyword matching for Upwork (since actor can't search) ---

function matchesRoles(job: Record<string, unknown>, roles: string[]): boolean {
  const title = String(job.title || "").toLowerCase();
  const desc = String(job.description || "").toLowerCase();

  const searchText = `${title} ${desc}`;

  // Build keyword list from roles: "Python Developer" → ["python", "developer"]
  for (const role of roles) {
    const words = role.toLowerCase().split(/\s+/);
    // Job must contain at least one keyword from the role
    if (words.some((word) => searchText.includes(word))) {
      return true;
    }
  }
  return false;
}

// --- Normalizers ---

function normalizeIndeed(jobs: Record<string, unknown>[]): NormalizedJob[] {
  return jobs.map((job) => {
    const jobType = Array.isArray(job.jobType)
      ? (job.jobType as string[]).join(", ")
      : String(job.jobType || "N/A");
    const desc = String(job.description || "");
    return {
      title: String(job.positionName || job.title || "N/A"),
      jobId: String(job.id || "N/A"),
      company: String(job.company || "N/A"),
      email: extractEmail(desc),
      location: String(job.location || "N/A"),
      jobType,
      description: desc.substring(0, 4000),
      url: String(job.url || job.externalApplyLink || ""),
      postedAt: String(job.postedAt || job.postingDateParsed || "N/A"),
      platform: "Indeed",
    };
  });
}

function normalizeUpwork(jobs: Record<string, unknown>[]): NormalizedJob[] {
  return jobs.map((job) => {
    const desc = String(job.description || "");

    return {
      title: String(job.title || "N/A"),
      jobId: String(job.id || "N/A"),
      company: "Upwork Client",
      email: extractEmail(desc),
      location: "Remote",
      jobType: String(job.jobType || "Freelance"),
      description: desc.substring(0, 4000),
      url: String(job.url || ""),
      postedAt: String(job.publishTime || job.absoluteDate || job.relativeDate || "N/A"),
      platform: "Upwork",
    };
  });
}

function normalizeLinkedin(jobs: Record<string, unknown>[]): NormalizedJob[] {
  return jobs.map((job) => {
    const rawDesc = String(job.descriptionHtml || job.descriptionText || job.description || "");
    const cleanDesc = rawDesc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const emailFromDesc = extractEmail(cleanDesc);
    return {
      title: String(job.title || "N/A"),
      jobId: String(job.id || "N/A"),
      company: String(job.companyName || job.company || "N/A"),
      email: emailFromDesc,
      location: String(job.location || "N/A"),
      jobType: String(job.employmentType || job.contractType || "N/A"),
      description: cleanDesc.substring(0, 4000),
      url: String(job.link || job.applyUrl || job.url || ""),
      postedAt: String(job.postedAt || job.postedDate || "N/A"),
      platform: "LinkedIn",
    };
  });
}

// --- Main handler ---

export async function POST(req: NextRequest) {
  try {
    const { platform, roles, filters } = await req.json();
    const platformKey = platform.toLowerCase();

    const actorId = ACTOR_IDS[platformKey];
    if (!actorId) {
      return NextResponse.json(
        { success: false, error: "Invalid platform" },
        { status: 400 }
      );
    }

    const input = buildInput(platformKey, roles, filters || []);

    console.log(`[${platform}] Actor: ${actorId}`);
    console.log(`[${platform}] Input:`, JSON.stringify(input));

    // Run actor
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${actorId}/runs`,
      input,
      {
        headers: { "Content-Type": "application/json" },
        params: { token: process.env.APIFY_API_KEY, waitForFinish: 120 },
      }
    );

    const datasetId = runResponse.data.data.defaultDatasetId;
    const runId = runResponse.data.data.id;
    let status = runResponse.data.data.status;
    let attempts = 0;

    while (status === "RUNNING" || status === "READY") {
      await new Promise((res) => setTimeout(res, 5000));
      const statusRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { params: { token: process.env.APIFY_API_KEY } }
      );
      status = statusRes.data.data.status;
      console.log(`[${platform}] Poll: ${status}`);
      attempts++;
      if (attempts > 24) break;
    }

    const fetchLimit = platformKey === "upwork" ? 100 : 15;
    const resultsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      { params: { token: process.env.APIFY_API_KEY, limit: fetchLimit } }
    );

    let rawJobs: Record<string, unknown>[] = resultsRes.data;
    console.log(`[${platform}] Raw results: ${rawJobs.length}`);

    // Upwork: actor can't search by keyword, so WE filter by keyword here
    if (platformKey === "upwork" && rawJobs.length > 0) {
      const before = rawJobs.length;
      rawJobs = rawJobs.filter((job) => matchesRoles(job, roles));
      console.log(`[upwork] Keyword filter: ${before} → ${rawJobs.length} matched`);
    }

    // Normalize
    let normalized: NormalizedJob[];
    switch (platformKey) {
      case "indeed":
        normalized = normalizeIndeed(rawJobs);
        break;
      case "upwork":
        normalized = normalizeUpwork(rawJobs);
        break;
      case "linkedin":
        normalized = normalizeLinkedin(rawJobs);
        break;
      default:
        normalized = [];
    }

    if (normalized.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        message: `No jobs found on ${platform}. Try different roles or filters.`,
      });
    }

    // ─────── LinkedIn description rescue (Apify → ScrapingBee fallback) ───────
    // Apify's LinkedIn search actor often returns a 100-300 char snippet instead of
    // the full JD. For Gemini personalization we need the full description, so fall
    // back to ScrapingBee (paid, ~25 credits/call from the 1000 free monthly credits).
    if (platformKey === "linkedin") {
      const RESCUE_THRESHOLD = 500;
      const needsRescue = normalized.filter(
        (j) =>
          (j.description?.length || 0) < RESCUE_THRESHOLD &&
          /linkedin\.com\/jobs\/view\/\d+/.test(j.url || "")
      );
      if (needsRescue.length > 0) {
        console.log(`[linkedin] Apify gave short description for ${needsRescue.length} jobs — rescuing via ScrapingBee...`);
        const CONCURRENCY = 3;
        let recovered = 0;
        for (let i = 0; i < needsRescue.length; i += CONCURRENCY) {
          const batch = needsRescue.slice(i, i + CONCURRENCY);
          await Promise.all(
            batch.map(async (job) => {
              const desc = await fetchLinkedInJobDescriptionScrapingBee(job.url);
              if (desc && desc.length > (job.description?.length || 0)) {
                job.description = desc;
                recovered++;
              }
            })
          );
        }
        console.log(`[linkedin] ScrapingBee rescue: ${recovered}/${needsRescue.length} jobs upgraded`);
      }
    }

    // Persist to Supabase jobs table (best-effort — scrape result returns
    // either way). dbId gets attached to each job row that lands in DB.
    await persistScrapedJobs(normalized);

    return NextResponse.json({ success: true, data: normalized });

  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("Apify Error:", error.response?.data);
      return NextResponse.json(
        { success: false, error: `Apify error: ${JSON.stringify(error.response?.data)}` },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
