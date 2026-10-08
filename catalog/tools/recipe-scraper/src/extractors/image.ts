import { config } from "../config.js";
import { getClient } from "../llm/client.js";
import { downloadBytes } from "../util/download.js";
import type { Extraction } from "../types.js";

const OCR_PROMPT =
  "Transcribe ALL text visible in this image verbatim, preserving line breaks. " +
  "This may be a recipe (ingredients, steps, notes). Output only the transcribed text, no commentary.";

/**
 * Runs a single image (already in memory) through the vision model as an OCR
 * engine, returning the recovered text. Shared by the single-image lane and
 * the TikTok photo (slideshow) lane so both use identical OCR behavior.
 */
export async function ocrImage(bytes: Buffer, contentType: string | undefined): Promise<string> {
  const mime = contentType && contentType.startsWith("image/") ? contentType : "image/jpeg";
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

  const client = getClient();
  const response = await client.chat.completions.create({
    model: config.visionModel,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Downloads an image (size-capped, SSRF-guarded) and uses a vision model as an
 * OCR engine to recover its text. The recovered text then flows through the
 * same formatting stage as every other source type.
 */
export async function extractImage(rawUrl: string): Promise<Extraction> {
  const { bytes, contentType } = await downloadBytes(rawUrl, config.maxImageBytes);
  const mime = contentType && contentType.startsWith("image/") ? contentType : "image/jpeg";
  const text = await ocrImage(bytes, mime);

  return {
    text,
    title: null,
    sourceType: "image",
    provenance: {
      extractor: "image-vision-ocr",
      visionModel: config.visionModel,
      bytes: bytes.length,
      mime,
    },
    warnings: text.trim() ? [] : ["No text recovered from image"],
  };
}
