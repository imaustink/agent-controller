import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  authenticate,
  authorize,
  ForbiddenError,
  UnauthorizedError,
  type AuthConfig,
  type Operation,
} from "./auth.js";
import {
  PermanentError,
  PermissionDeniedError,
  TransientError,
  type Credentials,
  type Scope,
} from "./drivers/types.js";
import type { CorpusRegistry } from "./registry.js";

/**
 * The broker's HTTP surface (docs/adr/0038 §3).
 *
 * Three operations, and which credential each may spend is decided by auth.ts
 * rather than by the route — so a new route cannot accidentally hand a
 * request-path caller the ingestion credential.
 *
 *   GET  /corpora/:name/resources              — incremental listing (sync only)
 *   GET  /corpora/:name/resources/:id          — one document, SCOPE-bounded (sync)
 *   GET  /corpora/:name/documents/:id          — one document, IDENTITY-bounded (read)
 *   GET  /corpora/:name/search?q=              — live search, SCOPE- and identity-bounded
 *   POST /corpora/:name/probe                  — per-user authorization (ADR 0040)
 *   POST /corpora/:name/sync                   — run a reconcile now (sync only)
 *   POST /connections/:name/webhook            — provider change notification
 *
 * Data is addressed by CORPUS and webhooks by CONNECTION, which is not an
 * inconsistency: a provider signs and delivers per integration, so one delivery
 * fans out to every Corpus over that Connection (ADR 0043 §4).
 */
export interface ServerOptions {
  auth: AuthConfig;
  registry: CorpusRegistry;
  /**
   * Webhook support, absent when this broker does not index.
   *
   * `secretFor` returns the shared secret the provider signs with; a connection
   * without one cannot receive webhooks, which is a configuration state rather
   * than an error — it simply stays on its reconcile interval.
   */
  /**
   * Runs a full reconcile for one corpus, for the CronJob that triggers it.
   *
   * Absent when this deployment does not index, in which case the route
   * reports not-found rather than accepting a kick it cannot act on.
   */
  runSync?: (corpus: string) => Promise<{ indexed: number; removed: number; full: boolean } | undefined>;
  webhooks?: {
    secretFor: (connection: string) => string | undefined;
    /**
     * Schedules a pass for the named resources on one CORPUS. An EMPTY list
     * means "something changed, we do not know what", which must escalate to a
     * full pass rather than be dropped.
     */
    onChange: (corpus: string, sourceIds: string[]) => void;
  };
}

/** Header carrying the calling user's delegated token, per request. */
export const DELEGATED_TOKEN_HEADER = "x-delegated-token";

