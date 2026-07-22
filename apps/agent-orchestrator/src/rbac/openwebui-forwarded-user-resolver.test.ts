import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { OpenWebUiForwardedUserResolver } from "./openwebui-forwarded-user-resolver.js";

const SECRET = "test-forward-user-secret";
const key = new TextEncoder().encode(SECRET);

function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(key);
}

describe("OpenWebUiForwardedUserResolver", () => {
  it("resolves a distinct, namespaced subject per signed user JWT, both granted the configured RBAC roles", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    const aliceToken = await sign({ id: "alice-id", role: "user" });
    const bobToken = await sign({ id: "bob-id", role: "admin" });

    await expect(resolver.resolve(aliceToken)).resolves.toEqual({
      subject: "openwebui:alice-id",
      roles: ["reader", "writer"],
    });
    await expect(resolver.resolve(bobToken)).resolves.toEqual({
      subject: "openwebui:bob-id",
      roles: ["reader", "writer"],
    });
  });

  it("grants the configured roles regardless of Open WebUI's own role claim (that vocabulary is unrelated to this system's RBAC)", async () => {
    // Regression test: Open WebUI's own permission model ("user"/"admin"/
    // "pending") used to be passed straight through as Identity.roles, which
    // matches no Tool/Skill's allowedRoles (this system's vocabulary is
    // "reader"/"writer") -- every RBAC-filtered catalog lookup came back
    // empty for every Open WebUI user.
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    const token = await sign({ id: "alice-id", role: "admin" });

    const identity = await resolver.resolve(token);

    expect(identity?.roles).toEqual(["reader", "writer"]);
    expect(identity?.roles).not.toContain("admin");
  });

  it("falls back to sub or email claims when id is absent", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    const subToken = await sign({ sub: "sub-id" });
    const emailToken = await sign({ email: "alice@example.com" });

    await expect(resolver.resolve(subToken)).resolves.toEqual({ subject: "openwebui:sub-id", roles: ["reader", "writer"] });
    await expect(resolver.resolve(emailToken)).resolves.toEqual({
      subject: "openwebui:alice@example.com",
      roles: ["reader", "writer"],
    });
  });

  it("fails closed on a bad signature (fails closed, ADR 0004)", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    const wrongKeyToken = await new SignJWT({ id: "alice-id" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("wrong-secret"));

    await expect(resolver.resolve(wrongKeyToken)).resolves.toBeUndefined();
  });

  it("fails closed when no usable id claim is present", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    const token = await sign({ role: "user" });

    await expect(resolver.resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed on an empty token", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });
    await expect(resolver.resolve("")).resolves.toBeUndefined();
  });
});
