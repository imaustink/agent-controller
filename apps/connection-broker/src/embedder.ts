import type { Embedder } from "./sync/corpus-writer.js";

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** Must match the corpus collections' vector size, and every corpus must agree. */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Vector size of the default model, and what the collections are created with. */
export const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_MODEL = "text-embedding-3-small";

/**
 * Batch embedder over the OpenAI embeddings API.
 *
 * Batched deliberately: the writer embeds a whole chunk batch per upsert, and
 * one request per chunk would turn a page of 20 chunks into 20 round trips.
 *
 * PARITY: the model and dimensionality must match whatever the Temporal engine
 * embeds with (`internal/llm`). Scores from different corpora are merged by a
 * knowledge base as if directly comparable, which they only are when every
 * collection was built by the same embedder.
 */
export class OpenAIEmbedder implements Embedder {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenAIEmbedderConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.fetchImpl(
      `${(this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.cfg.model ?? DEFAULT_MODEL, input: texts }),
      },
    );

    if (!response.ok) {
      throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = body.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`embeddings returned ${data.length} vectors for ${texts.length} inputs`);
    }

    // Sorted by index rather than trusted in arrival order. The writer zips
    // vectors to chunks positionally, so a reordering would pair every chunk
    // with another chunk's embedding — wrong in every retrieval, erroring
    // nowhere.
    return [...data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
  }
}
