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
  type SearchHit,
} from "./types.js";
import type { FetchLike } from "./confluence.js";
import { GoogleServiceCredential, type TokenFetch } from "./google-auth.js";
import { extractDocxText, extractXlsxText } from "./ooxml.js";

export interface GDriveDriverOptions {
  fetch?: FetchLike;
  pageSize?: number;
  apiOrigin?: string;
  /**
   * POST-capable fetch for the Google token endpoint, when the ingestion
   * credential is a service-account key (minted + refreshed by the driver).
   * Defaults to the global fetch; injected in tests.
   */
  tokenFetch?: TokenFetch;
  /** Injectable clock, for the token cache in tests. */
  now?: () => number;
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
  /** Bytes, as a STRING — Drive reports it that way, and it exceeds 2^53 for nothing we index. */
  size?: string;
  /** Present only on shortcuts. `targetMimeType` is in the LISTING, so indexability costs no extra call. */
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  permissions?: { type?: string; emailAddress?: string; domain?: string }[];
}

/** Google Docs formats have no bytes to download; they export instead. */
const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

const PDF_MIME = "application/pdf";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/**
 * Office Open XML formats, mapped to the extractor that reads them. `.xlsm`
 * (macro-enabled) is structurally a `.xlsx`, so it uses the spreadsheet path.
 * These are downloaded as bytes (alt=media) and parsed by ./ooxml.
 */
const OOXML: Record<string, "docx" | "xlsx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsx",
};

/**
 * What a file effectively IS, following a shortcut.
 *
 * Drive folders are routinely organised with shortcuts — a live Drive had 54
 * of them, pointing at meeting notes that are ordinary Google Docs. Judging
 * them by their own mime type skipped every one, and until the skip was
 * reported, silently.
 *
 * `targetMimeType` rides along in the listing, so deciding indexability
 * follows a shortcut without costing a call.
 */
function effectiveMime(file: DriveFile): string {
  const mime = file.mimeType ?? "";
  if (mime !== SHORTCUT_MIME) return mime;
  return file.shortcutDetails?.targetMimeType ?? "";
}

/**
 * The largest PDF worth pulling into a 512Mi container.
 *
 * Checked against Drive's reported size BEFORE downloading, so an oversized
 * file costs one metadata read rather than a transfer and a parse.
 */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Same ceiling for Office files, refused before download to bound unzip cost. */
const MAX_OFFICE_BYTES = 25 * 1024 * 1024;

/**
 * Formats worth indexing as text without conversion — downloaded with alt=media
 * and used verbatim. XML included: it is already text, so it needs no parser
 * (unlike the zipped Office formats), and skipping it dropped real content.
 */
