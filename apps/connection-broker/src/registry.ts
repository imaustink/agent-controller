import type { Driver, Scope } from "./drivers/types.js";

/**
 * What the broker needs to act on one Connection: which driver, which scope,
 * and the service credential for ingestion.
 */
export interface ConnectionBinding {
  name: string;
  driver: Driver;
  scope: Scope;
  /** Ingestion credential. Never handed to a request-path caller (see auth.ts). */
  serviceToken: string;
}

/**
 * Resolves a connection name to its binding.
 *
 * An interface rather than a concrete loader because the source of truth is the
 * `Connection` CR, and the broker should ultimately watch those directly the
 * way the catalog does (ADR 0020). `StaticConnectionRegistry` is the seam that
 * keeps the rest of the service testable and lets the CR watch land without
 * touching anything downstream of it.
 */
export interface ConnectionRegistry {
  get(name: string): ConnectionBinding | undefined;
}

export class StaticConnectionRegistry implements ConnectionRegistry {
  private readonly bindings: Map<string, ConnectionBinding>;

  constructor(bindings: ConnectionBinding[]) {
    this.bindings = new Map(bindings.map((binding) => [binding.name, binding]));
    // Scope is the security boundary, so it is validated once here rather than
    // being trusted on every request. A driver that accepts an unvalidated
    // scope silently widens a client boundary.
    for (const binding of bindings) binding.driver.validateScope(binding.scope);
  }

  get(name: string): ConnectionBinding | undefined {
    return this.bindings.get(name);
  }
}
