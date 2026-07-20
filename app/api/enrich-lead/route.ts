import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { scrapeCompanyDecisionMakers, pickBestDecisionMaker } from "@/lib/scrapers/website-scraper";
import { getSupabaseAdmin } from "@/lib/db/supabase";
// Google Dork import removed — DuckDuckGo scraping was timing out (~50s per
// company) and returning 0 results consistently. Time waste, not a real fallback.

interface Candidate {
  id: number;
  name: string;
  title: string;
  linkedin: string;
  company: string;
  domain: string;
  location: string;
  email?: string;
  emailVerified?: string;
}

interface EnrichedLead {
  companyDomain: string;
  companyLinkedin: string;
  companyPhone: string;
  companySize: string;
  companyCountry: string;
  companyIndustry: string;
  candidates: Candidate[];
  selectedCandidateIndex?: number;
  apolloSearchUrl: string;
  linkedinSearchUrl: string;
}

// Email priority (0 = best, higher = worse)
// Priority order updated for freelancer/B2B outreach:
// 1. Personal email (firstname@, first.last@) — best for reaching decision maker
// 2. Company domain generic (info@, contact@, hello@) — reaches someone at the company
// 3. HR/Careers/Hiring emails — least useful for freelancer pitch
function emailPriority(email: string): number {
  const local = email.split("@")[0].toLowerCase();

  // Priority 0: Personal email (firstname, firstname.lastname)
  if (/^[a-z]+\.[a-z]+$/.test(local) || /^[a-z]{2,15}$/.test(local)) {
    // Exclude generic/department names
    const generic = ["info", "contact", "hello", "support", "admin", "mail", "office", "team", "service", "hr", "sales", "careers", "hiring", "jobs", "recruit", "recruitment", "talent", "people", "staff"];
    if (!generic.includes(local)) {
      return 0; // HIGHEST — personal email
    }
  }

  // Priority 1: Generic company domain (info@, contact@, hello@)
  if (/^(info|contact|hello|inquiry|enquiry|general|mail|office|team|admin)$/.test(local)) return 1;

  // Priority 2: Business/sales (sometimes forwarded to right person)
  if (/^(sales|bd|business|partner|partnerships|biz|support)/.test(local)) return 2;

  // Priority 3: HR/Careers/Hiring (least useful for freelancer)
  if (/^(hiring|jobs|recruit|recruiter|recruitment|talent|apply|join|career|careers|cv|resume|hr|people|staff|employment)/.test(local)) return 3;

  // Everything else
  return 4;
}

function pickBestEmail(emails: string[]): string {
  if (emails.length === 0) return "";
  const sorted = [...emails].sort((a, b) => emailPriority(a) - emailPriority(b));
  return sorted[0];
}

// RocketReach search — FREE unlimited, returns Name, Title, LinkedIn URL (not email)
const TARGET_TITLES_RR = [
  "CTO", "Chief Technology Officer",
  "VP Engineering", "VP of Engineering",
  "Head of Engineering", "Head of Product",
  "Founder", "Co-Founder",
  "CEO", "Chief Executive Officer",
  "Engineering Manager",
];

type RRProfile = {
  name: string;
  title: string;
  email: string;
  linkedin: string;
  source: string;
  id?: number;
};

// Process-wide rate-limit guard. Once we've hit a 429 from RR Search, skip every
// subsequent search call for the next 2 min so we don't hammer the API and waste
// per-job latency on requests we already know will fail. RR Search free tier
// throttles aggressively when used at high concurrency.
let rrSearchCooldownUntil = 0;
const RR_COOLDOWN_MS = 120_000; // 2 minutes

