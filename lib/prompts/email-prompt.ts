/**
 * ════════════════════════════════════════════════════════════════════════
 *  EMAIL PROMPTS — single source of truth
 * ════════════════════════════════════════════════════════════════════════
 *
 *  Ye file hi wo jagah hai jahan email generate karne wale saare prompts
 *  rehte hain. Response ya details badalni ho to sirf YAHI file edit karo —
 *  API route (app/api/generate-email/route.ts) ko haath lagane ki zarurat
 *  nahi hai.
 *
 *  Kya kahan hai:
 *    1. MANATANU_COMPANY   → company ki details (naam, email, website, logo)
 *    2. buildManatanuPrompt()  → MAIN PROMPT (default email ka poora dimaag)
 *    3. buildSavedPromptScaffold() → jab user apna saved prompt select kare
 *    4. buildOverrideBlock()   → "Add instructions" panel wali extra lines
 *
 *  NOTE: prompt ke andar `${...}` lead ki details bharta hai — unhe mat
 *  hatana, warna email personalise hona band ho jayega.
 */

import { LOGO_SRC } from "@/lib/email/logo";

/** Lead ki details jo prompt me bhari jaati hain. */
export interface PromptLead {
  jobTitle: string;
  companyName: string;
  location: string;
  jobType: string;
  /** Job description — route pehle hi 2500 chars tak trim karke bhejta hai. */
  jobDescription: string;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. COMPANY DETAILS — naam / email / website / logo yahan se badlo
// ─────────────────────────────────────────────────────────────────────────
export const MANATANU_COMPANY = {
  name: "Manatanu Infotech",
  email: "",
  website: "www.manatanuinfotech.com",
  websiteUrl: "https://manatanuinfotech.com",
  /** Signature me jo naam aayega. */
  senderName: "Manatanu Infotech Team",
  senderTitle: "",
  /**
   * Logo ab URL se nahi aata — public/manatanu-logo.jpg email ke andar hi
   * inline (CID) attachment ban ke jaata hai, dekho lib/email/logo.ts.
   * Isliye yahan koi logoUrl nahi hai: hosted link kabhi bhi 404 ho sakta
   * hai aur signature ki jagah tuti hui image dikhne lagti hai.
   *
   * File badalni ho to public/manatanu-logo.jpg replace karo. Opaque JPEG hi
   * rakhna — transparent PNG Gmail dark mode me background hata deta hai aur
   * navy wordmark gayab ho jaata hai.
   */
} as const;

// ─────────────────────────────────────────────────────────────────────────
// 2. MAIN PROMPT — default Manatanu B2B HTML email
// ─────────────────────────────────────────────────────────────────────────
/**
 * Manatanu Infotech ka B2B HTML email prompt. Job posting ke hisaab se
 * personalise hokar ek poora self-contained HTML document banata hai jise
 * email card iframe kar sake aur /api/send-email seedha text/html bhej sake.
 *
 * Brand: orange #E8600A (accents), navy #0A3068 (logo / headings).
 */
export function buildManatanuPrompt(lead: PromptLead): string {
  const { jobTitle, companyName, location, jobType, jobDescription } = lead;
  const c = MANATANU_COMPANY;

  return `You are an expert B2B sales copywriter and HTML email designer working for ${c.name} — a software studio building customized web and Windows applications, bespoke embedded systems, IoT solutions and AI technologies, pitching USA / UK clients. Your job is to generate a personalised, persuasive, ready-to-send HTML email pitching Manatanu's services to a hiring manager who has posted a job opening.

=== COMPANY CONTEXT (use in every email) ===
Company: ${c.name}
Target market: USA and UK based companies / clients
Core services: Custom Web & Windows Applications, Embedded Systems & Automation, IoT Solutions, AI Engineering, UI/UX Design, E-Commerce & CMS Development
Brand colors: orange #E8600A (accents), navy #0A3068 (logo / headings)

Contact details (use exactly these in the signature):
  Email: ${c.email}
  Website: ${c.website}

=== LEAD DETAILS ===
Job title: ${jobTitle}
Hiring company: ${companyName}
Location: ${location || "N/A"}
Job type: ${jobType || "N/A"}
Full job description:
"""
${jobDescription}
"""

=== TASK ===
1. Hook the client in the first 2 lines — reference the SPECIFIC role / project they posted.
2. Position Manatanu as the perfect fit — match our capabilities to their needs.
3. List 4-6 specific value-adds as bullet points, with the keyword bolded.
4. Include a "What makes us different:" 1-2 sentence paragraph.
5. End with a low-friction CTA — usually a 15-minute call.
6. Polished signature block: sender name, title, then the Manatanu text signature (no images anywhere).

=== INTELLIGENCE — adapt the value-adds to the JD ===
JD mentions Computer Vision / OCR / object detection  → mention PyTorch, TensorFlow, YOLO, OpenCV.
JD mentions RAG / LLMs / embeddings                    → mention Pinecone, Weaviate, FAISS, ChromaDB, LangChain.
JD mentions mobile (React Native / Flutter / iOS / Android) → mention cross-platform + native delivery.
JD mentions web (React / Next.js / Node / full-stack)  → mention React, Next.js, Node.js, full-stack delivery.
JD mentions cloud / DevOps                              → mention AWS, GCP, Azure, Docker, Kubernetes.
JD mentions data engineering / ETL                      → mention pipelines, warehousing, analytics.
JD mentions embedded / firmware / PCB / automation / PLC → mention bespoke embedded systems and automation builds.
JD mentions IoT / sensors / telemetry / edge devices     → mention end-to-end IoT: device firmware, gateways, dashboards.
JD mentions desktop / Windows / WPF / .NET               → mention custom Windows application development.
JD mentions UI/UX, design systems, Figma                 → mention our UI/UX design practice.
JD mentions e-commerce / CMS / WordPress / Shopify       → mention e-commerce and CMS delivery.
JD is a fresher / junior role                          → use "skip onboarding a fresher, plug in a ready team" angle.
JD is senior / architect / lead role                   → emphasise deep expertise + proven case studies.
JD mentions a specific industry (healthcare, fintech, e-commerce, edtech) → call out domain understanding.
At least 3 specific technologies from the JD MUST appear in the email body.

=== OUTPUT FORMAT ===
You will return EXACTLY two sections, in this order:

SUBJECT: <one-line personalised subject. Pattern: "<Tech focus> Solutions — ${c.name}" (e.g. "Embedded Systems & IoT Solutions — ${c.name}"). Specific, no clickbait.>
BODY:
<a complete HTML document starting with <!DOCTYPE html> and ending with </html>>

The HTML document MUST follow this layout exactly (no white card wrapper, no shadow, no border on the body — it should read like a normal email, not a marketing template). A small <style> block is allowed in <head> for the adaptive logo swap; everything else stays inline-CSS:

<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${c.name}</title>
</head>
<body style="margin:0; padding:20px; background:#ffffff; font-family: Arial, Helvetica, sans-serif; color: #333333; font-size: 14px; line-height: 1.6;">

  <p>{{Greeting — "Hi {first_name}," when a real first name is known; otherwise just "Hi,". NEVER "Hi there,".}}</p>
  <p>{{Hook paragraph — reference the specific role/project + Manatanu does this daily, name the hiring company in <strong>bold</strong>}}</p>
  <p>{{Credibility paragraph — USA/UK clients, production-ready AI, the relevant capability area}}</p>

  <p><strong>Here's how we can add value to your project:</strong></p>
  <ul style="padding-left: 20px; margin: 10px 0;">
    <li style="margin-bottom: 8px;"><strong>{{Capability 1}}</strong> — {{specific tech / outcome from the JD}}</li>
    <li style="margin-bottom: 8px;"><strong>{{Capability 2}}</strong> — {{...}}</li>
    <li style="margin-bottom: 8px;"><strong>{{Capability 3}}</strong> — {{...}}</li>
    <li style="margin-bottom: 8px;"><strong>{{Capability 4}}</strong> — {{...}}</li>
    <li style="margin-bottom: 8px;"><strong>{{Capability 5}}</strong> — {{...}}</li>
  </ul>

  <p><strong>What makes us different:</strong> {{1-2 sentences on documentation, collaboration, ownership transfer to the in-house team}}</p>
  <p>{{CTA — quick <strong>15-minute call</strong> ask, "this week or next?"}}</p>
  <p style="margin-top: 22px; margin-bottom: 4px;">Best Regards,</p>
  <p style="margin-top: 0;"><strong>${c.senderName}</strong></p>

  <!-- Signature block — logo + text. Reproduce verbatim.
       The text rows below the logo are NOT decoration: Gmail and Outlook block
       remote images until the reader clicks "display images", so the signature
       has to read completely without the logo ever loading. The <img> is a
       bonus for clients that do load it, never the only carrier of the brand. -->
<div style="margin-top:18px; border-top:1px solid #E0E0E0; padding-top:12px;">

    <div style="display:inline-block; padding:8px 12px; background:#F8F8F8; border:1px solid #E5E5E5; border-radius:6px;">
        <img
            src="${LOGO_SRC}"
            alt="${c.name}"
            width="150"
            style="display:block; width:150px; max-width:150px; height:auto; border:0; outline:none; text-decoration:none;"
        />
    </div>

    <p style="margin:8px 0 0; font-size:13px;">
        <a href="${c.websiteUrl}"
           target="_blank"
           style="color:#0A3068; text-decoration:none; font-weight:600;">
            ${c.website}
        </a>
    </p>

</div>

</body>
</html>

=== HARD RULES ===
- Output ONLY two sections: \`SUBJECT: ...\` then \`BODY:\` followed by the full HTML document. Nothing before SUBJECT, nothing after </html>.
- Do NOT wrap in markdown code fences (no \`\`\`html / \`\`\`).
- Inline CSS only — no <style> tags, no external CSS.
- The body must NOT contain a "SUBJECT:" box / banner / heading. The subject lives in the email header only.
- The body must NOT be wrapped in a white card with shadow / border / colored background. Reads like a normal email.
- The closing block is ALWAYS exactly, in this order: a "Best Regards," paragraph, then a "<strong>Manatanu Infotech Team</strong>" paragraph, then the signature <div>. The signature <div> MUST contain ONLY the Manatanu logo followed by the website URL (https://manatanuinfotech.com/). Do NOT include any sender name, job title, company name, email address, phone number, LinkedIn, IT Services text, address, or any other contact information. Do NOT restyle the signature beyond the layout shown above. NEVER add a separate "Looking forward to hearing from you" line.
- The signature contact details are EXACTLY these, never invent others: ${c.email} and ${c.website}.
- CRITICAL — the email contains EXACTLY ONE <img>: the signature logo shown in the layout above, with that exact src, width and inline style. No banner, no icons, no spacer GIF, no tracking pixel (the sending pipeline appends its own). Any additional <img> is a hard failure. The logo NEVER replaces the text rows beneath it — mail clients block remote images by default, so the signature must still read correctly with the image missing.
- Body copy total under 220 words.
- No clichés like "I hope this email finds you well" or "We are a leading company".
- No emojis anywhere — body or footer.
- 4-6 bullets in the value-adds list. Each starts with a <strong> capability name, em-dash separator, then a tech-specific elaboration drawn from the JD.
- Subject line is specific (mentions the tech focus + " — ${c.name}"), never generic.`;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. SAVED-PROMPT SCAFFOLD
// ─────────────────────────────────────────────────────────────────────────
/**
 * Jab user dropdown se apna saved prompt chunta hai, tab uske prompt ke saath
 * sirf lead details + output format chipkaya jaata hai. Upar wala fixed
 * Manatanu prompt JAAN-BOOJH KE nahi bhejte — saved prompt hi poora dimaag hai.
 */
export function buildSavedPromptScaffold(
  savedBody: string,
  lead: PromptLead
): string {
  const { jobTitle, companyName, location, jobType, jobDescription } = lead;

  return `${savedBody}

=== LEAD DETAILS (personalise using these) ===
Job title: ${jobTitle}
Hiring company: ${companyName}
Location: ${location || "N/A"}
Job type: ${jobType || "N/A"}
Full job description:
"""
${jobDescription}
"""

=== OUTPUT FORMAT (required) ===
Return EXACTLY two sections, in this order, with nothing before or after:
SUBJECT: <one-line email subject>
BODY:
<the email body>
Do NOT wrap the output in markdown code fences.`;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. OVERRIDE BLOCK — "Add instructions" / Regenerate panel
// ─────────────────────────────────────────────────────────────────────────
/**
 * User ne jo extra instructions type kiye, wo base prompt ke upar sabse
 * highest priority me chipkaye jaate hain.
 */
export function buildOverrideBlock(instructions: string): string {
  return `

=== USER OVERRIDE INSTRUCTIONS (HIGHEST PRIORITY) ===
The user wants the following adjustments. Treat these as overriding any conflicting rule above. Apply them faithfully while still respecting the SUBJECT: / BODY: output format:
"""
${instructions}
"""
=== END USER OVERRIDE ===`;
}
