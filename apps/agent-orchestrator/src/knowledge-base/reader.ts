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
 * Takes an ID, never a path. An earlier version accepted a provider path and
 * matched it against per-driver regexes, which answered the wrong question —
 * "does this look like a page read" rather than "may this person read it" —
 * and put pattern matching on model-supplied text at the centre of a security
 * boundary.
 *
 * The bound is IDENTITY, not the corpus's scope. Material cites other spaces,
 * and an agent that can read a page but not the page it references is not much
 * use. Running as the caller means the source returns exactly what they would
 * see by opening it themselves. The scope check stays on the ingestion path,
 * which has no user to be bounded by.
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

  async read(tool: ToolDescriptor, sourceId: string, subject: string): Promise<CorpusReadResult> {
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

    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` +
      `/corpora/${encodeURIComponent(exec.corpusId)}/documents/${encodeURIComponent(sourceId)}`;

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

    // The fetch route returns a Document: the resource normalised to Markdown,
    // with the citation the source itself reported.
    const document = (await response.json()) as { markdown?: string; url?: string; title?: string };
    const citation = document.url ? ` — ${document.url}` : "";
    return {
      result:
        `Live read from ${exec.label ?? exec.corpusId}: ${document.title ?? sourceId}${citation}\n\n` +
        `${document.markdown ?? ""}`,
    };
  }
}
