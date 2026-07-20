import axios from "axios";
import * as cheerio from "cheerio";

// Decision maker titles we want to find
const TARGET_TITLES = [
  /\bcto\b/i,
  /chief\s+technology\s+officer/i,
  /\bvp\s+(of\s+)?engineering\b/i,
  /head\s+of\s+engineering/i,
  /head\s+of\s+product/i,
  /engineering\s+manager/i,
  /\bfounder\b/i,
  /co[-\s]?founder/i,
  /\bceo\b/i,
  /chief\s+executive\s+officer/i,
  /technical\s+director/i,
  /director\s+of\s+engineering/i,
  /\bvp\s+(of\s+)?technology/i,
  /\bcoo\b/i,
  /\bcpo\b/i,
  /chief\s+operating/i,
  /chief\s+product/i,
];

// Pages to try scraping — trimmed to the five paths that produce 90%+ of
// the decision-maker / email hits. Every extra path costs another
// ScrapingBee credit when the axios pass fails, so this list is kept tight.
const PAGES_TO_SCRAPE = [
  "",            // homepage — often carries founder names
  "/team",
  "/about",
  "/contact",
  "/leadership", // founders / executives commonly live here
];

export interface DecisionMaker {
  name: string;
  title: string;
  email: string;
  linkedin: string;
  source: string;
  id?: number; // RocketReach profile id (when source = "rocketreach-search") — used for auto Lookup
}

// ----- DOMAIN DETECTION -----

