import { chromium, type Browser } from "playwright";

// Playwright-based LinkedIn job description fetcher.
// Used by Method 2 (Gmail parser) only — Method 1 relies on Apify directly.
// Renders the page in a real headless browser so the JS-expanded full
// description becomes available in the DOM (cheerio can't see this).

const VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Single shared browser instance for the lifetime of the process. Launching is
// expensive (~1-2 s) so we reuse, only closing if Node tears down.
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (launching) return launching;
  launching = chromium
    .launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    })
    .then((b) => {
      sharedBrowser = b;
      launching = null;
      return b;
    })
    .catch((err) => {
      launching = null;
      throw err;
    });
  return launching;
}

// Returns the longest description text we can scrape from a LinkedIn job page.
// "" on any failure (login wall, timeout, layout change), letting callers fall back.
export async function fetchLinkedInJobDescriptionPlaywright(url: string): Promise<string> {
  if (!url || !/linkedin\.com\/jobs\/view\/\d+/.test(url)) return "";

  let context = null;
  let page = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: VIEWPORT,
      locale: "en-US",
      javaScriptEnabled: true,
      // Skip heavy assets to speed up — we only care about HTML & inline scripts.
      bypassCSP: true,
    });
    // Block images/fonts/media to make page-loads ~3x faster.
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media" || t === "stylesheet") {
        return route.abort();
      }
      return route.continue();
    });

    page = await context.newPage();
    page.setDefaultTimeout(15000);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Try clicking "Show more" buttons to unfold the full description if a clamp is present.
    // Selectors below cover both the public guest view and the legacy layout.
    const showMoreSelectors = [
      "button.show-more-less-html__button",
      "button[aria-label*='more']",
      "button.show-more-less-button",
    ];
    for (const sel of showMoreSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          break;
        }
      } catch {
        /* selector missing or blocked, skip */
      }
    }

    // Give any post-click animation/render a beat.
    await page.waitForTimeout(500);

    // Pull the longest candidate from the DOM. We try multiple selectors and keep the longest.
    const description: string = await page.evaluate(() => {
      const selectors = [
        ".show-more-less-html__markup",
        ".show-more-less-html__markup--clamp-after-5",
        ".description__text",
        ".description__text--rich",
        ".jobs-description__container",
        ".jobs-description-content__text",
        "section.description",
        "[data-test-description-text]",
        "#job-details",
      ];
      let best = "";
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        els.forEach((el) => {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length > best.length) best = text;
        });
      }
      // Also try JSON-LD as a fallback.
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      ldScripts.forEach((s) => {
        try {
          const json = JSON.parse(s.textContent || "{}");
          const items = Array.isArray(json) ? json : Array.isArray(json["@graph"]) ? json["@graph"] : [json];
          for (const it of items) {
            if (it && typeof it.description === "string") {
              const cleaned = it.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
              if (cleaned.length > best.length) best = cleaned;
            }
          }
        } catch {
          /* ignore */
        }
      });
      return best;
    });

    return (description || "").substring(0, 2500);
  } catch (err) {
    console.log(`[playwright-fetcher] error ${url}: ${(err as Error).message}`);
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}
