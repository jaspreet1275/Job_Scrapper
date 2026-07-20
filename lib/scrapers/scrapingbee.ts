import axios from "axios";
import * as cheerio from "cheerio";
import { htmlToMarkdown, cleanLinkedInJobDescription, isLinkedInLoginWall } from "@/lib/utils/html-to-text";

// ScrapingBee-based LinkedIn job description fetcher.
// Used as a paid fallback when cheerio / Apify return short descriptions.
// Costs 25 credits per call (premium proxy + JS rendering combined). Free tier
// gives 1000 credits/month → ~40 LinkedIn fetches before exhaustion.

const SCRAPINGBEE_BASE = "https://app.scrapingbee.com/api/v1/";

// JS scenario: after the page hydrates, click ONLY the description's "Show more"
// button (not the recruiter card or other expanders), then wait so the expanded
// JD is in the DOM before we read it back. `evaluate` is forgiving — missing
// button = no error. Tighter selector avoids dragging the recruiter card text
// into the captured description.
const SHOW_MORE_SCENARIO = JSON.stringify({
  instructions: [
    { wait: 1500 },
    {
      evaluate:
        "document.querySelectorAll('button.show-more-less-html__button').forEach(b => { try { b.click(); } catch(e) {} });",
    },
    { wait: 1500 },
  ],
});

// Pulls the longest description-like text from any HTML returned by ScrapingBee.
// Same shape as the cheerio fetcher's extractor so callers can compare lengths fairly.
function extractDescriptionFromHtml(html: string): { text: string; via: string } {
  const $ = cheerio.load(html);
  let best = "";
  let via = "none";

  const consider = (raw: string, label: string) => {
    if (!raw) return;
    // Convert to Markdown — keeps LinkedIn's real structure (**bold**,
    // ## headings, "- " bullets) instead of flattening to plain text.
    const cleaned = htmlToMarkdown(raw);
    // Same login-wall guard as the cheerio fetcher — when ScrapingBee
    // returns LinkedIn's auth-gate page (rare but happens on residential
    // IPs that LinkedIn has fingerprinted), the meta description reads
    // "Login to LinkedIn to keep in touch …". Discarding it lets the
    // orchestrator surface "Description not available" instead of
    // saving misleading boilerplate.
    if (isLinkedInLoginWall(cleaned)) return;
    if (cleaned.length > best.length) {
      best = cleaned;
      via = label;
    }
  };

  // 1) JSON-LD structured data (richest, most reliable)
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
      /* ignore malformed json-ld */
    }
  });

  // 2) DOM containers — ScrapingBee renders JS, so .show-more-less-html__markup
  //    contains the FULL description (not the clamped public preview).
  //    Kept parallel with linkedin-fetcher's selector list so both extractors
  //    pick up the same containers as LinkedIn rolls out layout changes.
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

  // 3) Meta tags — last resort
  consider($('meta[name="description"]').attr("content") || "", "meta:name");
  consider($('meta[property="og:description"]').attr("content") || "", "meta:og");

  // 15 000-char cap — matches the cheerio fetcher so long JDs survive
  // both paths. See comment in linkedin-fetcher for the rationale.
  return { text: best.substring(0, 15000), via };
}

