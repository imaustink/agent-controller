import type { SafeUrl } from "./security/url-guard.js";
import type { SourceType } from "./schema.js";
import { guardedFetch } from "./util/download.js";

/** Hosts that yt-dlp handles well and that we treat as video sources. */
const VIDEO_HOSTS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "vimeo.com",
  "facebook.com",
  "fb.watch",
  "twitter.com",
  "x.com",
  "dailymotion.com",
  "twitch.tv",
  "reddit.com",
];

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isTikTokHost(host: string): boolean {
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

/**
 * TikTok photo (slideshow) posts live under `/photo/` and are NOT handled by
 * yt-dlp (it reports "Unsupported URL"); everything else on TikTok is a video.
 * Short links (`/t/…`, `vm.`/`vt.` hosts) don't reveal which in the path, so
 * we resolve the redirect chain to find out. Any failure falls back to the
 * video lane, preserving prior behavior.
 */
async function classifyTikTok(safe: SafeUrl): Promise<SourceType> {
  let pathname = safe.url.pathname;
  if (!/\/(photo|video)\//.test(pathname)) {
    try {
      const res = await guardedFetch(safe.url.toString(), { method: "HEAD" });
      pathname = new URL(res.url).pathname;
    } catch {
      // Fall through to the video default below.
    }
  }
  return /\/photo\//.test(pathname) ? "tiktok_photo" : "video";
}

/**
 * Classifies a URL into an extractor lane. Domain and extension checks are
 * purely local; only truly ambiguous URLs incur a guarded HEAD request.
 */
export async function classify(safe: SafeUrl): Promise<SourceType> {
  const host = normalizeHost(safe.url.hostname);

  if (isTikTokHost(host)) {
    return classifyTikTok(safe);
  }

  if (VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return "video";
  }

  if (IMAGE_EXT.test(safe.url.pathname)) {
    return "image";
  }

  try {
    const res = await guardedFetch(safe.url.toString(), { method: "HEAD" });
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
      return "video";
    }
  } catch {
    // HEAD is best-effort; fall through to the default web lane.
  }

  return "web";
}
