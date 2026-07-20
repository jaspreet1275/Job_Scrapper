import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import * as cheerio from "cheerio";
import { fetchLinkedInJobDetails } from "@/lib/scrapers/linkedin-fetcher";
import { fetchLinkedInJobDetailsScrapingBee } from "@/lib/scrapers/scrapingbee";
import { isLinkedInLoginWall } from "@/lib/utils/html-to-text";
import {
  getReadClientsForSelection,
  markParsed,
  type ReadAccount,
} from "@/lib/email/gmail";
import { persistScrapedJobs } from "@/lib/db/jobs-persist";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";

interface ParsedJob {
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

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// YYYY-MM-DD for a Date in IST (UTC+5:30). Vercel runs this route in UTC,
// but the dashboard is IST-based (cron windows use IST) and LinkedIn alert
// "posted on" dates plus the user's notion of "today" are all IST. Every
// posted-date value AND the today/yesterday window filter are derived
// through this one helper so the comparison is always apples-to-apples.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function toISTDateString(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

// UTC instant of IST-midnight that opens the given IST calendar day.
function istMidnightMsFor(dateIST: string): number {
  const [y, m, d] = dateIST.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}

// The IST calendar day before `dateIST`. The scrape window spans the target
// day AND this one, so alerts that land late at night (or that we miss on a
// day the cron didn't fire) still get picked up on the next run.
function istPreviousDay(dateIST: string): string {
  // Midday of the previous IST day — far from either midnight boundary, so
  // the date this maps back to is unambiguous.
  return toISTDateString(new Date(istMidnightMsFor(dateIST) - 12 * 60 * 60 * 1000));
}

// True only for REMOTE roles. LinkedIn alert cards put the work type in the
// location ("India (Remote)" / "London (Hybrid)") and the parser also folds
// it into jobType ("Remote", "Full-time · Remote"). Anything that doesn't
// explicitly say "remote" — hybrid, on-site, or unknown — is dropped so only
// remote jobs ever enter the pipeline.
function isRemoteJob(job: ParsedJob): boolean {
  const hay = `${job.location || ""} ${job.jobType || ""}`.toLowerCase();
  return /\bremote\b/.test(hay);
}

// Parse LinkedIn alert email using cheerio
// Patterns shared by the <p>-based primary extractor and the anchor-loop
// fallback. Any anchor text or paragraph that starts with one of these
// phrases is almost certainly a CTA/wrapper, not a real job title.
const NON_JOB_TITLE_RE =
  /^(view|save|apply|see more|see all|click|learn more|https?:|manage|your job|"|'|alerts?\b|job alert|jobs?\s+similar\s+to|recommended|more\s+like|view\s+all|browse\s+jobs?|notifications?|easy\s+apply|apply\s+now|actively\s+recruiting|promoted|reposted|featured)\b/i;

// Pure CTA-badge texts that should NEVER be a job title even if they
// somehow pass the prefix regex (e.g. "Easy Apply" by itself was sneaking
// through as a 10-char title and creating garbage rows in the All Jobs
// table). Compared after trim/lowercase so an exact match kills the row.
const PURE_CTA_TITLES = new Set([
  "easy apply",
  "apply now",
  "apply",
  "save",
  "view",
  "view job",
  "see job",
  "actively recruiting",
  "promoted",
  "reposted",
  "featured",
  "new",
]);

function isNonJobText(s: string): boolean {
  if (!s) return true;
  const trimmed = s.trim();
  if (trimmed.length < 3) return true;
  if (PURE_CTA_TITLES.has(trimmed.toLowerCase())) return true;
  return (
    NON_JOB_TITLE_RE.test(trimmed) ||
    /\bmanage\s+alert\b/i.test(trimmed) ||
    /\bjob\s+alert\b/i.test(trimmed) ||
    /\bjobs?\s+similar\s+to\b/i.test(trimmed)
  );
}

// Strip trailing CTA badges that LinkedIn appends after the location:
// "Easy Apply", "Actively recruiting", "Promoted", "Reposted", "View job",
// "Apply now", "See job", "Featured", "New". Used by both extractors so
// location values stay clean regardless of which path produced them.
function stripCtaBadges(s: string): string {
  return s
    .replace(
      /\s*(?:[·•|]\s*)?(?:easy\s*apply|actively\s*recruiting|promoted|reposted|view\s+job|apply\s+now|see\s+job|featured|new)\b.*$/gi,
      ""
    )
    .replace(/[·•|,\s]+$/, "")
    .trim();
}

// Pulls a per-job "posted on M/D/YY" from the email subject (LinkedIn
// uses this in single-job notification subjects like
//   "react.js remote jobs at USA,UK": Netrolynx - Frontend Developer posted on 5/12/26
// ). Returns YYYY-MM-DD or null. Years are normalised from 2-digit form
// (5/12/26 → 2026) since LinkedIn always uses M/D/YY where YY is 21st-c.
function extractPostedOnFromSubject(subject: string): string | null {
  const m = subject.match(/posted\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// emailDate is the YYYY-MM-DD the LinkedIn alert email actually
// arrived (from Gmail's internalDate). This is what each job's
// `postedAt` defaults to when we can't parse a more specific
// "posted on …" date out of the subject — the alert is sent very
// close to when LinkedIn surfaces a job, so this matches the user's
// "Posted Date should be when the job was posted" expectation far
// better than today's-date.
function parseLinkedInAlertEmail(
  html: string,
  emailSubject: string,
  emailDate: string,
): ParsedJob[] {
  // Subject-derived posted date applies only to this email's batch of
  // jobs (LinkedIn puts a single date in the subject even for digest
  // emails — it represents when the job was published, not each one).
  const subjectPostedAt = extractPostedOnFromSubject(emailSubject);
  const defaultPostedAt = subjectPostedAt || emailDate;

  // ── Drop LinkedIn's "Jobs similar to…" recommendation section ───────────
  // A LinkedIn alert email is laid out as:
  //   [your matched jobs]  →  ["Jobs similar to…" recommendations]  →  [footer]
  // Only the FIRST block is the user's actual alert. The recommendation
  // block lists loosely-related jobs LinkedIn pads the digest with (e.g.
  // India-remote roles surfacing inside a "USA,UK" alert). Cut the HTML at
  // the first recommendation heading so NEITHER parser path sees those cards.
  //
  // Safety — the cut is honoured ONLY when the kept portion still contains a
  // real /jobs/view/{id} anchor. If no marker is found, or the marker fired
  // before any job, the FULL HTML is parsed exactly as before — so a normal
  // alert with no recs block is completely unaffected.
  const RECS_MARKER_RE =
    /jobs?\s+similar\s+to|more\s+jobs\s+for\s+you|jobs?\s+you\s+(?:may|might)\s+be\s+interested|recommended\s+for\s+you/i;
  let workingHtml = html;
  const recsMatch = html.match(RECS_MARKER_RE);
  if (recsMatch && typeof recsMatch.index === "number") {
    const mainListHtml = html.slice(0, recsMatch.index);
    if (/linkedin\.com\/(?:comm\/)?jobs\/view\/\d+/.test(mainListHtml)) {
      workingHtml = mainListHtml;
      console.log(
        `[gmail-parser] recs block cut at "${recsMatch[0].trim()}" — ` +
          `main alert list only (${mainListHtml.length}/${html.length} chars kept)`
      );
    }
  }

  const $ = cheerio.load(workingHtml);
  // Strip <style>, <script>, <noscript> BEFORE any .text() extraction.
  // Without this, font-family declarations like
  //   font-family: -apple-system, Roboto, Ubuntu, Oxygen, ...
  // leak into emailBodyText and the location regex matches "Ubuntu, Oxygen"
  // as if it were a "City, Country" pair — producing "Ubuntu, Oxygen"
  // as the location for every job in the digest.
  $("style, script, noscript").remove();
  const jobs: ParsedJob[] = [];
  const seenJobIds = new Set<string>();

  // ══════════════════════════════════════════════════════════════════
  // PRIMARY PATH — <p>-tag based extraction.
  //
  // LinkedIn alert email cards (including the ones inside "Jobs similar
  // to …" sections) consistently use this layout:
  //
  //   <a href="…/jobs/view/{id}">           ← title anchor
  //     <strong>AI Developer</strong>
  //   </a>
  //   <p style="…">                          ← THIS paragraph
  //     Numeric Technologies · India (Remote)
  //   </p>
  //
  // The <p> is the most reliable signal because:
  //   • Exactly one per job card (no walking-up ambiguity).
  //   • Always contains the "Company · Location" middle-dot pattern.
  //   • Works equally well for digest emails, single-job notifications,
  //     and the "Jobs similar to …" recommendation blocks — every job
  //     card in every section uses the same <p>.
  //
  // For each qualifying <p> we walk UP to find the nearest container
  // that holds a /jobs/view/{id} anchor (the title link) and use that
  // anchor's id + text. This handles the "Jobs similar to …" blocks
  // because each card inside the block has its OWN <p>, so we treat
  // each as its own job rather than collapsing them under the block's
  // section header.
  // ══════════════════════════════════════════════════════════════════
  $("p").each((_, pEl) => {
    const $p = $(pEl);
    const pText = $p.text().trim().replace(/\s+/g, " ");

    // Must look like "<Company> · <Location[ (Remote)]>" — middle-dot or bullet.
    if (!/.+\s[·•]\s.+/.test(pText)) return;
    // Reasonable card-line length. Anything longer is probably wrapping
    // multiple cards or a body paragraph.
    if (pText.length < 5 || pText.length > 200) return;
    // Skip obvious non-card paragraphs (alert footer prose, CTAs).
    if (/your\s+(job|alert)|job\s+alert|click\s+here|view\s+all|manage\s+alert|unsubscribe|preferences/i.test(pText)) return;

    // Find the closest preceding job-view anchor for THIS <p>.
    //
    // We can't just take .find().first() on the nearest container — when
    // a single container holds many job cards (e.g. "Jobs similar to …"
    // sections list 5 cards flat in one <div>), .first() would always
    // return the first card's anchor for every <p>. Instead walk back
    // through previous siblings at each level, moving up only when the
    // current level is exhausted. This finds the CLOSEST anchor in
    // document order — i.e. the title that visually sits right above
    // this <p>.
    const ANCHOR_HREF_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/\d+/;
    let $titleA: ReturnType<typeof $> | null = null;
    let $cursor = $p;
    for (let depth = 0; depth < 10 && $cursor.length && !$titleA; depth++) {
      let $sib = $cursor.prev();
      while ($sib.length && !$titleA) {
        // The sibling itself might be the anchor.
        if ($sib.is("a")) {
          const h = $sib.attr("href") || "";
          if (ANCHOR_HREF_RE.test(h)) {
            $titleA = $sib;
            break;
          }
        }
        // Or contain it (e.g. <td><a>…</a></td>). Pick the LAST matching
        // descendant — closest in document order to our <p>.
        const $within = $sib.find("a").filter((__, aEl) => {
          const h = $(aEl).attr("href") || "";
          return ANCHOR_HREF_RE.test(h);
        });
        if ($within.length > 0) {
          $titleA = $within.last();
          break;
        }
        $sib = $sib.prev();
      }
      if (!$titleA) $cursor = $cursor.parent();
    }
    // Whole-card anchor fallback — some templates wrap the entire card
    // (including this <p>) in a single <a>. In that case there's no
    // preceding sibling anchor; the title anchor is the <p>'s ancestor.
    if (!$titleA) {
      const $closestA = $p.closest("a");
      if ($closestA.length) {
        const h = $closestA.attr("href") || "";
        if (ANCHOR_HREF_RE.test(h)) $titleA = $closestA;
      }
    }
    if (!$titleA || !$titleA.length) return;

    const href = ($titleA.attr("href") || "").replace(/&amp;/g, "&");
    const idMatch = href.match(/\/jobs\/view\/(\d+)/);
    if (!idMatch) return;
    const jobId = idMatch[1];
    if (seenJobIds.has(jobId)) return;

    // Title — prefer inner <strong>/<b>, fall back to anchor's own text.
    let title = "";
    const $strong = $titleA.find("strong, b").first();
    if ($strong.length) {
      const inner = $strong.text().trim().replace(/\s+/g, " ");
      if (inner && !isNonJobText(inner)) title = inner;
    }
    if (!title) {
      const full = $titleA.text().trim().replace(/\s+/g, " ");
      if (full && !isNonJobText(full) && full.length <= 150) title = full;
    }
    if (!title) return;
    title = title.replace(/^["'""'']+/, "").replace(/["'""'']+$/, "").trim();
    if (title.length < 3) return;

    // Split the <p> on the first middle-dot — left = company, right = location.
    const split = pText.match(/^(.+?)\s+[·•]\s+(.+)$/);
    if (!split) return;
    const company = split[1].trim();
    let location = stripCtaBadges(split[2].trim()) || "N/A";
    if (company.length < 2 || company.length > 100) return;
    if (location.length > 100) location = location.substring(0, 100).trim();

    // Job type — derive from location string + paragraph context.
    let jobType = "N/A";
    const ctx = `${location} ${pText}`.toLowerCase();
    if (ctx.includes("full-time") || ctx.includes("full time")) jobType = "Full-time";
    else if (ctx.includes("part-time") || ctx.includes("part time")) jobType = "Part-time";
    else if (ctx.includes("contract")) jobType = "Contract";
    else if (ctx.includes("internship")) jobType = "Internship";
    if (/\bremote\b/.test(ctx)) jobType = jobType === "N/A" ? "Remote" : `${jobType} · Remote`;
    else if (/\bhybrid\b/.test(ctx)) jobType = jobType === "N/A" ? "Hybrid" : `${jobType} · Hybrid`;
    else if (/\bon-?site\b/.test(ctx)) jobType = jobType === "N/A" ? "On-site" : `${jobType} · On-site`;

    // Skills inferred from the title only — the <p> body rarely has
    // technical keywords, but titles like "Node.js Backend Engineer"
    // and "React Frontend Developer" do.
    seenJobIds.add(jobId);
    jobs.push({
      title,
      jobId,
      company,
      email: "N/A",
      location,
      jobType,
      description: `${title} at ${company}`,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      postedAt: defaultPostedAt,
      platform: "LinkedIn (Gmail Alert)",
    });
  });

  if (jobs.length > 0) {
    console.log(`[gmail-parser] <p>-based primary path extracted ${jobs.length} jobs`);
  }

  // ══════════════════════════════════════════════════════════════════
  // FALLBACK PATH — anchor-loop extraction (for older / non-standard
  // email templates that don't follow the <p>Company · Location</p>
  // convention). Pre-seeded `seenJobIds` from the primary path makes
  // this loop naturally skip jobs we've already captured.
  // ══════════════════════════════════════════════════════════════════

  // Collect all LinkedIn anchors (any jobs URL pattern)
  const allAnchors = $("a").filter((_, el) => {
    const href = $(el).attr("href") || "";
    return /linkedin\.com\/(?:comm\/)?jobs\/view\/\d+/.test(href) ||
           /linkedin\.com.*[?&]currentJobId=\d+/.test(href);
  }).toArray();

  console.log(`[gmail-parser] Found ${allAnchors.length} LinkedIn job anchors`);

  // Is this a digest email (multiple jobs)? Skip subject fallback for digest emails
  // because subject usually just has recruiter/sender name, not per-job company
  const isDigest = allAnchors.length > 1;

  // Track every jobId we observe in this email — even ones whose anchor-side metadata
  // extraction fails. The subject fallback below will then build a real
  // /jobs/view/{jobId}/ URL instead of a useless search URL, so the auto description
  // fetcher can hit the actual job page.
  const observedJobIds: string[] = [];

  // Whole-email body text — used as a location fallback because LinkedIn alerts
  // often print "A new job in Mohali district matches your preferences." OUTSIDE
  // the per-job card, in the email header. Per-job parent text won't see it.
  const emailBodyText = $.root().text().replace(/\s+/g, " ").trim();

  allAnchors.forEach((el) => {
    const $a = $(el);
    const href = ($a.attr("href") || "").replace(/&amp;/g, "&");

    // Extract jobId from any URL pattern
    let idMatch = href.match(/\/jobs\/view\/(\d+)/);
    if (!idMatch) idMatch = href.match(/[?&]currentJobId=(\d+)/);
    if (!idMatch) return;

    const jobId = idMatch[1];
    if (seenJobIds.has(jobId)) return;
    seenJobIds.add(jobId);
    if (!observedJobIds.includes(jobId)) observedJobIds.push(jobId);

    // Title extraction — LinkedIn alert email cards look like:
    //
    //   ▮ [bold/larger]      ← TITLE   (lives inside <strong> or <b>)
    //     Company · Location ← company before the "·" middle dot
    //     [Easy Apply]       ← CTA badge, NOT location
    //
    // Prefer the inner <strong>/<b> first because newer LinkedIn templates
    // wrap the WHOLE card in a single <a>, making $a.text() return
    // title+company+location+badge concatenated. The first <strong>/<b> is
    // reliably just the job title.
    // NON_JOB_TITLE_RE and isNonJobText are hoisted to module scope so the
    // <p>-based primary path can share them.

    let title = "";
    // Pass 1: inner <strong>/<b> — most reliable for the bold title text.
    const $titleEl = $a.find("strong, b").first();
    if ($titleEl.length) {
      const innerText = $titleEl.text().trim().replace(/\s+/g, " ");
      if (innerText && innerText.length >= 3 && !isNonJobText(innerText)) {
        title = innerText;
      }
    }
    // Pass 2: anchor's own text — fine for older templates where the <a>
    // wraps only the title. Skip if it looks like a CTA/alert wrapper, or
    // if it's suspiciously long (likely the whole card concatenated and
    // we'll fail to slice it cleanly later anyway).
    if (!title) {
      const fullText = $a.text().trim().replace(/\s+/g, " ");
      if (fullText && !isNonJobText(fullText) && fullText.length <= 150) {
        title = fullText;
      }
    }
    if (!title) return;

    // Strip stray leading/trailing quotes (LinkedIn sometimes wraps query
    // echoes in straight or curly quotes — "node.js remote jobs").
    title = title.replace(/^["'""'']+/, "").replace(/["'""'']+$/, "").trim();
    if (title.length < 3) return;

    // Find the JOB CARD container — go up until we find a block that has enough content
    // LinkedIn emails use deeply nested tables, we need to find the outer container
    let $parent = $a.closest("td").first();
    // Go up one level if td only has title (company is in sibling td/tr)
    for (let i = 0; i < 6; i++) {
      const text = $parent.text().replace(/\s+/g, " ").trim();
      if (text.length >= 50 && text.length < 3000) break;
      const $up = $parent.parent();
      if (!$up.length) break;
      $parent = $up;
    }

    const parentText = $parent.text().replace(/\s+/g, " ").trim();

    // ──────────────────────────────────────────────────────────────────
    // PRIMARY: dot-split on the line that follows the title.
    //
    // LinkedIn alert email cards uniformly format the second line as
    //   `<Company> · <Location>`
    // with the U+00B7 middle dot (occasionally a bullet U+2022). The
    // title appears on the preceding line. Slice parentText starting
    // AFTER the title and split on the first dot — left side is company,
    // right side is location (minus any trailing "Easy Apply" CTA).
    //
    // If this works we'll skip the older regex/img-alt/slug strategies
    // entirely — they exist as a safety net for non-standard cards.
    // ──────────────────────────────────────────────────────────────────
    let dotCompany = "";
    let dotLocation = "";
    {
      const tIdx = parentText.toLowerCase().indexOf(title.toLowerCase());
      if (tIdx >= 0) {
        let afterTitle = parentText.substring(tIdx + title.length);
        // Strip leading separators / "at " connector that LinkedIn sometimes
        // injects between title and company.
        afterTitle = afterTitle
          .replace(/^[\s·•|\-—,]+/, "")
          .replace(/^at\s+/i, "")
          .trim();
        // Match "<Company> · <Location-and-maybe-CTA>"
        const m = afterTitle.match(/^(.+?)\s+[·•]\s+(.+)$/);
        if (m) {
          const c = m[1].trim();
          let loc = m[2].trim();
          // Strip trailing CTA badges that LinkedIn appends inside the
          // card: "Easy Apply", "Actively recruiting", "Promoted",
          // "Reposted", "View job", "Apply now", "See job".
          loc = loc
            .replace(
              /\s*(?:[·•|]\s*)?(?:easy\s*apply|actively\s*recruiting|promoted|reposted|view\s+job|apply\s+now|see\s+job|featured|new)\b.*$/gi,
              ""
            )
            .replace(/[·•|,\s]+$/, "")
            .trim();
          if (c.length >= 2 && c.length <= 100) dotCompany = c;
          if (loc.length >= 2 && loc.length <= 100) dotLocation = loc;
        }
      }
    }

    // Extract company — multiple strategies
    let company = dotCompany;

    // Strategy 1: Look for <a href="/company/..."> link in parent or siblings
    $parent.find("a[href*='/company/']").each((__, cEl) => {
      if (company) return;
      const text = $(cEl).text().trim().replace(/\s+/g, " ");
      if (text && text.length >= 2 && text.length <= 80 &&
          !/^(view|see|apply|learn|click)/i.test(text)) {
        company = text;
      }
    });

    // Strategy 1-img: Check img alt attributes (LinkedIn often has logo with alt="CompanyName logo")
    if (!company) {
      $parent.find("img").each((__, imgEl) => {
        if (company) return;
        const alt = $(imgEl).attr("alt") || "";
        // Alt like "CompanyName logo" or just "CompanyName"
        const altMatch = alt.match(/^(.+?)\s*(?:logo|icon)?$/i);
        if (altMatch) {
          const candidate = altMatch[1].trim();
          if (candidate.length >= 2 && candidate.length <= 80 &&
              !/^(linkedin|applicant|candidate|user|image|photo|icon|background)/i.test(candidate)) {
            company = candidate;
          }
        }
      });
    }

    // Strategy 1b: company URL slug
    if (!company) {
      $parent.find("a[href*='/company/']").each((__, cEl) => {
        if (company) return;
        const companyHref = $(cEl).attr("href") || "";
        const slugMatch = companyHref.match(/\/company\/([a-z0-9-]+)/i);
        if (slugMatch) {
          const slug = slugMatch[1];
          company = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        }
      });
    }

    // Strategy 2: Text between title and location in parent
    if (!company && title) {
      const titleIdx = parentText.toLowerCase().indexOf(title.toLowerCase().substring(0, Math.min(title.length, 25)));
      if (titleIdx !== -1) {
        const after = parentText.substring(titleIdx + title.length).trim();
        // Match: "Company · Location" or "Company Location"
        const dotMatch = after.match(/^([A-Z][A-Za-z0-9&.,\-'\s]{1,60}?)\s*[·•]\s*/);
        if (dotMatch) company = dotMatch[1].trim();
        else {
          // Match: first 2-4 words that start with capital (likely company name)
          const words = after.split(/\s+/).slice(0, 5);
          const companyMatch = words.join(" ").match(/^([A-Z][A-Za-z0-9&.,'\-]+(?:\s+[A-Z][A-Za-z0-9&.,'\-]+){0,3})/);
          if (companyMatch) company = companyMatch[1].trim();
        }
      }
    }

    // Strategy 3: Look for "at CompanyName" in parent text
    if (!company) {
      const atMatch = parentText.match(/\s+at\s+([A-Z][A-Za-z0-9&.,\-'\s]{1,60}?)(?:\s*[·•,]|\s+is\s+|\s+\d|\s*$)/);
      if (atMatch) company = atMatch[1].trim();
    }

    // Strategy 3b: Check NEXT td/tr siblings of the anchor's td
    // LinkedIn emails often have: <td>Title</td> <td>Company</td> or
    // <tr><td>Title</td></tr> <tr><td>Company</td></tr>
    if (!company) {
      const $anchorTd = $a.closest("td").first();
      if ($anchorTd.length) {
        // Try next td in same tr
        const $nextTd = $anchorTd.next("td");
        if ($nextTd.length) {
          const text = $nextTd.text().trim().replace(/\s+/g, " ");
          if (text && text.length >= 2 && text.length <= 80 &&
              /^[A-Z]/.test(text) &&
              !/^(view|see|apply|learn|click|posted|location|remote|hybrid|on-site|[\d])/i.test(text)) {
            company = text;
          }
        }
      }
      // Try next tr
      if (!company) {
        const $anchorTr = $a.closest("tr").first();
        if ($anchorTr.length) {
          const $nextTr = $anchorTr.next("tr");
          if ($nextTr.length) {
            const text = $nextTr.text().trim().replace(/\s+/g, " ");
            if (text && text.length >= 2 && text.length <= 80 &&
                /^[A-Z]/.test(text) &&
                !/^(view|see|apply|learn|click|posted|location|remote|hybrid|on-site|[\d])/i.test(text)) {
              company = text;
            }
          }
        }
      }
    }

    // Strategy 4: Subject pattern extraction — ONLY for single-job emails
    // For digest emails, subject has recruiter/sender name, not per-job company
    if (!company && emailSubject && !isDigest) {
      // "keyword jobs in X": Company - Title posted on date
      const subjDigest = emailSubject.match(/[""`'"][^""`'"]+[""`'"]:\s*([^-—]+?)\s*[-—]/);
      if (subjDigest) company = subjDigest[1].trim();

      if (!company) {
        const subjAt = emailSubject.match(/\s+at\s+([^-—|]{2,60}?)(?:\s*[-—|]|$)/i);
        if (subjAt) company = subjAt[1].trim();
      }

      if (!company) {
        const subjHiring = emailSubject.match(/^([^-—:|]+?)\s+is\s+hiring/i);
        if (subjHiring) company = subjHiring[1].trim();
      }
    }

    // Strategy 5: Extract from URL slug pattern "/jobs/view/123-job-name-at-company-name"
    if (!company) {
      const slugMatch = href.match(/\/jobs\/view\/\d+-[\w-]+?-at-([\w-]+)/i);
      if (slugMatch) {
        company = slugMatch[1].split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
    }

    // Final fallback: use "Unknown Company" rather than N/A so user can manually edit
    if (!company) company = "Unknown";

    // ── Title cleanup ───────────────────────────────────────────────
    // Newer LinkedIn alert emails wrap the WHOLE card in a single anchor
    // (card-spanning click target). $a.text() then returns the title +
    // company + location + CTA badge all concatenated, e.g.:
    //   "GenAI Python Developer Durapid Technologies Private Limited
    //    · India (Remote) Easy Apply"
    // Once company is known, slice the title at the company-name boundary
    // to recover the clean job title ("GenAI Python Developer").
    if (
      company &&
      company !== "Unknown" &&
      company.length >= 3 &&
      title.length > company.length + 5
    ) {
      const lowerTitle = title.toLowerCase();
      const lowerCompany = company.toLowerCase();
      const idx = lowerTitle.indexOf(lowerCompany);
      if (idx > 0) {
        // Trim everything from the company name onwards. Also strip
        // trailing connector words ("at", "·", "•", "|", "-") plus any
        // trailing whitespace/punctuation.
        const beforeCompany = title.substring(0, idx).trim();
        const cleaned = beforeCompany
          .replace(/\s+(at|·|•|\||-|—)\s*$/, "")
          .replace(/[\s·•|—-]+$/, "")
          .trim();
        if (cleaned.length >= 3) {
          title = cleaned;
        }
      }
    }
    // Also strip trailing "Easy Apply" / "Actively recruiting" CTA badges
    // that LinkedIn appends inside the card-spanning anchor.
    title = title
      .replace(/\s*(?:·\s*)?(?:easy\s*apply|actively\s*recruiting|view\s+job|apply\s+now)\s*$/i, "")
      .trim();
    if (title.length < 3) return;

    // Extract location.
    //
    // PRIMARY: dotLocation (from the "Company · Location" split at the
    // top of this function). This is the most reliable source because
    // it matches the literal layout LinkedIn uses in every alert card —
    // "<Company> · <Location>" on the line below the bold title.
    //
    // Fallback strategies below only run when the dot-split missed (rare,
    // for non-standard cards). They have to be careful:
    // only the per-job `parentText` is fully trustworthy for per-row
    // location. The full `emailBodyText` contains LinkedIn's footer block
    // ("1000 W Maude Avenue, Sunnyvale, CA") and nav text ("Home | Search
    // | Discovery | ...") that the generic "City, Country" regex happily
    // mis-matches as a location. So:
    //   • Strategies that rely on regex-match-anywhere → parentText ONLY.
    //   • Strategies that rely on contextual phrases (e.g. "A new job in
    //     Mohali matches…") → subject + a TRUNCATED body where the
    //     footer is removed.
    let location = dotLocation || "N/A";

    // Cut emailBodyText at the LinkedIn footer marker so its remaining
    // half (top of email — header copy like "A new job in Mohali matches
    // your alert") can still feed contextual strategies safely.
    const footerCutRe =
      /\b(?:you are receiving|this email was|update your (?:email\s+)?preferences|unsubscribe|linkedin\s+corporation|linkedin\s+ireland|©\s*\d{4}\s*linkedin|1000\s+w\s+maude|sunnyvale,?\s*ca)\b/i;
    const footerMatch = emailBodyText.match(footerCutRe);
    const safeEmailBody = footerMatch
      ? emailBodyText.substring(0, footerMatch.index ?? emailBodyText.length)
      : emailBodyText;

    // Strategy 1: LinkedIn "Country (Remote)" / "City (Hybrid)" — most
    // specific, runs first so "India (Remote)" / "Sahibzada Ajit Singh
    // Nagar (Hybrid)" preserve country/city + work-type together.
    {
      const m = parentText.match(
        /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,4})\s*\((Remote|Hybrid|On-?site)\)/
      );
      if (m) {
        location = `${m[1].trim()} (${m[2]})`;
      }
    }

    // Strategy 2: "City, State/Country" pattern — PARENT TEXT ONLY.
    // Scanning emailBodyText here was the source of the "Maude Avenue,
    // Sunnyvale" / "Search, Discovery" leak.
    if (location === "N/A") {
      const m = parentText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      if (m) location = m[0].trim();
    }

    // Strategy 3: well-known major cities — checked in parentText first,
    // then emailSubject + footer-truncated body so header phrasings like
    // "A new job in Mohali district matches your preferences" still work.
    if (location === "N/A") {
      const knownCities = [
        // India
        "Bangalore", "Bengaluru", "Mumbai", "Delhi", "Pune", "Hyderabad", "Chennai",
        "Kolkata", "Ahmedabad", "Jaipur", "Lucknow", "Kanpur", "Nagpur", "Indore",
        "Sahibzada Ajit Singh Nagar", "SAS Nagar", "Mohali", "Chandigarh",
        "Gurgaon", "Gurugram", "Noida", "Faridabad", "Panchkula", "Zirakpur",
        "Coimbatore", "Kochi", "Thiruvananthapuram", "Bhubaneswar", "Visakhapatnam",
        // UK
        "London", "Manchester", "Birmingham", "Glasgow", "Edinburgh", "Bristol", "Leeds",
        // US
        "New York", "San Francisco", "Los Angeles", "Chicago", "Boston", "Seattle",
        "Austin", "Denver", "Atlanta", "Miami", "Phoenix", "Dallas", "Houston",
        // Other
        "Toronto", "Vancouver", "Montreal", "Sydney", "Melbourne", "Berlin", "Paris",
        "Dubai", "Singapore", "Tokyo", "Beijing", "Shanghai", "Hong Kong", "Amsterdam",
      ];
      // Try parentText first — most specific.
      for (const city of knownCities) {
        const re = new RegExp(`\\b${city}\\b`, "i");
        if (re.test(parentText)) {
          location = city;
          break;
        }
      }
      // Then subject + safe body — for header copy outside per-job cards.
      if (location === "N/A") {
        for (const city of knownCities) {
          const re = new RegExp(`\\b${city}\\b`, "i");
          if (re.test(emailSubject) || re.test(safeEmailBody)) {
            location = city;
            break;
          }
        }
      }
    }

    // Strategy 4: "A new job in {Location} matches…" / "job in {Location}"
    // — contextual phrase, runs on subject + safe body.
    if (location === "N/A") {
      const re = /(?:new\s+job|jobs?|opening|opportunity|position|role|hiring)\s+in\s+([A-Z][\w\s,.-]{2,40}?)(?:\s+match|\s+area|\s+region|\s+for\s|\s*[\.\,\:\|\(\)]|$)/i;
      for (const src of [parentText, emailSubject, safeEmailBody]) {
        const m = src.match(re);
        if (m) {
          location = m[1].trim();
          break;
        }
      }
    }

    // Strategy 5: bare Remote / Hybrid / On-site fallback. Prefer
    // parentText so a job-card "Remote" beats whichever Remote pops up
    // in the boilerplate body.
    if (location === "N/A") {
      const probe = parentText || emailSubject;
      if (/\bremote\b/i.test(probe)) location = "Remote";
      else if (/\bhybrid\b/i.test(probe)) location = "Hybrid";
      else if (/\bon-?site\b/i.test(probe)) location = "On-site";
    }

    // Job type
    let jobType = "N/A";
    const ptl = parentText.toLowerCase();
    if (ptl.includes("full-time") || ptl.includes("full time")) jobType = "Full-time";
    else if (ptl.includes("part-time") || ptl.includes("part time")) jobType = "Part-time";
    else if (ptl.includes("contract")) jobType = "Contract";
    else if (ptl.includes("internship")) jobType = "Internship";
    if (ptl.includes("remote")) jobType = jobType === "N/A" ? "Remote" : `${jobType} · Remote`;
    else if (ptl.includes("hybrid")) jobType = jobType === "N/A" ? "Hybrid" : `${jobType} · Hybrid`;

    // Build clean LinkedIn job URL
    const cleanUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

    jobs.push({
      title,
      jobId,
      company,
      email: "N/A",
      location,
      jobType,
      description: `${title}${company !== "N/A" ? " at " + company : ""}`,
      url: cleanUrl,
      postedAt: defaultPostedAt,
      platform: "LinkedIn (Gmail Alert)",
    });
  });

  // If still nothing from HTML, fallback to subject parsing.
  // IMPORTANT: only fall back when the email truly had ZERO job anchors.
  // If anchors existed but extraction yielded nothing (e.g. all anchors were
  // header/CTA wrappers like "Manage alerts" or "Your job alert for ..."),
  // the subject is almost always a query echo (e.g. `"node.js remote jobs
  // at USA,UK": Sundayy`) that the regex below will mangle into a garbage
  // title/company pair. Better to return empty and let the next email's
  // parse cycle (or the daily cron) try again with cleaner data.
  if (jobs.length === 0 && allAnchors.length === 0) {
    // Try subject patterns
    let title = "";
    let company = "N/A";

    const patternA = emailSubject.match(/[""`'"][^""`'"]+[""`'"]:\s*([^-—]+?)\s*[-—]\s*(.+?)\s+posted\s+on/i);
    if (patternA) {
      company = patternA[1].trim();
      title = patternA[2].trim();
    }

    if (!title) {
      const patternB = emailSubject.match(/^([^:]+?)\s+at\s+([^-—|]+)/i);
      if (patternB) {
        title = patternB[1].trim();
        company = patternB[2].trim();
      }
    }

    // Reject subject-derived titles that are clearly alert queries, not
    // real job postings. A LinkedIn alert email subject like
    //   Your job alert for "node.js remote jobs at USA,UK"
    // would otherwise produce title=`"node.js remote jobs` which is garbage.
    if (title && /^(your job|job alert|"|')/i.test(title)) {
      title = "";
    }
    // Strip stray quotes around the title (mirror of anchor-side cleanup).
    if (title) {
      title = title.replace(/^["'""'']+/, "").replace(/["'""'']+$/, "").trim();
    }

    if (title) {
      // Prefer a real /jobs/view/{id}/ URL — observedJobIds collected one even if
      // anchor-side title/company extraction failed. Falls back to a search URL only
      // when the email truly had zero job-view anchors (rare).
      const realJobId = observedJobIds[0];
      const fallbackUrl = realJobId
        ? `https://www.linkedin.com/jobs/view/${realJobId}/`
        : `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(title)}`;
      jobs.push({
        title,
        jobId: realJobId || `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        company,
        email: "N/A",
        location: "N/A",
        jobType: "N/A",
        description: `${title} at ${company}`,
        url: fallbackUrl,
        postedAt: defaultPostedAt,
        platform: "LinkedIn (Gmail Alert)",
      });
    }
  }

  // Diagnostic — surfaces silent-failure cases where anchors were found but
  // extraction produced nothing (the symptom that caused the "node.js remote
  // jobs at USA,UK" garbage row). Without this, you can't tell from the
  // logs whether the email had zero jobs or zero parseable jobs.
  if (allAnchors.length > 0 && jobs.length === 0) {
    console.warn(
      `[gmail-parser] ⚠ Found ${allAnchors.length} LinkedIn anchors but extracted 0 jobs — ` +
        `all anchors looked like alert wrappers / CTAs. Subject: "${emailSubject}"`
    );
  }
  console.log(
    `[gmail-parser] Extracted ${jobs.length} jobs from email (anchors=${allAnchors.length}, subject="${emailSubject.slice(0, 80)}")`
  );
  return jobs;
}

// Per-inbox parse — pulled out so the multi-account POST handler can call it
// once per connected Gmail. Returns the deduplicated (within this inbox only)
// job list plus the per-inbox counters that used to live inline.
//
// The inbox-level seen-set is NOT shared with sibling inboxes — that
// cross-account dedup happens in the POST handler after this returns, so the
// per-account `parsed` count here is faithful to what that inbox saw.
async function parseAlertsFromInbox(
  gmail: ReturnType<typeof google.gmail>,
  opts: {
    maxEmails: number;
    targetIST: string;
    accountTag: string;
  }
): Promise<{
  jobs: ParsedJob[];
  emailsFetched: number;
  emailsInWindow: number;
  emailsSkippedOld: number;
}> {
  const { maxEmails, targetIST, accountTag } = opts;

  // Bracket the target IST day AND the one before it for Gmail's date filter.
  // Two days rather than one because LinkedIn alerts for a given day keep
  // trickling in overnight, and a cron run that fails/skips would otherwise
  // lose that day's alerts permanently. Re-seeing yesterday's emails is free —
  // jobId dedupe (both in-run and against the DB) drops the repeats.
  //
  // We pass the boundaries as Unix EPOCH SECONDS, not YYYY/MM/DD strings: Gmail's
  // `after:`/`before:` date-string operators are interpreted in the ACCOUNT's
  // configured timezone (often US Pacific here), so an IST-built date boundary
  // silently shifted the window by ~a day and dropped early-IST alerts. Epoch
  // seconds are an absolute instant — no timezone reinterpretation — and they
  // line up exactly with the IST `internalDate` check below.
  //
  // `after:` is INCLUSIVE, `before:` is EXCLUSIVE, so [start-24h, start+24h)
  // == exactly the previous + target IST calendar days. IST midnight in UTC =
  // the day's UTC midnight minus the +5:30 offset.
  const prevIST = istPreviousDay(targetIST);
  const istMidnightMs = istMidnightMsFor(targetIST);
  const afterSec = Math.floor((istMidnightMs - 24 * 60 * 60 * 1000) / 1000);
  const beforeSec = Math.floor((istMidnightMs + 24 * 60 * 60 * 1000) / 1000);

  // Catch every LinkedIn alert email that arrived on the target day. We
  // intentionally don't narrow on subject — alert digests and single-job
  // notifications use different subject patterns. The HTML parser at
  // parseLinkedInAlertEmail() discards emails with zero /jobs/view/{id}
  // anchors, so non-alert LinkedIn mail (connections, news) costs
  // nothing to inspect.
  const query = `from:linkedin.com after:${afterSec} before:${beforeSec}`;
  console.log(`${accountTag} Search query: ${query} (maxResults=${maxEmails})`);

  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: maxEmails,
  });

  const messages = res.data.messages || [];
  console.log(
    `${accountTag} Found ${messages.length} LinkedIn emails for IST days ${prevIST}..${targetIST}`
  );

  const jobs: ParsedJob[] = [];
  const seen = new Set<string>();
  let emailsInWindow = 0;
  let emailsSkippedOld = 0;
  let emailIndex = 0;

  if (messages.length === 0) {
    return {
      jobs,
      emailsFetched: 0,
      emailsInWindow,
      emailsSkippedOld,
    };
  }

  for (const msg of messages) {
    try {
      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "full",
      });

      let htmlBody = "";
      const parts = email.data.payload?.parts || [];

      if (parts.length > 0) {
        for (const part of parts) {
          if (part.mimeType === "text/html" && part.body?.data) {
            htmlBody = decodeBase64(part.body.data);
            break;
          }
          if (part.parts) {
            for (const subPart of part.parts) {
              if (subPart.mimeType === "text/html" && subPart.body?.data) {
                htmlBody = decodeBase64(subPart.body.data);
                break;
              }
            }
            if (htmlBody) break;
          }
        }
      } else if (email.data.payload?.body?.data) {
        htmlBody = decodeBase64(email.data.payload.body.data);
      }

      if (!htmlBody) continue;

      const headers = email.data.payload?.headers || [];
      const subjectHeader = headers.find((h) => h.name?.toLowerCase() === "subject");
      const emailSubject = subjectHeader?.value || "";

      const internalMs = email.data.internalDate
        ? Number(email.data.internalDate)
        : NaN;
      const arrivedAt = !isNaN(internalMs) ? new Date(internalMs) : new Date();
      const emailDate = toISTDateString(arrivedAt);

      emailIndex++;
      const tag = `${accountTag} [${emailIndex}/${messages.length}]`;

      if (emailDate !== targetIST && emailDate !== prevIST) {
        emailsSkippedOld++;
        console.log(
          `${tag} ⏭ SKIP — arrived ${emailDate} (window ${prevIST}..${targetIST}) — "${emailSubject.slice(0, 70)}"`
        );
        continue;
      }
      emailsInWindow++;
      console.log(
        `${tag} ✓ arrived ${emailDate} — parsing "${emailSubject.slice(0, 70)}"`
      );

      const parsedJobs = parseLinkedInAlertEmail(htmlBody, emailSubject, emailDate);
      const remoteJobs = parsedJobs.filter(isRemoteJob);
      const nonRemoteDropped = parsedJobs.length - remoteJobs.length;
      let addedFromThisEmail = 0;
      for (const job of remoteJobs) {
        if (!seen.has(job.jobId)) {
          seen.add(job.jobId);
          jobs.push(job);
          addedFromThisEmail++;
        }
      }
      console.log(
        `${tag}   → ${parsedJobs.length} parsed, ${nonRemoteDropped} non-remote dropped, ` +
          `${addedFromThisEmail} new (after dedupe)`
      );
    } catch (err) {
      console.warn(`${accountTag} Failed to parse email ${msg.id}:`, err);
    }
  }

  return {
    jobs,
    emailsFetched: messages.length,
    emailsInWindow,
    emailsSkippedOld,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Default raised to 100 so the parser sees EVERY LinkedIn alert that
    // landed in the "yesterday → now" window — not just the newest 15.
    //
    // `saveToDb` controls whether parsed jobs are auto-persisted to jobs_v2.
    // Defaults to true so the existing cron + Auto-Scrape paths keep their
    // set-and-forget behaviour. The Run Scrape Now button on the dashboard
    // sends `false`, so a manual run returns the jobs without writing them
    // — the user then decides per-row (Save) or in bulk (Save All) what
    // actually lands in the DB via /api/jobs/save.
    const {
      maxEmails = 100,
      date: dateInput,
      saveToDb = true,
    } = await req.json().catch(() => ({ maxEmails: 100 }));

    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const targetIST =
      typeof dateInput === "string" && ISO_DATE_RE.test(dateInput)
        ? dateInput
        : toISTDateString(new Date());
    // Scrape covers two IST days — the target and the one before it.
    const windowFromIST = istPreviousDay(targetIST);

    // ── Resolve which Gmail accounts to read from ─────────────────────────────
    // The dashboard's "Select Email" dropdown writes its choice into
    // settings.parse_gmail_selection. 'both' fans out across every connected
    // account; otherwise the named label is the only one read. If the user
    // hasn't set a value yet, 'both' is the safe default — the empty case
    // is handled by getReadClientsForSelection() returning [].
    const db = getSupabaseAdmin();
    const { data: settingsRow } = await db
      .from(TABLES.settings)
      .select("parse_gmail_selection")
      .eq("id", 1)
      .maybeSingle();
    const selection =
      (settingsRow?.parse_gmail_selection as string | null) ?? "both";

    const accounts: ReadAccount[] = await getReadClientsForSelection(selection);
    if (accounts.length === 0) {
      return NextResponse.json({
        success: false,
        error:
          `No Gmail account connected for selection '${selection}'. ` +
          `Open Dashboard → 'Gmails Connected' to connect at least one account.`,
        selection,
      });
    }
    console.log(
      `[gmail-parser] Selection='${selection}' → ${accounts.length} account(s): ` +
        accounts.map((a) => `${a.label}(${a.email})`).join(", ")
    );

    // ── Loop accounts, parse each inbox, dedup cross-account ──────────────────
    // The seen set is shared across all inboxes so the SAME LinkedIn job that
    // shows up in both Gmail accounts only counts once. First-seen wins and
    // gets the sourceGmail tag for downstream traceability.
    const allJobs: Array<ParsedJob & { sourceGmail?: string }> = [];
    const seenJobIds = new Set<string>();
    let totalEmailsFetched = 0;
    let totalEmailsInWindow = 0;
    let totalEmailsSkippedOld = 0;
    const perAccount: Record<
      string,
      {
        email: string;
        emailsFetched: number;
        emailsInWindow: number;
        emailsSkippedOld: number;
        parsed: number;
        unique: number;
        error?: string;
      }
    > = {};

    for (const account of accounts) {
      const accountTag = `[gmail-parser:${account.label}]`;
      try {
        const gmail = google.gmail({ version: "v1", auth: account.client });
        const result = await parseAlertsFromInbox(gmail, {
          maxEmails,
          targetIST,
          accountTag,
        });

        let unique = 0;
        for (const job of result.jobs) {
          if (seenJobIds.has(job.jobId)) continue;
          seenJobIds.add(job.jobId);
          (job as ParsedJob & { sourceGmail: string }).sourceGmail = account.email;
          allJobs.push(job);
          unique++;
        }

        totalEmailsFetched += result.emailsFetched;
        totalEmailsInWindow += result.emailsInWindow;
        totalEmailsSkippedOld += result.emailsSkippedOld;
        perAccount[account.label] = {
          email: account.email,
          emailsFetched: result.emailsFetched,
          emailsInWindow: result.emailsInWindow,
          emailsSkippedOld: result.emailsSkippedOld,
          parsed: result.jobs.length,
          unique,
        };

        // Best-effort: update per-account last_parsed_at + total counter.
        // Failures here shouldn't fail the whole parse (we still return jobs).
        try {
          await markParsed(account.label, unique);
        } catch (e) {
          console.warn(`${accountTag} markParsed failed:`, e);
        }
      } catch (err) {
        console.error(`${accountTag} parse failed:`, err);
        perAccount[account.label] = {
          email: account.email,
          emailsFetched: 0,
          emailsInWindow: 0,
          emailsSkippedOld: 0,
          parsed: 0,
          unique: 0,
          error: (err as Error).message,
        };
      }
    }

    console.log(
      `[gmail-parser] ════ COMBINED SUMMARY ════ accounts: ${accounts.length} · ` +
        `emails: ${totalEmailsFetched} fetched · ${totalEmailsInWindow} in-window · ` +
        `${totalEmailsSkippedOld} skipped(old) · jobs: ${allJobs.length} unique ` +
        `(window ${windowFromIST}..${targetIST})`
    );

    // Distinguish a genuinely-empty inbox from an inbox we couldn't read at
    // all. A revoked/expired Google refresh token surfaces as `invalid_grant`
    // (Gmail OAuth), which the per-account catch records in perAccount[].error.
    // Without this branch every auth failure was reported as "No LinkedIn
    // emails found… set up alerts first" — sending the user to fix alerts that
    // were never the problem. Surface a reconnect prompt instead.
    const erroredAccounts = Object.entries(perAccount).filter(
      ([, info]) => info.error
    );
    const authExpired = erroredAccounts.some(([, info]) =>
      /invalid_grant|expired|revoked|unauthorized|invalid_token/i.test(
        info.error || ""
      )
    );

    if (allJobs.length === 0) {
      const emptyMessage = authExpired
        ? `Gmail connection expired for ${erroredAccounts
            .map(([label]) => label)
            .join(", ")}. Reconnect the account under 'Gmails Connected' to resume scraping.`
        : erroredAccounts.length === accounts.length
          ? "Could not read any connected inbox — check the Gmail connection."
          : totalEmailsFetched === 0
            ? "No LinkedIn emails found in any connected inbox. Set up LinkedIn job alerts first."
            : "LinkedIn emails parsed but no remote jobs extracted.";

      return NextResponse.json({
        success: true,
        data: [],
        message: emptyMessage,
        summary: {
          window: { from: windowFromIST, to: targetIST },
          selection,
          accountsRead: accounts.length,
          emailsFetched: totalEmailsFetched,
          emailsInWindow: totalEmailsInWindow,
          emailsSkippedOld: totalEmailsSkippedOld,
          jobsParsed: 0,
          perAccount,
        },
      });
    }

    // ─────── Enrich each job with full description from its LinkedIn page ───────
    // LinkedIn alert emails don't include the JD body, only the URL. Fetch the public
    // job page in parallel (concurrency 3) so Gemini gets real context for
    // personalization. Runs ONCE on the combined unique set, not per-account.
    const jobsNeedingDesc = allJobs.filter(
      (j) =>
        /linkedin\.com\/jobs\/view\/\d+/.test(j.url) &&
        (j.description?.length || 0) < 100
    );
    if (jobsNeedingDesc.length > 0) {
      console.log(
        `[gmail-parser] Fetching descriptions for ${jobsNeedingDesc.length} LinkedIn job pages...`
      );
      const CONCURRENCY = 3;
      const FALLBACK_THRESHOLD = 300;
      let viaCheerio = 0;
      let viaScrapingBee = 0;
      let blocked = 0;
      for (let i = 0; i < jobsNeedingDesc.length; i += CONCURRENCY) {
        const batch = jobsNeedingDesc.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (job) => {
            let { description: desc, location: loc } = await fetchLinkedInJobDetails(
              job.url
            );
            if (desc && isLinkedInLoginWall(desc)) desc = "";
            if (!desc || desc.length < FALLBACK_THRESHOLD || !loc) {
              const sb = await fetchLinkedInJobDetailsScrapingBee(job.url);
              const sbDesc =
                sb.description && !isLinkedInLoginWall(sb.description)
                  ? sb.description
                  : "";
              if (sbDesc && sbDesc.length > desc.length) {
                desc = sbDesc;
                viaScrapingBee++;
              } else if (desc) {
                viaCheerio++;
              }
              if (!loc && sb.location) loc = sb.location;
            } else {
              viaCheerio++;
            }
            if (desc && isLinkedInLoginWall(desc)) {
              console.warn(
                `[gmail-parser] login-wall slipped through for ${job.url} — discarding desc`
              );
              desc = "";
            }
            if (desc) job.description = desc;
            else blocked++;
            const currentLoc = (job.location || "").trim();
            const locMissing = !currentLoc || currentLoc === "N/A" || currentLoc === "—";
            if (loc && locMissing) job.location = loc;
          })
        );
      }
      console.log(
        `[gmail-parser] LinkedIn JD fetch: ${viaCheerio} cheerio · ${viaScrapingBee} scrapingbee · ${blocked} blocked/empty`
      );
    }

    // Persist to Supabase jobs table — only when the caller actually wants
    // the scrape to land in the DB. Cron + Auto-Scrape rely on the default
    // (true); the manual "Run Scrape Now" button passes false so the user
    // can pick which rows to save via /api/jobs/save.
    if (saveToDb) {
      await persistScrapedJobs(allJobs);

      // Stamp settings.last_scrape_at so the Scrape page hero stat reflects
      // a fresh "Last Run" without waiting for the cron orchestrator.
      try {
        await db
          .from(TABLES.settings)
          .update({ last_scrape_at: new Date().toISOString() })
          .eq("id", 1);
      } catch (e) {
        console.warn("[gmail-parser] last_scrape_at update failed:", e);
      }
    }

    return NextResponse.json({
      success: true,
      data: allJobs,
      summary: {
        window: { from: windowFromIST, to: targetIST },
        selection,
        accountsRead: accounts.length,
        emailsFetched: totalEmailsFetched,
        emailsInWindow: totalEmailsInWindow,
        emailsSkippedOld: totalEmailsSkippedOld,
        jobsParsed: allJobs.length,
        perAccount,
      },
    });
  } catch (error) {
    console.error("[gmail-parser] Error:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
