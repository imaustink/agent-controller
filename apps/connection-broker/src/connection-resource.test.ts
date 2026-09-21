import { describe, expect, it, vi } from "vitest";
import {
  collectionOf,
  ConnectionConfigError,
  SERVICE_TOKEN_ENV,
  toBinding,
  type ConnectionCustomResource,
} from "./connection-resource.js";
import { ConfluenceDriver } from "./drivers/confluence.js";

function cr(overrides: Partial<ConnectionCustomResource["spec"]> = {}): ConnectionCustomResource {
  return {
    metadata: { name: "snc-confluence", namespace: "default" },
    spec: {
      provider: "confluence",
      displayName: "SNC Confluence",
      scope: { space: "SNC" },
      site: { baseURL: "https://wiki.at.bitovi.com/wiki", cloudId: "cloud-1" },
      secretEnv: [
        { name: SERVICE_TOKEN_ENV, secretRef: { name: "snc-atlassian", key: "token" } },
      ],
      ...overrides,
    },
    status: { collection: "corpus-default-snc-confluence" },
  };
}

// No default parameter: `secrets(undefined)` must mean "the Secret is absent",
// and a default would silently turn that into the happy path.
const secrets = (...value: [string | undefined] | []) =>
  vi.fn().mockResolvedValue(value.length === 0 ? "svc-token" : value[0]);

describe("toBinding", () => {
  it("builds a confluence binding from the CR", async () => {
    const read = secrets();
    const binding = await toBinding(cr(), read);

    expect(binding.name).toBe("snc-confluence");
    expect(binding.driver).toBeInstanceOf(ConfluenceDriver);
    expect(binding.scope).toEqual({ space: "SNC", channel: undefined, folderID: undefined });
    expect(binding.serviceToken).toBe("svc-token");
    expect(read).toHaveBeenCalledWith("snc-atlassian", "token");
  });

  it("refuses a confluence connection with no site", async () => {
    // A CEL rule blocks this at admission, but admission does not cover a CR
    // that predates the rule — so the consumer checks too.
    await expect(toBinding(cr({ site: undefined }), secrets())).rejects.toBeInstanceOf(
      ConnectionConfigError,
    );
  });

  it("refuses a provider no driver implements", async () => {
    // The CRD's enum allows slack and gdrive; neither has a driver yet.
    // Binding them to a stand-in would be worse than refusing to serve them.
    await expect(
      toBinding(cr({ provider: "slack", scope: { channel: "C1" } }), secrets()),
    ).rejects.toThrow(/no driver implements provider "slack"/);
  });

  it("refuses when no service credential is named", async () => {
    await expect(toBinding(cr({ secretEnv: [] }), secrets())).rejects.toThrow(
      /no secretEnv entry named SERVICE_TOKEN/,
    );
  });

  it("refuses when the named Secret is missing or empty", async () => {
    // An empty token would reach the driver and fail as a 401, which reads as
    // a permissions problem rather than a missing Secret.
    await expect(toBinding(cr(), secrets(undefined))).rejects.toThrow(/missing or empty/);
    await expect(toBinding(cr(), secrets(""))).rejects.toThrow(/missing or empty/);
  });

  it("picks the service credential BY NAME, not by position", async () => {
    const read = vi.fn(async (secret: string) => (secret === "right" ? "correct-token" : "wrong-token"));
    const binding = await toBinding(
      cr({
        secretEnv: [
          { name: "WEBHOOK_SECRET", secretRef: { name: "wrong", key: "k" } },
          { name: SERVICE_TOKEN_ENV, secretRef: { name: "right", key: "k" } },
        ],
      }),
      read,
    );

    // A connection may legitimately carry several secrets. Taking the first
    // would authenticate with something that is not the ingestion credential
    // and fail in a way that looks like a permissions problem.
    expect(binding.serviceToken).toBe("correct-token");
  });

  it("passes the cloudId through, which a custom domain cannot work without", async () => {
    const binding = await toBinding(cr(), secrets());
    // Constructed with no cloudId, this driver refuses every custom-domain
    // request at resolveCloudId rather than guessing a tenant.
    expect(() => binding.driver.validateScope(binding.scope)).not.toThrow();
  });
});

describe("collectionOf", () => {
  it("reads the collection the controller published", () => {
    expect(collectionOf(cr())).toBe("corpus-default-snc-confluence");
  });

  it("is undefined before the Connection has been reconciled", () => {
    // Deriving a name here instead would disagree with the controller the
    // first time the scheme changed, and look like an empty corpus.
    expect(collectionOf({ ...cr(), status: undefined })).toBeUndefined();
  });
});
