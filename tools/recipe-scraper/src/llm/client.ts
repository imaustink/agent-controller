import OpenAI from "openai";

let client: OpenAI | null = null;

/** Lazily construct a single OpenAI client. The API key is the only secret the
 * container is trusted with. */
export function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    maxRetries: 2,
  });
  return client;
}
