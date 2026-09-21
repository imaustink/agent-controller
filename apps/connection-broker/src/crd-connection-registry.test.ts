import { describe, expect, it, vi } from "vitest";
import { CrdConnectionRegistry } from "./crd-connection-registry.js";
import { SERVICE_TOKEN_ENV, type ConnectionCustomResource } from "./connection-resource.js";
import type { WatchCrdFn } from "./k8s/crd-watcher.js";

function cr(name: string, overrides: Partial<ConnectionCustomResource["spec"]> = {}): ConnectionCustomResource {
  return {
    metadata: { name, namespace: "clients" },
    spec: {
      provider: "confluence",
      allowedRoles: ["reader"],
      scope: { space: "SNC" },
      site: { baseURL: "https://wiki.example.com/wiki", cloudId: "c1" },
      secretEnv: [{ name: SERVICE_TOKEN_ENV, secretRef: { name: "s", key: "token" } }],
      ...overrides,
    },
    status: { collection: `corpus-${name}` },
  };
}

const b64 = (value: string) => Buffer.from(value).toString("base64");

function registryWith(items: ConnectionCustomResource[], watchFn?: WatchCrdFn) {
  const onError = vi.fn();
  const core = { readNamespacedSecret: vi.fn().mockResolvedValue({ data: { token: b64("svc") } }) };
  const registry = new CrdConnectionRegistry({
    namespace: "clients",
    group: "core.controller-agent.dev",
    version: "v1alpha1",
    api: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }) },
    core,
    watchFn,
    onError,
  });
  return { registry, onError, core };
}

describe("loadAll", () => {
  it("binds every connection it can", async () => {
    const { registry } = registryWith([cr("a"), cr("b")]);
    await registry.loadAll();

    expect(registry.list().map((binding) => binding.name).sort()).toEqual(["a", "b"]);
    expect(registry.get("a")?.allowedRoles).toEqual(["reader"]);
  });

  it("omits a broken connection rather than serving it degraded, and says why", async () => {
    const { registry, onError } = registryWith([cr("good"), cr("broken", { site: undefined })]);
    await registry.loadAll();

    // A half-built binding would answer with a driver pointed somewhere
    // unintended, and every scope check downstream would pass.
    expect(registry.get("broken")).toBeUndefined();
    expect(registry.get("good")).toBeDefined();
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("reads the Secret from the CONNECTION's namespace, not a caller's", async () => {
    const { registry, core } = registryWith([cr("a")]);
    await registry.loadAll();

    // Otherwise the broker becomes a tool for reading any Secret in the cluster.
    expect(core.readNamespacedSecret).toHaveBeenCalledWith({ name: "s", namespace: "clients" });
  });

  it("base64-decodes the Secret value", async () => {
    const { registry } = registryWith([cr("a")]);
    await registry.loadAll();
    expect(registry.get("a")?.serviceToken).toBe("svc");
  });

  it("keeps the CR for fields the binding does not carry", async () => {
    const { registry } = registryWith([cr("a")]);
    await registry.loadAll();

    // The scheduler needs the collection the controller published and the
    // reconcile interval, neither of which belongs on a binding.
    expect(registry.listResources()[0]?.status?.collection).toBe("corpus-a");
  });
});

describe("watch", () => {
  function fakeWatch() {
    let emit: (phase: "ADDED" | "MODIFIED" | "DELETED", obj: unknown) => void = () => {};
    const watchFn: WatchCrdFn = (_opts, onEvent) => {
      emit = onEvent;
      return { stop: vi.fn() };
    };
    return { watchFn, emit: (...args: Parameters<typeof emit>) => emit(...args) };
  }

  it("binds a connection created after startup", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("ADDED", cr("late"));
    await vi.waitFor(() => expect(registry.get("late")).toBeDefined());
  });

  it("drops a deleted connection immediately", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([cr("a")], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("DELETED", cr("a"));
    // The credential stops being usable the moment the CR is gone.
    expect(registry.get("a")).toBeUndefined();
    expect(registry.listResources()).toHaveLength(0);
  });

  it("drops a connection edited into an invalid state", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([cr("a")], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("MODIFIED", cr("a", { site: undefined }));

    // Keeping the previous binding would go on using a credential or scope the
    // operator has just revoked.
    await vi.waitFor(() => expect(registry.get("a")).toBeUndefined());
  });
});