// Try one query against the RR Search API. Returns:
//   { profiles: [...], rateLimited: boolean }
// rateLimited=true tells the outer loop to stop trying more variations.
async function rrSearchOnce(
  employer: string,
  withTitleFilter: boolean
): Promise<{ profiles: Record<string, unknown>[]; rateLimited: boolean }> {
  if (Date.now() < rrSearchCooldownUntil) {
    return { profiles: [], rateLimited: true };
  }
  try {
    const body: Record<string, unknown> = {
      query: { current_employer: [employer] },
      page_size: 10,
    };
    if (withTitleFilter) {
      (body.query as Record<string, unknown>).current_title = TARGET_TITLES_RR;
    }
    const res = await axios.post("https://api.rocketreach.co/v2/api/search", body, {
      headers: {
        "Api-Key": process.env.ROCKETREACH_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status === 429) {
      rrSearchCooldownUntil = Date.now() + RR_COOLDOWN_MS;
      console.warn(`[enrich] RR search 429 — pausing all RR search calls for ${RR_COOLDOWN_MS / 1000}s`);
      return { profiles: [], rateLimited: true };
    }
    if (res.status !== 200) {
      console.warn(`[enrich] RR search "${employer}" status=${res.status}`);
      return { profiles: [], rateLimited: false };
    }
    const profiles: Record<string, unknown>[] = res.data?.profiles || [];
    console.log(
      `[enrich] RR search "${employer}" (titleFilter=${withTitleFilter}) → ${profiles.length} profiles`
    );
    return { profiles, rateLimited: false };
  } catch (err) {
    console.warn(
      `[enrich] RR search "${employer}" (titleFilter=${withTitleFilter}) failed:`,
      (err as Error).message
    );
    return { profiles: [], rateLimited: false };
  }
}

async function searchRocketReach(companyName: string): Promise<RRProfile[]> {
  // Strategy: minimize RR Search calls to avoid the free-tier rate limit.
  // - Pass 1 (1 call): original name with senior-title filter — covers 80% cases.
  // - Pass 2 (1 call): original name WITHOUT title filter — only fires when Pass 1 = 0.
  // Total per company: 1 call (best case) or 2 calls (worst case), instead of 4.
  // Name variations were dropped because they doubled the call volume for marginal gain.

  // Pass 1: senior-title filter (preferred decision makers)
  const p1 = await rrSearchOnce(companyName, true);
  if (p1.rateLimited) {
    console.log(`[enrich] RR search aborted (rate-limited) for "${companyName}"`);
    return [];
  }
  if (p1.profiles.length > 0) {
    const result = mapAndFilterProfiles(p1.profiles, companyName);
    if (result.length > 0) return result;
  }

  // Pass 2: drop title filter — wider net for small companies that don't have
  // CTO/Founder/CEO titles in RR's DB. Only fires if Pass 1 returned nothing.
  const p2 = await rrSearchOnce(companyName, false);
  if (p2.rateLimited) {
    console.log(`[enrich] RR fallback aborted (rate-limited) for "${companyName}"`);
    return [];
  }
  if (p2.profiles.length > 0) {
    const result = mapAndFilterProfiles(p2.profiles, companyName);
    if (result.length > 0) {
      console.log(`[enrich] RR fallback (no title filter) succeeded for "${companyName}"`);
      return result;
    }
  }

  console.log(`[enrich] RR search exhausted for "${companyName}" — no profiles found`);
  return [];
}

function mapAndFilterProfiles(
  profiles: Record<string, unknown>[],
  originalCompanyName: string
): RRProfile[] {
  const lowerName = originalCompanyName.toLowerCase().trim();
  const exactMatches = profiles.filter((p) => {
    const emp = String(p.current_employer || "").toLowerCase().trim();
    return emp === lowerName || emp.includes(lowerName) || lowerName.includes(emp);
  });
  const pool = exactMatches.length > 0 ? exactMatches : profiles;
  return pool.slice(0, 3).map((p) => ({
    id: p.id as number,
    name: String(p.name || "N/A"),
    title: String(p.current_title || "N/A"),
    linkedin: String(p.linkedin_url || "N/A"),
    email: "",
    source: "rocketreach-search",
  }));
}

// RocketReach Lookup (paid, 1 credit/call) — auto-fired when website scraping
// fails to find an email. Checks credits first; returns "" if quota exhausted so
// the caller can gracefully fall through. Limit is 5/month and resets monthly.
async function lookupRocketReachEmail(profileId: number): Promise<string> {
  if (!profileId || !process.env.ROCKETREACH_API_KEY) return "";
  try {
    // Quota check
    const accountRes = await axios.get("https://api.rocketreach.co/v2/api/account", {
      headers: { "Api-Key": process.env.ROCKETREACH_API_KEY },
      timeout: 8000,
    });
    const usage = accountRes.data?.credit_usage || [];
    const standard = usage.find((u: { credit_type: string }) => u.credit_type === "standard_lookup");
    const remaining = standard?.remaining || 0;
    if (remaining < 1) {
      console.log(`[enrich] RR Lookup skipped — 0/${standard?.allocated || 5} credits remaining`);
      return "";
    }
    console.log(`[enrich] RR Lookup auto-firing — ${remaining}/${standard?.allocated || 5} credits remaining`);

    const lookupRes = await axios.get(
      `https://api.rocketreach.co/v2/api/lookupProfile?id=${profileId}`,
      { headers: { "Api-Key": process.env.ROCKETREACH_API_KEY }, timeout: 15000 }
    );
    const data = lookupRes.data || {};
    const emails: { email?: string; smtp_valid?: string }[] = data.emails || [];
    const valid = emails.find((e) => e.smtp_valid === "valid");
    const best = valid || emails[0];
    return best?.email || "";
  } catch (err) {
    console.warn("[enrich] RR Lookup failed:", (err as Error).message);
    return "";
  }
}

// Snov.io and Apollo.io were dropped from this pipeline. Snov was used to
// verify emails post-discovery; Apollo was used to enrich company metadata
// (size / country / industry / LinkedIn). Both are no longer required:
//   - Verification: skipped, accept the email a tier returned and let bounces
//     surface naturally; the saved time per company is meaningful.
//   - Company info: not used by any active feature after the dashboard
//     analytics cleanup; the response keeps the fields as empty strings so
//     existing consumers don't break.
// To bring either back, restore the helpers from git history.

export async function POST(req: NextRequest) {
  try {
    const { companyName, source, jobId } = await req.json();
    const cleanName = (companyName || "").replace(/\s*\(.*\)/, "").trim();

    if (!cleanName || cleanName === "N/A" || cleanName === "Upwork Client") {
      return NextResponse.json({ success: false, error: "No valid company name" });
    }

    console.log(`[enrich] === ${cleanName} (source=${source || "unknown"}) ===`);

    // ─────── STEP 1: Website scrape FIRST — Name, Title, LinkedIn, Email ───────
    const scraped = await scrapeCompanyDecisionMakers(cleanName);
    console.log(`[enrich] Website scrape: ${scraped.members.length} members, ${scraped.genericEmails.length} emails`);

    let best = pickBestDecisionMaker(scraped.members);

    // ─────── STEP 2: RocketReach SEARCH (FREE) — primary source for Name/Title/LinkedIn ───────
    // Runs for every lead regardless of source. Website scrape is used only for emails.
    console.log(`[enrich] Running RocketReach search for "${cleanName}"...`);
    const rocketReachResults = await searchRocketReach(cleanName);
    console.log(`[enrich] RocketReach search: ${rocketReachResults.length} profiles`);

    if (rocketReachResults.length > 0) {
      // Merge: RocketReach members FIRST (preferred for name/title/linkedin),
      // then website-scraped members (whose value here is mainly the email match).
      const allMembers = [...rocketReachResults, ...scraped.members];
      const seenNames = new Set<string>();
      const mergedMembers = allMembers.filter((m) => {
        const nameKey = m.name.toLowerCase().trim();
        if (!nameKey) return true;
        if (seenNames.has(nameKey)) return false;
        seenNames.add(nameKey);
        return true;
      });
      best = pickBestDecisionMaker(mergedMembers);
      scraped.members = mergedMembers;
    } else {
      console.log(`[enrich] RocketReach returned no profiles — relying on website scrape only`);
    }
    // Google Dork fallback removed — DuckDuckGo was timing out 100% of the time
    // (~50s wasted per failed company). If RR + website both miss, we accept "no DM"
    // and let the user manually research / add via the Send button modal.

    // ─────── STEP 3: Match person with their email ───────
    // If we have "Rahul Sharma" as decision maker AND "rahul@company.com" in emails,
    // match them together for personalized email
    const allEmails = [
      ...scraped.members.map((m) => m.email).filter((e): e is string => !!e && e !== "N/A"),
      ...scraped.genericEmails,
    ];

    // Try to match decision maker name → email (from emails already scraped on the website)
    if (best && best.name !== "N/A" && !best.email) {
      const nameParts = best.name.toLowerCase().split(/\s+/).filter(Boolean);
      const first = nameParts[0] || "";
      const last = nameParts[nameParts.length - 1] || "";

      const matchedEmail = allEmails.find((e) => {
        const local = e.split("@")[0].toLowerCase();
        return (
          local === first ||
          local === last ||
          local === `${first}.${last}` ||
          local === `${first}${last}` ||
          local === `${first[0]}${last}` ||
          local === `${first}${last[0]}` ||
          local === `${first}_${last}` ||
          local === `${first}-${last}`
        );
      });

      if (matchedEmail) {
        console.log(`[enrich] Matched ${best.name} → ${matchedEmail}`);
        best.email = matchedEmail;
      }
    }

    // ─────── STEP 3b: Auto-fire RocketReach Lookup if website still gave no email ───────
    // RR Lookup costs 1 credit (5/month free). Only fires when:
    //  - Website scraping found no personal/generic email matching the DM
    //  - We have a RocketReach profile id (from the free RR Search step)
    //  - There are credits remaining (helper checks quota before consuming)
    if (best && (!best.email || best.email === "N/A") && best.id && allEmails.length === 0) {
      const lookedUp = await lookupRocketReachEmail(best.id);
      if (lookedUp) {
        best.email = lookedUp;
        console.log(`[enrich] ✓ Auto RR Lookup got email for ${best.name}: ${lookedUp}`);
      }
    }

    // If decision maker still has no email, use best available company email
    const bestEmail = best?.email || pickBestEmail(allEmails);

    console.log(`[enrich] Best email from ${allEmails.length} candidates: ${bestEmail || "none"}`);
    console.log(`[enrich] All emails found:`, allEmails.slice(0, 10));

    // ─────── STEP 4: Snov.io verification — REMOVED ───────
    // Verification step intentionally skipped. The pipeline now trusts whatever
    // email the website-scrape / RR Lookup chain returned, and Gmail bounces
    // surface invalid addresses post-send. Saves a credit-paid round-trip per
    // company. To restore, recover getSnovToken / verifyEmail from git history.
    const finalEmail = bestEmail;
    const verified = "unknown";

    // ─────── STEP 5: Company info — REMOVED (Apollo) ───────
    // Apollo's organization-enrich endpoint used to fill linkedin / phone /
    // size / country / industry. The dashboard analytics cleanup means none
    // of those fields are read anywhere; the response below keeps the keys
    // present (as empty strings) so existing consumers don't crash.

    // ─────── BUILD RESPONSE ───────
    // Attach best email to best decision maker if we have one
    let candidates: Candidate[] = [];
    if (best) {
      candidates = [
        {
          id: 0,
          name: best.name,
          title: best.title,
          linkedin: best.linkedin || "N/A",
          company: cleanName,
          domain: scraped.domain,
          location: "N/A",
          email: finalEmail || best.email || "N/A",
          emailVerified: verified,
        },
      ];
    } else if (finalEmail) {
      // No decision maker but email found — use company-level placeholder
      candidates = [
        {
          id: 0,
          name: "N/A",
          title: "N/A",
          linkedin: "N/A",
          company: cleanName,
          domain: scraped.domain,
          location: "N/A",
          email: finalEmail,
          emailVerified: verified,
        },
      ];
    }

    const apolloSearchUrl = `https://app.apollo.io/#/people?qOrganizationName=${encodeURIComponent(cleanName)}&personTitles[]=CTO&personTitles[]=VP+of+Engineering&personTitles[]=Founder&personTitles[]=CEO`;
    const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent("CTO OR VP Engineering OR Founder at " + cleanName)}&origin=GLOBAL_SEARCH_HEADER`;

    const enrichedLead: EnrichedLead = {
      companyDomain: scraped.domain,
      // Apollo company-info enrichment was removed — keep these keys present
      // (as empty strings) so existing consumers / TypeScript types don't
      // break, but no provider populates them anymore.
      companyLinkedin: "",
      companyPhone: "",
      companySize: "",
      companyCountry: "",
      companyIndustry: "",
      candidates,
      apolloSearchUrl,
      linkedinSearchUrl,
    };

    // Persist enrichment to jobs_v2 when the caller passed a jobId. Both the
    // browser auto-mode and cron/scrape pass it, so the enrichment JSONB +
    // email_status flip live in DB and survive page reloads / cross-session
    // hydration. Best-effort: a write failure here doesn't break the response.
    if (jobId && typeof jobId === "string") {
      try {
        const db = getSupabaseAdmin();
        const best = candidates[0];
        const hasEmail = !!(best && best.email && best.email !== "N/A");

        // A lead counts as "enriched"/usable ONLY when an email was found.
        // Without one, the decision-maker name/title/linkedin is intentionally
        // discarded — we don't persist anything, don't flip email_status, and
        // don't bump enriched_at. (No email = the downstream send/follow-up
        // pipeline can't run, so the rest of the data has no value and would
        // only inflate the Analytics "enriched" count with dead leads.)
        if (hasEmail) {
          const enrichmentJson = {
            email: best.email || null,
            name: best.name || null,
            title: best.title || null,
            linkedin: best.linkedin || null,
            company_country: enrichedLead.companyCountry || null,
            company_industry: enrichedLead.companyIndustry || null,
            company_size: enrichedLead.companySize || null,
            source: source || "enrich-lead",
            verified: best.emailVerified === "valid",
          };
          const update: Record<string, unknown> = {
            enrichment: enrichmentJson,
            email_status: "enriched",
            updated_at: new Date().toISOString(),
          };

          // enriched_at is set ONCE — the first successful (email-found)
          // enrichment. Re-enrichments must NOT bump it or the Analytics
          // timeline would shift historical counts forward on every re-run.
          const { data: existing } = await db
            .from("jobs_v2")
            .select("enriched_at")
            .eq("job_id", jobId)
            .maybeSingle();
          if (!existing?.enriched_at) {
            update.enriched_at = new Date().toISOString();
          }
          await db.from("jobs_v2").update(update).eq("job_id", jobId);
        }
      } catch (err) {
        console.warn("[enrich] jobs_v2 update failed:", (err as Error).message);
      }
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        data: enrichedLead,
        message: `No email found for ${cleanName}. Try manual LinkedIn search.`,
      });
    }

    return NextResponse.json({ success: true, data: enrichedLead });
  } catch (error) {
    console.error("[enrich] Error:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
