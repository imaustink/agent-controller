import {
  PermanentError,
  PermissionDeniedError,
  TransientError,
  type Cursor,
  type Document,
  type ResourceRef,
} from "../drivers/types.js";
import type { ResourceSource } from "./worker.js";

/** The HTTP surface this client needs, injectable so tests need no server. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> }>;

export interface HttpResourceSourceConfig {
  /** The broker's base URL, e.g. `http://connection-broker:8080`. */
  baseUrl: string;
  /**
   * This worker's sync token.
   *
   * Scoped to ONE connection by the broker (see auth.ts): a sync token is
   * issued per connection precisely so that a leaked one reaches one client's
   * source rather than every client's. This client therefore carries a single
   * token and must not be shared across connections — the broker would reject
   * it anyway, which is the intended outcome rather than an inconvenience.
   */
  token: string;
  fetch?: FetchLike;
}

/**
 * Reads one Connection's resources over the broker's HTTP API.
 *
 * The indirection is the point (ADR 0038 §3): the third-party credential lives
 * in the broker, and the sync worker is a CLIENT of that credential rather than
 * a holder of it. A worker that dereferenced Confluence directly would need the
 * service token in its own process, which is the arrangement this split exists
 * to avoid.
 */
export class HttpResourceSource implements ResourceSource {
  private readonly baseUrl: string;
  private readonly http: FetchLike;

  constructor(private readonly cfg: HttpResourceSourceConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.http = cfg.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async list(connection: string, cursor: Cursor): Promise<{ resources: ResourceRef[]; cursor: Cursor }> {
    const url =
      `${this.baseUrl}/connections/${encodeURIComponent(connection)}/resources` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");

    const body = (await this.request(url)) as { resources?: ResourceRef[]; cursor?: Cursor };
    return { resources: body.resources ?? [], cursor: body.cursor ?? undefined };
  }

  async fetch(connection: string, id: string): Promise<Document> {
    const url = `${this.baseUrl}/connections/${encodeURIComponent(connection)}/resources/${encodeURIComponent(id)}`;
    return (await this.request(url)) as Document;
  }

  private async request(url: string): Promise<unknown> {
    let response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: "application/json" },
      });
    } catch (cause) {
      // The broker being unreachable says nothing about the resource.
      throw new TransientError(`connection-broker unreachable: ${String(cause)}`);
    }

    if (response.ok) return response.json();

    const detail = await describeFailure(response);

    // The broker's status codes are a classification the driver already made
    // (server.ts), so this maps them back rather than re-deciding. Collapsing
    // them into one error would discard exactly the distinction that decides
    // whether a full reconcile is allowed to delete.
    if (response.status === 403) {
      // The service credential cannot read this resource. A real drop.
      throw new PermissionDeniedError(`broker refused ${url}${detail}`);
    }
    if (response.status === 401) {
      // Our own token was rejected. Retrying with the same token cannot fix it,
      // and it must not be mistaken for "this resource is inaccessible" — that
      // would let a misconfigured worker quietly reconcile a corpus to empty.
      throw new PermanentError(`connection-broker rejected this worker's token${detail}`);
    }
    if (response.status === 500) {
      throw new PermanentError(`connection-broker failed permanently${detail}`);
    }
    // 503 and everything else: we could not find out.
    throw new TransientError(`connection-broker returned ${response.status}${detail}`);
  }
}

/** The broker's own explanation, bounded. Never throws. */
async function describeFailure(response: { text?: () => Promise<string> }): Promise<string> {
  try {
    const body = (await response.text?.())?.trim();
    return body ? `: ${body.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}
