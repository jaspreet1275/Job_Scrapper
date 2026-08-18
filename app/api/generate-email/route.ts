import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
// Saare email prompts ek hi jagah rehte hain — prompt / wording / company
// details badalni ho to sirf lib/prompts/email-prompt.ts edit karo.
import {
  buildManatanuPrompt,
  buildSavedPromptScaffold,
  buildOverrideBlock,
  type PromptLead,
} from "@/lib/prompts/email-prompt";

interface EmailPayload {
  subject: string;
  body: string;
}

// Parses Gemini's reply into { subject, body }. The model can return content in
// many shapes (plain SUBJECT/BODY, markdown-decorated headers, raw email body
// with no markers at all, JSON-wrapped). This parser tries each shape in order.
function extractJSON(content: string): EmailPayload {
  // Step 0: aggressive pre-clean of common formatting noise Gemini sneaks in:
  //  - code fences (```json / ``` / ~~~)
  //  - markdown bold around field labels (**Subject:** → Subject:)
  //  - markdown headers (## SUBJECT → SUBJECT)
  //  - leading preambles like "Here is your email:" / "Sure, here's the response:"
  //  - HTML <br> if present
  const stripped = content
    .replace(/```(?:json|text|plaintext)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .replace(/~~~\s*/g, "")
    .replace(/\*\*(SUBJECT|BODY|Subject|Body)\s*:\s*\*\*/g, "$1:")
    .replace(/\*\*(SUBJECT|BODY|Subject|Body)\*\*\s*:/g, "$1:")
    .replace(/^#{1,6}\s+(SUBJECT|BODY|Subject|Body)\s*:?/gim, "$1:")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/^(?:sure[,!]?|here(?:'s| is)|here you go[,:]?|of course[,!]?|certainly[,!]?|okay[,!]?)[^\n]*?\n+/i, "")
    .trim();

  // Pass A (preferred): SUBJECT: … / BODY: … plain-text format.
  //   Tolerates lower/upper case, optional leading whitespace, optional newlines.
  //   BODY capture is greedy to end-of-message so multi-paragraph bodies survive.
  const subjLineMatch = stripped.match(/^[ \t]*SUBJECT[ \t]*:[ \t]*(.+?)[ \t]*$/im);
  const bodyMarkerMatch = stripped.match(/(?:^|\n)[ \t]*BODY[ \t]*:[ \t]*\n?([\s\S]+?)$/i);
  if (subjLineMatch && bodyMarkerMatch) {
    const subject = subjLineMatch[1].trim().replace(/^["'*_]+|["'*_]+$/g, "");
    const body = bodyMarkerMatch[1].trim();
    if (subject && body) return { subject, body };
  }

  // Pass A2: SUBJECT: present but the BODY: marker is missing — a very common
  // model slip where it writes the email straight after the subject line with
  // no "BODY:" label. Treat everything after the SUBJECT line as the body.
  if (subjLineMatch && !bodyMarkerMatch) {
    const subject = subjLineMatch[1].trim().replace(/^["'*_]+|["'*_]+$/g, "");
    const afterSubject = stripped
      .slice((subjLineMatch.index ?? 0) + subjLineMatch[0].length)
      // Strip a stray, label-only "BODY:" line if the model left one behind.
      .replace(/^\s*BODY\s*:?\s*/i, "")
      .trim();
    if (subject && afterSubject.length > 20) {
      return { subject, body: afterSubject };
    }
  }

  // Pass B: legacy JSON.parse on the full stripped text.
  let cleaned = stripped;
  try {
    const parsed = JSON.parse(cleaned) as EmailPayload;
    if (parsed.body && typeof parsed.body === "string") {
      parsed.body = parsed.body.replace(/\\n/g, "\n");
    }
    if (parsed.subject && parsed.body) return parsed;
  } catch {
    /* fall through */
  }

  // Pass C: trim to the first {…last} block, parse again.
  const cStart = cleaned.indexOf("{");
  const cEnd = cleaned.lastIndexOf("}");
  if (cStart !== -1 && cEnd !== -1 && cEnd > cStart) {
    cleaned = cleaned.slice(cStart, cEnd + 1);
    try {
      const parsed = JSON.parse(cleaned) as EmailPayload;
      if (parsed.body && typeof parsed.body === "string") {
        parsed.body = parsed.body.replace(/\\n/g, "\n");
      }
      if (parsed.subject && parsed.body) return parsed;
    } catch {
      /* fall through */
    }
  }

  // Pass D: regex-extract "subject" / "body" fields from broken JSON.
  const subjectMatch = cleaned.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  const bodyMatch = cleaned.match(/"body"\s*:\s*"([\s\S]*?)"\s*[,}]/i);
  if (subjectMatch && bodyMatch) {
    return {
      subject: subjectMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim(),
      body: bodyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim(),
    };
  }

  // Pass E (last-chance heuristic): the model dropped both markers and JSON.
  // Look for the universal email opener "Hi <Name>," and treat everything from
  // there as the body; synthesise a sensible subject from the first body line.
  const greetingIdx = stripped.search(/^[ \t]*Hi[ \t]+[A-Za-z][^\n]{0,50},\s*$/m);
  if (greetingIdx !== -1) {
    const body = stripped.slice(greetingIdx).trim();
    // Try to find an explicit subject line above the greeting; else build one.
    const above = stripped.slice(0, greetingIdx).trim();
    const subjectFromAbove = above.match(/(?:Subject\s*:?\s*)?(.+?)(?:\n|$)/i)?.[1]?.trim();
    const synthesisedSubject = subjectFromAbove && subjectFromAbove.length > 5 && subjectFromAbove.length < 120
      ? subjectFromAbove.replace(/^["'*_]+|["'*_]+$/g, "")
      : "Quick note about your role";
    return { subject: synthesisedSubject, body };
  }

  // Truly unparseable — log first 600 chars so we can see what came back, then
  // throw so the caller falls through to the next model.
  console.warn("[generate-email] All passes failed. Raw content (first 600 chars):");
  console.warn(content.slice(0, 600));
  throw new Error("Failed to parse Gemini response (no SUBJECT/BODY or valid JSON found)");
}

// Custom error so the route can surface a friendly message + retry hint to the UI.
class GeminiQuotaError extends Error {
  retrySeconds: number;
  constructor(message: string, retrySeconds: number) {
    super(message);
    this.retrySeconds = retrySeconds;
  }
}

// Gemini — try the live free-tier models in priority order.
// Every model below was live-tested against our own API key with the exact
// generationConfig used here (1200 max tokens, thinking disabled) and returned
// finishReason=STOP with real text.
//
// Removed because they are dead on this key:
//   • gemini-2.5-flash-lite / gemini-2.5-flash → "no longer available to new users"
//   • gemini-2.5-pro / gemini-pro-latest / gemini-2.0-flash → free-tier quota is 0
//
// Order: cheapest/fastest lite models first, heavier flash models as fallback.
// The "-latest" aliases are preferred over pinned previews so Google's own
// rotation keeps them alive when a specific preview is retired.
// 12s timeout × 5 models = ~60s worst case (still under the 2-min target).
async function generateWithGemini(prompt: string): Promise<EmailPayload> {
  const models = [
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-flash-latest",
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
  ];
  // Hop to next model on these — 429 quota, 4xx config, 5xx transient, or timeout.
  const RECOVERABLE = new Set([400, 403, 404, 429, 500, 502, 503, 504]);
  let lastError = "";
  let maxRetrySecs = 0;
  let allQuotaHit = true; // becomes false the moment we see a non-quota error

  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          // CRITICAL: gemini-2.5 models default to "thinking mode" which silently
          // burns 1000+ output tokens on internal reasoning BEFORE the reply text
          // — that's why finishReason=MAX_TOKENS was firing at only 246 chars
          // even with maxOutputTokens=1500. Disable thinking so the full budget
          // goes to the actual email body.
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1200,
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        // 12s ceiling — gemini-2.5-flash-lite usually replies in 2-3s, but sometimes
        // takes 7-8s. 8s was truncating slow-but-working calls; 12s gives headroom
        // while still keeping worst-case under 36s across all 3 models.
        { headers: { "Content-Type": "application/json" }, timeout: 12000 }
      );
      const candidate = res.data.candidates?.[0];
      const content = candidate?.content?.parts?.[0]?.text;
      const finishReason = candidate?.finishReason;
      if (!content) {
        lastError = `${model}: empty response (finishReason=${finishReason || "unknown"})`;
        allQuotaHit = false;
        continue;
      }
      console.log(`[generate-email] Used ${model} · finishReason=${finishReason} · ${content.length} chars`);
      // If finishReason is MAX_TOKENS, the body got truncated mid-sentence.
      // Try the next model rather than returning a half-email.
      if (finishReason === "MAX_TOKENS") {
        lastError = `${model}: hit MAX_TOKENS — output truncated`;
        allQuotaHit = false;
        continue;
      }
      return extractJSON(content);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const errData = err.response?.data;
        const errMsg = errData?.error?.message || err.message;
        lastError = `${model}: ${errMsg}`;
        console.warn(`[generate-email] ${model} failed:`, errMsg);

        const status = err.response?.status;
        // Capture the longest "retry in Xs" so we can tell the user how long to wait.
        const retryMatch = String(errMsg).match(/retry in ([\d.]+)s/i);
        if (retryMatch) {
          const secs = Math.ceil(parseFloat(retryMatch[1]));
          if (secs > maxRetrySecs) maxRetrySecs = secs;
        }
        if (status !== 429) allQuotaHit = false;

        if (!status || RECOVERABLE.has(status) || err.code === "ECONNABORTED") continue;
        throw err;
      }
      allQuotaHit = false;
      throw err;
    }
  }

  // Gemini is out — try Groq before giving up. Groq has a separate 30 RPM free
  // quota on llama-3.3-70b-versatile, so when Gemini's 20 RPM bucket is empty
  // we usually still have headroom on the Groq side.
  console.log("[generate-email] All Gemini models exhausted — falling back to Groq Llama 3.3 70B");
  try {
    const groqResult = await generateWithGroq(prompt);
    if (groqResult) return groqResult;
  } catch (err) {
    console.warn("[generate-email] Groq fallback also failed:", (err as Error).message);
  }

  // Every provider failed. If every Gemini failure was a 429 quota hit, throw a
  // friendly quota-specific error so the route can surface a "wait Xs" message.
  if (allQuotaHit && maxRetrySecs > 0) {
    throw new GeminiQuotaError(
      `All providers quota-limited. Try again in ~${maxRetrySecs}s.`,
      maxRetrySecs
    );
  }
  throw new Error(`All models failed. Last error: ${lastError}`);
}

// Groq fallback — uses the OpenAI-compatible chat completions API. Llama 3.3 70B
// has a 30 RPM free tier that's independent of Gemini's quota, so it kicks in
// when Gemini's 20 RPM bucket has been drained.
async function generateWithGroq(prompt: string): Promise<EmailPayload | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.log("[generate-email] GROQ_API_KEY not set — skipping Groq fallback");
    return null;
  }
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 1200,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 15000,
      }
    );
    const content: string = res.data?.choices?.[0]?.message?.content || "";
    if (!content) {
      console.warn("[generate-email] Groq returned empty content");
      return null;
    }
    console.log(`[generate-email] Used groq:llama-3.3-70b-versatile · ${content.length} chars`);
    return extractJSON(content);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.warn("[generate-email] Groq error:", err.response?.data?.error?.message || err.message);
    }
    return null;
  }
}


export async function POST(req: NextRequest) {
  try {
    const { job, contactName, companyName, stage = 1, customPrompt, promptMode, basePromptBody } =
      await req.json();
    // promptMode controls how `customPrompt` is used:
    //   "append"  (default) → fixed Manatanu prompt + customPrompt as a
    //                          highest-priority override. Used by the
    //                          Regenerate / "Add instructions" panel.
    //   "replace"           → customPrompt IS the prompt. The fixed
    //                          Manatanu template is NOT sent at all; we
    //                          only attach the lead details + output
    //                          format so the email can personalise and
    //                          parse. Used by the saved-prompt dropdown.
    const mode: "append" | "replace" = promptMode === "replace" ? "replace" : "append";

    // ── Step 1: request received ─────────────────────────────────────
    console.log(
      `\n[generate-email] ── NEW REQUEST ──────────────────────────────`
    );
    console.log(
      `[generate-email] job="${job?.title ?? "?"}" company="${companyName ?? "?"}" stage=${stage}`
    );
    console.log(
      `[generate-email] promptMode(raw)=${JSON.stringify(promptMode)} → resolved mode="${mode}"`
    );
    console.log(
      `[generate-email] customPrompt present? ${
        typeof customPrompt === "string" && customPrompt.trim().length > 0
          ? `YES (${customPrompt.trim().length} chars)`
          : "NO"
      }`
    );

    const firstName = (contactName || "Hiring Manager").split(" ")[0];
    void firstName; // Greeting now baked into the Manatanu template ("Hi there,").

    // Legacy 3-stage freelance templates kept for reference / rollback.
    // The active prompt below is the Manatanu B2B HTML email — see further
    // down. Re-enable the freelance flow by swapping `finalPrompt` to use
    // these templates again.
    const stageTemplates: Record<number, string> = {
      1: `EMAIL 1 — THE TRIGGER (Day 0)
Subject: {company_name}'s {job_title} opening

Hi {first_name},

[ONE direct hook, 12-18 words, starting with "Your focus on" or "The combination of" or "Your work on" — name 1-2 SPECIFIC things from the JD + the real-world theme. NO "I was going through" preamble.]

I'm a freelance [INSERT IDENTITY THAT MATCHES THE JD ROLE — see Identity Map in rule 3 below], and recently I've [ONE flowing sentence with 3 concrete things matching THIS JD's stack — see Projects Map in rule 5. Use past simple: "built X, designed Y, and shipped Z". DO NOT copy generic AI/ML examples if the role isn't AI/ML.]

So this feels very aligned with the kind of systems I usually build and optimize.

I can suggest a practical approach based on your use case.

Quick question — [ONE smart, specific question tied to THEIR JD, ~12-18 words, plain prose ending with "?".]

Based on that, I can share a similar build I've done that maps closely.

Happy to connect if this sounds useful.

Best regards,
Pawanpreet Singh
[Contact / Portfolio Link]`,

      2: `EMAIL 2 — THE CASE STUDY (Day 3)
Subject: Re: {company_name}'s {job_title} opening

Hi {first_name},

Quick follow-up — wanted to share a quick example since I didn't hear back yet.

I recently shipped [ONE SPECIFIC past project that mirrors THIS JD's stack — pull the project type from Projects Map rule 5. e.g. for an AI/ML JD: "a RAG-powered support assistant on Pinecone + GPT-4o for a US fintech client"; for a Data Analyst JD: "a Tableau marketplace-metrics dashboard backed by SQL pipelines for a job-tech client"]. Took ~6 weeks end-to-end and the stack lined up almost exactly with what {company_name} is hiring for.

[ONE concrete outcome line, 1 sentence, with a specific number or measurable improvement. e.g. "Cut their support-resolution time from 12 minutes to under 2." OR "Got their cohort-retention reporting from a weekly 4-hour manual job down to a self-serve dashboard."]

Happy to walk through the architecture or share the repo if useful.

Quick question — would a 15-min call this week work, or should I send a written walk-through first?

Best regards,
Pawanpreet Singh
[Contact / Portfolio Link]`,

      3: `EMAIL 3 — THE BREAKUP (Day 7)
Subject: Re: {company_name}'s {job_title} opening

Hi {first_name},

Totally understand if the timing isn't right or you've already moved forward with someone for the {job_title} role.

I'll close this thread on my end. If you ever need an extra pair of hands on [DOMAIN-MATCHED phrase based on JD — see Identity Map. e.g. for AI/ML: "AI/ML or LLM work"; for Data Analyst: "data + analytics work"; for DevOps: "infra / DevOps work"; for Frontend: "React / frontend work"] — full builds, audits, or just a second opinion — I'm around.

Wishing {company_name} the best with the search.

Best regards,
Pawanpreet Singh
[Contact / Portfolio Link]`,
    };

    // Job description trimmed to 2500 chars for faster Gemini response. The first
    // 2500 chars typically include the role intro + responsibilities + most of
    // required skills, which is enough for personalization. Bumping higher slows
    // each generation noticeably without much email-quality gain.
    const jobDescription = (job.description || "").substring(0, 2500);

    // Legacy freelance prompt — kept inside an unused string so it doesn't
    // run, but stays version-controlled for easy rollback.
    const _legacyFreelancePrompt = `You are writing a SHORT, HIGH-CONVERSION, HUMAN-LIKE pitch email from a FREELANCE engineer applying to a job posting. Voice is "I", not "we". This is a freelancer reaching out to the hiring manager — not an agency selling a team.

ABOUT ME (the freelancer):
- Freelance AI/ML engineer (also full-stack capable)
- Skills: LLMs, RAG, vector DBs (Pinecone/FAISS), Automation (n8n / Zapier / APIs), Python, Node, FastAPI/Django, React, deployment on AWS/GCP
- I build real-world production systems, not just prototypes
- Top-rated on Upwork (US/UK clients)
- Indian — can plug in fast, work async

LEAD DETAILS:
- Company: ${companyName}
- Contact first name: ${firstName}
- Job title: ${job.title}
- Location: ${job.location || "N/A"}
- Job type: ${job.jobType || "N/A"}
- Full job description:
"""
${jobDescription}
"""

TEMPLATE TO FOLLOW (personalize heavily based on the job description above):
${stageTemplates[stage as number] || stageTemplates[1]}

PERSONALIZATION RULES:
1. READ the full job description carefully and pull out 2-4 SPECIFIC technical phrases by name. Examples of specific (good): "RAG systems", "Pinecone/FAISS", "n8n workflows", "LLaMA/Mistral", "Snowflake + Airflow", "Kubernetes", "GraphQL APIs". Examples of generic (BAD): "looking for expertise", "building and deploying ML models", "scalable AI solutions", "intelligent systems".
2. The HOOK is sentence 1 — DIRECT, 12-18 words, NO preamble like "I was going through your requirement". Start with "Your focus on" / "The combination of" / "Your work on" / "Your push toward" + 1-2 specific things from the JD + the real-world theme. e.g. "Your focus on combining LLMs with workflow automation for real business use cases really stood out to me."
3. IDENTITY MAP — pick the freelancer identity that fits the JD role. The "I'm a freelance ___ engineer" line MUST match. NEVER say "AI/ML engineer" for a Data Analyst / Frontend / DevOps role — sounds like spam:
   - JD = Data Analyst / Data Scientist / BI / Analytics → "I'm a freelance data analyst"
   - JD = Data Engineer / ETL / Pipeline → "I'm a freelance data engineer"
   - JD = AI/ML / GenAI / LLM / NLP → "I'm a freelance AI/ML engineer"
   - JD = DevOps / SRE / Cloud / Platform → "I'm a freelance DevOps engineer"
   - JD = Frontend / UI / React → "I'm a freelance frontend engineer"
   - JD = Backend (Python/Node/Java) → "I'm a freelance backend engineer"
   - JD = Mobile (iOS/Android/RN/Flutter) → "I'm a freelance mobile engineer"
   - JD = Full Stack → "I'm a freelance full-stack engineer"
   - JD = WordPress / PHP → "I'm a freelance WordPress developer"
   - JD = QA / Test / SDET → "I'm a freelance QA automation engineer"

4. The "recently I've" sentence is ONE flowing past-simple prose sentence (NOT a bulleted list) that names 3 concrete things separated by commas + "and". Each thing must include a specific tech name FROM the same domain as the JD identity. Use past simple verbs: "built X, designed Y, and shipped Z". This sentence MIRRORS their JD's vocabulary — never copy the AI/ML example below if the role is anything else.
4. The SMART QUESTION starts with "Quick question — " and is ~12-18 words specific to their JD, plain prose ending with "?", inviting a thoughtful reply (not yes/no). Examples:
   - "Quick question — are you planning to build this from scratch, or improve an existing AI workflow?"
   - "Quick question — is the RAG side already in production, or still at proof-of-concept stage?"
   - "Quick question — are you optimising more for latency or accuracy on the LLM side?"
   This question is THE reply driver — don't skip, don't make it generic.
4a. RIGHT BEFORE the smart question, include a single value-signal line: "I can suggest a practical approach based on your use case." (or a close natural variant). This signals "solution mindset" — the email isn't just intro, there's a concrete next step. Keep it ONE short sentence.
4b. RIGHT AFTER the smart question, include a single follow-through line that promises specifics if they reply. e.g. "Based on that, I can share a similar build I've done that maps closely." Keep it concrete, no fluff.
5. PROJECTS MAP — concrete past-simple example projects per JD role. Pick the row that matches THIS JD and write a NATURAL sentence using 3 of these patterns. NEVER name tech that's irrelevant to the JD. Examples (use as inspiration, vary the wording):
   - AI/ML / GenAI / LLM → "built RAG systems using Pinecone, fine-tuned LLaMA/Mistral models, and shipped LLM-powered apps with FastAPI in production"
   - Data Analyst / BI → "built SQL pipelines feeding Tableau dashboards for marketplace metrics, designed cohort and funnel analyses for retention, and ran A/B tests for product experiments"
   - Data Engineer → "built Airflow DAGs orchestrating Snowflake ETL pipelines, designed Kafka streams for real-time events, and shipped data-quality checks across 100+ datasets"
   - DevOps / SRE → "built Kubernetes deployments on AWS/GCP, automated CI/CD with GitHub Actions and Terraform, and shipped observability stacks (Prometheus + Grafana)"
   - Frontend → "built React/Next.js production apps with TypeScript, designed a shared component library with Tailwind, and shipped server-side-rendered SEO-heavy pages"
   - Backend Python → "built Django/FastAPI services backed by Postgres, designed async task queues with Celery, and shipped REST/GraphQL APIs for high-traffic apps"
   - Backend Node → "built Express/Nest APIs on MongoDB and Postgres, designed real-time features with Socket.io, and shipped microservices on AWS Lambda"
   - Mobile → "built cross-platform React Native and Flutter apps, designed offline-first sync layers, and shipped 10+ apps to App Store and Play Store"
   - Full Stack → "built MERN/PERN production apps on AWS, designed REST and GraphQL APIs end-to-end, and shipped CI/CD-driven deployment pipelines"
   - WordPress / PHP → "built custom WordPress plugins and themes, designed Laravel APIs with MySQL, and shipped WooCommerce integrations for clients"
   - QA / Test → "built end-to-end Cypress / Playwright suites, designed CI test pipelines on GitHub Actions, and shipped Selenium-based regression frameworks"
6. Tone: experienced freelancer writing to a hiring manager — confident, specific, no-fluff. Don't sound salesy. Don't beg. Don't overstate. Speak as a peer.

WRITING RULES:
- Total length: 100-140 words. KEEP IT TIGHT — every sentence must earn its place. Cut filler like "I was going through your requirement", "Before I share more", "If this sounds relevant" — replace with direct equivalents.
- ABSOLUTELY NO formatting — no bullets ("*" or "•" or "-"), no markdown bold ("**"), no italics, no headings. Pure flowing prose. Markdown markers show up literally in plain-text email and scream "AI-generated".
- Use actual company name + job title + first name (NEVER leave template placeholders like {first_name} or [LIST...]).
- Greeting: "Hi {first_name},". If first name unknown / "Hiring Manager", use just "Hi,". NEVER "Hi there,".
- Closing line before sign-off: "Happy to connect if this sounds useful." (or natural variation, ~7 words max).
- Sign off exactly: "Best regards,\\nPawanpreet Singh\\n[Contact / Portfolio Link]" — keep the placeholder exactly so the user can swap it later.
- BANNED phrases (refuse to use): "looking for expertise", "building and deploying", "scalable AI solutions", "intelligent systems", "drive business value", "leverage", "synergy", "cutting-edge", "robust solutions", "best-in-class", "50-60% cheaper", "save cost".

Return your reply in EXACTLY this format (NOT JSON — JSON breaks on multi-line bodies):

SUBJECT: <one-line personalized subject>
BODY:
<the full email body, multiple paragraphs separated by blank lines, no escaping needed>

Do not output anything before "SUBJECT:" or after the body. Do not wrap in code fences.`;
    void _legacyFreelancePrompt;

    // ─── Prompt inputs ───────────────────────────────────────────────────
    // Lead ki details ek object me — yahi teeno prompt builders ko jaata hai.
    const lead: PromptLead = {
      jobTitle: job.title,
      companyName,
      contactName: contactName || "",
      location: job.location,
      jobType: job.jobType,
      jobDescription,
    };

    // Fixed Manatanu B2B HTML email prompt — poora text
    // lib/prompts/email-prompt.ts me hai.
    const prompt = buildManatanuPrompt(lead);

    const trimmedCustom =
      typeof customPrompt === "string" && customPrompt.trim().length > 0
        ? customPrompt.trim()
        : "";
    const trimmedBase =
      typeof basePromptBody === "string" && basePromptBody.trim().length > 0
        ? basePromptBody.trim()
        : "";

    // Resolve the BASE prompt + the override instructions:
    //   • basePromptBody present  → base = that saved prompt (new combined flow:
    //                               selected prompt, optionally + instructions).
    //   • legacy mode==="replace" → customPrompt itself WAS the saved prompt.
    //   • otherwise               → base = fixed Manatanu prompt; customPrompt (if
    //                               any) is the instruction override (append).
    const savedBase = trimmedBase || (mode === "replace" ? trimmedCustom : "");
    const instructions = trimmedBase
      ? trimmedCustom // new flow: saved-prompt base + (optional) instructions
      : mode === "replace"
      ? "" // legacy replace: saved prompt only, no separate instructions
      : trimmedCustom; // append: instructions layered on the fixed Manatanu base

    let finalPrompt: string;
    if (savedBase) {
      // Base = the selected saved prompt. Manatanu fixed template EXCLUDED.
      finalPrompt = buildSavedPromptScaffold(savedBase, lead);
      if (instructions) finalPrompt += buildOverrideBlock(instructions);
      console.log(
        `[generate-email] ▶ SAVED-PROMPT base${
          instructions ? " + instructions override" : ""
        } (Manatanu fixed prompt EXCLUDED).`
      );
    } else {
      // Base = fixed Manatanu prompt. Instructions (if any) layered on top.
      finalPrompt = prompt + (instructions ? buildOverrideBlock(instructions) : "");
      console.log(
        instructions
          ? `[generate-email] ▶ FIXED Manatanu prompt + instructions override.`
          : `[generate-email] ▶ FIXED Manatanu prompt only (baseline).`
      );
    }

    // ── Step 2: prompt assembled ─────────────────────────────────────
    console.log(
      `[generate-email] final prompt length = ${finalPrompt.length} chars`
    );
    console.log('final report', finalPrompt);       
    console.log("[generate-email] → calling Gemini…");
    const result: EmailPayload = await generateWithGemini(finalPrompt);
    console.log(
      `[generate-email] ✓ Gemini returned · subject="${(result.subject || "").slice(0, 60)}" · body=${(result.body || "").length} chars`
    );

    if (!result.subject || !result.body) {
      throw new Error("AI returned invalid email format");
    }

    // Strip code-fence wrappers if the model accidentally added them
    // around the HTML body, and trim leading/trailing whitespace.
    result.body = result.body
      .replace(/^\s*```(?:html)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    console.log(
      `[generate-email] ✅ DONE (mode="${mode}") · returning email to client\n`
    );
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[generate-email] Error:", error);
    if (error instanceof GeminiQuotaError) {
      // 429 — surface a friendly user-facing message + machine-readable retry hint.
      return NextResponse.json(
        {
          success: false,
          error: `Gemini free-tier quota exhausted. Wait ~${error.retrySeconds}s and try again. (Or upgrade to a paid plan in Google AI Studio.)`,
          retryAfter: error.retrySeconds,
          quotaExceeded: true,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
