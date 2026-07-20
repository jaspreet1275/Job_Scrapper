import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import * as cheerio from "cheerio";
import { persistScrapedJobs } from "@/lib/db/jobs-persist";

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

// Detects and repairs the classic Latin-1-as-UTF-8 mojibake (Stio® shows up
// as "StioÂ®", smart quotes show as "â€™" etc.) that some upstream HTML
// pipelines bake in. Reads the string as Latin-1 bytes, re-decodes as
// UTF-8; only commits the result if the decoded version doesn't introduce
// more U+FFFD replacement characters (which would mean we just damaged a
// genuinely-correct string).
function fixMojibakeIfPresent(text: string): string {
  if (!text || !/[ÃÂâÅ]/.test(text)) return text;
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const origReplacements = (text.match(/�/g) || []).length;
    const newReplacements = (decoded.match(/�/g) || []).length;
    if (newReplacements > origReplacements) return text;
    return decoded;
  } catch {
    return text;
  }
}

// Semantic heading classifier — decides whether a string fragment is
// "heading-like" rather than body prose. The detector intentionally has
// multiple independent signals because RemoteOK listings ship headings
// in wildly inconsistent shapes:
//
//   - ALL-CAPS + colon          → "WORK ENVIRONMENT:", "QUALIFICATIONS:"
//   - Mixed-case + colon         → "About the role:", "Position summary:"
//   - Bare mixed-case phrase     → "The opportunity", "Who We Are"
//   - Common JD section names    → "Responsibilities", "Benefits",
//                                  "What you'll do", "Why join us"
//
// Length guard rejects anything obviously body-sized (>100 chars), and
// the punctuation check rejects fragments with multiple sentence-ending
// marks — body paragraphs almost always have those, real headings don't.
function isHeadingLike(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 100) return false;

  // Body-sentence shape: contains multiple sentence terminators → not a
  // heading. Single trailing "." or "?" is fine (some headings end with
  // them); two or more anywhere is body.
  const sentenceEnders = (t.match(/[.!?]/g) || []).length;
  if (sentenceEnders > 1) return false;

  // Signal 1 — ALL CAPS heading. Allow common heading punctuation.
  if (/^[A-Z][A-Z0-9\s&\/,\-:.()]+:?\s*$/.test(t)) return true;

  // Signal 2 — short, ends with ":" and isn't a body sentence.
  if (t.endsWith(":") && t.length <= 80) {
    const body = t.slice(0, -1);
    // Avoid catching things like "Note: text" if followed by long text.
    if (!/[.!?]/.test(body)) return true;
  }

  // Signal 3 — known JD section phrases. Each pattern is anchored to the
  // start AND end (with optional colon / period) so we don't promote a
  // run-on sentence that happens to mention "responsibilities".
  const HEADING_PHRASES: RegExp[] = [
    /^who we are\s*[:.]?$/i,
    /^about (us|the (company|role|team|position|opportunity|job|product))\s*[:.]?$/i,
    /^the (opportunity|role|company|team|mission|impact|challenge|story|position|job|product|founders?|team\b.*)\s*[:.]?$/i,
    /^(overview|introduction|background|summary|description)\s*[:.]?$/i,
    /^what (you|we)('?(ll| will|'?re| are| do))\s*([\w\s'’]*?)$/i,
    /^(key |core |main )?(responsibilit(?:y|ies)|duties|tasks|deliverables)\s*[:.]?$/i,
    /^(key |core |main |required |preferred |minimum |essential |basic |bonus |nice to have )?(qualifications?|requirements?|skills?|experience|background)\s*[:.]?$/i,
    /^why (join|work|us|choose|consider|here|this|now)/i,
    /^our (mission|vision|values?|culture|team|story|approach|product|stack|tech|company|customer|client|process|philosophy)\s*[:.]?$/i,
    /^(benefits|perks|compensation|salary|wage|pay|package|offer)\s*[:.]?$/i,
    /^how (to apply|we (work|hire|operate))\s*[:.]?$/i,
    /^(equal (opportunity|employment)|diversity|inclusion|dei)/i,
    /^join (us|our|the)\b/i,
    /^role (overview|summary|description|details)\s*[:.]?$/i,
    /^position (overview|summary|description|details)\s*[:.]?$/i,
    /^job (overview|summary|description|details|requirements|functions)\s*[:.]?$/i,
    /^what we (offer|provide|need|expect|are looking for|do|build)\s*[:.]?$/i,
    /^work (environment|schedule|hours|culture|life|setup)\s*[:.]?$/i,
    /^(salary (and|&) benefits|compensation (and|&) benefits)\s*[:.]?$/i,
    /^(perks (and|&) benefits|benefits (and|&) perks)\s*[:.]?$/i,
    /^(application|hiring|interview) (process|stages?|steps?)\s*[:.]?$/i,
    /^next steps?\s*[:.]?$/i,
    /^(essential|required|critical|primary) (job )?(functions|duties|responsibilities)\s*[:.]?$/i,
    /^(core )?(skills (and|&) capabilities|capabilities|competencies)\s*[:.]?$/i,
    /^(career (path|growth|development)|growth|advancement)\s*[:.]?$/i,
    /^remote (work|first|policy|culture|setup)/i,
    /^(reporting|hierarchy|structure)\s*[:.]?$/i,
    /^tools (and|&) (technologies|stack|frameworks)\s*[:.]?$/i,
    /^team (and|&) culture\s*[:.]?$/i,
    /^(timezone|time zone|location|hours)\s*[:.]?$/i,
    /^(ready to (apply|start|join))/i,
    /^what'?s (next|in it for you)\s*[:.]?$/i,
  ];
  return HEADING_PHRASES.some((p) => p.test(t));
}