export function createBrokerServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    void handle(options, req, res).catch((err: unknown) => {
      // Nothing below should throw uncaught; if it does, do not leak internals.
      console.error("broker request failed:", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
}

async function handle(
  options: ServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://broker.invalid");

  if (url.pathname === "/healthz") {
    send(res, 200, { ok: true });
    return;
  }

  const route = parseRoute(url.pathname);
  if (!route) {
    send(res, 404, { error: "not found" });
    return;
  }

  // Webhooks are authenticated by the PROVIDER's signature, not by a bearer
  // token: the caller is Confluence or Slack, which hold no credential of ours.
  // Handled before the bearer path so an unsigned request cannot fall through
  // into it.
  if (route.kind === "webhook") {
    await handleWebhook(options, route.name, req, res);
    return;
  }

  let credential: "service" | "delegated";
  const delegated = header(req, DELEGATED_TOKEN_HEADER);
  try {
    const caller = authenticate(options.auth, header(req, "authorization"));
    // A sync kick spends the SERVICE credential, exactly as listing does, so
    // it authorizes as a list: only this corpus's sync worker may ask for one.
    // A user read authorizes exactly as a fetch does: the orchestrator may,
    // with a delegated token, and a sync worker may not — it has no user to
    // read as, and this read is nothing but the user's access.
    const operation: Operation =
      route.kind === "probe"
        ? "probe"
        : // A search reads on the caller's behalf and must never reach the
          // ingestion credential, which is exactly what `fetch` already
          // encodes — so it authorizes as one rather than growing a fourth
          // operation that would have to be kept in step with it.
          route.kind === "documents" || route.kind === "search" || route.id
          ? "fetch"
          : "list";
    ({ credential } = authorize(caller, operation, route.name, delegated));
  } catch (err) {
    if (err instanceof UnauthorizedError) return send(res, 401, { error: err.message });
    if (err instanceof ForbiddenError) return send(res, 403, { error: err.message });
    throw err;
  }

  const binding = options.registry.get(route.name);
  if (!binding) {
    send(res, 404, { error: `no such corpus: ${route.name}` });
    return;
  }

  // Only ever hand the driver the credential authorization actually granted.
  const credentials: Credentials =
    credential === "service" ? { service: binding.serviceToken } : { delegated };

  // `documents` and `search` are user reads BY DEFINITION: both answer "what
  // can this person see", and both are meaningless without a person.
  //
  // auth.ts authorizes them as a fetch, which is right about the danger — they
  // must never spend the ingestion credential — but a fetch is also a
  // legitimate SYNC operation, so a sync worker passes that check and arrives
  // here holding the service credential. Today every driver refuses it, but
  // that makes the boundary a thing each driver has to remember, and
  // `searchAsUser` is optional, so the next one can forget. Refusing here
  // makes it a property of the route instead.
  if ((route.kind === "documents" || route.kind === "search") && credential !== "delegated") {
    return send(res, 403, {
      error: `${route.kind} is a read on a user's behalf and requires a delegated token`,
    });
  }

  try {
    if (route.kind === "documents") {
      if (!binding.driver.readAsUser) {
        return send(res, 404, { error: `${binding.driver.provider} has no user read` });
      }
      // Note what is NOT passed: the scope. This read is bounded by who is
      // asking, not by what the corpus covers, so handing the driver a scope
      // would only invite it to enforce one.
      const document = await binding.driver.readAsUser(credentials, route.id!);
      return send(res, 200, document);
    }

    if (route.kind === "search") {
      if (!binding.driver.searchAsUser) {
        return send(res, 404, { error: `${binding.driver.provider} has no live search` });
      }
      const query = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const hits = await binding.driver.searchAsUser(
        credentials,
        // The scope IS passed here, unlike the document read directly above.
        // That asymmetry is the design (see Driver.searchAsUser), not an
        // inconsistency between two neighbouring lines.
        binding.scope,
        query,
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 25) : 10,
      );
      return send(res, 200, { hits });
    }

    if (route.kind === "sync") {
      if (!options.runSync) return send(res, 404, { error: "this broker does not index" });
      const report = await options.runSync(route.name);
      // A pass already running is not a failure: the CronJob fired while the
      // previous one was still going, which Forbid concurrency should prevent
      // and a restart can still produce. 409 lets the Job surface it without
      // looking like an error.
      if (!report) return send(res, 409, { error: "a pass is already running" });
      return send(res, 200, report);
    }

    if (route.kind === "probe") {
      const body = await readJson(req);
      const result = await binding.driver.probe(
        binding.scope,
        credentials,
        typeof body.sourceId === "string" ? body.sourceId : undefined,
      );
      send(res, 200, result);
      return;
    }

    if (route.id) {
      const document = await binding.driver.fetch(binding.scope, credentials, route.id);
      send(res, 200, document);
      return;
    }

    const page = await binding.driver.list(
      binding.scope,
      credentials,
      url.searchParams.get("cursor") ?? undefined,
    );
    send(res, 200, page);
  } catch (err) {
    // The distinction the caller must be able to act on (ADR 0040): 403 is a
    // drop, 503 is "we could not find out" and must never become a silent
    // omission.
    if (err instanceof PermissionDeniedError) return send(res, 403, { error: err.message });
    if (err instanceof TransientError) return send(res, 503, { error: err.message });
    // Deliberately NOT 503: the caller retries those, and this is the one
    // failure retrying can never fix. 500 stops the loop and puts the
    // provider's own explanation where an operator will read it.
    if (err instanceof PermanentError) return send(res, 500, { error: err.message });
    throw err;
  }
}

interface Route {
  /** A corpus name for data routes; a CONNECTION name for a webhook. */
  name: string;
  kind: "resources" | "documents" | "search" | "probe" | "sync" | "webhook";
  id?: string;
}

/**
 * Handles a provider change notification.
 *
 * This endpoint is reachable by anyone who can route to the pod, so the
 * driver's signature check is the entire boundary. Everything here fails
 * closed: no webhook support, no secret, no driver support, or a signature that
 * does not verify all end the request without touching a credential.
 *
 * It deliberately answers 200 to a VERIFIED notification it does not act on.
 * Providers disable endpoints that keep returning errors, and "this event was
 * not about anything we index" is a normal outcome, not a failure.
 */
async function handleWebhook(
  options: ServerOptions,
  connection: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const webhooks = options.webhooks;

  // Every Corpus drawing from this Connection is a candidate; which of them the
  // delivery is actually about is decided below, from the scope key the driver
  // reports.
  const candidates = options.registry.list().filter((binding) => binding.connection === connection);

  // Deliberately the same answer for "unknown connection", "webhooks off",
  // "nothing indexed from it" and "no secret configured": a distinguishable
  // response here would let an unauthenticated caller enumerate what exists.
  if (!webhooks || candidates.length === 0) {
    send(res, 404, { error: "not found" });
    return;
  }
  const secret = webhooks.secretFor(connection);
  if (!secret) {
    send(res, 404, { error: "not found" });
    return;
  }

  // Any Corpus over this Connection can verify the signature — they all share
  // one driver type and one secret — so the first is enough to decide whether
  // the request is trustworthy at all.
  const verifier = candidates[0]!.driver;
  if (!verifier.parseWebhook) {
    send(res, 404, { error: "not found" });
    return;
  }

  // The bytes as received: a signature is computed over them, so a parsed and
  // re-stringified body verifies against nothing.
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = verifier.parseWebhook({
      headers: req.headers as Record<string, string | undefined>,
      rawBody,
    }, secret);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return send(res, 401, { error: "signature verification failed" });
    }
    throw err;
  }

  // Verified, but not something this provider wants us to act on — a Slack URL
  // handshake, a retry of an event type we ignore.
  if (!event) return send(res, 200, { ok: true, acted: false });

  const targets = candidates.filter((binding) => coversScope(binding.scope, event.scopeKey));

  // Verified, and about a subset nobody indexed. The ORDINARY case: most events
  // in a workspace concern channels no Corpus covers. Answered 200 because
  // providers disable endpoints that keep returning errors.
  if (targets.length === 0) return send(res, 200, { ok: true, acted: false });

  for (const target of targets) webhooks.onChange(target.name, event.sourceIds);
  send(res, 202, { ok: true, acted: true, corpora: targets.length, resources: event.sourceIds.length });
}