const PLAIN_TEXT = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/xml",
  "application/xml",
]);

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
  /** Mints + refreshes the ingestion token when the service credential is an SA key. */
  private readonly serviceCreds: GoogleServiceCredential;

  /** Scoped folder id -> that folder and everything beneath it. */
  private readonly folderTrees = new Map<string, string[]>();

  constructor(options: GDriveDriverOptions = {}) {
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 100;
    this.apiOrigin = (options.apiOrigin ?? "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
    this.serviceCreds = new GoogleServiceCredential(options.tokenFetch, undefined, options.now);
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

  /**
   * Lists the folder's indexable files, RECURSIVELY.
   *
   * Drive has no "in parents, at any depth" operator, so the tree is
   * enumerated first and every folder in it named as a parent in one query.
   * That keeps the cursor a plain Drive pageToken, which is what the
   * incremental contract above expects.
   *
   * This used to ask for `'<id>' in parents`, which is ONE level, while the
   * Corpus CRD's folderID field documents the contents as synced recursively.
   * The driver disagreed with itself as much as with the docs: `fetch` walks a
   * parent chain sixteen levels deep and will happily serve a nested file, so
   * a document in a subfolder was readable and could never be INDEXED — it
   * simply never appeared, with nothing to indicate it had been skipped. Found
   * against a live folder, where two of two nested documents were missing.
   */
  async list(scope: Scope, credentials: Credentials, since: Cursor): Promise<ListPage> {
    this.validateScope(scope);
    // Ingestion: an SA key is minted + refreshed here; a raw token is used as-is.
    const token = await this.serviceCreds.bearer(credentials.service);

    const folders = await this.descendantFolders(scope.folderID!, token);
    const parents = folders.map((id) => `'${id}' in parents`).join(" or ");

    const body = (await this.call("/files", token, {
      q: `(${parents}) and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size,shortcutDetails)",
      pageSize: String(this.pageSize),
      // Return Shared Drive items too, not just My Drive (paired with
      // supportsAllDrives in request). A folder in a Shared Drive otherwise
      // lists as empty however much the credential can see.
      includeItemsFromAllDrives: "true",
      ...(since ? { pageToken: since } : {}),
    })) as { files?: DriveFile[]; nextPageToken?: string };

    const all = body.files ?? [];
    const files = all.filter((file) => this.indexable(file));

    // Say what was left behind.
    //
    // Skipping unsupported types is right; doing it SILENTLY is what let a
    // folder of PDFs index as empty and look like it had worked. A corpus that
    // is confidently incomplete is worse than one that is visibly partial,
    // and until now nothing anywhere recorded the difference.
    const skipped = new Map<string, number>();
    for (const file of all) {
      const mime = file.mimeType ?? "unknown";
      if (this.indexable(file) || mime === "application/vnd.google-apps.folder") continue;
      skipped.set(mime, (skipped.get(mime) ?? 0) + 1);
    }
    if (skipped.size > 0) {
      const summary = [...skipped].map(([mime, count]) => `${count}x ${mime}`).join(", ");
      console.warn(`gdrive: not indexed, unsupported type: ${summary}`);
    }

    return {
      resources: await Promise.all(files.map((file) => this.refFor(file, token))),
      cursor: body.nextPageToken,
    };
  }

  /**
   * A resource ref, following a shortcut to whatever it points at.
   *
   * The ID stays the SHORTCUT's, deliberately. The shortcut is what lives in
   * the scoped folder; its target usually does not, and often sits somewhere
   * the parent walk cannot even see. Indexing the target's id would hand the
   * scope check a file outside the corpus and it would rightly refuse.
   *
   * The VERSION, though, has to be the target's. A shortcut's own version
   * never changes when the document it points at is edited, so a corpus keyed
   * on it would go stale with nothing to notice — a reconcile compares
   * versions, and this one would always match. That costs one metadata read
   * per shortcut per full pass, which is proportional to how many shortcuts
   * there are rather than to the size of the corpus.
   */
  private async refFor(file: DriveFile, token: string) {
    const targetId = file.shortcutDetails?.targetId;
    if (!targetId) return toRef(file);

    try {
      const target = (await this.call(`/files/${encodeURIComponent(targetId)}`, token, {
        fields: "id,version,modifiedTime,mimeType,size",
      })) as DriveFile;
      return {
        ...toRef(file),
        version: target.version,
        updatedAt: target.modifiedTime,
      };
    } catch {
      // A target we cannot read is still a shortcut we listed. Fall back to
      // the shortcut's own metadata rather than dropping the resource: the
      // fetch will refuse it later, with a reason, which is more useful than
      // it silently never appearing.
      return toRef(file);
    }
  }

  /**
   * The scoped folder and every folder beneath it.
   *
   * Breadth-first and depth-bounded by the same constant the scope walk uses,
   * so the two agree about how deep a corpus reaches: a file the walk would
   * reject as too deep is not one this should list.
   *
   * Cached for the driver's lifetime — one instance per corpus binding, so the
   * tree is enumerated once per sync rather than once per page.
   *
   * Refuses rather than truncates past MAX_TREE_FOLDERS. Quietly dropping
   * folders would under-index a client's corpus and look like an empty
   * subfolder, which is precisely the failure this method exists to fix.
   */
  private async descendantFolders(root: string, token: string): Promise<string[]> {
    const cached = this.folderTrees.get(root);
    if (cached) return cached;

    const all = [root];
    let frontier = [root];

    for (let depth = 0; depth < MAX_FOLDER_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const parent of frontier) {
        let pageToken: string | undefined;
        // Bounded: a provider that always returns a nextPageToken — whether
        // through a bug or a test double — would otherwise spin here forever,
        // and a sync that hangs is harder to diagnose than one that stops.
        for (let page = 0; page < MAX_TREE_PAGES; page += 1) {
          const body = (await this.call("/files", token, {
            q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: "nextPageToken,files(id)",
            pageSize: String(this.pageSize),
            // Shared Drive subfolders too, else descendantFolders finds none and
            // the whole corpus indexes empty.
            includeItemsFromAllDrives: "true",
            ...(pageToken ? { pageToken } : {}),
          })) as { files?: { id: string }[]; nextPageToken?: string };

          for (const folder of body.files ?? []) {
            // A shortcut or a cycle would otherwise loop until the depth bound.
            if (all.includes(folder.id)) continue;
            all.push(folder.id);
            next.push(folder.id);
          }
          pageToken = body.nextPageToken;
          if (!pageToken) break;
        }
      }

      if (all.length > MAX_TREE_FOLDERS) {
        throw new PermanentError(
          `gdrive folder ${root} contains more than ${MAX_TREE_FOLDERS} folders; ` +
            "scope this Corpus to a narrower folder",
        );
      }
      frontier = next;
    }

    this.folderTrees.set(root, all);
    return all;
  }

  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    // A user read runs on their delegated token; a sync read falls back to the
    // service credential (minted/refreshed from an SA key when it is one).
    const token = credentials.delegated
      ? requireToken(credentials.delegated)
      : await this.serviceCreds.bearer(credentials.service);

    const file = (await this.call(`/files/${encodeURIComponent(id)}`, token, {
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size,shortcutDetails",
    })) as DriveFile;

    await this.assertInScope(file, scope, token);

    return { ...toRef(file), markdown: await this.readContent(file, token) };
  }

  /**
   * Reads any file the CALLER can see (see Driver.readAsUser).
   *
   * No parent walk: Drive applies this user's own permissions, so a file they
   * cannot open comes back 404 wherever it lives. Skipping the walk also
   * removes the per-read cost of climbing a folder chain that is no longer
   * being used to decide anything.
   */
  async readAsUser(credentials: Credentials, id: string): Promise<Document> {
    const token = requireDelegatedDrive(credentials);

    const file = (await this.call(`/files/${encodeURIComponent(id)}`, token, {
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size,shortcutDetails",
    })) as DriveFile;

    return { ...toRef(file), markdown: await this.readContent(file, token) };
  }

  /**
   * Live full-text search, as the caller, inside the corpus's folder.
   *
   * Two Drive-specific wrinkles shape this.
   *
   * `fullText contains '...'` is a Drive query literal in SINGLE quotes, and
   * the folder id already taught this driver that lesson: an apostrophe in the
   * caller's words would close the literal and let the rest parse as query
   * syntax. Escaped rather than stripped — the words are the question.
   *
   * `'<id>' in parents` is ONE level, and the corpus is recursive. A file in a
   * subfolder is in the corpus but not in that result set, so the query cannot
   * express the bound on its own. Rather than walk every subfolder up front —
   * unbounded work for one search — this searches the user's whole Drive and
   * then keeps only what the existing parent-chain walk says is inside. The
   * walk is the same code the fetch path enforces scope with, so search cannot
   * drift from it.
   */
  async searchAsUser(
    credentials: Credentials,
    scope: Scope,
    query: string,
    limit = 10,
  ): Promise<SearchHit[]> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("a gdrive search requires the calling user's delegated token");
    }

    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const escaped = trimmed.replace(/['\\]/g, "\\$&");
    const body = (await this.call("/files", credentials.delegated, {
      q: `fullText contains '${escaped}' and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size,shortcutDetails)",
      // Over-fetched on purpose: the scope filter below removes most of these,
      // and asking for exactly `limit` would return a short page of hits that
      // happen to be in the folder rather than the best ones that are.
      pageSize: String(Math.min(limit * 10, 100)),
      // The user's own search must reach Shared Drive files too, or live
      // retrieval silently never finds anything in a Shared-Drive corpus.
      includeItemsFromAllDrives: "true",
    })) as { files?: DriveFile[] };

    const candidates = (body.files ?? []).filter((file) => this.indexable(file));

    const hits: SearchHit[] = [];
    for (const file of candidates) {
      if (hits.length >= limit) break;
      // The same walk fetch enforces scope with. Run as the CALLER, so a file
      // whose parent chain they cannot see is not in their corpus either.
      try {
        await this.assertInScope(file, scope, credentials.delegated);
        hits.push(toRef(file));
      } catch {
        // A walk that cannot complete is not evidence the file is inside.
        // Dropping the candidate is the safe direction here: over-inclusion
        // would put another folder's file in a client's knowledge base.
      }
    }
    return hits;
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
      fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size,shortcutDetails",
    })) as DriveFile;

    await this.assertInScope(file, scope, credentials.delegated);

    const ref = toRef(file);
    return { allowed: true, title: ref.title, url: ref.url, version: ref.version };
  }

  /** Files whose bytes are worth indexing as text. */
  private indexable(file: DriveFile): boolean {
    const mime = effectiveMime(file);
    // Folders are traversed, not indexed; anything binary would embed as noise.
    if (mime === "application/vnd.google-apps.folder") return false;
    return mime in EXPORTABLE || PLAIN_TEXT.has(mime) || mime === PDF_MIME || mime in OOXML;
  }

  private async readContent(file: DriveFile, token: string): Promise<string> {
    // A shortcut has no content of its own; read what it points at. Scope was
    // already asserted against the SHORTCUT, which is the thing that lives in
    // the folder — see refFor.
    const targetId = file.shortcutDetails?.targetId;
    if (targetId) {
      const target = (await this.call(`/files/${encodeURIComponent(targetId)}`, token, {
        fields: "id,name,mimeType,modifiedTime,version,webViewLink,trashed,parents,size",
      })) as DriveFile;
      return this.readContent(target, token);
    }

    const mime = file.mimeType ?? "";
    if (mime === PDF_MIME) return this.readPdf(file, token);
    const office = OOXML[mime];
    if (office) return this.readOffice(file, token, office);

    const exportAs = EXPORTABLE[mime];

    const path = exportAs
      ? `/files/${encodeURIComponent(file.id)}/export`
      : `/files/${encodeURIComponent(file.id)}`;
    const params: Record<string, string> = exportAs ? { mimeType: exportAs } : { alt: "media" };

    const text = await this.callText(path, token, params);
    return text.trim();
  }

  /**
   * Extracts a PDF's text.
   *
   * PDFs were silently DROPPED before this: `indexable()` rejected the mime
   * type and nothing recorded that anything had been skipped, so a folder of
   * them indexed as empty and looked like it had worked. Silence is the part
   * that made it dangerous — the corpus was confidently incomplete.
   *
   * Parsing is delegated, as it now is for Confluence storage format. The rule
   * both follow: on untrusted input from client systems, a battle-tested
   * parser beats one we wrote. Hand-rolling is what conflates supply-chain
   * risk with parser-correctness risk, and only the second one applies to
   * every wiki page and every PDF we ingest — in a memory-safe runtime a
   * parser bug is wrong output, not a read of adjacent memory, and wrong
   * output in a corpus is content an agent will answer from.
   *
   * `unpdf` was chosen on its supply-chain surface rather than convenience:
   * one package, ZERO transitive dependencies, no native bindings, so what is
   * trusted is a single reviewable unit.
   *
   * What that leaves is resource exhaustion, which is bounded here: oversized
   * files are refused before a byte is downloaded.
   */
  private async readPdf(file: DriveFile, token: string): Promise<string> {
    const size = Number(file.size ?? 0);
    if (size > MAX_PDF_BYTES) {
      // A refusal, not a silent skip. Permanent because retrying cannot make
      // the file smaller, and an operator should see it rather than watch a
      // sync retry forever.
      throw new PermanentError(
        `gdrive file ${file.id} is ${Math.round(size / 1024 / 1024)}MB, over the ` +
          `${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB limit for PDF extraction`,
      );
    }

    const bytes = await this.callBytes(`/files/${encodeURIComponent(file.id)}`, token, {
      alt: "media",
    });

    // Imported lazily so the parser is loaded only by a deployment that
    // actually indexes PDFs — this is a ~9MB one-off heap cost in a container
    // budgeted at 512Mi, and a broker serving only Slack should not pay it.
    const { extractText, getDocumentProxy } = await import("unpdf");

    try {
      const document = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(document, { mergePages: true });
      return (Array.isArray(text) ? text.join("\n\n") : text).trim();
    } catch (cause) {
      // A PDF we cannot parse is not a PDF we should retry: encrypted,
      // truncated or malformed does not improve on a second pass.
      throw new PermanentError(`gdrive file ${file.id} could not be parsed as a PDF: ${String(cause)}`);
    }
  }

  /**
   * Extracts text from an Office Open XML file (.docx / .xlsx / .xlsm).
   *
   * Same shape as readPdf: oversized files are refused before download, bytes
   * are fetched once, and an unparseable file is PERMANENT (a corrupt or
   * password-protected doc does not improve on retry) rather than a silent skip.
   * Parsing lives in ./ooxml (fflate to unzip, parse5 to read the XML).
   */
  private async readOffice(file: DriveFile, token: string, kind: "docx" | "xlsx"): Promise<string> {
    const size = Number(file.size ?? 0);
    if (size > MAX_OFFICE_BYTES) {
      throw new PermanentError(
        `gdrive file ${file.id} is ${Math.round(size / 1024 / 1024)}MB, over the ` +
          `${Math.round(MAX_OFFICE_BYTES / 1024 / 1024)}MB limit for Office extraction`,
      );
    }

    const bytes = await this.callBytes(`/files/${encodeURIComponent(file.id)}`, token, { alt: "media" });

    // Lazy, like unpdf: a broker that indexes no Office files never loads fflate.
    const { unzipSync } = await import("fflate");
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(bytes));
    } catch (cause) {
      throw new PermanentError(`gdrive file ${file.id} is not a readable ${kind} (unzip failed): ${String(cause)}`);
    }

    try {
      return kind === "docx" ? extractDocxText(entries) : extractXlsxText(entries);
    } catch (cause) {
      throw new PermanentError(`gdrive file ${file.id} could not be parsed as ${kind}: ${String(cause)}`);
    }
  }

  private async callBytes(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<ArrayBuffer> {
    const response = await this.request(path, token, params);
    if (!response.arrayBuffer) {
      throw new PermanentError("this fetch implementation cannot read bytes");
    }
    return response.arrayBuffer();
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
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    // supportsAllDrives on EVERY call (get/list/export/media): without it the
    // Drive API refuses to act on Shared Drive items at all, even when the
    // credential has access. List calls additionally set includeItemsFromAllDrives
    // where the query is built. Harmless on My-Drive-only content.
    const url = `${this.apiOrigin}${path}?${new URLSearchParams({ supportsAllDrives: "true", ...params }).toString()}`;

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

/**
 * How many folders one Corpus may span.
 *
 * Every folder becomes an `'<id>' in parents` term in a single query, and
 * Drive's query strings are not unbounded. The cap keeps that query sane and
 * gives an operator a clear error instead of a request Drive rejects for
 * reasons that do not mention size.
 */
const MAX_TREE_FOLDERS = 200;

/** Pages of subfolders to read per parent before giving up on the walk. */
const MAX_TREE_PAGES = 50;

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

function requireDelegatedDrive(credentials: Credentials): string {
  if (!credentials.delegated) {
    throw new Error("a gdrive user read requires the calling user's delegated token");
  }
  return credentials.delegated;
}

function requireToken(token: string | undefined): string {
  if (!token) throw new Error("no credential supplied for a gdrive request");
  return token;
}