// Pre-process the parsed DOM to flatten RemoteOK's inconsistent heading
// markup into clean <h3> elements. RemoteOK ships headings in at least
// four shapes:
//   (a) <p><strong>Heading</strong></p>            → standalone heading
//   (b) <p><strong>Heading:</strong>Body...</p>    → heading + body inline
//   (c) <p>Body... <strong>HEADING:</strong></p>   → heading trailing a paragraph
//   (d) <p><strong>A...<br><br>B...<br><br>C</strong></p>
//                                                  → whole block accidentally bolded
//
// All four collapse to ambiguous markdown when walked naïvely. Promoting
// the strong tags to real <h3> elements up front lets the walker emit a
// proper "### …" heading every time, regardless of source quirks.
function normalizeHeadings(
  $: ReturnType<typeof cheerio.load>,
  root: ReturnType<ReturnType<typeof cheerio.load>>
): void {
  // Up to 3 passes — splitting a paragraph can expose new heading-shaped
  // strong tags inside its replacement, but real-world JDs don't need more.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    root.find("strong, b").each((_i, el) => {
      const $el = $(el);
      // If this tag was already consumed by a previous split it may no
      // longer have a parent — skip it.
      if ($el.parents("body").length === 0 && $el.parents("#__rok_root").length === 0)
        return;
      const text = $el.text().trim();
      if (!isHeadingLike(text)) return;

      const $parent = $el.parent();
      const parentTag = (
        ($parent.get(0) as { name?: string } | undefined)?.name ?? ""
      ).toLowerCase();
      // Only promote when the strong sits inside a block-level container —
      // promoting an inline-context strong (inside an <li> bullet body, an
      // <a>, etc.) would shred the structure.
      if (!["p", "div", "section", "article"].includes(parentTag)) return;

      const contents = $parent.contents().toArray();
      const idx = contents.indexOf(el);
      const before = contents.slice(0, idx);
      const after = contents.slice(idx + 1);

      const beforeHtml = before.map((n) => $.html(n)).join("");
      const afterHtml = after.map((n) => $.html(n)).join("");
      const beforeIsEmpty = !beforeHtml.replace(/<[^>]+>/g, "").trim();
      const afterIsEmpty = !afterHtml.replace(/<[^>]+>/g, "").trim();

      // Heading mid-body — leave as inline bold to avoid mangling prose.
      if (!beforeIsEmpty && !afterIsEmpty) return;

      const safeText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let replacement: string;
      if (beforeIsEmpty && afterIsEmpty) {
        replacement = `<h3>${safeText}</h3>`;
      } else if (beforeIsEmpty) {
        replacement = `<h3>${safeText}</h3><p>${afterHtml}</p>`;
      } else {
        replacement = `<p>${beforeHtml}</p><h3>${safeText}</h3>`;
      }
      $parent.replaceWith(replacement);
      changed = true;
    });
    if (!changed) break;
  }
}