/**
 * Whether a Corpus's scope is the subset a delivery named.
 *
 * An absent scope key means the provider told us something changed without
 * saying where — every Corpus over the Connection is a candidate, and each
 * escalates to a full pass rather than nothing, because a deletion whose event
 * never arrived would otherwise never be noticed.
 */
function coversScope(scope: Scope, scopeKey: string | undefined): boolean {
  if (!scopeKey) return true;
  return scope.space === scopeKey || scope.channel === scopeKey || scope.folderID === scopeKey;
}

function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts[1]) return undefined;
  const name = decodeURIComponent(parts[1]);

  // Data is addressed by CORPUS: a scope, a role list, a collection.
  if (parts[0] === "corpora") {
    if (parts[2] === "probe" && parts.length === 3) return { name, kind: "probe" };
    if (parts[2] === "sync" && parts.length === 3) return { name, kind: "sync" };
    // Two reads, deliberately on different paths. `resources` is the
    // ingestion read and stays inside the Corpus's scope; `documents` is the
    // user read and is bounded by the caller's own access instead. Same driver,
    // different question — and a URL that says which one was asked.
    if (parts[2] === "documents" && parts.length === 4) {
      return { name, kind: "documents", id: decodeURIComponent(parts[3]!) };
    }
    // The third read, and the one bounded BOTH ways: by the corpus's scope and
    // by the caller. `documents` may leave the scope because a citation
    // anchors it; a search has no anchor, so it may not.
    if (parts[2] === "search" && parts.length === 3) return { name, kind: "search" };
    if (parts[2] === "resources") {
      if (parts.length === 3) return { name, kind: "resources" };
      if (parts.length === 4) {
        // Reading ONE resource by the id the index gave out. This is the live
        // read face: no provider path, no pattern matching — an id, checked
        // against the corpus's scope by the driver, fetched with the caller's
        // own token.
        return { name, kind: "resources", id: decodeURIComponent(parts[3]!) };
      }
    }
    return undefined;
  }

  // Webhooks are addressed by CONNECTION, because that is what a provider
  // signs and delivers per — one Slack app, one Confluence site (ADR 0043 §4).
  if (parts[0] === "connections" && parts[2] === "webhook" && parts.length === 3) {
    return { name, kind: "webhook" };
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A probe body is a few fields; anything larger is not a probe.
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The body as BYTES, for signature verification.
 *
 * Separate from readJson because a signature is computed over exactly what was
 * sent: parsing and re-stringifying reorders keys and drops whitespace, and the
 * result verifies against nothing.
 *
 * Bounded like every other body here — this endpoint is unauthenticated until
 * the signature has been checked, and the signature cannot be checked until the
 * body is read, so the limit is the only thing bounding an anonymous request.
 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("webhook body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
