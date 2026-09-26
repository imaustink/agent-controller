import type { ToolDescriptor } from "../tool-descriptor.js";
import type { DelegatedCredentialResolver } from "./searcher.js";

export interface CorpusReaderOptions {
  /** Base URL of the connection-broker Service. */
  brokerUrl: string;
  /** Authenticates THIS orchestrator to the broker. */
  brokerToken: string;
  credentials: DelegatedCredentialResolver;
  fetchImpl?: typeof fetch;
}

export interface CorpusReadResult {
  result: string;
  /** Set when the caller has not linked the credential this read requires. */
  needsLink?: boolean;
}

/**
 * Reads one resource live, as the calling user — a Corpus's GET face
 * (docs/adr/0038 §5).
 *
 * The escape hatch retrieval needs and deliberately does not take on itself: an
 * indexed chunk is a snapshot, and when the model decides the snapshot is not
 * good enough it spends a call, rather than every retrieval paying for
 * hydration it may not need (docs/adr/0040).
 *
 * The orchestrator holds no third-party credential of its own. It forwards the
 * caller's delegated token per request, and the broker refuses to let it spend
 * a corpus's service credential at all — so this carries a credential it did
 * not mint and cannot widen.
 *
 * PARITY: `ReadCorpus` in
 * `engines/temporal/internal/temporal/activities/corpus_get.go`.
 */
export class CorpusReader {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CorpusReaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async read(tool: ToolDescriptor, path: string, subject: string): Promise<CorpusReadResult> {
    const exec = tool.corpusGetExec;
    if (!exec) throw new Error(`tool ${tool.id} carries no corpus GET spec`);

    const credential = await this.options.credentials.delegatedToken(
      subject,
      exec.identityProviders ?? [],
    );
    if (!credential?.token) {
      // Asked rather than failed, and never silently fallen back to the
      // ingestion credential — that would answer a different question,
      // permissively.
      return {
        needsLink: true,
        result:
          `I need you to link the account behind ${exec.label ?? exec.corpusId} before I can ` +
          "read from it — a live read has to run as you, not as the ingestion credential.",
      };
    }

    // Each segment escaped separately: escaping the whole path would encode the
    // separators and turn a two-segment request into one meaningless one.
    const segments = path
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` +
      `/corpora/${encodeURIComponent(exec.corpusId)}/api/${segments}`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: {
          authorization: `Bearer ${this.options.brokerToken}`,
          "x-delegated-token": credential.token,
        },
      });
    } catch (cause) {
      throw new Error(`connection-broker unreachable: ${String(cause)}`);
    }

    if (!response.ok) {
      // Returned as prose rather than thrown: a refused path or a resource this
      // user may not see is an ANSWER the model can act on — it can try a
      // different path, or say the material is not available — where a thrown
      // error just ends the turn.
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      return { result: `The source refused that read (${response.status}). ${detail}`.trim() };
    }

    const body = (await response.json()) as { body?: unknown; url?: string };
    const citation = body.url ? ` — ${body.url}` : "";
    return {
      result:
        `Live read from ${exec.label ?? exec.corpusId} (${path})${citation}:\n\n` +
        `${JSON.stringify(body.body, null, 2)}`,
    };
  }
}
