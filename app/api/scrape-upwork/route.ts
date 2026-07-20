import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

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

function extractEmail(text: string): string {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "N/A";
}

export async function POST(req: NextRequest) {
  try {
    const { roles } = await req.json();
    const keywords = Array.isArray(roles) ? roles.join(" OR ") : roles;

    console.log(`[upwork] Searching: ${keywords}`);

    const runResponse = await axios.post(
      "https://api.apify.com/v2/acts/getdataforme~upwork-actor/runs",
      {
        queries: [keywords],
        maxItems: 15,
      },
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
      console.log(`[upwork] Poll: ${status}`);
      attempts++;
      if (attempts > 24) break;
    }

    const resultsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      { params: { token: process.env.APIFY_API_KEY, limit: 15 } }
    );

    const rawJobs = resultsRes.data;
    console.log(`[upwork] Results: ${rawJobs.length}`);

    if (rawJobs.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        message: "Upwork: No jobs posted in the last 5 hours for this search. Try again later.",
      });
    }

    const normalized: NormalizedJob[] = rawJobs.map((job: Record<string, unknown>) => {
      const desc = String(job.description || "");

      return {
        title: String(job.title || "N/A"),
        jobId: String(job.id || "N/A"),
        company: "Upwork Client",
        email: extractEmail(desc),
        location: "Remote",
        jobType: String(job.jobType || "Freelance"),
        description: desc.substring(0, 300),
        url: String(job.url || ""),
        postedAt: String(job.publishedDate || job.postedOn || "N/A"),
        platform: "Upwork",
      };
    });

    return NextResponse.json({ success: true, data: normalized });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("[upwork] Error:", error.response?.data);
      return NextResponse.json(
        { success: false, error: `Upwork error: ${JSON.stringify(error.response?.data)}` },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
