import { describe, expect, it, vi } from "vitest";
import {
  collectionOf,
  CorpusConfigError,
  reconcileIntervalMs,
  SERVICE_TOKEN_ENV,
  toBinding,
  type ConnectionCustomResource,
  type CorpusCustomResource,
} from "./corpus-resource.js";
import { ConfluenceDriver } from "./drivers/confluence.js";
import { JazzHRDriver } from "./drivers/jazzhr.js";

function connection(overrides: Partial<ConnectionCustomResource["spec"]> = {}): ConnectionCustomResource {
  return {
    metadata: { name: "bitovi-confluence", namespace: "clients" },
    spec: {
      provider: "confluence",
      displayName: "Bitovi Confluence",
      site: { baseURL: "https://wiki.at.bitovi.com/wiki", cloudId: "cloud-1" },
      secretEnv: [{ name: SERVICE_TOKEN_ENV, secretRef: { name: "atlassian", key: "token" } }],
      ...overrides,
    },
  };
}

function corpus(overrides: Partial<CorpusCustomResource["spec"]> = {}): CorpusCustomResource {
  return {
    metadata: { name: "globex-confluence", namespace: "clients" },
    spec: {
      connectionRef: "bitovi-confluence",
      displayName: "GLOBEX Confluence",
      allowedRoles: ["reader"],
      scope: { space: "GLOBEX" },
      ...overrides,
    },
    status: { collection: "corpus_clients_globex-confluence" },
  };
}

// No default parameter: `secrets(undefined)` must mean "the Secret is absent",
// and a default would silently turn that into the happy path.
const secrets = (...value: [string | undefined] | []) =>
  vi.fn().mockResolvedValue(value.length === 0 ? "svc-token" : value[0]);

describe("toBinding", () => {
  it("builds a binding from a Corpus and the Connection it draws from", async () => {
    const read = secrets();
    const binding = await toBinding(corpus(), connection(), read);

    expect(binding.name).toBe("globex-confluence");
    // Carried so a webhook delivery, which arrives per Connection, can be
    // routed to every Corpus over it.
    expect(binding.connection).toBe("bitovi-confluence");
    expect(binding.driver).toBeInstanceOf(ConfluenceDriver);
    expect(binding.scope).toEqual({ space: "GLOBEX", channel: undefined, folderID: undefined });
    expect(binding.allowedRoles).toEqual(["reader"]);
    expect(binding.serviceToken).toBe("svc-token");
    expect(read).toHaveBeenCalledWith("atlassian", "token");
  });

  it("refuses a Corpus paired with the wrong Connection", async () => {
    // A wiring mistake rather than a user error, and the worst one to serve:
    // a driver addressed at one system with another's scope.
    const mismatched = { ...connection(), metadata: { name: "someone-else", namespace: "clients" } };
    await expect(toBinding(corpus(), mismatched, secrets())).rejects.toThrow(/but was given someone-else/);
  });

  it("refuses a confluence connection with no site", async () => {
    // A CEL rule blocks this at admission, but admission does not cover a CR
    // that predates the rule — so the consumer checks too.
    await expect(
      toBinding(corpus(), connection({ site: undefined }), secrets()),
    ).rejects.toBeInstanceOf(CorpusConfigError);
  });

  it("refuses a provider no driver implements", async () => {
    await expect(
      toBinding(corpus(), connection({ provider: "notion" }), secrets()),
    ).rejects.toThrow(/no driver implements provider "notion"/);
  });

  it("refuses when the Connection names no service credential", async () => {
    await expect(
      toBinding(corpus(), connection({ secretEnv: [] }), secrets()),
    ).rejects.toThrow(/no secretEnv entry named SERVICE_TOKEN/);
  });

  it("refuses when the named Secret is missing or empty", async () => {
    // An empty token would reach the driver and fail as a 401, which reads as
    // a permissions problem rather than a missing Secret.
    await expect(toBinding(corpus(), connection(), secrets(undefined))).rejects.toThrow(/missing or empty/);
    await expect(toBinding(corpus(), connection(), secrets(""))).rejects.toThrow(/missing or empty/);
  });

  it("picks the service credential BY NAME, not by position", async () => {
    const read = vi.fn(async (secret: string) => (secret === "right" ? "correct-token" : "wrong-token"));
    const binding = await toBinding(
      corpus(),
      connection({
        secretEnv: [
          { name: "WEBHOOK_SECRET", secretRef: { name: "wrong", key: "k" } },
          { name: SERVICE_TOKEN_ENV, secretRef: { name: "right", key: "k" } },
        ],
      }),
      read,
    );

    // A connection may legitimately carry several secrets. Taking the first
    // would authenticate to the source with something that is not the ingestion
    // credential and fail in a way that looks like a permissions problem.
    expect(binding.serviceToken).toBe("correct-token");
  });

  it("builds a slack binding, which needs no site coordinates", async () => {
    const binding = await toBinding(
      corpus({ scope: { channel: "C123ABC" } }),
      connection({ provider: "slack", site: undefined }),
      secrets(),
    );
    expect(binding.driver.provider).toBe("slack");
    expect(binding.scope.channel).toBe("C123ABC");
  });

  it("builds a gdrive binding", async () => {
    const binding = await toBinding(
      corpus({ scope: { folderID: "FOLDER1" } }),
      connection({ provider: "gdrive", site: undefined }),
      secrets(),
    );
    expect(binding.driver.provider).toBe("gdrive");
  });
});

