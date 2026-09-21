import type { QdrantLike } from "./corpus-writer.js";

export interface QdrantHttpClientConfig {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The slice of Qdrant's REST API the corpus writer needs.
 *
 * Hand-rolled rather than pulling in the official client for four calls. The
 * broker's dependency surface is worth keeping small: it is the process holding
 * every client's third-party credentials, so each package added to it is
 * another thing that can reach them.
 */
export class QdrantHttpClient implements QdrantLike {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: QdrantHttpClientConfig) {
    this.base = cfg.url.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async collectionExists(collection: string): Promise<boolean> {
    const response = await this.request("GET", `/collections/${encodeURIComponent(collection)}`);
    if (response.status === 404) return false;
    await this.assertOk(response, "check collection");
    return true;
  }

  async createCollection(
    collection: string,
    config: { vectors: { size: number; distance: "Cosine" } },
  ): Promise<unknown> {
    const response = await this.request("PUT", `/collections/${encodeURIComponent(collection)}`, {
      vectors: { size: config.vectors.size, distance: config.vectors.distance },
    });
    // A 409 means another replica created it first, which is success here.
    if (response.status === 409) return undefined;
    return this.assertOk(response, "create collection");
  }

  async upsert(
    collection: string,
    args: { wait: boolean; points: { id: string; vector: number[]; payload: Record<string, unknown> }[] },
  ): Promise<unknown> {
    const response = await this.request(
      "PUT",
      `/collections/${encodeURIComponent(collection)}/points?wait=${args.wait}`,
      { points: args.points },
    );
    return this.assertOk(response, "upsert points");
  }

  async delete(collection: string, args: { wait: boolean; points: string[] }): Promise<unknown> {
    const response = await this.request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/delete?wait=${args.wait}`,
      { points: args.points },
    );
    return this.assertOk(response, "delete points");
  }

  async scroll(
    collection: string,
    args: { limit: number; offset?: string | number; with_payload: string[]; with_vector: false },
  ): Promise<{
    points: { payload?: Record<string, unknown> | null }[];
    next_page_offset?: string | number | null;
  }> {
    const response = await this.request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        limit: args.limit,
        offset: args.offset,
        with_payload: args.with_payload,
        with_vector: args.with_vector,
      },
    );
    const body = (await this.assertOk(response, "scroll points")) as {
      result?: {
        points?: { payload?: Record<string, unknown> | null }[];
        next_page_offset?: string | number | null;
      };
    };
    return {
      points: body.result?.points ?? [],
      next_page_offset: body.result?.next_page_offset ?? null,
    };
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { "api-key": this.cfg.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async assertOk(response: Response, what: string): Promise<unknown> {
    if (!response.ok) {
      // Qdrant explains itself in the body, and losing that turns every
      // mismatched vector size into an opaque 400.
      throw new Error(`qdrant ${what}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  }
}