// Convert RemoteOK's HTML description into structured Markdown. The API
// returns rich HTML — paragraphs, headings, bold lead-in words on each
// interview step, *and* deeply nested <ul><li> trees for the "Core
// Responsibilities" section. The previous regex-based pass flattened all
// of that into a wall of bullets and dropped every <strong> emphasis on
// the floor.
//
// Pipeline:
//   1. Repair Latin-1-as-UTF-8 mojibake (so quotes / ® / em-dashes round-trip).
//   2. Parse with cheerio.
//   3. Pre-process the DOM (normalizeHeadings): promote heading-shaped
//      <strong> tags to real <h3> elements so the walker doesn't have to
//      guess.
//   4. Walk the cleaned DOM, preserving bold/italic/heading/list/link
//      structure as Markdown.
//   5. Post-process to strip RemoteOK boilerplate and tidy whitespace.
//
// HTML entities are decoded by cheerio's parser, so the old hand-rolled
// entity table is gone.
function htmlToStructuredText(html: string): string {
  if (!html) return "";
  const repaired = fixMojibakeIfPresent(html);
  // Wrap so cheerio always has a single root, regardless of whether the
  // upstream payload was a fragment or a full document. (cheerio decodes
  // entities by default in this version, so no extra options needed.)
  const $ = cheerio.load(`<div id="__rok_root">${repaired}</div>`);
  const root = $("#__rok_root");

  // Drop non-content elements before the walker ever sees them. Even
  // accidentally rendering a <script> body as JD prose would be wildly
  // confusing in the dashboard.
  root.find("script, style, noscript, iframe, embed, object").remove();

  // Promote heading-shaped <strong> tags to actual <h3> elements so the
  // walker treats them as real headings instead of inline bold.
  normalizeHeadings($, root);

  // Walks a cheerio selection of children and returns the rendered text.
  // `depth` tracks the current <ul>/<ol> nesting so sub-bullets indent.
  function walk(
    nodes: ReturnType<typeof $>,
    depth: number
  ): string {
    let out = "";
    nodes.each((_i, node) => {
      // Text node — pass the raw text through.
      if (node.type === "text") {
        out += (node as { data?: string }).data ?? "";
        return;
      }
      if (node.type !== "tag") return;
      const tag = (node as { name?: string }).name?.toLowerCase() ?? "";
      const $node = $(node);
      const inner = () => walk($node.contents(), depth);
      const innerDeeper = () => walk($node.contents(), depth + 1);

      switch (tag) {
        case "br":
          out += "\n";
          return;
        case "p":
        case "div":
        case "section":
        case "article":
        case "header":
        case "footer":
        case "tr":
        case "blockquote":
          out += "\n\n" + inner().trim() + "\n\n";
          return;
        case "h1":
        case "h2":
          out += "\n\n## " + inner().trim() + "\n\n";
          return;
        case "h3":
          out += "\n\n### " + inner().trim() + "\n\n";
          return;
        case "h4":
        case "h5":
        case "h6":
          out += "\n\n#### " + inner().trim() + "\n\n";
          return;
        case "strong":
        case "b": {
          const t = inner().trim();
          out += t ? `**${t}**` : "";
          return;
        }
        case "em":
        case "i": {
          const t = inner().trim();
          out += t ? `*${t}*` : "";
          return;
        }
        case "u": {
          const t = inner().trim();
          out += t ? `__${t}__` : "";
          return;
        }
        case "a": {
          const href = ($node.attr("href") ?? "").trim();
          const t = inner().trim();
          if (!t) return;
          out += href ? `[${t}](${href})` : t;
          return;
        }
        case "ul":
        case "ol":
          // Children <li> handle indentation; just walk them.
          out += "\n" + inner() + "\n";
          return;
        case "li": {
          const indent = "  ".repeat(depth);
          // Sub-content (including nested <ul>) renders at depth+1.
          const content = innerDeeper().trim().replace(/^\s+/, "");
          out += `\n${indent}- ${content}`;
          return;
        }
        case "script":
        case "style":
        case "noscript":
          // Drop entirely.
          return;
        default:
          // Unknown / inline tag — pass through children.
          out += inner();
          return;
      }
    });
    return out;
  }

  const raw = walk(root.contents(), 0);

  // Tidy up: NBSP → space, cap blank-line runs, collapse inline whitespace
  // without collapsing the line breaks we just emitted.
  const tidied = raw
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // Strip RemoteOK's spam-prevention watermark. Every listing on the board
  // ends with boilerplate like "Please mention the word XXXX and tag
  // <base64>= when applying… see they're human." It's RemoteOK's own
  // anti-bot tag, not part of the JD — drop it before the description
  // reaches the dashboard / AI email generator.
  return stripRemoteOKBoilerplate(tidied);
}

