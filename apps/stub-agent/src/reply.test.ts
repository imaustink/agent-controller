import { describe, expect, it } from "vitest";
import { buildReply, CREDENTIAL_ENV_NAMES, observedCredentialEnv, STUB_REPLY_MARKER } from "./reply.js";

describe("observedCredentialEnv", () => {
  it("reports the names of credential vars that are set", () => {
    expect(observedCredentialEnv({ AGENT_ACTOR_LOGIN: "e2e-user", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" })).toEqual([
      "AGENT_ACTOR_LOGIN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("treats an empty value as absent", () => {
    // A `secretEnv` entry pointing at a Secret key that exists but is empty
    // yields a set-but-empty var. Reporting it as present would make the
    // happy-path spec pass on an injection that delivered nothing.
    expect(observedCredentialEnv({ AGENT_ACTOR_LOGIN: "" })).toEqual([]);
  });

  it("ignores env vars outside the known credential list", () => {
    expect(observedCredentialEnv({ SOME_OTHER_TOKEN: "x", PATH: "/usr/bin" })).toEqual([]);
  });

  it("never returns a value, only a name", () => {
    const secret = "sk-ant-oat01-super-secret";
    const reported = observedCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: secret });
    expect(reported.join(" ")).not.toContain(secret);
  });
});

describe("buildReply", () => {
  it("carries the marker the happy-path spec matches on", () => {
    expect(buildReply("do a thing", [])).toContain(STUB_REPLY_MARKER);
  });

  it("echoes the goal so the spec can prove it survived the whole path", () => {
    expect(buildReply("triage issue #7", ["AGENT_ACTOR_LOGIN"])).toContain("triage issue #7");
  });

  it("truncates a long goal rather than mirroring an entire issue body into a comment", () => {
    const reply = buildReply("x".repeat(500), []);
    expect(reply).toContain("...");
    expect(reply.length).toBeLessThan(400);
  });

  it("says so explicitly when no credential env arrived", () => {
    // Distinguishes "injection delivered nothing" from "the stub forgot to
    // look", which an empty list in the comment would not.
    expect(buildReply("g", [])).toContain("(none)");
  });

  it("lists every credential env name it was given", () => {
    const reply = buildReply("g", [...CREDENTIAL_ENV_NAMES]);
    for (const name of CREDENTIAL_ENV_NAMES) expect(reply).toContain(name);
  });
});
