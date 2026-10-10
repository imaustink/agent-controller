import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
// playwright-extra wraps the real playwright chromium with a plugin system.
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "../config.js";
import { assertUrlAllowed } from "../security/url-guard.js";
import type { SafeUrl } from "../security/url-guard.js";
import type { Extraction } from "../types.js";

// Apply stealth evasions once at module load.
chromium.use(StealthPlugin());

/** Per-host SSRF decision cache to avoid re-resolving on every subresource. */
async function isRequestHostAllowed(
  requestUrl: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  // Non-network schemes (data:, blob:, about:) carry no SSRF risk.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;

  const key = `${parsed.protocol}//${parsed.host}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let allowed = true;
  try {
    await assertUrlAllowed(requestUrl);
  } catch {
    allowed = false;
  }
  cache.set(key, allowed);
  return allowed;
}

/**
 * Loads a page in stealth headless Chromium and extracts the main article
 * text via Readability. Every outbound request is re-checked against the SSRF
 * guard so a page cannot pivot the browser to an internal address.
 */
export async function extractWeb(safe: SafeUrl): Promise<Extraction> {
  const warnings: string[] = [];
  const browser = await chromium.launch({
    args: [
      // The hardened container (cap-drop ALL, read-only, no-new-privileges) is
      // the security boundary, so Chromium's own sandbox is disabled.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width: 1280, height: 1024 },
      javaScriptEnabled: true,
    });
    context.setDefaultNavigationTimeout(config.navTimeoutMs);

    const hostCache = new Map<string, boolean>();
    await context.route("**/*", async (route) => {
      const allowed = await isRequestHostAllowed(route.request().url(), hostCache);
      if (allowed) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });

    const page = await context.newPage();
    await page.goto(safe.url.toString(), { waitUntil: "domcontentloaded" });

    const html = await page.content();
    const pageTitle = await page.title();

    const dom = new JSDOM(html, { url: safe.url.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    let text = article?.textContent?.trim() ?? "";
    if (!text) {
      text = dom.window.document.body?.textContent?.trim() ?? "";
      warnings.push("Readability found no main content; used raw body text");
    }

    return {
      text,
      title: article?.title?.trim() || pageTitle || null,
      sourceType: "web",
      provenance: {
        extractor: "playwright-stealth+readability",
        readabilityUsed: Boolean(article?.textContent),
      },
      warnings,
    };
  } finally {
    await browser.close();
  }
}
