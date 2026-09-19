import { describe, expect, it } from "vitest";
import {
  authenticate,
  authorize,
  ForbiddenError,
  UnauthorizedError,
  type AuthConfig,
} from "./auth.js";

const config: AuthConfig = {
  orchestratorToken: "orchestrator-secret",
  syncTokens: new Map([
    ["snc-confluence", "snc-sync-secret"],
    ["acme-confluence", "acme-sync-secret"],
  ]),
};

describe("authenticate", () => {
  it("identifies the orchestrator", () => {
    expect(authenticate(config, "Bearer orchestrator-secret")).toEqual({ kind: "orchestrator" });
  });

  it("identifies a sync worker by the connection its token was issued for", () => {
    expect(authenticate(config, "Bearer snc-sync-secret")).toEqual({
      kind: "sync",
      connection: "snc-confluence",
    });
  });

  it("fails closed on a missing or unknown token", () => {
    // An unrecognized caller is never an anonymous one with reduced powers —
    // reduced powers here still means "can spend somebody's credential".
    expect(() => authenticate(config, undefined)).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "Bearer nope")).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "")).toThrow(UnauthorizedError);
  });
});

describe("authorize", () => {
  const orchestrator = { kind: "orchestrator" } as const;
  const sncSync = { kind: "sync", connection: "snc-confluence" } as const;

  it("lets the orchestrator probe with a delegated token", () => {
    expect(authorize(orchestrator, "probe", "snc-confluence", "user-token")).toEqual({
      credential: "delegated",
    });
  });

  it("refuses to let the orchestrator spend the service credential", () => {
    // The whole point: a compromised or confused orchestrator would otherwise
    // read every client's entire corpus with the ingestion credential.
    expect(() => authorize(orchestrator, "fetch", "snc-confluence", undefined)).toThrow(
      ForbiddenError,
    );
  });

  it("refuses to let the orchestrator list", () => {
    // Listing is an ingestion operation; letting a request-path component drive
    // it would hand it corpus-wide enumeration.
    expect(() => authorize(orchestrator, "list", "snc-confluence", "user-token")).toThrow(
      /may not list/,
    );
  });

  it("scopes a sync worker to its own connection", () => {
    expect(authorize(sncSync, "list", "snc-confluence", undefined)).toEqual({
      credential: "service",
    });
    // A leaked sync credential must reach one client's source, not every one.
    expect(() => authorize(sncSync, "list", "acme-confluence", undefined)).toThrow(ForbiddenError);
  });

  it("refuses to let a sync worker probe", () => {
    // A probe answers "may this USER read it", and a sync worker has no user.
    expect(() => authorize(sncSync, "probe", "snc-confluence", "somehow-a-token")).toThrow(
      /cannot probe on behalf of a user/,
    );
  });

  it("does not let a delegated token upgrade a sync caller", () => {
    // Supplying a user token must not change which credential a sync caller
    // spends, or the two classes would collapse into one.
    expect(authorize(sncSync, "fetch", "snc-confluence", "user-token")).toEqual({
      credential: "service",
    });
  });
});
