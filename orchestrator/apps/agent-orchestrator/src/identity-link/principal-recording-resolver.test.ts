import { describe, expect, it, vi } from "vitest";
import type { Identity, IdentityResolver } from "../rbac/types.js";
import { PrincipalRecordingResolver } from "./principal-recording-resolver.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function resolverReturning(identity: Identity | undefined): IdentityResolver {
  return { resolve: vi.fn(async () => identity) };
}

const ada: Identity = { subject: "openwebui:1", roles: ["reader"], perUser: true, email: "Ada@Example.com" };

describe("PrincipalRecordingResolver", () => {
  it("passes the identity through and records the normalized email once", async () => {
    const sink = { recordPrincipal: vi.fn(async () => {}) };
    const resolver = new PrincipalRecordingResolver(resolverReturning(ada), sink);

    expect(await resolver.resolve("jwt")).toBe(ada);
    await resolver.resolve("jwt");
    await flush();

    expect(sink.recordPrincipal).toHaveBeenCalledTimes(1);
    expect(sink.recordPrincipal).toHaveBeenCalledWith("ada@example.com", "openwebui:1");
  });

  it("records again when a subject's email changes", async () => {
    const sink = { recordPrincipal: vi.fn(async () => {}) };
    const inner = { resolve: vi.fn<IdentityResolver["resolve"]>() };
    const resolver = new PrincipalRecordingResolver(inner, sink);

    inner.resolve.mockResolvedValueOnce(ada).mockResolvedValueOnce({ ...ada, email: "ada@new.example" });
    await resolver.resolve("a");
    await resolver.resolve("b");

    expect(sink.recordPrincipal).toHaveBeenLastCalledWith("ada@new.example", "openwebui:1");
  });

  // A shared subject mapped to one email would give that person everyone's
  // connections.
  it("never records an identity that is not per-user", async () => {
    const sink = { recordPrincipal: vi.fn(async () => {}) };
    const { perUser: _omit, ...shared } = ada;
    await new PrincipalRecordingResolver(resolverReturning(shared), sink).resolve("jwt");
    expect(sink.recordPrincipal).not.toHaveBeenCalled();
  });

  it("does nothing for an identity with no email, or no identity", async () => {
    const sink = { recordPrincipal: vi.fn(async () => {}) };
    const { email: _omit, ...noEmail } = ada;
    await new PrincipalRecordingResolver(resolverReturning(noEmail), sink).resolve("jwt");
    expect(await new PrincipalRecordingResolver(resolverReturning(undefined), sink).resolve("jwt")).toBeUndefined();
    expect(sink.recordPrincipal).not.toHaveBeenCalled();
  });

  it("never fails resolution when recording fails, and backs off before retrying", async () => {
    let now = 0;
    const sink = { recordPrincipal: vi.fn(async () => Promise.reject(new Error("gateway down"))) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolver = new PrincipalRecordingResolver(resolverReturning(ada), sink, () => now);

    expect(await resolver.resolve("jwt")).toBe(ada);
    await flush();
    await resolver.resolve("jwt");
    expect(sink.recordPrincipal).toHaveBeenCalledTimes(1);

    now = 6 * 60 * 1000;
    await resolver.resolve("jwt");
    expect(sink.recordPrincipal).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
