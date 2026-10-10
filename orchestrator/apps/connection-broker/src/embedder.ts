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
 * OpenAI's embeddings endpoint caps a single request at 2,048 inputs and
 * 300,000 tokens. A large corpus (Drive's Office files produced ~921k tokens of
 * chunks) sent in one call 400s on the token cap, so inputs are split into
 * batches under both limits. The token figure is estimated from length — rough
 * is fine because an undersized estimate is still caught by the split-and-retry
 * in embedBatch — and kept well under 300k for margin.
 */
const MAX_INPUTS_PER_REQUEST = 2048;
const MAX_TOKENS_PER_REQUEST = 250_000;
/** Deliberately a slight OVER-estimate (~3 chars/token) so batches stay under the cap. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3) + 1;

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

    // Batches preserve input order, and each batch's vectors are concatenated in
    // order, so the writer's positional zip of chunks<->vectors still holds.
    const vectors: number[][] = [];
    for (const batch of batchInputs(texts)) {
      vectors.push(...(await this.embedBatch(batch)));
    }
    return vectors;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
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
      const detail = (await response.text()).slice(0, 300);
      // A batch that still trips a per-request limit is split and retried, so
      // the token estimate above only has to be roughly right. Recursion ends at
      // a single input (which the estimate cannot have put over a count/token
      // request cap), where a genuine error surfaces instead of looping.
      if (response.status === 400 && texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const [head, tail] = await Promise.all([
          this.embedBatch(texts.slice(0, mid)),
          this.embedBatch(texts.slice(mid)),
        ]);
        return [...head, ...tail];
      }
      throw new Error(`embeddings ${response.status}: ${detail}`);
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

/**
 * Splits inputs into batches under OpenAI's per-request caps: at most
 * MAX_INPUTS_PER_REQUEST inputs and about MAX_TOKENS_PER_REQUEST tokens each.
 * Greedy and order-preserving. A single input that alone exceeds the token
 * budget still gets its own batch rather than being dropped — the request cap is
 * about the batch total, and an over-long single chunk is the chunker's concern.
 */
export function batchInputs(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const text of texts) {
    const estimate = estimateTokens(text);
    if (current.length > 0 && (current.length >= MAX_INPUTS_PER_REQUEST || tokens + estimate > MAX_TOKENS_PER_REQUEST)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += estimate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
