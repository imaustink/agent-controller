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
    ["globex-confluence", "globex-sync-secret"],
    ["acme-confluence", "acme-sync-secret"],
  ]),
};

describe("authenticate", () => {
  it("identifies the orchestrator", () => {
    expect(authenticate(config, "Bearer orchestrator-secret")).toEqual({ kind: "orchestrator" });
  });

  it("identifies a sync worker by the connection its token was issued for", () => {
    expect(authenticate(config, "Bearer globex-sync-secret")).toEqual({
      kind: "sync",
      connection: "globex-confluence",
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
  const globexSync = { kind: "sync", connection: "globex-confluence" } as const;

  it("lets the orchestrator probe with a delegated token", () => {
    expect(authorize(orchestrator, "probe", "globex-confluence", "user-token")).toEqual({
      credential: "delegated",
    });
  });

  it("refuses to let the orchestrator spend the service credential", () => {
    // The whole point: a compromised or confused orchestrator would otherwise
    // read every client's entire corpus with the ingestion credential.
    expect(() => authorize(orchestrator, "fetch", "globex-confluence", undefined)).toThrow(
      ForbiddenError,
    );
  });

  it("refuses to let the orchestrator list", () => {
    // Listing is an ingestion operation; letting a request-path component drive
    // it would hand it corpus-wide enumeration.
    expect(() => authorize(orchestrator, "list", "globex-confluence", "user-token")).toThrow(
      /may not list/,
    );
  });

  it("scopes a sync worker to its own connection", () => {
    expect(authorize(globexSync, "list", "globex-confluence", undefined)).toEqual({
      credential: "service",
    });
    // A leaked sync credential must reach one client's source, not every one.
    expect(() => authorize(globexSync, "list", "acme-confluence", undefined)).toThrow(ForbiddenError);
  });

  it("refuses to let a sync worker probe", () => {
    // A probe answers "may this USER read it", and a sync worker has no user.
    expect(() => authorize(globexSync, "probe", "globex-confluence", "somehow-a-token")).toThrow(
      /cannot probe on behalf of a user/,
    );
  });

  it("does not let a delegated token upgrade a sync caller", () => {
    // Supplying a user token must not change which credential a sync caller
    // spends, or the two classes would collapse into one.
    expect(authorize(globexSync, "fetch", "globex-confluence", "user-token")).toEqual({
      credential: "service",
    });
  });
});
