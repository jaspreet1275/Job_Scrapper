import axios from "axios";
import * as cheerio from "cheerio";

export interface DorkResult {
  name: string;
  title: string;
  linkedinUrl: string;
  snippet: string;
}

// Parse LinkedIn search result snippet
// Example snippet: "John Doe - CTO - Company Name | LinkedIn"
function parseLinkedInSnippet(title: string, snippet: string, url: string): DorkResult | null {
  // LinkedIn titles usually formatted as: "Name - Title - Company | LinkedIn"
  // or: "Name - Title at Company | LinkedIn"
  const cleaned = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();

  // Pattern 1: "Name - Title - Company"
  const pattern1 = cleaned.match(/^([^-–—]+?)\s*[-–—]\s*(.+?)(?:\s*[-–—]\s*(.+))?$/);
  if (pattern1) {
    const name = pattern1[1].trim();
    const rawTitle = pattern1[2].trim();
    // Skip if name has weird characters
    if (!/^[A-Z]/.test(name) || name.length > 80 || name.length < 3) return null;

    return {
      name,
      title: rawTitle,
      linkedinUrl: url,
      snippet: snippet.substring(0, 200),
    };
  }

  return null;
}

// Search DuckDuckGo for LinkedIn profiles (no API key, free)
export async function googleDorkLinkedIn(
  companyName: string,
  titles: string[] = ["CTO", "Founder", "CEO", "VP Engineering", "Head of Engineering"]
): Promise<DorkResult[]> {
  const results: DorkResult[] = [];

  for (const targetTitle of titles) {
    const query = `site:linkedin.com/in "${targetTitle}" "${companyName}"`;
    console.log(`[dork] Searching: ${query}`);

    try {
      // DuckDuckGo HTML endpoint (no API key)
      const res = await axios.get(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          timeout: 10000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          },
        }
      );

      const $ = cheerio.load(res.data);

      $(".result").each((_, el) => {
        const $el = $(el);
        const titleEl = $el.find(".result__title a");
        const snippet = $el.find(".result__snippet").text().trim();

        let linkedinUrl = titleEl.attr("href") || "";
        // DDG wraps URLs in redirect
        const uddgMatch = linkedinUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          linkedinUrl = decodeURIComponent(uddgMatch[1]);
        }
        if (!linkedinUrl.includes("linkedin.com/in/")) return;

        const title = titleEl.text().trim();
        if (!title) return;

        const parsed = parseLinkedInSnippet(title, snippet, linkedinUrl);
        if (parsed) {
          // Dedupe by linkedinUrl
          if (!results.some((r) => r.linkedinUrl === parsed.linkedinUrl)) {
            results.push(parsed);
          }
        }
      });

      // Rate limit: wait 1s between queries
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.warn(`[dork] Search failed for "${targetTitle}":`, (err as Error).message);
    }

    if (results.length >= 5) break; // Enough results
  }

  console.log(`[dork] Found ${results.length} LinkedIn profiles`);
  return results;
}

// Extract "Report to [Name]" from job description
export function extractReportToFromDescription(description: string): string[] {
  const names: string[] = [];
  const patterns = [
    /report(?:s|ing)?\s+(?:directly\s+)?to\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /manager[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /hiring\s+manager[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const name = match[1].trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
