import {
  PermanentError,
  PermissionDeniedError,
  TransientError,
  type Credentials,
  type Cursor,
  type Document,
  type Driver,
  type ListPage,
  type ProbeGranularity,
  type ProbeResult,
  type Scope,
} from "./types.js";
import { matchPath } from "./path-allowlist.js";
import type { FetchLike } from "./confluence.js";
import type { ApiRequest, ApiResponse } from "./types.js";

export interface GDriveDriverOptions {
  fetch?: FetchLike;
  pageSize?: number;
  apiOrigin?: string;
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  version?: string;
  webViewLink?: string;
  trashed?: boolean;
  parents?: string[];
  permissions?: { type?: string; emailAddress?: string; domain?: string }[];
}

/** Google Docs formats have no bytes to download; they export instead. */
const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

/** Formats worth indexing as text without conversion. */
const PLAIN_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/**
 * Google Drive driver (docs/adr/0038).
 *
 * Scope is ONE folder, and the scope check is the reason this driver looks the
 * way it does: Drive has no "is this file under that folder" query, only a
 * file's immediate `parents`. So membership is asserted by walking parents
 * upward, and the walk is bounded — an unbounded one is a denial of service
 * against ourselves on a deep or cyclic hierarchy.
 */
export class GDriveDriver implements Driver {
  readonly provider = "gdrive";

  private readonly http: FetchLike;
  private readonly pageSize: number;
  private readonly apiOrigin: string;

