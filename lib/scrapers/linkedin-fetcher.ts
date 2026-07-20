import axios from "axios";
import * as cheerio from "cheerio";
import { htmlToMarkdown, cleanLinkedInJobDescription, isLinkedInLoginWall } from "@/lib/utils/html-to-text";

// Fetches a public LinkedIn job page (no login) and extracts the description text.
// Used by both parse-gmail (Method 2) and scrape-jobs (Method 1) to recover full
// job descriptions when the upstream source only gives us a snippet or URL.
// Returns "" on any failure so callers can fall back gracefully.

// LinkedIn shows different HTML to different agents. We try several in priority:
// 1. Googlebot — many sites serve full SEO content to crawlers (highest hit rate).
// 2. Bingbot — alternate crawler when Google is blocked.
// 3. Real Chrome — what a normal browser sends (LinkedIn often clamps this).
// 4. Mobile Safari — LinkedIn's mobile site sometimes serves a fuller JD
//    without the desktop login wall; useful last-resort UA.
const USER_AGENTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
] as const;

// Common request headers shared by every cheerio fetch. The Referer claim
// makes the request look like an organic Google → LinkedIn click, which
// some endpoints relax their bot heuristics for. sec-fetch-* headers
// match what real browsers send on top-level navigation.
const BASE_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
  Referer: "https://www.google.com/",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "cross-site",
};

// Pulls a job location from the LinkedIn HTML — used as a Method-2-only fallback
// when Gmail-side parsing couldn't find a city. Reads JSON-LD's jobLocation first
// (most reliable), then a couple of well-known LinkedIn DOM selectors.
// Returns "" if nothing found so callers can decide whether to overwrite.
function extractLinkedInLocation(html: string): string {
  const $ = cheerio.load(html);
  let location = "";

  // 1) JSON-LD structured data (preferred)
  $('script[type="application/ld+json"]').each((_, el) => {
    if (location) return;
    try {
      const json = JSON.parse($(el).text() || "{}");
      const items = Array.isArray(json) ? json : Array.isArray(json["@graph"]) ? json["@graph"] : [json];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const jl = item.jobLocation;
        if (!jl) continue;
        const candidates = Array.isArray(jl) ? jl : [jl];
        for (const c of candidates) {
          if (!c) continue;
          if (typeof c === "string") {
            location = c;
            return;
          }
          const addr = c.address || c;
          if (typeof addr === "string") {
            location = addr;
            return;
          }
          if (addr && typeof addr === "object") {
            const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
              .filter((p) => typeof p === "string" && p.trim().length > 0);
            if (parts.length > 0) {
              location = parts.join(", ");
              return;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  });

  // 2) DOM selectors (fallback)
  if (!location) {
    for (const sel of [
      ".topcard__flavor--bullet",
      ".job-details-jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__bullet",
      "[data-test-job-location]",
      ".sub-nav-cta__meta-text",
    ]) {
      const text = $(sel).first().text().replace(/\s+/g, " ").trim();
      if (text && text.length >= 2 && text.length <= 80) {
        location = text;
        break;
      }
    }
  }

  return location.replace(/\s+/g, " ").trim().substring(0, 80);
}

// Pulls the longest candidate description from a single LinkedIn HTML document.
// Strategies are layered worst-to-best; we always keep the LONGEST hit so a meta
// snippet (~150 chars) gets overridden by a real JSON-LD body (~1500 chars).
function extractLinkedInDescription(html: string): { text: string; via: string } {
  const $ = cheerio.load(html);
  let best = "";
  let via = "none";

  const consider = (raw: string, label: string) => {
    if (!raw) return;
    // Convert to Markdown — keeps LinkedIn's real structure (**bold**,
    // ## headings, "- " bullets) instead of flattening to plain text.
    const cleaned = htmlToMarkdown(raw);
    // Reject LinkedIn auth-gate boilerplate ("Login to LinkedIn to keep in
    // touch …") — it's a short string that otherwise wins as "longest"
    // candidate when no real description container rendered, and gets
    // saved as the JD. Skipping it forces the orchestrator's ScrapingBee
    // fallback to fire (because final length stays 0).
    if (isLinkedInLoginWall(cleaned)) return;
    if (cleaned.length > best.length) {
      best = cleaned;
      via = label;
    }
  };

  // 1) JSON-LD structured data — handles plain object, array, and @graph wrapper.
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).text() || "{}");
      const items = Array.isArray(json) ? json : Array.isArray(json["@graph"]) ? json["@graph"] : [json];
      for (const item of items) {
        if (item && typeof item.description === "string") {
          consider(item.description, "json-ld");
        }
      }
    } catch {
      /* malformed JSON-LD, ignore */
    }
  });

  // 2) LinkedIn's known description containers (class names change with
  // each redesign — keep the OLD ones too, multiple may coexist while
  // LinkedIn A/B-tests a new layout).
  for (const sel of [
    ".show-more-less-html__markup",
    ".show-more-less-html__markup--clamp-after-5",
    ".description__text",
    ".description__text--rich",
    ".jobs-description__container",
    ".jobs-description-content__text",
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-unified-description__content",
    "#job-details",
    "section.description",
    "[data-test-description-text]",
    "[data-job-details-description]",
    "article[data-test-description]",
  ]) {
    // .html() (not .text()) so the real <ul>/<strong>/<h*> structure
    // reaches htmlToMarkdown instead of being pre-flattened by cheerio.
    consider($(sel).first().html() || "", `selector:${sel}`);
  }

  // 3) Inline JSON blobs — LinkedIn embeds long descriptions inside <code> / <script>
  //    tags as JSON. Grab any "description":"..." string > 200 chars and pick the longest.
  const inlineMatches = html.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.){200,})"/g);
  for (const m of inlineMatches) {
    const decoded = m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\u003c/gi, "<")
      .replace(/\\u003e/gi, ">")
      .replace(/\\u0026/gi, "&");
    consider(decoded, "inline-json");
  }

  // 4) Meta tags — short, but better than nothing.
  consider($('meta[name="description"]').attr("content") || "", "meta:name");
  consider($('meta[property="og:description"]').attr("content") || "", "meta:og");

  // 15 000-char cap. LinkedIn JDs routinely run 4–8k chars once
  // requirements + benefits + EEO sections are included; Markdown markers
  // (**, ##, "- ") add ~15 % on top, so the cap is bumped from 10k to keep
  // the FULL description rather than lopping off its tail.
  return { text: best.substring(0, 15000), via };
}

