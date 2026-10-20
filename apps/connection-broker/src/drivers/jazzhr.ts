/**
 * JazzHR (Resumator) driver — candidates as a knowledge-base corpus
 * (docs/adr/0038, docs/adr/0043).
 *
 * A Corpus is scoped to ONE JazzHR job (`scope.jobID`, the candidates attached
 * to one opening) or to EVERY job the Connection permits (`scope.all`, the
 * wildcard). `fetch` renders one applicant — profile, questionnaire, and the
 * decoded resume — to Markdown for embedding.
 *
 * Every API detail here is taken from a working integration (bitovi's
 * RatingCandidates), not from JazzHR's published docs, which are incomplete and
 * in places wrong. The three that bite hardest, each learned live:
 *
 *   1. **Auth is a query param, sent twice.** `?apikey=<k>&api_key=<k>` — the
 *      API accepts one spelling on some endpoints and the other elsewhere, and
 *      sending both is the only thing that works everywhere. There is no header
 *      auth. A bad key answers 401 "Invalid API Key".
 *   2. **A WAF rejects the default runtime User-Agent.** A request with no (or a
 *      library-default) UA is 403'd before it reaches the API. Every call sets
 *      an explicit one.
 *   3. **Pagination is a URL PATH SEGMENT, not a query param.** Page 1 has no
 *      suffix; page N≥2 is `<path>/page/N`. Page size is 100; a page shorter
 *      than that (or empty) is the last. And a listing that would hold exactly
 *      one item comes back as a BARE OBJECT, not a one-element array.
 */

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
  type ResourceRef,
  type Scope,
} from "./types.js";
import type { FetchLike } from "./confluence.js";
import { extractDocxText } from "./ooxml.js";

const DEFAULT_API_ORIGIN = "https://api.resumatorapi.com/v1";

/**
 * JazzHR's WAF 403s a request whose User-Agent is missing or a library default
 * (confirmed live against the production API). Every call sets this explicitly.
 */
const USER_AGENT = "agent-controller-connection-broker/1.0";

const PAGE_SIZE = 100;

/**
 * A ceiling on pages walked, so a pathological listing cannot loop forever.
 * 200 pages × 100 = 20k rows per job, well past any real pipeline.
 */
const MAX_PAGES = 200;

/**
 * JazzHR publishes a 240 requests/minute limit (`x-ratelimit-limit: 240`), and
 * a tight fetch loop trips it hard (observed ~90% 429s). Retry ONLY on 429,
 * honouring `Retry-After`; everything else surfaces immediately.
 */
const RATE_LIMIT_MAX_ATTEMPTS = 6;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;

