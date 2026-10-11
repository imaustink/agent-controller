import { describe, expect, it, vi } from "vitest";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import {
  CrdIdentityProviderRegistry,
  DEFAULT_IDENTITY_PROVIDER_CATALOG,
  InMemoryIdentityProviderCatalog,
  resolveIdentityGateway,
  resolveIdentityProviderCatalog,
  type IdentityProviderCustomResource,
} from "./identity-provider-catalog.js";

const glyph: IdentityProviderCustomResource = {
  metadata: { name: "glyph" },
  spec: { envVar: "GLYPH_TOKEN", label: "Glyph" },
};

describe("CrdIdentityProviderRegistry", () => {
  it("maps IdentityProvider custom resources to configs, defaulting flow to oauth", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [glyph] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdIdentityProviderRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const providers = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "identityproviders",
    });
    expect(providers).toEqual([
      { id: "glyph", config: { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false } },
    ]);
  });

  it("decodes an explicit flow/crossEntryPoint", async () => {
    const claudeRemote: IdentityProviderCustomResource = {
      metadata: { name: "claude-remote" },
      spec: {
        envVar: "CLAUDE_LOGIN_CREDENTIALS_JSON",
        label: "Claude Remote Control",
        flow: "claude-remote-login",
        crossEntryPoint: true,
      },
    };
    const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [claudeRemote] }) };
    const registry = new CrdIdentityProviderRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const providers = await registry.listAll();

    expect(providers[0]?.config).toEqual({
      envVar: "CLAUDE_LOGIN_CREDENTIALS_JSON",
      label: "Claude Remote Control",
      flow: "claude-remote-login",
      crossEntryPoint: true,
    });
  });

  it("skips a malformed IdentityProvider (missing envVar) rather than failing the whole catalog", async () => {
    const malformed: IdentityProviderCustomResource = { metadata: { name: "broken" }, spec: { envVar: "", label: "Broken" } };
    const api: CustomObjectsApiLike = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [malformed, glyph] }),
    };
    const registry = new CrdIdentityProviderRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const providers = await registry.listAll();

    expect(providers).toEqual([
      { id: "glyph", config: { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false } },
    ]);
  });

  describe("watch", () => {
    it("maps ADDED to an upsert event and DELETED to a delete event", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts.plural).toBe("identityproviders");
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdIdentityProviderRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("ADDED", glyph);
      expect(onChange).toHaveBeenCalledWith({
        type: "upsert",
        descriptor: { id: "glyph", config: { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false } },
      });

      onEvent("DELETED", glyph);
      expect(onChange).toHaveBeenCalledWith({ type: "delete", id: "glyph" });
    });

    it("throws when constructed without a watchFn", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      const registry = new CrdIdentityProviderRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      expect(() => registry.watch(() => {})).toThrow();
    });
  });
});

describe("InMemoryIdentityProviderCatalog", () => {
  it("looks up a provider seeded at construction", () => {
    const catalog = new InMemoryIdentityProviderCatalog([
      { id: "glyph", config: { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false } },
    ]);
    expect(catalog.get("glyph")?.envVar).toBe("GLYPH_TOKEN");
    expect(catalog.get("nonexistent")).toBeUndefined();
  });

  it("reflects upsert/delete", () => {
    const catalog = new InMemoryIdentityProviderCatalog();
    catalog.upsert("glyph", { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false });
    expect(catalog.get("glyph")?.label).toBe("Glyph");
    catalog.delete("glyph");
    expect(catalog.get("glyph")).toBeUndefined();
  });
});

describe("resolveIdentityProviderCatalog", () => {
  it("falls back to the default catalog when none is injected", () => {
    expect(resolveIdentityProviderCatalog(undefined)).toBe(DEFAULT_IDENTITY_PROVIDER_CATALOG);
  });

  it("returns the injected catalog unchanged when one is given", () => {
    const catalog = new InMemoryIdentityProviderCatalog();
    expect(resolveIdentityProviderCatalog(catalog)).toBe(catalog);
  });
});

describe("DEFAULT_IDENTITY_PROVIDER_CATALOG", () => {
  it("carries github/claude/claude-remote, matching the chart's shipped defaults", () => {
    expect(DEFAULT_IDENTITY_PROVIDER_CATALOG.get("github")).toEqual({
      envVar: "GITHUB_TOKEN",
      label: "GitHub",
      flow: "oauth",
      crossEntryPoint: false,
    });
    expect(DEFAULT_IDENTITY_PROVIDER_CATALOG.get("claude")).toMatchObject({ flow: "claude-cli-setup-token", crossEntryPoint: true });
    expect(DEFAULT_IDENTITY_PROVIDER_CATALOG.get("claude-remote")).toMatchObject({
      flow: "claude-remote-login",
      crossEntryPoint: true,
    });
    expect(DEFAULT_IDENTITY_PROVIDER_CATALOG.get("glyph")).toBeUndefined();
  });
});

describe("resolveIdentityGateway", () => {
  const github = { getToken: vi.fn() } as never;
  const claude = { getToken: vi.fn() } as never;
  const claudeRemote = { getToken: vi.fn() } as never;
  const deps = { identityLinkGateway: github, claudeAuthGateway: claude, claudeRemoteGateway: claudeRemote };

  it("routes claude-cli-setup-token to claudeAuthGateway", () => {
    const catalog = new InMemoryIdentityProviderCatalog([
      { id: "claude", config: { envVar: "X", label: "Claude", flow: "claude-cli-setup-token", crossEntryPoint: true } },
    ]);
    expect(resolveIdentityGateway("claude", catalog, deps)).toBe(claude);
  });

  it("routes claude-remote-login to claudeRemoteGateway", () => {
    const catalog = new InMemoryIdentityProviderCatalog([
      { id: "claude-remote", config: { envVar: "X", label: "Claude Remote", flow: "claude-remote-login", crossEntryPoint: true } },
    ]);
    expect(resolveIdentityGateway("claude-remote", catalog, deps)).toBe(claudeRemote);
  });

  it("routes oauth (and an unknown provider) to identityLinkGateway", () => {
    const catalog = new InMemoryIdentityProviderCatalog([
      { id: "glyph", config: { envVar: "GLYPH_TOKEN", label: "Glyph", flow: "oauth", crossEntryPoint: false } },
    ]);
    expect(resolveIdentityGateway("glyph", catalog, deps)).toBe(github);
    expect(resolveIdentityGateway("nonexistent", catalog, deps)).toBe(github);
  });
});
