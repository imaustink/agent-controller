import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import type { ToolInput } from "../schema.js";

let client: OpenAI | null = null;

/** Lazily construct a single OpenAI client. The API key is the only OpenAI
 * secret the container is trusted with. */
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL, maxRetries: 2 });
  return client;
}

export interface GeneratedImage {
  /** Raw PNG bytes of the produced image. */
  bytes: Buffer;
}

/** gpt-image-1 returns base64 only; pull the first image's bytes or throw. */
function firstImageBytes(data: Array<{ b64_json?: string }> | undefined): Buffer {
  const b64 = data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("image model returned no image data");
  }
  return Buffer.from(b64, "base64");
}

/** Text -> image. Used when the caller supplied no source image. */
export async function generateImage(input: ToolInput): Promise<GeneratedImage> {
  const res = await getClient().images.generate({
    model: config.imageModel,
    prompt: input.prompt,
    size: (input.size ?? config.defaultSize) as never,
    quality: (input.quality ?? config.defaultQuality) as never,
    ...(input.background ? { background: input.background as never } : {}),
  });
  return { bytes: firstImageBytes(res.data) };
}

/** Image + prompt -> new image. Used when the caller supplied a source image. */
export async function editImage(input: ToolInput, source: Buffer, contentType: string): Promise<GeneratedImage> {
  const filename = contentType === "image/jpeg" ? "source.jpg" : "source.png";
  const image = await toFile(source, filename, { type: contentType || "image/png" });
  const res = await getClient().images.edit({
    model: config.imageModel,
    image,
    prompt: input.prompt,
    size: (input.size ?? config.defaultSize) as never,
    quality: (input.quality ?? config.defaultQuality) as never,
  });
  return { bytes: firstImageBytes(res.data) };
}
