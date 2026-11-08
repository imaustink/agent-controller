import OpenAI from "openai";
import type { Embedder } from "./types.js";

export interface OpenAiEmbedderOptions {
  model?: string;
  client?: OpenAI;
}

const DEFAULT_MODEL = "text-embedding-3-small";

/** {@link Embedder} backed by the OpenAI embeddings API. */
export class OpenAiEmbedder implements Embedder {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAiEmbedderOptions = {}) {
    this.client = opts.client ?? new OpenAI();
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({ model: this.model, input: text });
    const vector = res.data[0]?.embedding;
    if (!vector) {
      throw new Error("Embedding response contained no vector");
    }
    return vector;
  }
}