/** Resume bytes we will pull into a 512Mi container before giving up on text. */
const MAX_RESUME_BYTES = 25 * 1024 * 1024;

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface JazzHRDriverOptions {
  fetch?: FetchLike;
  /** Where the API lives; overridden for the e2e fake, like the other drivers. */
  apiOrigin?: string;
  pageSize?: number;
  userAgent?: string;
  /** Injectable sleep so the 429 backoff is testable without real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** One applicant as JazzHR returns it. Every field optional — shapes vary. */
interface JazzApplicant {
  id?: string;
  prospect_int_id?: string;
  first_name?: string;
  firstName?: string;
  last_name?: string;
  lastName?: string;
  email?: string;
  resume_body?: string;
  resumetext?: string;
  resume_text?: string;
  questionnaire?: unknown;
  linkedin_url?: string;
  linkedin?: string;
  apply_date?: string;
  city?: string;
  state?: string;
  phone?: string;
}

/** One file record from `/files/applicant_id/{id}`. Field names vary by shape. */
interface JazzFile {
  id?: string;
  file_id?: string;
  file_name?: string;
  filename?: string;
  name?: string;
  mimeType?: string;
  mime_type?: string;
  content_type?: string;
  /** base64 of the file, when the record carries it inline. */
  file_data?: string;
  content?: string;
  /** an authenticated URL that returns the raw bytes, when it does not. */
  file_url?: string;
  url?: string;
}

/**
 * JazzHR driver.
 *
 * Service-credentialled throughout: JazzHR has no per-user authorization model
 * over candidates — an API key either reaches the account's applicants or it
 * does not — so there is no delegated read to make, and `probeGranularity` is
 * `"connection"` (one answer settles every candidate from this Connection).
 */
export class JazzHRDriver implements Driver {
  readonly provider = "jazzhr";

  private readonly http: FetchLike;
  private readonly apiOrigin: string;
  private readonly pageSize: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JazzHRDriverOptions = {}) {
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiOrigin = (options.apiOrigin ?? DEFAULT_API_ORIGIN).replace(/\/+$/, "");
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  validateScope(scope: Scope): void {
    if (scope.space || scope.channel || scope.folderID) {
      throw new Error("a jazzhr corpus must be scoped to scope.jobID or scope.all, nothing else");
    }
    const named = scope.jobID !== undefined;
    // Exactly one of a named job or the wildcard — never both, never neither.
    if (named === Boolean(scope.all)) {
      throw new Error("a jazzhr corpus must set exactly one of scope.jobID or scope.all");
    }
    // The job id is interpolated into a URL path segment; constrain it to a safe
    // character set so it cannot smuggle in path syntax (../, /page/, a query).
    if (scope.jobID !== undefined && !/^[A-Za-z0-9._-]+$/.test(scope.jobID)) {
      throw new Error(`illegal jazzhr job id: ${scope.jobID}`);
    }
  }

  probeGranularity(): ProbeGranularity {
    return "connection";
  }

  /**
   * Lists the applicant ids in scope.
   *
   * A named-job corpus paginates `/applicants2jobs/job_id/{id}`. A wildcard
   * corpus enumerates the jobs it is permitted — the Connection's `allowedUnits`
   * when it caps them, otherwise every job the key can see via `/jobs` — and
   * concatenates their applicants, de-duplicated (one person can sit in several
   * pipelines).
   *
   * Returns the whole listing in one call with `cursor: undefined`: JazzHR
   * offers no "changed since" cursor, so each reconcile re-lists from scratch.
   * The reconcile pass is the source of truth regardless (ADR 0038 §4), and the
   * worker dedupes unchanged chunks by content hash, so a full re-list re-embeds
   * nothing that did not actually change.
   */
  async list(scope: Scope, credentials: Credentials, _since: Cursor): Promise<ListPage> {
    this.validateScope(scope);
    const apiKey = this.requireService(credentials);

    const jobIDs = scope.all ? await this.resolveJobIDs(scope, apiKey) : [scope.jobID!];

    const seen = new Set<string>();
    const resources: ResourceRef[] = [];
    for (const jobID of jobIDs) {
      const rows = await this.paginate(`/applicants2jobs/job_id/${encodeURIComponent(jobID)}`, apiKey);
      for (const row of rows as Record<string, unknown>[]) {
        const applicantID = String(row.applicant_id ?? row.applicantId ?? "").trim();
        if (!applicantID || seen.has(applicantID)) continue;
        seen.add(applicantID);
        resources.push(this.refFromMapping(applicantID, row, jobID));
      }
    }

    return { resources, cursor: undefined };
  }

  /**
   * One applicant, rendered to Markdown: profile, questionnaire, and the resume
   * — the inline resume text when the profile carries it, otherwise the best
   * resume file decoded (PDF via unpdf, DOCX via OOXML, plain text sniffed).
   */
  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    const apiKey = this.requireService(credentials);

    const applicant = (await this.call(
      `/applicants/${encodeURIComponent(id)}`,
      apiKey,
    )) as JazzApplicant;

    const resume = await this.resolveResume(id, applicant, apiKey);
    const markdown = renderApplicant(id, applicant, resume);

    return {
      id,
      title: fullName(applicant) || id,
      url: profileUrl(applicant, id),
      // No reliable change marker: apply_date is when they applied, not when the
      // record last changed, and nothing else is monotonic. Left undefined; the
      // reconcile pass + content-hash dedupe handle staleness (see `list`).
      version: undefined,
      updatedAt: applicant.apply_date || undefined,
      // JazzHR has no per-candidate ACL — the key reaches the account or it does
      // not — so every applicant is readable by anyone the corpus's roles admit.
      acl: { principals: [], permissive: true },
      markdown,
    };
  }

  /**
   * Candidates carry no per-user permission in JazzHR, so there is nothing to
   * probe as the caller: if the corpus admits this user by role, every indexed
   * candidate is theirs to read. Reports the citation fields from the live
   * record so a retrieval still cites an up-to-date name and link.
   */
  async probe(scope: Scope, credentials: Credentials, id?: string): Promise<ProbeResult> {
    this.validateScope(scope);
    if (!id) {
      // probeGranularity is "connection": one allow settles the whole Connection.
      return { allowed: true, title: "", url: "" };
    }
    const apiKey = this.requireService(credentials);
    const applicant = (await this.call(
      `/applicants/${encodeURIComponent(id)}`,
      apiKey,
    )) as JazzApplicant;
    return { allowed: true, title: fullName(applicant) || id, url: profileUrl(applicant, id) };
  }

  /**
   * The jobs a wildcard corpus covers: the Connection's allowlist when it caps
   * them, otherwise every job `/jobs` returns.
   */
  private async resolveJobIDs(scope: Scope, apiKey: string): Promise<string[]> {
    // A PRESENT cap is exhaustive, even when empty: an explicit `jobIDs: []`
    // means "no jobs", never "every job". Only an ABSENT cap (undefined)
    // enumerates the whole account. See listWildcard for the same rule.
    if (scope.allowedUnits !== undefined) {
      return scope.allowedUnits;
    }
    const jobs = await this.paginate("/jobs", apiKey);
    return (jobs as Record<string, unknown>[])
      .map((job) => String(job.id ?? job.job_id ?? "").trim())
      .filter((jobID) => jobID.length > 0);
  }

  private refFromMapping(applicantID: string, row: Record<string, unknown>, jobID: string): ResourceRef {
    const first = String(row.first_name ?? row.firstName ?? "").trim();
    const last = String(row.last_name ?? row.lastName ?? "").trim();
    const title = [first, last].filter(Boolean).join(" ") || `Applicant ${applicantID}`;
    return {
      id: applicantID,
      title,
      url: `https://app.jazz.co/app/v2/jobs/${encodeURIComponent(jobID)}/candidate/${encodeURIComponent(applicantID)}`,
      acl: { principals: [], permissive: true },
    };
  }

  /**
   * Resume text for an applicant: the inline profile field when present,
   * otherwise the best resume FILE decoded. Returns "" when there is none —
   * absence of a resume is not an error, and a candidate with only a
   * questionnaire still belongs in the index.
   */
  private async resolveResume(
    applicantID: string,
    applicant: JazzApplicant,
    apiKey: string,
  ): Promise<string> {
    const inline = (applicant.resume_body || applicant.resumetext || applicant.resume_text || "").trim();
    if (inline) return inline;

    const file = await this.pickResumeFile(applicantID, apiKey);
    if (!file) return "";

    const bytes = await this.resumeBytes(file, applicantID, apiKey);
    if (!bytes) return "";
    return decodeResumeAsync(bytes, reportedMime(file));
  }

  /**
   * Refuses an oversized resume. Enforced on the DECLARED size before the bytes
   * are materialized (a download's Content-Length, an inline blob's encoded
   * length), so a multi-hundred-MB file never lands in the 512Mi container —
   * the post-read call is only a backstop for a server that declared nothing.
   */
  private assertResumeSize(applicantID: string, bytes: number): void {
    if (bytes > MAX_RESUME_BYTES) {
      // A refusal rather than a silent skip: an operator should see it.
      throw new PermanentError(
        `jazzhr applicant ${applicantID}: resume is ${Math.round(bytes / 1024 / 1024)}MB, ` +
          `over the ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)}MB limit`,
      );
    }
  }

  /**
   * The best resume file for an applicant, or undefined. `/files/applicant_id/`
   * returns a BARE OBJECT when there is exactly one file (not a one-element
   * array), so the listing is normalized before anything reads it. Prefers a
   * file whose name says "resume"/"cv", then the first by id — the same order
   * the reference integration settled on.
   */
  private async pickResumeFile(applicantID: string, apiKey: string): Promise<JazzFile | undefined> {
    const files = (await this.paginate(
      `/files/applicant_id/${encodeURIComponent(applicantID)}`,
      apiKey,
    )) as JazzFile[];
    if (files.length === 0) return undefined;

    const named = files.find((file) => /resume|cv/i.test(fileName(file)));
    return named ?? files[0];
  }

  /** The bytes of a resume file: inline base64 when present, else a download. */
  private async resumeBytes(
    file: JazzFile,
    applicantID: string,
    apiKey: string,
  ): Promise<Uint8Array | undefined> {
    const inline = file.file_data || file.content;
    if (inline) {
      // Bound the decode by the ENCODED length first: base64 decodes to ~3/4 of
      // its length, so an oversized inline resume is refused without ever being
      // decoded into memory.
      this.assertResumeSize(applicantID, Math.floor((inline.length * 3) / 4));
      return base64ToBytes(inline);
    }

    const href = file.file_url || file.url;
    if (!href) return undefined;
    // The authenticated download URL returns the RAW file, not a base64
    // envelope (reference: candidate-export-transformer.js). It already carries
    // the key, so it is fetched as-is rather than through the API-origin call.
    return this.fetchBytes(href, applicantID);
  }

  private requireService(credentials: Credentials): string {
    if (!credentials.service) {
      // A wiring bug, not a source answer: ingestion always runs with the key.
      throw new Error("no jazzhr api key supplied for a service-credentialled call");
    }
    return credentials.service;
  }

  /**
   * Walks JazzHR's path-segment pagination to the end of a listing. Page 1 has
   * no suffix, page N≥2 is `/page/N`; a page shorter than the page size ends it.
   * Normalizes the bare-object-for-one-item shape, and an object whose first
   * array-valued field is the page (some listings wrap).
   */
  private async paginate(path: string, apiKey: string): Promise<unknown[]> {
    const records: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const suffix = page === 1 ? "" : `/page/${page}`;
      const data = await this.call(`${path}${suffix}`, apiKey);
      const batch = asArray(data);
      if (batch.length === 0) break;
      records.push(...batch);
      if (batch.length < this.pageSize) break;
    }
    return records;
  }

  /**
   * One GET against the API origin, as JSON. Appends the dual-spelling API key,
   * sets the WAF-satisfying User-Agent, retries a 429 honouring `Retry-After`,
   * and classifies every other failure (401/403 → denied, 5xx/network →
   * transient) so callers never guess what an unlabelled error meant.
   */
  private async call(path: string, apiKey: string): Promise<unknown> {
    const key = encodeURIComponent(apiKey);
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.apiOrigin}${path}${sep}apikey=${key}&api_key=${key}`;

    for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await this.http(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json" } });
      } catch (cause) {
        throw new TransientError(`jazzhr request failed: ${String(cause)}`);
      }

      if (response.ok) return response.json();

      if (response.status === 429 && attempt < RATE_LIMIT_MAX_ATTEMPTS - 1) {
        await this.sleep(retryAfterMs(response, attempt));
        continue;
      }

      const detail = (await safeText(response)).slice(0, 200);
      // 401 is a rejected KEY, not a per-candidate denial, and 403 here is the
      // WAF or a disabled account — both are the whole Connection failing, so
      // neither is a drop. (JazzHR has no per-user candidate ACL to deny at all.)
      if (response.status === 401 || response.status === 403) {
        throw new PermissionDeniedError(`jazzhr returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      if (response.status === 404) {
        // A gone applicant/job is permanent — retrying cannot bring it back —
        // but it must not masquerade as a credential denial.
        throw new PermanentError(`jazzhr returned 404${detail ? `: ${detail}` : ""}`);
      }
      throw new TransientError(`jazzhr returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    // Exhausted the 429 retries.
    throw new TransientError(`jazzhr still rate-limited after ${RATE_LIMIT_MAX_ATTEMPTS} attempts: ${path}`);
  }

  /** Raw bytes from a fully-formed URL (a file download), with the same UA. */
  private async fetchBytes(url: string, applicantID: string): Promise<Uint8Array | undefined> {
    let response;
    try {
      response = await this.http(url, { headers: { "User-Agent": this.userAgent } });
    } catch (cause) {
      throw new TransientError(`jazzhr file download failed: ${String(cause)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PermissionDeniedError(`jazzhr file download returned ${response.status}`);
      }
      if (response.status === 404) return undefined; // a missing file is not a resume
      throw new TransientError(`jazzhr file download returned ${response.status}`);
    }
    // Reject BEFORE reading the body when the server declares an oversized file,
    // so a multi-hundred-MB download never materializes in the container.
    const declared = Number(readHeader(response, "content-length"));
    if (Number.isFinite(declared) && declared > 0) this.assertResumeSize(applicantID, declared);

    if (!response.arrayBuffer) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Backstop for a server that declared no length.
    this.assertResumeSize(applicantID, bytes.byteLength);
    return bytes;
  }
}