// Extracts location from LinkedIn HTML — JSON-LD jobLocation first, then a few
// reliable DOM selectors. Returns "" when nothing usable found.
function extractLocationFromHtml(html: string): string {
  const $ = cheerio.load(html);
  let location = "";

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

// Variant strategy for ScrapingBee. Each entry is one billable call —
// we try them in order and stop once the cleaned JD is "good enough"
// (≥ 800 chars). Ordered cheapest-first so the credit bill scales with
// difficulty: easy jobs cost ~10 credits, the toughest cost ~75 + 25.
//
//   1. jobs-guest API, premium proxy, NO JS render (~10 credits) —
//      LinkedIn's static SEO endpoint serves the full JD without a
//      login wall and without needing JS. Wins ~80 % of cases.
//
//   2. Original /jobs/view/{id}/ URL, premium proxy + JS render with
//      the Show-More click scenario (~25 credits) — for the rare
//      jobs where the guest API serves only a short stub.
//
//   3. Original URL with STEALTH proxy + JS render (~75 credits) —
//      last-resort for the ~10 % of jobs LinkedIn fingerprints the
//      premium-proxy pool against. Stealth proxy uses heavier
//      browser-fingerprint emulation and a residential IP set that
//      hasn't been seen on LinkedIn's bot lists.
//
// The variant config is `{ url, needsJs, stealth }`. `needsJs=false`
// implies `render_js=false` for free; setting it on the guest call
// keeps that variant under the 25-credit bracket.
interface SBVariant {
  url: string;
  needsJs: boolean;
  stealth: boolean;
}
function linkedinUrlVariants(originalUrl: string): SBVariant[] {
  const idMatch = originalUrl.match(/\/jobs\/view\/(\d+)/);
  const variants: SBVariant[] = [];
  if (idMatch) {
    variants.push({
      url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${idMatch[1]}`,
      needsJs: false,
      stealth: false,
    });
  }
  variants.push({ url: originalUrl, needsJs: true, stealth: false });
  // Stealth-proxy escalation — only for the public URL where JS render
  // matters. We don't escalate the guest API because if guest didn't
  // work behind premium proxy, stealth proxy on the same endpoint
  // rarely changes anything.
  variants.push({ url: originalUrl, needsJs: true, stealth: true });
  return variants;
}

// One ScrapingBee call. The proxy flag pair (`premium_proxy` vs
// `stealth_proxy`) is mutually exclusive — stealth costs ~75 credits
// but tunnels through ScrapingBee's heaviest fingerprint-rotation
// pool, which is the only way to clear the worst LinkedIn IP blocks.
async function fetchOneFromScrapingBee(
  apiKey: string,
  url: string,
  needsJs: boolean,
  stealth: boolean,
): Promise<{ html: string; status: number }> {
  const baseParams: Record<string, string> = {
    api_key: apiKey,
    url,
    country_code: "us",
    block_resources: "true",
  };
  if (stealth) {
    baseParams.stealth_proxy = "true";
  } else {
    baseParams.premium_proxy = "true";
  }
  if (needsJs) {
    baseParams.render_js = "true";
    baseParams.wait = "2500";
    baseParams.wait_for =
      ".description__text, .show-more-less-html__markup, [data-test-description-text]";
    baseParams.js_scenario = SHOW_MORE_SCENARIO;
  } else {
    baseParams.render_js = "false";
  }
  const res = await axios.get(SCRAPINGBEE_BASE, {
    params: baseParams,
    timeout: needsJs ? 90000 : 30000,
    validateStatus: () => true,
  });
  return {
    html: typeof res.data === "string" ? res.data : "",
    status: res.status,
  };
}

export async function fetchLinkedInJobDescriptionScrapingBee(url: string): Promise<string> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.log("[scrapingbee] SCRAPINGBEE_API_KEY not set — skipping");
    return "";
  }
  if (!url || !url.includes("linkedin.com")) return "";

  // Threshold above which we trust the JD and stop trying further variants.
  // 800 chars: LinkedIn's longest meta-description stub maxes ~250, so 800
  // means we definitely got real body content.
  const GOOD_ENOUGH = 800;

  let best = "";
  let bestVia = "none";
  for (const variant of linkedinUrlVariants(url)) {
    try {
      const { html, status } = await fetchOneFromScrapingBee(apiKey, variant.url, variant.needsJs, variant.stealth);
      if (status !== 200 || html.length < 500) {
        console.log(`[scrapingbee] ${variant.url}: status=${status} len=${html.length}`);
        continue;
      }
      const { text, via } = extractDescriptionFromHtml(html);
      const cleaned = cleanLinkedInJobDescription(text);
      if (cleaned.length > best.length) {
        best = cleaned;
        bestVia = `${via} @ ${variant.needsJs ? (variant.stealth ? "public+js+stealth" : "public+js") : "guest-api"}`;
      }
      if (best.length >= GOOD_ENOUGH) break;
    } catch (err) {
      console.log(`[scrapingbee] error ${variant.url}: ${(err as Error).message}`);
    }
  }
  if (best.length > 0) {
    console.log(`[scrapingbee] ${url}: ${best.length} chars via ${bestVia}`);
  }
  return best;
}

// Public: fetch BOTH description + location from one (or two, if the
// first short-circuits) ScrapingBee calls. Used by /api/fetch-job-description
// for Method 2 (Gmail) jobs as the paid fallback when free cheerio came
// back short. Tries guest API first (cheaper, more reliable for the JD
// part), falls back to the JS-rendered public URL only when needed.
export async function fetchLinkedInJobDetailsScrapingBee(
  url: string
): Promise<{ description: string; location: string }> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.log("[scrapingbee] SCRAPINGBEE_API_KEY not set — skipping");
    return { description: "", location: "" };
  }
  if (!url || !url.includes("linkedin.com")) return { description: "", location: "" };

  const GOOD_ENOUGH = 800;

  let bestDesc = "";
  let bestVia = "none";
  let bestLocation = "";
  for (const variant of linkedinUrlVariants(url)) {
    try {
      const { html, status } = await fetchOneFromScrapingBee(apiKey, variant.url, variant.needsJs, variant.stealth);
      if (status !== 200 || html.length < 500) {
        console.log(`[scrapingbee] details ${variant.url}: status=${status} len=${html.length}`);
        continue;
      }
      const { text, via } = extractDescriptionFromHtml(html);
      const cleanedDesc = cleanLinkedInJobDescription(text);
      if (cleanedDesc.length > bestDesc.length) {
        bestDesc = cleanedDesc;
        bestVia = `${via} @ ${variant.needsJs ? (variant.stealth ? "public+js+stealth" : "public+js") : "guest-api"}`;
      }
      if (!bestLocation) {
        const loc = extractLocationFromHtml(html);
        if (loc) bestLocation = loc;
      }
      if (bestDesc.length >= GOOD_ENOUGH && bestLocation) break;
    } catch (err) {
      console.log(`[scrapingbee] details error ${variant.url}: ${(err as Error).message}`);
    }
  }
  if (bestDesc.length > 0 || bestLocation) {
    console.log(
      `[scrapingbee] details ${url}: desc=${bestDesc.length}c via ${bestVia} · location=${bestLocation || "—"}`
    );
  }
  return { description: bestDesc, location: bestLocation };
}
