import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export async function POST(req: NextRequest) {
  try {
    const { jobs, roles, filters, platform } = await req.json();

    console.log(
      `[filter] Platform: ${platform}, Jobs: ${jobs.length}, Roles: ${roles}, Filters: ${filters}`
    );

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    const jobsSummary = jobs
      .slice(0, 15)
      .map((job: Record<string, unknown>) => ({
        title: job.title || "N/A",
        jobId: job.jobId || "N/A",
        company: job.company || "N/A",
        email: job.email || "N/A",
        location: job.location || "N/A",
        jobType: job.jobType || "N/A",
        description: String(job.description || "N/A").substring(0, 200),
        url: job.url || "",
        postedAt: job.postedAt || "N/A",
        platform: job.platform || platform,
      }));

    const rolesStr = Array.isArray(roles) ? roles.join(", ") : roles;
    const filtersStr =
      Array.isArray(filters) && filters.length > 0
        ? filters.join(", ")
        : "None";

    const prompt = `You are a job filtering assistant. Filter and rank these job listings.

Platform: ${platform}
Job Roles wanted: ${rolesStr}
Filters: ${filtersStr}

Job Listings:
${JSON.stringify(jobsSummary, null, 2)}

RULES:
1. Include jobs relevant to these roles: ${rolesStr}
2. Apply filters where data is available
3. Include ALL partially relevant jobs — never return empty array if jobs exist
4. Give matchScore 90+ for perfect match, 70+ for good match, 50+ for partial match

Return ONLY a raw JSON array. No markdown, no backticks, no explanation:
[
  {
    "title": "job title",
    "jobId": "copy from input",
    "company": "company name",
    "email": "copy from input",
    "location": "location",
    "jobType": "job type",
    "description": "2 line description",
    "url": "apply url",
    "postedAt": "copy from input",
    "platform": "copy from input",
    "matchScore": 85
  }
]

Sort by matchScore descending.`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 4000,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      }
    );

    const content = response.data.choices[0].message.content;
    console.log("[filter] Groq response preview:", content.substring(0, 300));

    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({ success: true, data: parsed });
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("Groq Error:", error.response?.data);
      return NextResponse.json(
        { success: false, error: JSON.stringify(error.response?.data) },
        { status: 500 }
      );
    }
    console.error("Filter unknown error:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}