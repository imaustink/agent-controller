import { describe, expect, it, vi } from "vitest";
import { CrdCorpusRegistry } from "./crd-corpus-registry.js";
import {
  SERVICE_TOKEN_ENV,
  type ConnectionCustomResource,
  type CorpusCustomResource,
} from "./corpus-resource.js";
import type { WatchCrdFn } from "./k8s/crd-watcher.js";

function connection(name: string, overrides: Partial<ConnectionCustomResource["spec"]> = {}) {
  return {
    metadata: { name, namespace: "clients" },
    spec: {
      provider: "confluence",
      site: { baseURL: "https://wiki.example.com/wiki", cloudId: "c1" },
      secretEnv: [{ name: SERVICE_TOKEN_ENV, secretRef: { name: "s", key: "token" } }],
      ...overrides,
    },
  } satisfies ConnectionCustomResource;
}

function corpus(name: string, connectionRef = "bitovi-confluence", space = "GLOBEX") {
  return {
    metadata: { name, namespace: "clients" },
    spec: {
      connectionRef,
      allowedRoles: ["reader"],
      scope: { space },
    },
    status: { collection: `corpus_clients_${name}` },
  } satisfies CorpusCustomResource;
}

const b64 = (value: string) => Buffer.from(value).toString("base64");

function registryWith(
  corpora: CorpusCustomResource[],
  connections: ConnectionCustomResource[],
  watchFn?: WatchCrdFn,
) {
  const onError = vi.fn();
  const core = { readNamespacedSecret: vi.fn().mockResolvedValue({ data: { token: b64("svc") } }) };
  const api = {
    listNamespacedCustomObject: vi.fn(async ({ plural }: { plural: string }) => ({
      items: plural === "corpora" ? corpora : connections,
    })),
  };
  const registry = new CrdCorpusRegistry({
    namespace: "clients",
    group: "core.controller-agent.dev",
    version: "v1alpha1",
    api,
    core,
    watchFn,
    onError,
  });
  return { registry, onError, core, api };
}

describe("loadAll", () => {
  it("binds a Corpus by joining it to its Connection", async () => {
    const { registry } = registryWith([corpus("globex")], [connection("bitovi-confluence")]);
    await registry.loadAll();

    const binding = registry.get("globex");
    expect(binding?.connection).toBe("bitovi-confluence");
    expect(binding?.driver.provider).toBe("confluence");
    expect(binding?.serviceToken).toBe("svc");
  });

  it("loads Connections before Corpora", async () => {
    // The other order reports every Corpus as broken on a cold start and then
    // quietly fixes itself, which looks exactly like a flapping bug.
    const { registry, api, onError } = registryWith([corpus("globex")], [connection("bitovi-confluence")]);
    await registry.loadAll();

    expect(api.listNamespacedCustomObject.mock.calls.map(([args]) => args.plural)).toEqual([
      "connections",
      "corpora",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("omits a Corpus whose connectionRef does not resolve, and says why", async () => {
    const { registry, onError } = registryWith([corpus("dangling", "no-such-connection")], []);
    await registry.loadAll();

    expect(registry.get("dangling")).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("dangling", expect.any(Error));
  });

  it("omits a broken Corpus rather than serving it degraded", async () => {
    const { registry, onError } = registryWith(
      [corpus("good"), corpus("broken")],
      [connection("bitovi-confluence", { site: undefined })],
    );
    await registry.loadAll();

    // A half-built binding would answer with a driver pointed somewhere
    // unintended, and every scope check downstream would pass.
    expect(registry.list()).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("reads the Secret from the CORPUS's namespace, not a caller's", async () => {
    const { registry, core } = registryWith([corpus("globex")], [connection("bitovi-confluence")]);
    await registry.loadAll();

    // Otherwise the broker becomes a tool for reading any Secret in the cluster.
    expect(core.readNamespacedSecret).toHaveBeenCalledWith({ name: "s", namespace: "clients" });
  });
});

describe("corporaFor", () => {
  it("finds every Corpus over one Connection, for webhook fan-out", async () => {
    // A provider signs and delivers per integration, so one delivery has to
    // reach however many Corpora cover what changed (ADR 0043 §4).
    const { registry } = registryWith(
      [corpus("eng", "bitovi-confluence", "ENG"), corpus("globex", "bitovi-confluence", "GLOBEX")],
      [connection("bitovi-confluence")],
    );
    await registry.loadAll();

    expect(registry.corporaFor("bitovi-confluence").map((b) => b.name).sort()).toEqual(["eng", "globex"]);
    expect(registry.corporaFor("someone-else")).toEqual([]);
  });
});

describe("watch", () => {
  function fakeWatch() {
    const handlers = new Map<string, (phase: "ADDED" | "MODIFIED" | "DELETED", obj: unknown) => void>();
    const watchFn: WatchCrdFn = ({ plural }, onEvent) => {
      handlers.set(plural, onEvent);
      return { stop: vi.fn() };
    };
    return {
      watchFn,
      emit: (plural: string, phase: "ADDED" | "MODIFIED" | "DELETED", obj: unknown) =>
        handlers.get(plural)?.(phase, obj),
    };
  }

  it("binds a Corpus created after startup", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([], [connection("bitovi-confluence")], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("corpora", "ADDED", corpus("late"));
    await vi.waitFor(() => expect(registry.get("late")).toBeDefined());
  });

  it("binds a Corpus whose Connection arrives afterwards", async () => {
    // The ordering nobody controls: a Corpus applied before its Connection is
    // not broken, it is early.
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([corpus("early")], [], watchFn);
    await registry.loadAll();
    registry.watch();
    expect(registry.get("early")).toBeUndefined();

    emit("connections", "ADDED", connection("bitovi-confluence"));
    await vi.waitFor(() => expect(registry.get("early")).toBeDefined());
  });

  it("rebuilds every Corpus over an edited Connection", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith(
      [corpus("globex"), corpus("eng", "bitovi-confluence", "ENG")],
      [connection("bitovi-confluence")],
      watchFn,
    );
    await registry.loadAll();
    registry.watch();
    expect(registry.list()).toHaveLength(2);

    // A tightened cap now excludes ENG. Without a rebuild the broker would keep
    // serving it on what the Connection used to say.
    emit("connections", "MODIFIED", connection("bitovi-confluence", { allowedScopes: { spaces: ["GLOBEX"] } }));

    await vi.waitFor(() => expect(registry.list().map((b) => b.name)).toEqual(["globex"]));
  });

  it("drops every Corpus when its Connection is deleted", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([corpus("globex")], [connection("bitovi-confluence")], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("connections", "DELETED", connection("bitovi-confluence"));

    // There is no credential left to serve them with. The controller blocks
    // this deletion while Corpora exist, but the broker must not depend on
    // that having worked.
    await vi.waitFor(() => expect(registry.get("globex")).toBeUndefined());
  });

  it("drops a deleted Corpus immediately", async () => {
    const { watchFn, emit } = fakeWatch();
    const { registry } = registryWith([corpus("globex")], [connection("bitovi-confluence")], watchFn);
    await registry.loadAll();
    registry.watch();

    emit("corpora", "DELETED", corpus("globex"));
    expect(registry.get("globex")).toBeUndefined();
    expect(registry.listResources()).toHaveLength(0);
  });
});