  constructor(options: GDriveDriverOptions = {}) {
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 100;
    this.apiOrigin = (options.apiOrigin ?? "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
  }

  validateScope(scope: Scope): void {
    if (!scope.folderID) throw new Error("a gdrive connection must be scoped to a folder");
    if (scope.space || scope.channel) {
      throw new Error("a gdrive connection must set scope.folderID and nothing else");
    }
    // The folder id is interpolated into a query string, where an apostrophe
    // would terminate the quoted term and let the rest be read as query syntax.
    if (!/^[A-Za-z0-9_-]+$/.test(scope.folderID)) {
      throw new Error(`illegal gdrive folder id: ${scope.folderID}`);
    }
  }

  probeGranularity(): ProbeGranularity {
    return "resource";
  }

  async list(scope: Scope, credentials: Credentials, since: Cursor): Promise<ListPage> {
    this.validateScope(scope);
    const token = requireToken(credentials.service);

    const body = (await this.call("/files", token, {
      q: `'${scope.folderID}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents)",
      pageSize: String(this.pageSize),
      ...(since ? { pageToken: since } : {}),
    })) as { files?: DriveFile[]; nextPageToken?: string };

    const files = (body.files ?? []).filter((file) => this.indexable(file));

    return {
      resources: files.map((file) => toRef(file)),
      cursor: body.nextPageToken,
    };
  }

  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    const token = requireToken(credentials.delegated ?? credentials.service);

    const file = (await this.call(`/files/${encodeURIComponent(id)}`, token, {
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents",
    })) as DriveFile;

    await this.assertInScope(file, scope, token);

    return { ...toRef(file), markdown: await this.readContent(file, token) };
  }

  async probe(scope: Scope, credentials: Credentials, id?: string): Promise<ProbeResult> {
    this.validateScope(scope);
    if (!id) throw new Error("gdrive probes are per resource and need a file id");
    if (!credentials.delegated) {
      throw new Error("a gdrive probe requires the calling user's delegated token");
    }

    // Metadata only: reaching 200 under the USER's token is the authorization
    // decision, and the body is the model's to request separately (ADR 0040).
    const file = (await this.call(`/files/${encodeURIComponent(id)}`, credentials.delegated, {
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents",
    })) as DriveFile;

    await this.assertInScope(file, scope, credentials.delegated);

    const ref = toRef(file);
    return { allowed: true, title: ref.title, url: ref.url, version: ref.version };
  }

  /**
   * The live GET face (ADR 0038 §5).
   *
   * Two paths: re-read one file, or list a folder's children to walk down from
   * the scoped root. Both are scope-checked by the same parent walk the
   * retrieval path uses, so a file id from outside the folder is refused here
   * exactly as it is there.
   */
  async api(scope: Scope, credentials: Credentials, request: ApiRequest): Promise<ApiResponse> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("the gdrive GET face requires the calling user's delegated token");
    }
    const token = credentials.delegated;

    const fileId = matchPath(request.path, [/^files\/([A-Za-z0-9_-]+)$/]);
    const folderId = matchPath(request.path, [/^folders\/([A-Za-z0-9_-]+)\/children$/]);
    if (!fileId && !folderId) {
      throw new PermissionDeniedError(
        `gdrive GET face does not serve ${request.path}; it serves files/<id> and folders/<id>/children`,
      );
    }

    if (folderId) {
      // The folder itself must be in scope before its contents are listed;
      // otherwise a folder id alone would enumerate another client's tree.
      const folder = (await this.call(`/files/${encodeURIComponent(folderId)}`, token, {
        fields: "id,name,mimeType,parents",
      })) as DriveFile;
      if (folderId !== scope.folderID) await this.assertInScope(folder, scope, token);

      const listed = (await this.call("/files", token, {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        pageSize: "50",
      })) as { files?: DriveFile[] };
      return { body: listed, url: `https://drive.google.com/drive/folders/${folderId}` };
    }

    const file = (await this.call(`/files/${encodeURIComponent(fileId!)}`, token, {
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents",
    })) as DriveFile;
    await this.assertInScope(file, scope, token);

    return {
      body: { ...toRef(file), markdown: await this.readContent(file, token) },
      url: file.webViewLink,
    };
  }

  /** Files whose bytes are worth indexing as text. */
  private indexable(file: DriveFile): boolean {
    const mime = file.mimeType ?? "";
    // Folders are traversed, not indexed; anything binary would embed as noise.
    if (mime === "application/vnd.google-apps.folder") return false;
    return mime in EXPORTABLE || PLAIN_TEXT.has(mime);
  }

  private async readContent(file: DriveFile, token: string): Promise<string> {
    const mime = file.mimeType ?? "";
    const exportAs = EXPORTABLE[mime];

    const path = exportAs
      ? `/files/${encodeURIComponent(file.id)}/export`
      : `/files/${encodeURIComponent(file.id)}`;
    const params: Record<string, string> = exportAs ? { mimeType: exportAs } : { alt: "media" };

    const text = await this.callText(path, token, params);
    return text.trim();
  }

  /**
   * Asserts a file is inside this connection's folder.
   *
   * Drive offers no "descendant of" predicate, so this walks `parents` upward.
   * It is the only thing stopping a file id from reaching another client's
   * folder, so it fails CLOSED: absent parents, a broken chain, or a walk that
   * runs past its budget are all refusals.
   *
   * The depth bound is not cosmetic. Drive permits a file to have several
   * parents and, through shortcuts and shared drives, cycles are reachable —
   * an unbounded walk there is a denial of service we would be running against
   * ourselves, with the caller's credential.
   */
  private async assertInScope(file: DriveFile, scope: Scope, token: string): Promise<void> {
    const target = scope.folderID!;
    const seen = new Set<string>();
    let frontier = file.parents ?? [];

    for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth += 1) {
      if (frontier.length === 0) break;
      if (frontier.includes(target)) return;

      const next: string[] = [];
      for (const parent of frontier) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        const folder = (await this.call(`/files/${encodeURIComponent(parent)}`, token, {
          fields: "id,parents",
        }).catch(() => undefined)) as DriveFile | undefined;
        next.push(...(folder?.parents ?? []));
      }
      frontier = next;
    }

    throw new PermissionDeniedError(
      `file ${file.id} is not inside folder ${target}, or its parentage could not be confirmed`,
    );
  }

  private async call(path: string, token: string, params: Record<string, string>): Promise<unknown> {
    const response = await this.request(path, token, params);
    return response.json();
  }

  private async callText(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<string> {
    const response = await this.request(path, token, params);
    // `alt=media` and `export` return bytes, not JSON.
    return (await response.text?.()) ?? "";
  }

  private async request(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> }> {
    const url = `${this.apiOrigin}${path}?${new URLSearchParams(params).toString()}`;

    let response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (cause) {
      throw new TransientError(`gdrive request failed: ${String(cause)}`);
    }

    if (response.ok) return response;

    // 403 is overloaded in Drive: it covers both "you may not" and "you have
    // exhausted your quota", and the two must not be blurred (ADR 0040).
    if (response.status === 403) {
      const detail = (await response.text?.()) ?? "";
      if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(detail)) {
        throw new TransientError(`gdrive rate limited: ${detail.slice(0, 200)}`);
      }
      throw new PermissionDeniedError(`gdrive returned 403: ${detail.slice(0, 200)}`);
    }
    if (response.status === 404) throw new PermissionDeniedError("gdrive returned 404");
    if (response.status === 401) throw new PermanentError("gdrive rejected the credential");
    throw new TransientError(`gdrive returned ${response.status}`);
  }
}

/**
 * How far up the parent chain the scope check will walk.
 *
 * Generous for real hierarchies and finite for hostile ones.
 */
const MAX_FOLDER_DEPTH = 16;

function toRef(file: DriveFile) {
  return {
    id: file.id,
    title: file.name ?? file.id,
    url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    // Drive's own monotonic revision counter.
    version: file.version,
    updatedAt: file.modifiedTime,
    // Drive permissions need a separate call per file and enumerate people
    // rather than groups. Permissive rather than guessed: the probe is the
    // authority, and under-inclusion is the only direction that hurts.
    acl: { principals: [], permissive: true },
  };
}

function requireToken(token: string | undefined): string {
  if (!token) throw new Error("no credential supplied for a gdrive request");
  return token;
}