export async function fetchLinkedInJobDescription(url: string): Promise<string> {
  if (!url || !url.includes("linkedin.com")) return "";
  const idMatch = url.match(/\/jobs\/view\/(\d+)/);
  const jobId = idMatch?.[1];

  // URL variants tried in order — the jobs-guest API often returns the FULL
  // description even without login, while the public job page is heavily clamped.
  // For non-/jobs/view/ URLs (e.g. search pages) we just fetch the URL as-is.
  const variants: string[] = [];
  if (jobId) {
    variants.push(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`);
  }
  variants.push(url);
  if (jobId && !url.includes("/comm/")) {
    variants.push(url.replace("/jobs/view/", "/comm/jobs/view/"));
  }

  // Try every (url variant × user-agent) combo until a good description appears.
  // Googlebot UA is tried first for each URL since LinkedIn serves richer SEO HTML to crawlers.
  let bestText = "";
  let bestVia = "none";
  outer: for (const tryUrl of variants) {
    for (let uaIdx = 0; uaIdx < USER_AGENTS.length; uaIdx++) {
      const ua = USER_AGENTS[uaIdx];
      const uaLabel =
        uaIdx === 0 ? "googlebot" : uaIdx === 1 ? "bingbot" : uaIdx === 2 ? "chrome" : "mobile-safari";
      try {
        const res = await axios.get(tryUrl, {
          headers: { "User-Agent": ua, ...BASE_HEADERS },
          timeout: 10000,
          maxRedirects: 3,
          validateStatus: () => true,
        });
        if (res.status !== 200 || typeof res.data !== "string" || res.data.length < 200) continue;

        const { text, via } = extractLinkedInDescription(res.data);
        const urlTag = tryUrl.includes("jobs-guest") ? "guest-api" : tryUrl.includes("/comm/") ? "comm" : "public";
        const labeledVia = `${via} @ ${urlTag}/${uaLabel}`;
        if (text.length > bestText.length) {
          bestText = text;
          bestVia = labeledVia;
        }
        // Good enough — stop trying anything else.
        if (bestText.length >= 800) break outer;
        // This URL+UA returned 200 but short text; try next UA before moving to next URL.
      } catch (err) {
        console.log(`[linkedin-fetcher] error ${tryUrl} (${uaLabel}): ${(err as Error).message}`);
      }
    }
  }

  // Strip recruiter-card preamble + trailing metadata sections so the saved JD
  // is the actual description body, not the surrounding LinkedIn page chrome.
  const cleaned = cleanLinkedInJobDescription(bestText);
  if (cleaned.length > 0) {
    console.log(`[linkedin-fetcher] ${url}: ${cleaned.length} chars via ${bestVia} (raw=${bestText.length})`);
  }
  return cleaned;
}

// Public: fetch BOTH description + location from the LinkedIn page in a single
// request flow. Used by /api/fetch-job-description for Method-2 (Gmail) jobs
// whose location may not be present in the alert email itself.
// Returns { description, location } — either field may be "" on failure.
export async function fetchLinkedInJobDetails(
  url: string
): Promise<{ description: string; location: string }> {
  if (!url || !url.includes("linkedin.com")) return { description: "", location: "" };
  const idMatch = url.match(/\/jobs\/view\/(\d+)/);
  const jobId = idMatch?.[1];

  const variants: string[] = [];
  if (jobId) {
    variants.push(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`);
  }
  variants.push(url);
  if (jobId && !url.includes("/comm/")) {
    variants.push(url.replace("/jobs/view/", "/comm/jobs/view/"));
  }

  let bestDesc = "";
  let bestVia = "none";
  let bestLocation = "";
  outer: for (const tryUrl of variants) {
    for (let uaIdx = 0; uaIdx < USER_AGENTS.length; uaIdx++) {
      const ua = USER_AGENTS[uaIdx];
      const uaLabel =
        uaIdx === 0 ? "googlebot" : uaIdx === 1 ? "bingbot" : uaIdx === 2 ? "chrome" : "mobile-safari";
      try {
        const res = await axios.get(tryUrl, {
          headers: { "User-Agent": ua, ...BASE_HEADERS },
          timeout: 10000,
          maxRedirects: 3,
          validateStatus: () => true,
        });
        if (res.status !== 200 || typeof res.data !== "string" || res.data.length < 200) continue;

        const html = res.data;
        const { text, via } = extractLinkedInDescription(html);
        const urlTag = tryUrl.includes("jobs-guest") ? "guest-api" : tryUrl.includes("/comm/") ? "comm" : "public";
        const labeledVia = `${via} @ ${urlTag}/${uaLabel}`;
        if (text.length > bestDesc.length) {
          bestDesc = text;
          bestVia = labeledVia;
        }
        if (!bestLocation) {
          const loc = extractLinkedInLocation(html);
          if (loc) bestLocation = loc;
        }
        if (bestDesc.length >= 800 && bestLocation) break outer;
      } catch (err) {
        console.log(`[linkedin-fetcher] details-error ${tryUrl} (${uaLabel}): ${(err as Error).message}`);
      }
    }
  }

  const cleanedDesc = cleanLinkedInJobDescription(bestDesc);
  if (cleanedDesc.length > 0 || bestLocation) {
    console.log(
      `[linkedin-fetcher] details ${url}: desc=${cleanedDesc.length}c via ${bestVia} (raw=${bestDesc.length}) · location=${bestLocation || "—"}`
    );
  }
  return { description: cleanedDesc, location: bestLocation };
}
