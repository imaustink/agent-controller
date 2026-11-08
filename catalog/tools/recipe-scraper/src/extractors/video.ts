import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { execFile } from "../util/exec.js";
import { transcribeAudio } from "../transcription/audio.js";
import type { Extraction } from "../types.js";

interface YtDlpMeta {
  title?: string;
  description?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
}

/** Common, injection-safe flags for every yt-dlp invocation. */
function baseArgs(): string[] {
  const args = [
    "--ignore-config", // never read a config file that could inject options
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--socket-timeout",
    "30",
    // YouTube aggressively blocks the default web client ("Sign in to confirm
    // you're not a bot"). Offer alternate innertube clients so yt-dlp can fall
    // back. Ignored for non-YouTube extractors.
    "--extractor-args",
    "youtube:player_client=default,web_safari,tv,mweb",
  ];

  // Optional cookies escape hatch for gated content. Mount a Netscape cookies
  // file read-only and point RECIPE_YTDLP_COOKIES at it.
  const cookies = process.env.RECIPE_YTDLP_COOKIES;
  if (cookies) {
    args.push("--cookies", cookies);
  }

  return args;
}

async function fetchMeta(url: string): Promise<YtDlpMeta> {
  const { stdout, code, stderr } = await execFile(
    "yt-dlp",
    [...baseArgs(), "-J", url],
    { timeoutMs: config.subprocessTimeoutMs },
  );
  if (code !== 0) {
    throw new Error(`yt-dlp metadata failed (${code}): ${stderr.slice(0, 300)}`);
  }
  try {
    return JSON.parse(stdout) as YtDlpMeta;
  } catch {
    throw new Error("yt-dlp returned unparseable metadata JSON");
  }
}

/** Strips WebVTT cue markup down to plain transcript lines. */
function vttToText(vtt: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (line.startsWith("NOTE") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.includes("-->")) continue;
    if (/^\d+$/.test(line)) continue;
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      lines.push(clean);
    }
  }
  return lines.join("\n");
}

async function fetchSubtitles(url: string, dir: string): Promise<string | null> {
  const { code } = await execFile(
    "yt-dlp",
    [
      ...baseArgs(),
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en",
      "--sub-format",
      "vtt",
      "--convert-subs",
      "vtt",
      "-o",
      path.join(dir, "sub.%(ext)s"),
      url,
    ],
    { timeoutMs: config.subprocessTimeoutMs },
  );
  if (code !== 0) return null;

  const files = await fs.readdir(dir);
  const vttFile = files.find((f) => f.endsWith(".vtt"));
  if (!vttFile) return null;
  const content = await fs.readFile(path.join(dir, vttFile), "utf8");
  const text = vttToText(content);
  return text.trim() ? text : null;
}

async function downloadAudio(url: string, dir: string): Promise<string | null> {
  const maxFilesize = `${Math.floor(config.maxAudioBytes / (1024 * 1024))}M`;
  const { code } = await execFile(
    "yt-dlp",
    [
      ...baseArgs(),
      "-f",
      "bestaudio/best",
      "--max-filesize",
      maxFilesize,
      "-x",
      "--audio-format",
      "mp3",
      "-o",
      path.join(dir, "audio.%(ext)s"),
      url,
    ],
    { timeoutMs: config.subprocessTimeoutMs },
  );
  if (code !== 0) return null;

  const files = await fs.readdir(dir);
  const audioFile = files.find((f) => f.startsWith("audio."));
  return audioFile ? path.join(dir, audioFile) : null;
}

/**
 * Extracts text from a video URL: title + uploader + description, plus a
 * transcript sourced from subtitles when available, otherwise from cloud
 * transcription of downloaded (size-capped) audio.
 */
export async function extractVideo(url: string): Promise<Extraction> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recipe-video-"));
  const warnings: string[] = [];
  let transcriptSource: string | null = null;

  try {
    const meta = await fetchMeta(url);
    const parts: string[] = [];
    if (meta.title) parts.push(`Title: ${meta.title}`);
    const author = meta.uploader ?? meta.channel;
    if (author) parts.push(`Uploader: ${author}`);
    if (meta.description) parts.push(`Description:\n${meta.description}`);

    // Fetch subtitles and download audio in parallel so neither blocks the
    // other. Both are best-effort: a failure in one doesn't prevent the other
    // from contributing content. The LLM receives both when available, which
    // improves extraction for videos whose subtitles are incomplete or absent.
    const [subtitleTranscript, audioPath] = await Promise.all([
      fetchSubtitles(url, dir),
      downloadAudio(url, dir),
    ]);

    let audioTranscript: string | null = null;
    if (audioPath) {
      try {
        audioTranscript = await transcribeAudio(audioPath);
      } catch (err) {
        warnings.push(`Audio transcription failed: ${(err as Error).message}`);
      }
    }

    const transcriptSources: string[] = [];
    if (subtitleTranscript) {
      transcriptSources.push("subtitles");
      parts.push(`Subtitles:\n${subtitleTranscript}`);
    }
    if (audioTranscript) {
      transcriptSources.push("audio-transcription");
      parts.push(`Audio Transcript:\n${audioTranscript}`);
    }
    if (transcriptSources.length === 0) {
      warnings.push("No transcript available (subtitles absent and audio transcription failed or skipped)");
    }
    transcriptSource = transcriptSources.join("+") || null;

    return {
      text: parts.join("\n\n"),
      title: meta.title ?? null,
      sourceType: "video",
      provenance: {
        extractor: "yt-dlp",
        transcriptSource,
        duration: meta.duration ?? null,
      },
      warnings,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