// The credential holder decides what the credential may pull (ADR 0043 §3).
// The controller checks this too; both exist because they answer at different
// moments, and this is the last one before a credential is actually spent.
describe("the Connection's allowedScopes cap", () => {
  it("refuses a subset the Connection does not permit", async () => {
    await expect(
      toBinding(corpus(), connection({ allowedScopes: { spaces: ["PERMITTED"] } }), secrets()),
    ).rejects.toThrow(/does not permit/);
  });

  it("permits a subset inside the cap", async () => {
    const binding = await toBinding(
      corpus(),
      connection({ allowedScopes: { spaces: ["GLOBEX"] } }),
      secrets(),
    );
    expect(binding.name).toBe("globex-confluence");
  });

  it("permits anything when the Connection sets no cap", async () => {
    // An absent allowlist means no cap, not an empty one — reading it the
    // other way would break every Connection that never set one.
    const binding = await toBinding(corpus(), connection(), secrets());
    expect(binding.name).toBe("globex-confluence");
  });

  it("ignores a cap for a different provider's unit", async () => {
    // Channels listed on a confluence connection say nothing about spaces.
    const binding = await toBinding(
      corpus(),
      connection({ allowedScopes: { channels: ["C123"] } }),
      secrets(),
    );
    expect(binding.name).toBe("globex-confluence");
  });
});

describe("collectionOf", () => {
  it("reads the collection the controller published", () => {
    expect(collectionOf(corpus())).toBe("corpus_clients_globex-confluence");
  });

  it("is undefined before the Corpus has been reconciled", () => {
    // Deriving a name here instead would disagree with the controller the
    // first time the scheme changed, and look like an empty corpus.
    expect(collectionOf({ ...corpus(), status: undefined })).toBeUndefined();
  });
});

describe("reconcileIntervalMs", () => {
  it("parses a Go-style duration", () => {
    expect(reconcileIntervalMs(corpus({ sync: { mode: "poll", reconcileInterval: "6h" } }))).toBe(
      6 * 3_600_000,
    );
  });

  it("does not schedule a corpus that indexes nothing", () => {
    expect(reconcileIntervalMs(corpus({ sync: { mode: "none" } }))).toBeUndefined();
  });

  it("does not default a missing interval", () => {
    // A CEL rule requires one, so its absence is a CR that should not exist.
    // Defaulting would reconcile on a cadence nobody chose.
    expect(reconcileIntervalMs(corpus({ sync: { mode: "poll" } }))).toBeUndefined();
  });
});

describe("jazzhr provider", () => {
  const jazzConnection = (overrides: Partial<ConnectionCustomResource["spec"]> = {}): ConnectionCustomResource => ({
    metadata: { name: "bitovi-jazz", namespace: "clients" },
    spec: {
      provider: "jazzhr",
      secretEnv: [{ name: SERVICE_TOKEN_ENV, secretRef: { name: "jazz", key: "apiKey" } }],
      ...overrides,
    },
  });
  const jazzCorpus = (scope: CorpusCustomResource["spec"]["scope"]): CorpusCustomResource => ({
    metadata: { name: "senior-eng", namespace: "clients" },
    spec: { connectionRef: "bitovi-jazz", allowedRoles: ["recruiter"], scope },
    status: { collection: "corpus_clients_senior-eng" },
  });

  it("dispatches to the JazzHR driver for a named job", async () => {
    const binding = await toBinding(jazzCorpus({ jobID: "job-1" }), jazzConnection(), secrets());
    expect(binding.driver).toBeInstanceOf(JazzHRDriver);
    expect(binding.scope).toMatchObject({ jobID: "job-1" });
    expect(binding.scope.all).toBeUndefined();
  });

  it("carries the Connection's jobIDs cap into a wildcard scope as allowedUnits", async () => {
    const binding = await toBinding(
      jazzCorpus({ all: true }),
      jazzConnection({ allowedScopes: { jobIDs: ["job-1", "job-2"] } }),
      secrets(),
    );
    expect(binding.scope.all).toBe(true);
    expect(binding.scope.allowedUnits).toEqual(["job-1", "job-2"]);
  });

  it("leaves allowedUnits unset for an uncapped wildcard", async () => {
    const binding = await toBinding(jazzCorpus({ all: true }), jazzConnection(), secrets());
    expect(binding.scope.all).toBe(true);
    expect(binding.scope.allowedUnits).toBeUndefined();
  });

  it("permits a wildcard even when the Connection caps scopes", async () => {
    // A wildcard is bounded by the cap at enumeration time, not rejected here.
    await expect(
      toBinding(jazzCorpus({ all: true }), jazzConnection({ allowedScopes: { jobIDs: ["job-1"] } }), secrets()),
    ).resolves.toBeDefined();
  });

  it("still enforces the cap for a NAMED job outside it", async () => {
    await expect(
      toBinding(jazzCorpus({ jobID: "job-9" }), jazzConnection({ allowedScopes: { jobIDs: ["job-1"] } }), secrets()),
    ).rejects.toBeInstanceOf(CorpusConfigError);
  });
});
