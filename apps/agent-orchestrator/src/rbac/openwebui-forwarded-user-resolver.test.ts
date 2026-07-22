import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { OpenWebUiForwardedUserResolver } from "./openwebui-forwarded-user-resolver.js";

const SECRET = "test-forward-user-secret";
const key = new TextEncoder().encode(SECRET);

function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(key);
}

describe("OpenWebUiForwardedUserResolver", () => {
  it("resolves a distinct, namespaced subject per signed user JWT", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET });
    const aliceToken = await sign({ id: "alice-id", role: "user" });
    const bobToken = await sign({ id: "bob-id", role: "user" });

    await expect(resolver.resolve(aliceToken)).resolves.toEqual({
      subject: "openwebui:alice-id",
      roles: ["user"],
    });
    await expect(resolver.resolve(bobToken)).resolves.toEqual({
      subject: "openwebui:bob-id",
      roles: ["user"],
    });
  });

  it("falls back to sub or email claims when id is absent", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET });
    const subToken = await sign({ sub: "sub-id" });
    const emailToken = await sign({ email: "alice@example.com" });

    await expect(resolver.resolve(subToken)).resolves.toEqual({ subject: "openwebui:sub-id", roles: [] });
    await expect(resolver.resolve(emailToken)).resolves.toEqual({
      subject: "openwebui:alice@example.com",
      roles: [],
    });
  });

  it("fails closed on a bad signature (fails closed, ADR 0004)", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET });
    const wrongKeyToken = await new SignJWT({ id: "alice-id" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("wrong-secret"));

    await expect(resolver.resolve(wrongKeyToken)).resolves.toBeUndefined();
  });

  it("fails closed when no usable id claim is present", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET });
    const token = await sign({ role: "user" });

    await expect(resolver.resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed on an empty token", async () => {
    const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET });
    await expect(resolver.resolve("")).resolves.toBeUndefined();
  });
});