function stripRemoteOKBoilerplate(text: string): string {
  return (
    text
      // 1. Spam-prevention watermark at the very end.
      .replace(
        /\n*\s*please\s+mention\s+the\s+word\s+[\s\S]*?they['’]re\s+human\.?\s*$/i,
        ""
      )
      // 2. RemoteOK's "Ready to join? We invite you to watch this video and
      //    learn who we are and how we build and innovates together!" call
      //    to action. Some listings glue it to the last benefit bullet, so
      //    the match is greedy from "Ready to join?" through the trailing
      //    "together!" / "together." regardless of position in the text.
      .replace(
        /[ \t]*\n?\s*ready\s+to\s+join\??\s*[\s\S]*?innovate(?:s|d)?\s+together\.?!?\s*/gi,
        "\n\n"
      )
      // 3. Lingering "Let's Go!" tagline (RemoteOK template, not company copy).
      .replace(/\n*\s*let['’]s\s+go\.?!?\s*(?=\n|$)/gi, "")
      // 4. Adjacent <strong> runs collapse to "****" in our walker — split
      //    them so each emphasis run renders independently. Without this,
      //    CommonMark sees four asterisks in a row and parses them as
      //    literal text, leaving "**" leaking into the dashboard.
      .replace(/\*\*\*\*/g, "** **")
      // 4b. Repair bold spans that crossed a paragraph break inside the
      //     source HTML — most commonly happens when RemoteOK wraps
      //     "heading + body + heading" in one <strong> tag (their CMS
      //     does this on Gildan-style listings). CommonMark refuses to
      //     render `**X\n\nY\n\nZ**` as emphasis, so both ** would leak
      //     as literal text. Heuristic: first and last lines look like
      //     headings, the middle is body — re-bold the boundary lines
      //     and leave the middle as plain prose.
      .replace(/\*\*([^*]+?)\*\*/g, (m, inner: string) => {
        if (!/\n\s*\n/.test(inner)) return m;
        const lines = inner
          .split(/\n\s*\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) return "";
        if (lines.length === 1) return `**${lines[0]}**`;
        if (lines.length === 2) {
          return `**${lines[0]}**\n\n**${lines[1]}**`;
        }
        const first = lines[0];
        const last = lines[lines.length - 1];
        const middle = lines.slice(1, -1).join("\n\n");
        return `**${first}**\n\n${middle}\n\n**${last}**`;
      })
      // 5. Defensive space after a closing **bold** when the next character
      //    is a word character — strict CommonMark sometimes refuses to
      //    render emphasis without this whitespace boundary.
      //    "**WORK ENVIRONMENT:**Nymbus" → "**WORK ENVIRONMENT:** Nymbus"
      .replace(/\*\*([^*\n]+?)\*\*([A-Za-z0-9])/g, "**$1** $2")
      // 6. Promote ANY heading-shaped **bold** to its own paragraph using
      //    the semantic `isHeadingLike` classifier (defined above). This is
      //    the broad fallback that catches headings the DOM-level
      //    `normalizeHeadings` pre-pass missed — e.g. ALL-CAPS headings
      //    written as literal text (no <strong> wrapper), bare phrases
      //    like "The opportunity" / "Who We Are" that don't end with ":",
      //    or section markers buried mid-paragraph by the source CMS.
      //    Inline bold for emphasis (e.g. "**Apply.**", "**Card Fraud
      //    Specialist**") is left untouched because isHeadingLike rejects
      //    body-sentence shapes and mixed-case fragments without heading
      //    signals.
      .replace(/\*\*([^*\n]{2,100})\*\*/g, (match, content: string) => {
        if (!isHeadingLike(content)) return match;
        return `\n\n**${content.trim()}**\n\n`;
      })
      // 8. Collapse blank-line runs that the splits above could double up.
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()
  );
}

// Generic words that show up in almost every job title. We strip these from
// the role-keyword set so a search for "Node.js Developer" doesn't match every
// listing on the board just because it contains "developer".
const GENERIC_ROLE_WORDS = new Set([
  "developer", "dev", "engineer", "engineering", "senior", "junior", "lead",
  "staff", "principal", "mid", "sr", "jr", "software", "remote", "fulltime",
  "full-time", "parttime", "part-time", "contract", "the", "and", "of", "a",
]);

// Role families that are CLEARLY non-technical — the spam-prone listings
// where companies pile every tech tag onto an Illustrator / Marketing /
// Customer-Support job just to widen reach. Anything matching these gets
// hard-rejected regardless of how many tech tags it carries. Data
// Scientist / ML Engineer / AI Researcher style roles are NOT here on
// purpose — they're real tech roles that frequently use Python.
const EXCLUDED_TITLE_TERMS = [
  // Creative / design / video
  "designer", "ui/ux", "ux/ui", "ux designer", "ui designer", "graphic",
  "illustrator", "illustration", "animator", "3d artist", "video editor",
  // Marketing / sales / content
  "marketing", "sales", "seo", "content writer", "copywriter",
  // Management / executive (non-IC tracks)
  "product manager", "project manager", "program manager",
  "managing director", " director", "executive", "vp ", "vice president",
  // HR / recruiting / support / admin
  "recruiter", "talent acquisition", "customer support", "customer success",
  "customer service", "human resources", "hr specialist",
  "executive assistant", "virtual assistant", "office admin",
  "scrum master", "agile coach",
  // Operations / finance
  "accountant", "bookkeeper", "finance manager",
  "supply chain", "logistics",
  // Other clearly non-tech families
  "nurse", "physician", "legal counsel", "attorney",
  "teacher", "tutor",
];

// "Tech role" markers used by the tag-only acceptance path. Broadened beyond
// pure "developer / engineer" so legitimate Python-using roles — Data
// Scientist, ML Engineer (which IS allowed when not also "ml engineer"
// without context), Research Scientist, Cybersecurity Specialist, etc. —
// can pass when tags carry "python" / "django" / "flask" but the title
// itself doesn't include the keyword. RemoteOK's tag spam still gets
// caught by EXCLUDED_TITLE_TERMS above.
const TECH_ROLE_INDICATORS = [
  "developer", "engineer", "programmer", "coder", "architect",
  "scientist", "analyst", "specialist", "researcher",
  "fullstack", "full-stack", "full stack", "backend", "back-end", "back end",
  "frontend", "front-end", "front end", "software", "tech lead", "sde",
  "data", "ml", "ai", "infra", "devops", "sre",
];

export async function POST(req: NextRequest) {
  try {
    // `saveToDb` mirrors the parse-gmail flag — default true keeps cron +
    // Auto-Scrape persisting silently, while the manual Run Scrape Now
    // button passes false so the user gets to pick what actually lands.
    //
    // `locations` is an optional array of country/region hints
    // (e.g. ["US", "UK", "Canada", "Remote"]).
    const {
      roles,
      filters,
      locations,
      saveToDb = true,
    } = (await req.json()) as {
      roles?: string | string[];
      filters?: string[];
      locations?: string[];
      saveToDb?: boolean;
    };

    const keywords = Array.isArray(roles)
      ? roles.map((r: string) => r.toLowerCase().replace(/\s+/g, "-")).join(",")
      : String(roles).toLowerCase().replace(/\s+/g, "-");

    console.log(
      `[remoteok] Searching: ${keywords} · locations=${
        Array.isArray(locations) && locations.length > 0
          ? locations.join(",")
          : "<any>"
      }`
    );

    // RemoteOK free JSON API — no auth, no key, no Cloudflare
    const response = await axios.get("https://remoteok.com/api", {
      headers: {
        "User-Agent": "JobScraperDashboard/1.0",
        Accept: "application/json",
      },
      timeout: 15000,
    });

    // First item is metadata, rest are jobs
    const allJobs = Array.isArray(response.data) ? response.data.slice(1) : [];
    console.log(`[remoteok] Total jobs from API: ${allJobs.length}`);

    // ── Role / tag filter ───────────────────────────────────────────────────
    // Build a keyword set from the requested role(s). We deliberately DROP
    // generic words (developer, engineer, senior…) so matching keys off the
    // actual technology token (node / nodejs / node-js), not the job level.
    function expandRoleKeywords(label: string): string[] {
      const lower = label.toLowerCase();
      const out = new Set<string>();
      // Raw label words, minus the generic noise (developer, engineer,
      // senior…) so we match on the real tech token, not the level.
      for (const w of lower.split(/[\s/]+/).filter(Boolean)) {
        if (!GENERIC_ROLE_WORDS.has(w)) out.add(w);
      }

      // Targeted aliases per stack — the set is what RemoteOK actually
      // ships in its tag taxonomy. Keep the tokens long enough that
      // matching is unambiguous; the title-side check uses a word-boundary
      // regex so even short tokens (go, php) don't accidentally fire on
      // unrelated substrings.

      // JavaScript ecosystem
      if (/node\.?\s*js|nodejs/.test(lower)) {
        ["node", "node.js", "nodejs", "node-js"].forEach((t) => out.add(t));
      }
      if (/\breact\b/.test(lower)) {
        ["react", "react.js", "reactjs"].forEach((t) => out.add(t));
      }
      if (/next\.?\s*js|nextjs/.test(lower)) {
        ["next", "next.js", "nextjs", "next-js"].forEach((t) => out.add(t));
      }
      if (/\bmern\b/.test(lower)) {
        ["mern", "mern-stack", "react", "node", "mongodb", "express"].forEach(
          (t) => out.add(t)
        );
      }
      if (/\bjavascript\b/.test(lower)) {
        ["javascript", "js"].forEach((t) => out.add(t));
      }
      if (/\btypescript\b/.test(lower)) {
        ["typescript", "ts"].forEach((t) => out.add(t));
      }
      if (/\bangular\b/.test(lower)) {
        ["angular", "angularjs", "angular.js"].forEach((t) => out.add(t));
      }
      if (/vue\.?\s*js|vuejs|\bvue\b/.test(lower)) {
        ["vue", "vue.js", "vuejs", "vue-js"].forEach((t) => out.add(t));
      }
      if (/react\s*native|reactnative/.test(lower)) {
        ["react-native", "reactnative", "react native"].forEach((t) => out.add(t));
      }

      // Python ecosystem
      if (/\bpython\b/.test(lower)) {
        ["python", "django", "flask", "fastapi"].forEach((t) => out.add(t));
      }
      if (/\bdjango\b/.test(lower)) {
        ["django", "python"].forEach((t) => out.add(t));
      }

      // JVM / .NET
      if (/\bjava\b/.test(lower) && !/javascript/.test(lower)) {
        ["java"].forEach((t) => out.add(t));
      }
      if (/spring\s*boot|springboot/.test(lower)) {
        ["spring", "spring-boot", "springboot", "java"].forEach((t) => out.add(t));
      }
      if (/\.net|dotnet/.test(lower)) {
        [".net", "dotnet", "asp.net", "c#", "csharp"].forEach((t) => out.add(t));
      }
      if (/c\s*#|c\s*sharp|csharp/.test(lower)) {
        ["c#", "csharp", ".net"].forEach((t) => out.add(t));
      }

      // Other backends
      if (/\bphp\b/.test(lower)) ["php"].forEach((t) => out.add(t));
      if (/\blaravel\b/.test(lower)) {
        ["laravel", "php"].forEach((t) => out.add(t));
      }
      if (/\bgo(lang)?\b/.test(lower)) {
        ["go", "golang"].forEach((t) => out.add(t));
      }
      if (/\bruby\b|\brails\b|\bror\b/.test(lower)) {
        ["ruby", "rails", "ror", "ruby on rails"].forEach((t) => out.add(t));
      }

      // Mobile
      if (/\bflutter\b|\bdart\b/.test(lower)) {
        ["flutter", "dart"].forEach((t) => out.add(t));
      }

      // AI / ML / Data
      if (/ai\/?ml|machine learning|\bai\b|\bml\b/.test(lower)) {
        ["ai", "ml", "machine-learning", "ai/ml", "deep-learning", "llm"].forEach(
          (t) => out.add(t)
        );
      }
      if (/data scientist|data science/.test(lower)) {
        ["data-science", "ml", "python"].forEach((t) => out.add(t));
      }
      if (/data analyst|data analytics/.test(lower)) {
        ["data-analyst", "analytics", "sql"].forEach((t) => out.add(t));
      }

      // Ops / general
      if (/\bdevops\b/.test(lower)) {
        ["devops", "sre", "infra", "kubernetes", "docker", "aws"].forEach(
          (t) => out.add(t)
        );
      }

      // Role families (broad — Layer-3 still gates these by tag match +
      // tech-role title indicator)
      if (/full[\s-]*stack/.test(lower)) {
        ["fullstack", "full-stack", "full stack"].forEach((t) => out.add(t));
      }
      if (/\bbackend\b|back[\s-]end/.test(lower)) {
        ["backend", "back-end", "back end"].forEach((t) => out.add(t));
      }
      if (/\bfrontend\b|front[\s-]end/.test(lower)) {
        ["frontend", "front-end", "front end"].forEach((t) => out.add(t));
      }

      return Array.from(out);
    }

    const roleList: string[] = Array.isArray(roles)
      ? roles
      : roles
      ? [String(roles)]
      : [];
    const roleKeywords = roleList.flatMap(expandRoleKeywords);

    const matched = roleKeywords.length === 0
      ? allJobs
      : allJobs.filter((job: Record<string, unknown>) => {
          const title = String(job.position || "").toLowerCase();
          const tags = Array.isArray(job.tags)
            ? (job.tags as string[]).map((t) => t.toLowerCase())
            : [];

          // 1. Hard exclude off-target role families (illustrator, manager,
          //    designer, …). Drops Twine-style spammy listings whose tags
          //    include "node" alongside 30 unrelated tags.
          const excluded = EXCLUDED_TITLE_TERMS.some((t) => title.includes(t));
          if (excluded) return false;

          // 2. Title hit: word-boundary match on the actual tech keyword
          //    ("node", "node.js" etc.). Avoids substring false positives.
          const titleHasKeyword = roleKeywords.some((w) =>
            new RegExp(
              `(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`
            ).test(title)
          );

          // 3. Tag hit needs EXACT tag equality (no substring) so tags like
          //    "node-monitoring" don't accidentally satisfy "node". Plus the
          //    title must also carry a tech-role indicator (developer /
          //    engineer / programmer / fullstack …) — otherwise a tag-spam
          //    listing like "Junior Illustrator" with a stray "node" tag
          //    sneaks in.
          const tagHasKeyword = tags.some((t) => roleKeywords.includes(t));
          const titleHasTechRole = TECH_ROLE_INDICATORS.some((role) =>
            new RegExp(
              `(^|[^a-z0-9])${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`
            ).test(title)
          );
          const tagHitWithRoleProof = tagHasKeyword && titleHasTechRole;

          return titleHasKeyword || tagHitWithRoleProof;
        });

    console.log(
      `[remoteok] Role filter: ${allJobs.length} → ${matched.length} matched (keywords=${roleKeywords.join(",")})`
    );

    // ── Filters: Remote / Full time / Part time ─────────────────────────────
    const remote = (filters || []).some((f: string) =>
      f.toLowerCase().includes("remote")
    );
    const fullTime = (filters || []).includes("Full time");
    const partTime = (filters || []).includes("Part time");

    let filtered = matched;
    if (fullTime) {
      filtered = filtered.filter((j: Record<string, unknown>) => {
        const pos = String(j.position || "").toLowerCase();
        const desc = String(j.description || "").toLowerCase();
        return !pos.includes("part-time") && !desc.includes("part-time");
      });
    }
    if (partTime) {
      filtered = filtered.filter((j: Record<string, unknown>) => {
        const pos = String(j.position || "").toLowerCase();
        const desc = String(j.description || "").toLowerCase();
        return pos.includes("part-time") || desc.includes("part-time");
      });
    }

    // ── Location filter ─────────────────────────────────────────────────────
    // Keep US / UK / Canada + globally-remote jobs. Geo-locked remote jobs
    // (e.g. "Remote - Germany") are rejected unless they match a requested
    // country, since those aren't what was asked for.
    function expandLocationKeywords(label: string): string[] {
      const lower = label.toLowerCase().trim();
      if (lower === "us" || lower === "usa" || lower === "united states")
        return ["us", "u.s.", "usa", "united states", "u.s.a", "america"];
      if (lower === "uk" || lower === "u.k." || lower === "united kingdom")
        return ["uk", "u.k.", "united kingdom", "britain", "england"];
      if (lower === "ca" || lower === "canada")
        return ["canada", "canadian"];
      if (lower === "remote" || lower === "worldwide" || lower === "anywhere" || lower === "global")
        return ["remote", "worldwide", "anywhere", "global"];
      return [lower];
    }

    if (Array.isArray(locations) && locations.length > 0) {
      const locKeywords = locations.flatMap(expandLocationKeywords);
      const before = filtered.length;
      filtered = filtered.filter((j: Record<string, unknown>) => {
        const loc = String(j.location || "").toLowerCase().trim();
        // Empty location on RemoteOK conventionally means worldwide-remote.
        if (loc === "") return true;
        // Truly global postings — always accepted.
        if (/\b(worldwide|anywhere|global)\b/.test(loc)) return true;
        // Bare "Remote" / "Remote only" with no country attached = global remote.
        if (/^remote( only)?$/.test(loc)) return true;
        // Otherwise it must mention one of the requested geographies.
        return locKeywords.some((k) => loc.includes(k));
      });
      console.log(
        `[remoteok] Location filter: ${before} → ${filtered.length} (allowed=${locKeywords.join(",")})`
      );
    }

    // ── Sort newest-first ───────────────────────────────────────────────────
    // No date filter — jobs of ANY age are kept. We just order them so the
    // most recently posted ones land at the top of the 15-result slice.
    filtered = filtered
      .map((j: Record<string, unknown>) => ({ j, epoch: Number(j.epoch) || 0 }))
      .sort((a, b) => b.epoch - a.epoch)
      .map(({ j }) => j);

    // Limit to 15 results (newest-first)
    const limited = filtered.slice(0, 15);

    const normalized: NormalizedJob[] = limited.map((job: Record<string, unknown>) => {
      const desc = htmlToStructuredText(String(job.description || ""));

      const epoch = Number(job.epoch);
      const postedAt = epoch
        ? new Date(epoch * 1000).toISOString().split("T")[0]
        : String(job.date || "N/A");

      return {
        title: String(job.position || "N/A"),
        jobId: String(job.id || "N/A"),
        company: String(job.company || "N/A"),
        email: extractEmail(desc),
        location: String(job.location || "Remote"),
        jobType: remote ? "Remote" : "Full-time",
        description: desc,
        url: job.url ? String(job.url) : `https://remoteok.com/remote-jobs/${job.slug || job.id}`,
        postedAt,
        platform: "RemoteOK",
      };
    });

    console.log(`[remoteok] Final: ${normalized.length} jobs`);

    if (normalized.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        message:
          "RemoteOK: No matching jobs found. Try widening the role or locations.",
      });
    }

    if (saveToDb) {
      await persistScrapedJobs(normalized);
    }

    return NextResponse.json({ success: true, data: normalized });
  } catch (error) {
    console.error("[remoteok] Error:", error);
    return NextResponse.json(
      { success: false, error: `RemoteOK error: ${String(error)}` },
      { status: 500 }
    );
  }
}