/** The page payload, tolerating a bare array, a bare object, or an array-wrapping object. */
function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    // A one-item listing comes back as the item itself. Only an UNAMBIGUOUS page
    // wrapper is unwrapped — exactly one key, and it holds the array. A genuine
    // single-item record (which may itself carry an array-valued field, e.g. a
    // job with a nested list) is one row, not its inner array.
    const entries = Object.entries(data as Record<string, unknown>);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only && Array.isArray(only[1])) {
      return only[1] as unknown[];
    }
    return [data];
  }
  return [];
}

function fullName(applicant: JazzApplicant): string {
  const first = (applicant.first_name || applicant.firstName || "").trim();
  const last = (applicant.last_name || applicant.lastName || "").trim();
  return [first, last].filter(Boolean).join(" ");
}

function profileUrl(applicant: JazzApplicant, applicantID: string): string {
  const prospect = (applicant.prospect_int_id || "").trim();
  if (prospect) return `https://app.jazz.co/app/v2/candidate/${encodeURIComponent(prospect)}/profile`;
  return `https://app.jazz.co/app/v2/candidate/${encodeURIComponent(applicantID)}/profile`;
}

function fileName(file: JazzFile): string {
  return (file.file_name || file.filename || file.name || "").trim();
}

function reportedMime(file: JazzFile): string {
  return (file.mimeType || file.mime_type || file.content_type || "").trim();
}