async function isDomainAlive(domain: string): Promise<boolean> {
  try {
    const res = await axios.head(`https://${domain}`, {
      timeout: 5000,
      maxRedirects: 3,
      headers: { "User-Agent": "Mozilla/5.0" },
      validateStatus: () => true,
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    try {
      const res = await axios.get(`https://${domain}`, {
        timeout: 5000,
        maxRedirects: 3,
        headers: { "User-Agent": "Mozilla/5.0" },
        validateStatus: () => true,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }
}

export async function getCompanyDomain(companyName: string): Promise<string | null> {
  const candidates: string[] = [];

  // Clean company name — remove Inc, LLC, Ltd, commas, periods, special chars
  const cleaned = companyName
    .replace(/,?\s*(inc\.?|llc\.?|ltd\.?|limited|corp\.?|corporation|co\.?|company|group|gmbh|pvt\.?)\.?\s*$/i, "")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Has TLD in name?
  const tldMatch = cleaned.match(/^(.+?)\.(co|io|com|ai|net|org|app|dev|tech|xyz)$/i);
  if (tldMatch) {
    candidates.push(cleaned.toLowerCase().replace(/\s+/g, ""));
  }

  // Clearbit
  try {
    const res = await axios.get(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(cleaned)}`,
      { timeout: 5000 }
    );
    const results = res.data || [];
    results.slice(0, 2).forEach((r: { domain?: string }) => {
      if (r.domain) candidates.push(r.domain);
    });
  } catch {}

  // Guesses — use cleaned name (no special chars)
  const cleanName = cleaned.toLowerCase().replace(/\s+/g, "");
  const cleanNameHyphen = cleaned.toLowerCase().replace(/\s+/g, "-");
  const firstWord = cleaned.toLowerCase().split(/\s+/)[0];

  candidates.push(
    `${cleanName}.com`,
    `${cleanNameHyphen}.com`,
    `${cleanName}.io`,
    `${cleanName}.co`,
    `${firstWord}.com`
  );

  const unique = [...new Set(candidates.map((c) => c.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "")))];
  console.log(`[scraper] Trying domains: ${unique.join(", ")}`);

  for (const domain of unique) {
    if (await isDomainAlive(domain)) {
      console.log(`[scraper] ✅ Active: ${domain}`);
      return domain;
    }
  }
  return null;
}

// ----- PAGE FETCHING -----

// ScrapingBee fallback for when plain axios is blocked (403, captchas, JS-only
// pages that won't ship HTML to a generic UA). Basic params only — no JS render
// and no premium proxy — so each call costs ~1 credit. The 1000-credit free
// tier therefore covers a few hundred company-website fetches before quota is
// exhausted; once that happens this just returns null and the caller treats
// the page as unfetched, same as a hard axios failure.
const SCRAPINGBEE_API = "https://app.scrapingbee.com/api/v1/";

async function fetchPageViaScrapingBee(url: string): Promise<string | null> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await axios.get(SCRAPINGBEE_API, {
      params: {
        api_key: apiKey,
        url,
        // Cheapest mode — most company sites SSR enough HTML to scrape
        // names/emails without JS rendering. Skip images/fonts to speed up.
        block_resources: "true",
      },
      timeout: 30000,
      validateStatus: () => true,
    });
    if (
      res.status >= 200 &&
      res.status < 400 &&
      typeof res.data === "string" &&
      res.data.length > 100
    ) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

// Resolution order:
//   1. Plain axios — free, fast, works for cooperative sites.
//   2. ScrapingBee  — fallback when axios is blocked (403, captcha, empty
//                     body, network refusal). Only fires if the API key is
//                     set; otherwise we degrade to "page unreachable".
async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: 5000, // reduced from 10s
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: (s) => s < 500,
    });
    if (
      res.status >= 200 &&
      res.status < 400 &&
      typeof res.data === "string" &&
      res.data.length > 100
    ) {
      return res.data;
    }
  } catch {
    /* fall through to ScrapingBee */
  }
  return await fetchPageViaScrapingBee(url);
}

// Try to discover team pages from sitemap.xml
async function discoverTeamPages(domain: string): Promise<string[]> {
  const discovered: string[] = [];
  try {
    const sitemap = await fetchPage(`https://${domain}/sitemap.xml`);
    if (sitemap) {
      const urlMatches = sitemap.match(/<loc>([^<]+)<\/loc>/g) || [];
      for (const u of urlMatches) {
        const url = u.replace(/<\/?loc>/g, "").trim();
        if (/\/(team|about|leadership|founder|people|staff|management|crew|members)/i.test(url)) {
          discovered.push(url.replace(`https://${domain}`, "").replace(`http://${domain}`, ""));
        }
      }
    }
  } catch {}
  return discovered.slice(0, 10);
}

// ----- EXTRACTION -----

function isDecisionMakerTitle(title: string): boolean {
  return TARGET_TITLES.some((re) => re.test(title));
}

// Filters out strings that match the email regex but are actually image/asset
// filenames (e.g. "rocket-midtown@300x-150x150.png") or otherwise not real
// addresses. The bare regex doesn't know that a TLD-shaped chunk like ".png"
// or ".jpg" is a file extension, not a real domain.
const NON_EMAIL_TLD = /\.(png|jpe?g|gif|svg|webp|ico|bmp|tiff?|avif|heic|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp4|mov|avi|mp3|wav|css|js|json|xml|html?|woff2?|ttf|otf|eot)$/i;
function isLikelyRealEmail(email: string): boolean {
  if (!email) return false;
  const lower = email.toLowerCase().trim();
  if (NON_EMAIL_TLD.test(lower)) return false;
  // "@2x", "@300x" image density suffixes — local-part ending in @<digit>x is asset-y
  if (/@\d+x[-.]/i.test(lower)) return false;
  return true;
}

// Extract decision makers from HTML
function extractTeamMembers(html: string, domain: string, sourceUrl: string): DecisionMaker[] {
  const $ = cheerio.load(html);
  const members: DecisionMaker[] = [];
  const emailRegex = new RegExp(`[a-zA-Z0-9._%+-]+@${domain.replace(".", "\\.")}`, "gi");

  // Strategy 1: Team member containers
  const containerSelectors = [
    ".team-member", ".team_member", ".member", ".person",
    ".leadership", ".founder", ".executive", ".profile",
    ".card", ".bio", ".staff", ".employee",
    "[class*='team']", "[class*='member']", "[class*='person']",
    "[class*='leader']", "[class*='founder']", "[class*='executive']",
    "[class*='staff']", "[class*='bio']", "[class*='profile']",
    "article", "li",
  ];

  for (const selector of containerSelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const text = $el.text().replace(/\s+/g, " ").trim();
      if (text.length < 10 || text.length > 2000) return;

      // Must contain a target title
      if (!isDecisionMakerTitle(text)) return;

      // Extract name — h2/h3/h4/strong/alt from img
      let name = "";
      const nameSelectors = ["h1", "h2", "h3", "h4", "h5", ".name", "[class*='name']", "strong", "b"];
      for (const ns of nameSelectors) {
        const t = $el.find(ns).first().text().trim();
        if (t && t.length >= 3 && t.length < 80 && /^[A-Z]/.test(t) && !isDecisionMakerTitle(t)) {
          name = t;
          break;
        }
      }
      // Try alt text of image
      if (!name) {
        const altText = $el.find("img").first().attr("alt") || "";
        if (altText && altText.length >= 3 && altText.length < 80 && /^[A-Z]/.test(altText)) {
          name = altText;
        }
      }

      // Extract title
      let title = "";
      const titleSelectors = [".title", ".role", ".position", ".designation", "[class*='title']", "[class*='role']", "[class*='position']", "[class*='designation']", "p", "span", "em", "i"];
      for (const ts of titleSelectors) {
        $el.find(ts).each((__, tEl) => {
          if (title) return;
          const t = $(tEl).text().trim();
          if (t && t !== name && isDecisionMakerTitle(t) && t.length < 100) {
            title = t;
          }
        });
        if (title) break;
      }

      // LinkedIn URL — personal profile only (/in/)
      let linkedin = "";
      $el.find("a").each((__, a) => {
        if (linkedin) return;
        const href = $(a).attr("href") || "";
        // Personal LinkedIn profile
        if (/linkedin\.com\/in\//.test(href)) {
          linkedin = href;
        }
      });
      // Also check data attributes and social icons
      if (!linkedin) {
        $el.find("[data-linkedin], [data-social-linkedin]").each((__, a) => {
          if (linkedin) return;
          linkedin = $(a).attr("data-linkedin") || $(a).attr("data-social-linkedin") || "";
          if (linkedin && !linkedin.startsWith("http")) {
            linkedin = `https://www.linkedin.com/in/${linkedin}`;
          }
        });
      }

      // Email — check mailto + text content
      let email = "";
      $el.find("a[href^='mailto:']").each((__, a) => {
        if (!email) {
          const candidate = ($(a).attr("href") || "").replace(/^mailto:/, "").split("?")[0].trim();
          if (isLikelyRealEmail(candidate)) email = candidate;
        }
      });
      if (!email) {
        const elText = $el.text();
        const emailMatch = elText.match(emailRegex);
        if (emailMatch) {
          const candidate = emailMatch.find((m) => isLikelyRealEmail(m));
          if (candidate) email = candidate;
        }
      }

      if (name && title) {
        if (!members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
          members.push({ name, title, email, linkedin, source: sourceUrl });
        }
      }
    });
  }

  // Strategy 1b: Heading pairs — name in one heading, title in next heading/paragraph
  // Example: <h2>SANKALP CHHABRA</h2> <h3>FOUNDER</h3>
  $("h1, h2, h3, h4, h5").each((_, el) => {
    const $h = $(el);
    const headingText = $h.text().trim().replace(/\s+/g, " ");

    // Check if this heading looks like a person name
    // Patterns: "Sankalp Chhabra", "SANKALP CHHABRA", "Sankalp K. Chhabra"
    const isNameLike =
      /^[A-Z][a-zA-Z.'-]+(\s+[A-Z][a-zA-Z.'-]+){1,3}$/.test(headingText) ||
      /^[A-Z]{2,}(\s+[A-Z]{2,})+$/.test(headingText);

    if (!isNameLike || headingText.length > 80 || headingText.length < 4) return;
    if (isDecisionMakerTitle(headingText)) return; // it's a title not a name

    // Convert ALL CAPS to Title Case for cleaner display
    const cleanName = /^[A-Z]{2,}(\s+[A-Z]{2,})+$/.test(headingText)
      ? headingText.split(/\s+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")
      : headingText;

    // Look at NEXT 1-3 siblings for title
    let title = "";
    let $next = $h.next();
    let attempts = 0;
    while ($next.length && attempts < 4 && !title) {
      const nextText = $next.text().trim().replace(/\s+/g, " ");
      if (nextText && nextText.length < 100 && isDecisionMakerTitle(nextText)) {
        title = nextText;
        break;
      }
      $next = $next.next();
      attempts++;
    }

    // Also check the parent container for title if not found in siblings
    if (!title) {
      const $parent = $h.parent();
      $parent.find("p, h3, h4, h5, div, span, em, i").each((__, tEl) => {
        if (title) return;
        const t = $(tEl).text().trim();
        if (t && t !== headingText && t.length < 100 && isDecisionMakerTitle(t)) {
          // Clean up all caps titles too
          title = /^[A-Z]{2,}$/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
        }
      });
    }

    if (cleanName && title) {
      // Extract LinkedIn + email from nearby siblings/parent
      const $section = $h.parent();
      let linkedin = "";
      let email = "";
      $section.find("a[href*='linkedin.com/in/']").each((__, a) => {
        if (!linkedin) linkedin = $(a).attr("href") || "";
      });
      $section.find("a[href^='mailto:']").each((__, a) => {
        if (!email) email = ($(a).attr("href") || "").replace(/^mailto:/, "").split("?")[0];
      });
      if (!email) {
        const emailMatch = $section.text().match(emailRegex);
        if (emailMatch) email = emailMatch[0];
      }

      if (!members.some((m) => m.name.toLowerCase() === cleanName.toLowerCase())) {
        members.push({ name: cleanName, title, email, linkedin, source: sourceUrl });
      }
    }
  });

  // Strategy 1c: Find ALL CAPS name followed by ALL CAPS title on Wix/Squarespace/Webflow sites
  // Example: "SANKALP CHHABRA FOUNDER" or "SANKALP CHHABRA\nFOUNDER"
  const fullBodyText = $("body").text().replace(/\s+/g, " ");
  const titlePatterns = [
    "FOUNDER", "CO-FOUNDER", "COFOUNDER", "CEO", "CTO", "COO", "CPO",
    "VP ENGINEERING", "VP OF ENGINEERING", "HEAD OF ENGINEERING", "HEAD OF PRODUCT",
    "CHIEF TECHNOLOGY OFFICER", "CHIEF EXECUTIVE OFFICER", "ENGINEERING MANAGER",
    "TECHNICAL DIRECTOR", "DIRECTOR OF ENGINEERING",
  ];
  for (const titleUpper of titlePatterns) {
    // Pattern: NAME NAME [optional middle] TITLE
    // Example: "SANKALP CHHABRA FOUNDER" or "RAHUL KUMAR CEO"
    const pattern = new RegExp(
      `([A-Z][A-Z]+(?:\\s+[A-Z][A-Z]+){1,3})\\s+${titleUpper}\\b`,
      "g"
    );
    let match;
    while ((match = pattern.exec(fullBodyText)) !== null) {
      const rawName = match[1].trim();
      // Skip if it's a common word sequence
      if (rawName.length < 6 || rawName.length > 60) continue;
      if (/\b(THE|AND|OR|FOR|WITH|OUR|YOUR|ABOUT|TEAM|COMPANY|SERVICES|CLIENT)\b/.test(rawName)) continue;

      // Convert to Title Case
      const cleanName = rawName.split(/\s+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
      const cleanTitle = titleUpper.split(/\s+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");

      if (!members.some((m) => m.name.toLowerCase() === cleanName.toLowerCase())) {
        members.push({ name: cleanName, title: cleanTitle, email: "", linkedin: "", source: sourceUrl });
      }
    }
  }

  // Strategy 1d: Find div/span blocks containing just a name followed by just a title
  $("div, span, p").each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim().replace(/\s+/g, " ");
    // Check if element is ONLY a name (all caps or title case)
    const isNameOnly =
      (/^[A-Z][A-Z]+(\s+[A-Z][A-Z]+){1,3}$/.test(text) ||
       /^[A-Z][a-z]+(\s+[A-Z][a-z]+){1,3}$/.test(text)) &&
      text.length >= 6 && text.length <= 60 &&
      !isDecisionMakerTitle(text);

    if (!isNameOnly) return;

    // Find sibling or next element containing decision maker title
    let titleFound = "";
    const $sibling = $el.next();
    if ($sibling.length) {
      const siblingText = $sibling.text().trim().replace(/\s+/g, " ");
      if (siblingText.length < 100 && isDecisionMakerTitle(siblingText)) {
        titleFound = siblingText;
      }
    }
    // Check parent's next section
    if (!titleFound) {
      const $parent = $el.parent();
      const $parentNext = $parent.next();
      if ($parentNext.length) {
        const pnText = $parentNext.text().trim().replace(/\s+/g, " ");
        if (pnText.length < 100 && isDecisionMakerTitle(pnText)) {
          titleFound = pnText;
        }
      }
    }

    if (titleFound) {
      const cleanName = /^[A-Z]{2,}/.test(text)
        ? text.split(/\s+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")
        : text;
      const cleanTitle = /^[A-Z]{2,}$/.test(titleFound)
        ? titleFound.charAt(0) + titleFound.slice(1).toLowerCase()
        : titleFound;

      if (!members.some((m) => m.name.toLowerCase() === cleanName.toLowerCase())) {
        members.push({ name: cleanName, title: cleanTitle, email: "", linkedin: "", source: sourceUrl });
      }
    }
  });

  // Strategy 1e: Handle "Name – Title" or "Name — Title" in single heading
  // Example: <h3>Daniel Beal – Chief Executive Officer / Health & Safety Trainer</h3>
  $("h1, h2, h3, h4, h5, h6, strong, b").each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, " ");
    // Pattern: Name(2-3 words) SEPARATOR Title(rest)
    const match = text.match(/^([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,3})\s*[–—\-|,:]\s*(.+)$/);
    if (!match) return;

    const candidateName = match[1].trim();
    let candidateTitle = match[2].trim();
    // Title might have multiple roles separated by / — keep first relevant one
    const titles = candidateTitle.split(/\s*\/\s*/);
    const relevantTitle = titles.find((t) => isDecisionMakerTitle(t));
    if (relevantTitle) candidateTitle = relevantTitle.trim();

    if (!isDecisionMakerTitle(candidateTitle)) return;
    if (candidateName.length < 4 || candidateName.length > 60) return;

    // Extract nearby LinkedIn + email
    const $container = $(el).closest("div, section, article, li, td, tr").first();
    let linkedin = "";
    let email = "";
    $container.find("a[href*='linkedin.com/in/']").each((__, a) => {
      if (!linkedin) linkedin = $(a).attr("href") || "";
    });
    $container.find("a[href^='mailto:']").each((__, a) => {
      if (!email) email = ($(a).attr("href") || "").replace(/^mailto:/, "").split("?")[0];
    });
    if (!email) {
      const emailMatch = $container.text().match(emailRegex);
      if (emailMatch) email = emailMatch[0];
    }

    if (!members.some((m) => m.name.toLowerCase() === candidateName.toLowerCase())) {
      members.push({ name: candidateName, title: candidateTitle, email, linkedin, source: sourceUrl });
    }
  });

  // Strategy 2: Free-text regex on body
  const bodyText = $("body").text().replace(/\s+/g, " ");
  const titleGroup = "(CTO|CEO|Chief\\s+Technology\\s+Officer|Chief\\s+Executive\\s+Officer|VP\\s+of\\s+Engineering|VP\\s+Engineering|Head\\s+of\\s+Engineering|Head\\s+of\\s+Product|Engineering\\s+Manager|Co[-\\s]?Founder|Founder|Technical\\s+Director|Director\\s+of\\s+Engineering)";
  const patterns = [
    // "Name – Title" (with optional spaces around separator)
    new RegExp(`([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+){1,2})\\s*[,—–\\-]\\s*${titleGroup}`, "g"),
    new RegExp(`([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+){1,2})\\s*\\(${titleGroup}\\)`, "g"),
    new RegExp(`${titleGroup}\\s*[:—–\\-]\\s*([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+){1,2})`, "g"),
    new RegExp(`${titleGroup}\\s+(?:is\\s+|at\\s+)?([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+){1,2})`, "g"),
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      const g1 = match[1];
      const g2 = match[2];
      let name = "", title = "";
      if (/^[A-Z][a-zA-Z]+(\s+[A-Z][a-zA-Z]+)+$/.test(g1)) {
        name = g1; title = g2;
      } else {
        title = g1; name = g2;
      }
      if (name && title && !members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        members.push({ name, title, email: "", linkedin: "", source: sourceUrl });
      }
    }
  }

  // Strategy 3: JSON-LD structured data
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.founder) {
          const founders = Array.isArray(item.founder) ? item.founder : [item.founder];
          for (const f of founders) {
            if (f.name && !members.some((m) => m.name.toLowerCase() === f.name.toLowerCase())) {
              const linkedin = f.sameAs
                ? (Array.isArray(f.sameAs) ? f.sameAs.find((u: string) => u.includes("linkedin")) || "" : f.sameAs)
                : "";
              members.push({
                name: f.name,
                title: "Founder",
                email: f.email || "",
                linkedin,
                source: sourceUrl,
              });
            }
          }
        }
        if (item.employee) {
          const emps = Array.isArray(item.employee) ? item.employee : [item.employee];
          for (const e of emps) {
            if (e.name && e.jobTitle && isDecisionMakerTitle(e.jobTitle)) {
              if (!members.some((m) => m.name.toLowerCase() === e.name.toLowerCase())) {
                members.push({
                  name: e.name,
                  title: e.jobTitle,
                  email: e.email || "",
                  linkedin: "",
                  source: sourceUrl,
                });
              }
            }
          }
        }
      }
    } catch {}
  });

  // Strategy 4: Next.js __NEXT_DATA__ or other embedded JSON
  const nextDataScript = $("#__NEXT_DATA__").text();
  if (nextDataScript) {
    try {
      const nextData = JSON.parse(nextDataScript);
      const stringified = JSON.stringify(nextData);
      // Find patterns in JSON like {"name":"...","title":"CTO"}
      const jsonMembers = stringified.match(/"name":"[^"]+","[^}]*(?:title|jobTitle|role|position)":"[^"]*(?:CTO|CEO|Founder|VP)[^"]*"/gi) || [];
      for (const jm of jsonMembers) {
        const nameMatch = jm.match(/"name":"([^"]+)"/);
        const titleMatch = jm.match(/"(?:title|jobTitle|role|position)":"([^"]+)"/);
        if (nameMatch && titleMatch) {
          const name = nameMatch[1];
          const title = titleMatch[1];
          if (isDecisionMakerTitle(title) && !members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
            members.push({ name, title, email: "", linkedin: "", source: sourceUrl });
          }
        }
      }
    } catch {}
  }

  return members;
}

