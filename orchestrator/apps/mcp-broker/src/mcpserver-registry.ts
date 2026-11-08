import type { MCPServerCustomResource } from "./mcp-server-resource.js";

/**
 * What the broker needs to act on one MCPServer: the CR itself (for its url,
 * exposure map and identityProviders) and the resolved DISCOVERY credential.
 *
 * The service token is resolved once, at load, from the server's `secretEnv`
 * (ADR 0045 §5) — not on the request path, which would put a Secret read in
 * front of every discovery pass and every invocation. It is used ONLY for
 * tools/list and for a tools/call to a server that declares no
 * identityProviders; a server that runs as the user never has it spent on a
 * call (see server.ts).
 */
export interface MCPServerBinding {
  name: string;
  cr: MCPServerCustomResource;
  /** The discovery credential, or undefined when the server carries no secretEnv. */
  serviceToken?: string;
}

export interface MCPServerRegistry {
  get(name: string): MCPServerBinding | undefined;
  list(): MCPServerBinding[];
}

/** An in-memory registry, for tests and for wiring that supplies its own CRs. */
export class StaticMCPServerRegistry implements MCPServerRegistry {
  private readonly bindings: Map<string, MCPServerBinding>;

  constructor(bindings: MCPServerBinding[]) {
    this.bindings = new Map(bindings.map((binding) => [binding.name, binding]));
  }

  get(name: string): MCPServerBinding | undefined {
    return this.bindings.get(name);
  }

  list(): MCPServerBinding[] {
    return [...this.bindings.values()];
  }
}
