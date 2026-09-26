import type { Driver, Scope } from "./drivers/types.js";

/**
 * What the broker needs to act on one Corpus: which driver, which scope, and
 * the service credential for ingestion — the last of which comes from the
 * Corpus's Connection rather than from the Corpus itself (ADR 0043).
 */
export interface CorpusBinding {
  name: string;
  /**
   * The Connection this Corpus draws from (ADR 0043).
   *
   * Carried because webhook deliveries arrive per CONNECTION — one Slack app,
   * one Confluence site — and have to be routed to every Corpus over it.
   */
  connection: string;
  driver: Driver;
  scope: Scope;
  /**
   * Roles a caller must hold to retrieve this connection's chunks.
   *
   * The broker does not enforce these — retrieval RBAC is the orchestrator's —
   * but it WRITES them onto every point it indexes, because a KnowledgeBase
   * mixes connections of differing sensitivity into one search and the filter
   * has to be evaluable on the point itself (ADR 0039 §4).
   */
  allowedRoles: string[];
  /** Ingestion credential. Never handed to a request-path caller (see auth.ts). */
  serviceToken: string;
}

/**
 * Resolves a corpus name to its binding.
 *
 * An interface rather than a concrete loader because the source of truth is the
 * `Corpus` CR, and the broker should ultimately watch those directly the
 * way the catalog does (ADR 0020). `StaticCorpusRegistry` is the seam that
 * keeps the rest of the service testable and lets the CR watch land without
 * touching anything downstream of it.
 */
export interface CorpusRegistry {
  get(name: string): CorpusBinding | undefined;
  /** Every binding, for the sync scheduler and for webhook fan-out. */
  list(): CorpusBinding[];
}

export class StaticCorpusRegistry implements CorpusRegistry {
  private readonly bindings: Map<string, CorpusBinding>;

  constructor(bindings: CorpusBinding[]) {
    this.bindings = new Map(bindings.map((binding) => [binding.name, binding]));
    // Scope is the security boundary, so it is validated once here rather than
    // being trusted on every request. A driver that accepts an unvalidated
    // scope silently widens a client boundary.
    for (const binding of bindings) binding.driver.validateScope(binding.scope);
  }

  get(name: string): CorpusBinding | undefined {
    return this.bindings.get(name);
  }

  list(): CorpusBinding[] {
    return [...this.bindings.values()];
  }
}
