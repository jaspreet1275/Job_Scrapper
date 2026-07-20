// Converts noisy HTML (sometimes double-encoded with &lt; entities) into clean
// readable plain text. Used by every LinkedIn description fetcher so the saved
// `job.description` is human-friendly text, not a wall of <strong>/<br>/&lt;.

const HTML_ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&#160;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&bull;": "•",
  "&middot;": "·",
};

function decodeHtmlEntities(s: string): string {
  if (!s) return "";
  let out = s;
  // Two passes to handle double-encoded HTML (e.g. &amp;lt; → &lt; → <)
  for (let i = 0; i < 2; i++) {
    // Named entities
    out = out.replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (match) => {
      if (HTML_ENTITY_MAP[match]) return HTML_ENTITY_MAP[match];
      // Numeric: &#65; → A
      const numMatch = match.match(/&#(\d+);/);
      if (numMatch) return String.fromCharCode(parseInt(numMatch[1], 10));
      // Hex: &#x41; → A
      const hexMatch = match.match(/&#x([0-9a-fA-F]+);/);
      if (hexMatch) return String.fromCharCode(parseInt(hexMatch[1], 16));
      return match;
    });
  }
  return out;
}

// Public: turn whatever messy HTML/entity blob the upstream sources hand us into
// clean readable plain text with sensible line breaks.
export function htmlToText(input: string): string {
  if (!input) return "";

  // Step 1: decode HTML entities (handles double-encoding too)
  let s = decodeHtmlEntities(input);

  // Step 2: turn block-level tags into line breaks BEFORE stripping all tags,
  // so the output keeps paragraph + bullet structure.
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n");

  // Step 3: strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");

  // Step 4: tidy whitespace — collapse runs of spaces, but keep single/double newlines.
  s = s
    .replace(/[ \t]+/g, " ")           // collapse spaces/tabs
    .replace(/ *\n */g, "\n")          // trim space around newlines
    .replace(/\n{3,}/g, "\n\n")        // cap consecutive newlines
    .trim();

  return s;
}

// Public: convert messy HTML (LinkedIn job-description markup, often
// double-encoded) into clean Markdown that PRESERVES structure. Unlike
// htmlToText — which flattens everything to plain text and loses bold +
// headings — this keeps <strong>→**bold**, <h*>→"## heading", <ul><li>→
// "- " bullets and <a>→[text](url), so the saved description renders in
// the dashboard exactly the way LinkedIn laid it out.
export function htmlToMarkdown(input: string): string {
  if (!input) return "";

  // Step 1: decode HTML entities (handles double-encoding too).
  let s = decodeHtmlEntities(input);

  // Step 2: drop tags whose content is never part of the description.
  s = s.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Step 3: inline emphasis → Markdown markers (before block conversion).
  // Pairwise, so whitespace hugging the INSIDE of a tag is moved OUT of the
  // markers — Markdown renders "**x**" but NOT "**x **" / "** x**", so a
  // <strong>Job title: </strong> must become "**Job title:** " not "**…: **".
  const emphasize = (str: string, tags: string, mark: string) => {
    const re = new RegExp(
      `<\\s*(?:${tags})\\b[^>]*>([\\s\\S]*?)<\\s*/\\s*(?:${tags})\\s*>`,
      "gi"
    );
    return str.replace(re, (_m, inner: string) => {
      const lead = inner.match(/^\s*/)?.[0] ?? "";
      const trail = inner.match(/\s*$/)?.[0] ?? "";
      const core = inner.trim();
      return core ? `${lead}${mark}${core}${mark}${trail}` : inner;
    });
  };
  s = emphasize(s, "strong|b", "**");
  s = emphasize(s, "em|i", "*");

  // Step 4: anchors → their visible text only. LinkedIn JD bodies carry no
  // real links — any <a> is page chrome (recruiter profile link, "see
  // more"), so keep the text and drop the URL to avoid stray green links.
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // Step 5: block-level tags → line breaks / Markdown prefixes.
  s = s
    .replace(/<h[1-6][^>]*>/gi, "\n\n## ")
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<p\b[^>]*>/gi, "\n\n")
    .replace(/<\/(?:div|tr)\s*>/gi, "\n");

  // Step 6: strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");

  // Step 7: tidy — collapse horizontal whitespace, trim around newlines,
  // drop empty bullet lines, cap blank lines. Markdown markers survive.
  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^[ \t]*-[ \t]*$/gm, "")
    .replace(/^[ \t]*#{1,6}[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}

// Detects when a "description" we extracted from a LinkedIn page is actually
// the login-wall boilerplate, not the real JD. Happens when LinkedIn serves
// the auth-gate page to a bot UA (or a free-tier ScrapingBee request that
// got fingerprinted) — meta-description then reads
//   "Login to LinkedIn to keep in touch with people you know …"
// or "Welcome back / Join your professional community".
//
// Returning true tells callers to discard the candidate and try the next
// strategy (next selector, next UA, ScrapingBee fallback). Without this,
// the 95-char login blurb wins as the "longest" candidate when no real
// description container rendered, and gets saved to the DB.
const LOGIN_WALL_PATTERNS = [
  /\blogin\s+to\s+linkedin\s+to\s+keep\s+in\s+touch\b/i,
  /\bsign\s+in\s+to\s+linkedin\b/i,
  /\blog\s+in\s+(?:or\s+sign\s+up\s+)?to\s+linkedin\b/i,
  /\bjoin\s+your\s+professional\s+community\b/i,
  /\bwelcome\s+back\s+to\s+linkedin\b/i,
  /\blinkedin\s+helps\s+you\s+connect\b/i,
  /\bkeep\s+in\s+touch\s+with\s+people\s+you\s+know,?\s+share\s+ideas\b/i,
];
export function isLinkedInLoginWall(text: string): boolean {
  if (!text) return false;
  // Login-wall meta text is short — anything > 600 chars is almost
  // certainly a real description, even if it incidentally contains
  // the word "linkedin". Bound the check so a JD that says
  // "5+ years on LinkedIn …" doesn't get false-positived.
  if (text.length > 600) return false;
  return LOGIN_WALL_PATTERNS.some((re) => re.test(text));
}

// LinkedIn-specific noise stripper. The job-description container we scrape often
// has the page chrome bolted on (recruiter card before, metadata sections after).
// This trims those off so the saved description is just the JD body.
//
// It ALSO recovers paragraph + bullet structure that LinkedIn flattens out
// when serving the description via JSON-LD (their meta-graph stores the
// description as a single string with all <p>/<li> separators stripped, so
// the raw fetch comes back as one wall of glued text: "…organizational
// goals.Qualifications5+ years of experience as a software engineerAt
// least 3 years…"). We restore structure heuristically: known section
// names get promoted to **bold headings** with paragraph breaks around
// them, and bullets within bullet-style sections get split on the safe
// "lowercase-then-uppercase" boundary.
//
// All transforms are CONSERVATIVE — they only fire on high-confidence
// patterns so we never corrupt a valid sentence. If the source already
// had proper line breaks (from a DOM container, say) the regexes
// no-op and the original structure passes through.
const SECTION_HEADERS = [
  "About\\s+(?:Us|Me|the\\s+(?:Role|Company|Job|Position|Team|Client))",
  "Role\\s+Overview",
  "Position\\s+(?:Overview|Summary)",
  "Job\\s+(?:Description|Summary|Overview)",
  "Key\\s+Responsibilities",
  "Responsibilities",
  "What\\s+You'?ll\\s+(?:Do|Be\\s+Doing)",
  "Most\\s+Important\\s+Responsibilities",
  "Required\\s+Qualifications",
  "Minimum\\s+Qualifications",
  "Preferred\\s+Qualifications",
  "Qualifications",
  "Required\\s+Skills",
  "Skills(?:\\s+Required)?",
  "Requirements",
  "Benefits",
  "What\\s+We\\s+Offer",
  "Perks(?:\\s+and\\s+Benefits)?",
  "Compensation(?:\\s+and\\s+Benefits)?",
  "Equal\\s+Opportunity(?:\\s+Employer)?",
  "EEO\\s+Statement",
  "Education",
  "Experience",
  "Nice\\s+to\\s+Have",
];
const SECTION_HEADER_GROUP = `(?:${SECTION_HEADERS.join("|")})`;

// Promotes glued section headers to **bold** with surrounding line breaks.
// Triggers ONLY when the header is preceded by sentence-end punctuation OR
// is at the very start of the string — so a mid-sentence word like
// "qualifications" won't false-positive.
function injectSectionHeadings(text: string): string {
  // Case A: header preceded by `.`, `!`, `?`, or `:` (with optional space).
  // We re-emit the closing punctuation so "…goals.Qualifications…" becomes
  // "…goals.\n\n**Qualifications**\n\n…" (no character lost).
  const inlineRe = new RegExp(`([\\.\\!\\?\\:])\\s*(${SECTION_HEADER_GROUP})\\b`, "g");
  let out = text.replace(inlineRe, (_m, punct: string, header: string) => {
    return `${punct}\n\n**${header}**\n\n`;
  });
  // Case B: header at the very start of the string.
  const startRe = new RegExp(`^\\s*(${SECTION_HEADER_GROUP})\\b`);
  out = out.replace(startRe, (_m, header: string) => `**${header}**\n\n`);
  return out;
}

// Splits glued bullet lines on lower→Upper boundaries within bullet-like
// sections. Conservative: only fires when the uppercase word starts with a
// known bullet-phrase trigger (a verb, a "N+ years" pattern, "Bachelor's",
// etc.) so compound words like "JavaScript" / "NodeJS" stay intact.
function splitGluedBullets(text: string): string {
  // Common LinkedIn bullet starters — verbs and noun-phrase patterns that
  // routinely begin a bullet line in a Qualifications / Responsibilities /
  // Skills section. Conservative list; misses are fine (no false breaks).
  const BULLET_STARTERS = [
    // Verbs (responsibilities)
    "Implement", "Design", "Build", "Develop", "Lead", "Manage", "Maintain",
    "Collaborate", "Coordinate", "Create", "Drive", "Define", "Ensure",
    "Establish", "Evaluate", "Execute", "Identify", "Improve", "Optimize",
    "Own", "Partner", "Plan", "Provide", "Research", "Review", "Stay",
    "Support", "Translate", "Work", "Write", "Architect", "Deploy",
    // Qualification phrases
    "Expertise", "Experience", "Familiarity", "Knowledge", "Proficiency",
    "Strong", "Excellent", "Demonstrated", "Proven", "Solid", "Hands-on",
    "Deep", "Working", "Practical", "Ability", "Background", "Understanding",
    "Bachelor", "Master", "PhD", "Degree", "Certification",
    // Benefit phrases
    "Competitive", "Comprehensive", "Inclusive", "Remote", "Flexible",
    "Paid", "Professional", "Unlimited",
  ];
  // "N+ years" / "N years" — very strong bullet-start signal in Qualifications.
  const yearPattern = "\\d+\\+?\\s*years?";
  const starterAlt = `(?:${BULLET_STARTERS.join("|")}|${yearPattern})`;
  // Lowercase letter or `)` or digit immediately followed by a starter
  // capitalised word. Insert a bullet break between them.
  const re = new RegExp(`([a-z\\)\\d])(${starterAlt})\\b`, "g");
  return text.replace(re, "$1\n* $2");
}

// LinkedIn's "Meet the hiring team" card sits directly above the JD body
// and renders the job poster's name TWICE in a row (a profile link + the
// plain name) — sometimes with an empty "##" heading between them. That
// block leaks into the scraped description. When the first two lines that
// carry real visible text are the SAME short, punctuation-free string,
// drop the whole recruiter block.
export function stripRecruiterNameCard(text: string): string {
  // Visible text of a line — strips markdown link syntax and bare markers
  // so a "[Name](url)" link or an empty "##" heading compares cleanly.
  const visible = (l: string) =>
    l.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#]/g, "").trim();
  const lines = text.split("\n");
  // First two lines with real visible content — blanks and bare markers
  // (e.g. an empty "##" heading the converter emitted) are skipped.
  const idx: number[] = [];
  for (let i = 0; i < lines.length && i < 10 && idx.length < 2; i++) {
    if (visible(lines[i])) idx.push(i);
  }
  if (idx.length < 2) return text;
  const a = visible(lines[idx[0]]);
  const b = visible(lines[idx[1]]);
  if (a && a === b && a.length <= 60 && !/[.!?]/.test(a)) {
    return lines.slice(idx[1] + 1).join("\n").trim();
  }
  return text;
}

export function cleanLinkedInJobDescription(text: string): string {
  if (!text) return "";
  let s = text;

  // Drop the "Meet the hiring team" recruiter-name card when it leaked in
  // above the JD body (LinkedIn prints the job poster's name twice).
  s = stripRecruiterNameCard(s);

  // Genuine JD-START landmarks ONLY. Mid-JD section names ("Responsibilities",
  // "Required Skills", "What You'll Do" …) are deliberately NOT here — a job's
  // intro / "About the company" paragraph comes BEFORE those sections, so
  // slicing at "Responsibilities" would throw the entire intro away.
  const startMarkers =
    /(About the (?:Role|Company|Job|Position|Team|Client)|About\s+Us|Role Overview|Job Description|Job Summary|Position Overview|Position Summary|We are looking|We're looking|We are seeking|We're seeking|We have a|Position:|Title:|Location:|Job#|Payrate:|Pay Rate:|Type of contract:)/i;

  // 1) Drop preamble noise:
  //    a) "Direct message the job poster from {Company} {Recruiter} {Recruiter title}"
  //    b) Plain recruiter card with no "Direct message" prefix (just "Name\nTitle @ Company\n…")
  //    Strategy: find the first strong JD landmark in the head; if it's not at the
  //    very beginning, slice from it (everything before was page chrome).
  const head = s.slice(0, 800);
  const headMatch = head.match(startMarkers);
  // Slice ONLY when the marker sits just past a SHORT preamble (a recruiter
  // card runs < ~320 chars). A marker further in means the "preamble" is
  // real JD content — an intro paragraph — and must be kept.
  if (
    headMatch &&
    headMatch.index !== undefined &&
    headMatch.index > 30 &&
    headMatch.index < 320
  ) {
    s = s.slice(headMatch.index);
  } else {
    // Fallback for the explicit "Direct message" form when no landmark found.
    s = s.replace(/^.*?Direct message the job poster from\s+\S[^\n]*\n+/, "");
  }

  // 2) Drop the trailing metadata section LinkedIn appends:
  //    "Show more / Show less / Seniority level / Employment type /
  //     Job function / Industries / ..."
  const tailMarker = /\n+\s*(Show more\s*\n+\s*Show less|Seniority level|Employment type|Job function\b|Industries\b)/i;
  const tailMatch = s.match(tailMarker);
  if (tailMatch && tailMatch.index !== undefined) {
    s = s.slice(0, tailMatch.index);
  }

  // 3) Standalone "Show more" / "Show less" UI artifacts inside the body.
  s = s.replace(/\bShow\s+(?:more|less)\b/gi, "");

  // 4) Structure recovery — promote glued section names to bold headings,
  //    then split runs of glued bullets within those sections. Both are
  //    no-ops when the source already had proper line breaks.
  s = injectSectionHeadings(s);
  s = splitGluedBullets(s);

  // 5) Tidy the whitespace one more time after slicing + restructuring.
  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}