// Decode Cloudflare email obfuscation (data-cfemail="abc123..")
function decodeCfEmail(hex: string): string {
  try {
    const r = parseInt(hex.substring(0, 2), 16);
    let email = "";
    for (let n = 2; n < hex.length; n += 2) {
      email += String.fromCharCode(parseInt(hex.substring(n, n + 2), 16) ^ r);
    }
    return email;
  } catch {
    return "";
  }
}

export function extractGenericEmails(html: string, domain: string): string[] {
  const emails = new Set<string>();

  // Step 1: Extract ALL emails from HTML (any domain)
  const anyEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const allMatches: string[] = html.match(anyEmailRegex) || [];

  // Step 2: Also extract mailto: links
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let mtMatch: RegExpExecArray | null;
  while ((mtMatch = mailtoRegex.exec(html)) !== null) {
    allMatches.push(mtMatch[1]);
  }

  // Step 2b: Decode Cloudflare email obfuscation (data-cfemail="hex")
  const cfEmailRegex = /data-cfemail="([a-f0-9]+)"/gi;
  let cfMatch: RegExpExecArray | null;
  while ((cfMatch = cfEmailRegex.exec(html)) !== null) {
    const decoded = decodeCfEmail(cfMatch[1]);
    if (decoded && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(decoded)) {
      allMatches.push(decoded);
    }
  }

  // Step 2c: Extract emails from HTML entities (&#64; instead of @)
  const entityHtml = html
    .replace(/&#64;/g, "@")
    .replace(/&#46;/g, ".")
    .replace(/&commat;/g, "@")
    .replace(/&period;/g, ".")
    .replace(/\s*\[\s*(?:at|@)\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*(?:at|@)\s*\)\s*/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".");
  const entityMatches = entityHtml.match(anyEmailRegex) || [];
  entityMatches.forEach((e) => allMatches.push(e));

  // Step 3: Filter — keep emails matching the domain, OR common company subdomain patterns
  const domainCore = domain.replace(/^www\./, "").toLowerCase();
  const domainBase = domainCore.split(".")[0]; // "zenotis" from "zenotis.com"

  for (const e of allMatches) {
    if (!isLikelyRealEmail(e)) continue;
    const lower = e.toLowerCase();
    const [, emailDomain] = lower.split("@");
    if (!emailDomain) continue;

    // Exact match
    if (emailDomain === domainCore) {
      emails.add(lower);
      continue;
    }
    // Same base name but different TLD (e.g., zenotis.io vs zenotis.com)
    const emailBase = emailDomain.split(".")[0];
    if (emailBase === domainBase && emailBase.length > 3) {
      emails.add(lower);
      continue;
    }
    // Subdomain match (mail.zenotis.com, hr.zenotis.com)
    if (emailDomain.endsWith("." + domainCore)) {
      emails.add(lower);
    }
  }

  // Step 4: If no domain-matched emails found, return top company-looking emails
  // (skip generic @gmail.com, @yahoo.com, @hotmail.com, etc.)
  if (emails.size === 0) {
    const webmailDomains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "example.com", "test.com", "aol.com", "mail.com"];
    for (const e of allMatches) {
      if (!isLikelyRealEmail(e)) continue;
      const lower = e.toLowerCase();
      const [, emailDomain] = lower.split("@");
      if (emailDomain && !webmailDomains.includes(emailDomain)) {
        emails.add(lower);
        if (emails.size >= 5) break;
      }
    }
  }

  return Array.from(emails);
}

function titlePriority(title: string): number {
  const t = title.toLowerCase();
  if (t.includes("cto") || t.includes("chief technology")) return 0;
  if (t.includes("vp") && t.includes("engineering")) return 1;
  if (t.includes("head") && t.includes("engineering")) return 2;
  if (t.includes("head") && t.includes("product")) return 3;
  if (t.includes("founder") && !t.includes("co-")) return 4;
  if (t.includes("co-founder") || t.includes("cofounder")) return 5;
  if (t.includes("ceo") || t.includes("chief executive")) return 6;
  if (t.includes("engineering manager")) return 7;
  if (t.includes("coo") || t.includes("cpo")) return 8;
  return 99;
}

export function pickBestDecisionMaker(members: DecisionMaker[]): DecisionMaker | null {
  if (members.length === 0) return null;
  const sorted = [...members].sort((a, b) => titlePriority(a.title) - titlePriority(b.title));
  return sorted[0];
}

// ----- MAIN -----

export async function scrapeCompanyDecisionMakers(companyName: string): Promise<{
  domain: string;
  members: DecisionMaker[];
  genericEmails: string[];
}> {
  const domain = await getCompanyDomain(companyName);
  if (!domain) {
    return { domain: "", members: [], genericEmails: [] };
  }

  console.log(`[scraper] Domain for "${companyName}": ${domain}`);

  // Discover additional team pages from sitemap
  const discovered = await discoverTeamPages(domain);
  const allPaths = [...new Set([...PAGES_TO_SCRAPE, ...discovered])];
  console.log(`[scraper] Discovered ${discovered.length} extra paths from sitemap`);

  // Try just non-www (redirects will handle www if needed)
  const baseUrl = `https://${domain}`;
  const allUrls = allPaths.map((path) => `${baseUrl}${path}`);

  // Fetch all in parallel (with timeout safety)
  const pageResults = await Promise.all(
    allUrls.map(async (url) => ({ url, html: await fetchPage(url) }))
  );

  const validPages = pageResults.filter((p) => p.html);
  console.log(`[scraper] Fetched ${validPages.length}/${allUrls.length} pages`);

  const allMembers: DecisionMaker[] = [];
  const allGenericEmails = new Set<string>();

  for (const { url, html } of validPages) {
    if (!html) continue;
    const mems = extractTeamMembers(html, domain, url);
    for (const m of mems) {
      if (!allMembers.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) {
        allMembers.push(m);
      }
    }
    const ems = extractGenericEmails(html, domain);
    ems.forEach((e) => allGenericEmails.add(e));
  }

  console.log(`[scraper] ${allMembers.length} decision makers, ${allGenericEmails.size} emails`);

  return {
    domain,
    members: allMembers,
    genericEmails: Array.from(allGenericEmails),
  };
}
