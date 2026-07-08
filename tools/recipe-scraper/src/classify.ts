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

/**
 * Classifies a URL into an extractor lane. Domain and extension checks are
 * purely local; only truly ambiguous URLs incur a guarded HEAD request.
 */
export async function classify(safe: SafeUrl): Promise<SourceType> {
  const host = normalizeHost(safe.url.hostname);

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