/** Renders one applicant to Markdown. Only the sections that have content appear. */
function renderApplicant(applicantID: string, applicant: JazzApplicant, resume: string): string {
  const lines: string[] = [];
  const name = fullName(applicant) || `Applicant ${applicantID}`;
  lines.push(`# ${name}`, "");

  const facts: string[] = [];
  if (applicant.email) facts.push(`- **Email:** ${applicant.email}`);
  if (applicant.phone) facts.push(`- **Phone:** ${applicant.phone}`);
  const location = [applicant.city, applicant.state].filter(Boolean).join(", ");
  if (location) facts.push(`- **Location:** ${location}`);
  const linkedin = (applicant.linkedin_url || applicant.linkedin || "").trim();
  if (linkedin) facts.push(`- **LinkedIn:** ${linkedin}`);
  if (applicant.apply_date) facts.push(`- **Applied:** ${applicant.apply_date}`);
  if (facts.length) lines.push(...facts, "");

  const questionnaire = renderQuestionnaire(applicant.questionnaire);
  if (questionnaire) lines.push("## Questionnaire", "", questionnaire, "");

  if (resume) lines.push("## Resume", "", resume.trim(), "");

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Renders the questionnaire, which JazzHR returns in a few shapes: an array of
 * `{question, answer}`, or an object of question→answer. Anything else is
 * stringified rather than dropped.
 */
function renderQuestionnaire(questionnaire: unknown): string {
  if (!questionnaire) return "";
  const pairs: [string, string][] = [];

  if (Array.isArray(questionnaire)) {
    for (const entry of questionnaire) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const question = String(record.question ?? record.text ?? record.label ?? "").trim();
        const answer = String(record.answer ?? record.response ?? record.value ?? "").trim();
        if (question || answer) pairs.push([question || "Question", answer]);
      }
    }
  } else if (typeof questionnaire === "object") {
    for (const [question, answer] of Object.entries(questionnaire as Record<string, unknown>)) {
      pairs.push([question, String(answer ?? "").trim()]);
    }
  }

  return pairs.map(([question, answer]) => `**${question}**\n\n${answer}`).join("\n\n");
}

