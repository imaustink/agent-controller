import { createReadStream } from "node:fs";
import { config } from "../config.js";
import { getClient } from "../llm/client.js";

/** Transcribes a local audio file via the cloud transcription API. */
export async function transcribeAudio(filePath: string): Promise<string> {
  const client = getClient();
  const result: unknown = await client.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: config.transcribeModel,
    response_format: "text",
  });
  // With response_format "text" the SDK resolves to a plain string.
  if (typeof result === "string") return result;
  const maybe = result as { text?: unknown };
  return typeof maybe.text === "string" ? maybe.text : "";
}
