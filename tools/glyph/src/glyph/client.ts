import type { PMNode } from "../markdown.js";

/**
 * A thin, typed client for the subset of Glyph's REST API this tool uses:
 * pages (notes) + their ProseMirror content, and tasks. Talks to
 * `${baseUrl}/api/v1/...` and authenticates every request with the caller's
 * Bearer token (Glyph's per-user OAuth delegation — see config.ts).
 *
 * Field shapes mirror glyph/api/internal/model/model.go. Only the fields this
 * tool reads or writes are typed; unknown fields on responses are ignored.
 */

export interface GlyphClientConfig {
  /** Fixed, trusted base URL (no `/api/v1`, no trailing slash) — never derived from tool input. */
  baseUrl: string;
  /** The caller's Glyph access token (Bearer). */
  token: string;
  fetchTimeoutMs: number;
}

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type TaskStatus = "todo" | "in-progress" | "done" | "cancelled";

export interface Page {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
  tags: string[];
  priority: Priority;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PageContent {
  pageId: string;
  content: PMNode | null;
  updatedAt: string;
  schemaVersion?: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  dueDate: string | null;
  sourcePageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A failed Glyph API call, carrying the HTTP status so index.ts can shape a helpful message. */
export class GlyphApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

export class GlyphClient {
  constructor(
    private readonly cfg: GlyphClientConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private get apiBase(): string {
    return `${this.cfg.baseUrl}/api/v1`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.fetchTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: this.headers(),
        // The target host is fixed configuration; never let a 3xx silently
        // re-point the request (same posture as recipe-publisher's client).
        redirect: "error",
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new GlyphApiError(0, `request to Glyph failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new GlyphApiError(res.status, await this.errorMessage(res));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Best-effort extraction of Glyph's `{ "error": "..." }` body, falling back to the status text. */
  private async errorMessage(res: Response): Promise<string> {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: string };
      detail = parsed?.error ?? "";
    } catch {
      // Non-JSON error body — ignore.
    }
    const suffix = detail ? `: ${detail}` : "";
    return `Glyph API returned ${res.status} ${res.statusText}${suffix}`;
  }

  // ─── Pages (notes) ──────────────────────────────────────────────────────────

  createPage(input: {
    title: string;
    parentId?: string;
    tags?: string[];
    priority?: Priority;
  }): Promise<Page> {
    return this.request<Page>("POST", "/pages", {
      type: "page",
      title: input.title,
      parentId: input.parentId ?? null,
      tags: input.tags ?? [],
      ...(input.priority ? { priority: input.priority } : {}),
    });
  }

  getPage(id: string): Promise<Page> {
    return this.request<Page>("GET", `/pages/${id}`);
  }

  updatePage(
    id: string,
    patch: { title?: string; tags?: string[]; priority?: Priority },
  ): Promise<Page> {
    return this.request<Page>("PATCH", `/pages/${id}`, patch);
  }

  listPages(): Promise<Page[]> {
    return this.request<Page[]>("GET", "/pages");
  }

  getPageContent(id: string): Promise<PageContent> {
    return this.request<PageContent>("GET", `/pages/${id}/content`);
  }

  upsertPageContent(id: string, content: PMNode): Promise<PageContent> {
    return this.request<PageContent>("PUT", `/pages/${id}/content`, { content });
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: Priority;
    dueDate?: string;
    tags?: string[];
  }): Promise<Task> {
    return this.request<Task>("POST", "/tasks", {
      title: input.title,
      description: input.description ?? "",
      tags: input.tags ?? [],
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    });
  }

  getTask(id: string): Promise<Task> {
    return this.request<Task>("GET", `/tasks/${id}`);
  }

  updateTask(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: Priority;
      dueDate?: string | null;
      tags?: string[];
    },
  ): Promise<Task> {
    return this.request<Task>("PATCH", `/tasks/${id}`, patch);
  }

  listTasks(): Promise<Task[]> {
    return this.request<Task[]>("GET", "/tasks");
  }
}