/**
 * Decodes resume bytes to text, sniffing the real type because JazzHR's
 * reported MIME is frequently wrong or empty (plain-text resumes arrive as
 * `application/octet-stream`). Ported from the reference integration's
 * decodeResumeContent. A PDF or DOCX is extracted to text (the parsers load
 * lazily, so a broker that indexes no resumes pays nothing); a buffer that
 * looks like printable UTF-8 is taken as text; anything else yields "" rather
 * than dumping binary into the index.
 */
async function decodeResumeAsync(bytes: Uint8Array, mimeType: string): Promise<string> {
  if (bytes.byteLength === 0) return "";
  const mime = mimeType.toLowerCase();

  if (isPdf(bytes) || /^application\/(x-)?pdf$/.test(mime)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    try {
      const document = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(document, { mergePages: true });
      return (Array.isArray(text) ? text.join("\n\n") : text).trim();
    } catch (cause) {
      throw new PermanentError(`jazzhr resume could not be parsed as a PDF: ${String(cause)}`);
    }
  }
  if (isZip(bytes) || mime === DOCX_MIME) {
    const { unzipSync } = await import("fflate");
    try {
      return extractDocxText(unzipSync(bytes)).trim();
    } catch (cause) {
      throw new PermanentError(`jazzhr resume could not be parsed as a DOCX: ${String(cause)}`);
    }
  }
  if (mime === "text/plain" || looksLikeText(bytes)) {
    return new TextDecoder("utf-8").decode(bytes).trim();
  }
  return "";
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function isZip(bytes: Uint8Array): boolean {
  // ZIP magic "PK\x03\x04"; DOCX is a ZIP.
  return bytes.byteLength >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * True when a buffer decodes as mostly-printable UTF-8 — a resume saved as
 * plain text under a wrong/empty MIME. Binary (NUL bytes, many invalid
 * sequences) fails, keeping it out of the index.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  if (bytes.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text) return false;
  let suspicious = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0xfffd || code < 0x09 || (code > 0x0d && code < 0x20)) suspicious += 1;
  }
  return suspicious / text.length < 0.1;
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function retryAfterMs(response: unknown, attempt: number): number {
  // FetchLike does not surface headers, but the real global fetch Response does
  // (a `Headers` with `.get`) and a test double may; read it best-effort and
  // fall back to exponential backoff when it is absent.
  const header = readHeader(response, "retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
}

function readHeader(response: unknown, name: string): string | undefined {
  const headers = (response as { headers?: unknown }).headers;
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? undefined;
}

async function safeText(response: { text?: () => Promise<string> }): Promise<string> {
  try {
    return response.text ? (await response.text()).trim() : "";
  } catch {
    return "";
  }
}

export { decodeResumeAsync, renderApplicant, asArray, looksLikeText };
