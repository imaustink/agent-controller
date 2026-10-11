// playwright-extra wraps the real playwright chromium with a plugin system.
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "../config.js";
import { assertUrlAllowed } from "../security/url-guard.js";
import type { SafeUrl } from "../security/url-guard.js";
import type { Extraction } from "../types.js";
import { ocrImage } from "./image.js";

// Apply stealth evasions once at module load (same posture as the web lane).
chromium.use(StealthPlugin());

/** Matches the signed CDN host that serves TikTok photo-mode slide images. */
const PHOTOMODE_IMAGE = /i-photomode-tx/i;
/** The detail XHR TikTok fires to hydrate a post; its JSON carries the slide list + caption. */
const ITEM_DETAIL_API = /\/api\/item\/detail\//;

interface TikTokImage {
  imageURL?: { urlList?: string[] };
}

/**
 * Pulls the ordered slide image URLs and caption out of the intercepted
 * `/api/item/detail/` JSON. Shaped defensively — every field is treated as
 * optional untrusted data.
 */
function parseDetail(detail: unknown): { images: string[]; caption: string } {
  const item = (detail as { itemInfo?: { itemStruct?: Record<string, unknown> } })?.itemInfo
    ?.itemStruct;
  const caption = typeof item?.desc === "string" ? item.desc : "";
  const rawImages = (item?.imagePost as { images?: TikTokImage[] } | undefined)?.images ?? [];
  const images = rawImages
    .map((img) => img?.imageURL?.urlList?.[0])
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  return { images, caption };
}

/**
 * Extracts a recipe from a TikTok photo (slideshow) post.
 *
 * These posts are NOT handled by yt-dlp (it reports "Unsupported URL"), and the
 * recipe text lives in the slide images rather than the short caption or the
 * background audio. So this lane loads the post in the same stealth Chromium
 * used by the web lane, intercepts the `/api/item/detail/` response to recover
 * the ordered slide image URLs + caption, downloads each slide **through the
 * browser context** (the signed CDN 403s a plain server-side fetch), and runs
 * every slide through the shared vision-OCR path.
 */
export async function extractTikTokPhoto(safe: SafeUrl): Promise<Extraction> {
  const warnings: string[] = [];
  const browser = await chromium.launch({
    args: [
      // The hardened container is the security boundary, so Chromium's own
      // sandbox is disabled (identical rationale to the web lane).
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

    // Re-check every page-initiated request against the SSRF guard so a page
    // cannot pivot the browser to an internal address (mirrors the web lane).
    const hostCache = new Map<string, boolean>();
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      let allowed = true;
      try {
        const parsed = new URL(requestUrl);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          const key = `${parsed.protocol}//${parsed.host}`;
          const cached = hostCache.get(key);
          if (cached === undefined) {
            try {
              await assertUrlAllowed(requestUrl);
            } catch {
              allowed = false;
            }
            hostCache.set(key, allowed);
          } else {
            allowed = cached;
          }
        }
      } catch {
        allowed = false;
      }
      if (allowed) await route.continue();
      else await route.abort("blockedbyclient");
    });

    const page = await context.newPage();

    // Register the interception BEFORE navigating: the detail XHR often fires
    // during the initial load, so waiting only afterwards would miss it.
    const detailPromise = page
      .waitForResponse((r) => ITEM_DETAIL_API.test(r.url()), { timeout: config.navTimeoutMs })
      .catch(() => null);

    await page.goto(safe.url.toString(), { waitUntil: "domcontentloaded" });

    let images: string[] = [];
    let caption = "";
    const detailResp = await detailPromise;
    if (detailResp) {
      try {
        ({ images, caption } = parseDetail(await detailResp.json()));
      } catch {
        warnings.push("Could not parse TikTok item detail response");
      }
    }

    // Fallback: if the detail XHR was missed, scrape the rendered slide <img>
    // elements. TikTok preloads all photo-mode slides, so they're in the DOM.
    if (images.length === 0) {
      await page.waitForTimeout(3_000);
      const domImages = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img"))
          .map((i) => i.currentSrc || i.src)
          .filter((u) => /i-photomode-tx/i.test(u)),
      );
      images = [...new Set(domImages)];
    }

    if (images.length === 0) {
      warnings.push("No slide images found in the TikTok photo post");
    }

    const slideTexts: string[] = [];
    for (const imgUrl of images.slice(0, config.maxTikTokImages)) {
      try {
        // The images are on a public signed CDN, but re-check anyway: this is
        // untrusted input and the download bypasses the page route guard.
        await assertUrlAllowed(imgUrl);
      } catch {
        warnings.push("Skipped a slide image that failed the SSRF guard");
        continue;
      }
      try {
        const resp = await context.request.get(imgUrl, {
          headers: { referer: "https://www.tiktok.com/" },
          timeout: config.fetchTimeoutMs,
        });
        if (!resp.ok()) {
          warnings.push(`Slide image download failed: HTTP ${resp.status()}`);
          continue;
        }
        const body = await resp.body();
        if (body.length > config.maxImageBytes) {
          warnings.push(`Slide image exceeded the ${config.maxImageBytes}-byte cap`);
          continue;
        }
        const contentType = (resp.headers()["content-type"] ?? "").split(";")[0]!.trim();
        const text = await ocrImage(body, contentType);
        if (text.trim()) slideTexts.push(text.trim());
      } catch (err) {
        warnings.push(`Slide image OCR failed: ${(err as Error).message}`);
      }
    }

    const parts: string[] = [];
    if (caption.trim()) parts.push(`Caption: ${caption.trim()}`);
    slideTexts.forEach((t, i) => parts.push(`Slide ${i + 1}:\n${t}`));

    return {
      text: parts.join("\n\n"),
      title: null,
      sourceType: "tiktok_photo",
      provenance: {
        extractor: "tiktok-photomode-ocr",
        visionModel: config.visionModel,
        imagesFound: images.length,
        slidesTranscribed: slideTexts.length,
      },
      warnings,
    };
  } finally {
    await browser.close();
  }
}
