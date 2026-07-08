import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CallbackAuthError, CallbackReceiver, verifyAndParseCallback } from "./receiver.js";

const SECRET = "shh";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyAndParseCallback", () => {
  it("parses a validly-signed succeeded event", () => {
    const body = JSON.stringify({ type: "succeeded", job_id: "j1", seq: 1, ts: new Date().toISOString(), result: { ok: true } });
    const event = verifyAndParseCallback(body, sign(body), SECRET);
    expect(event.type).toBe("succeeded");
    expect(event.job_id).toBe("j1");
  });

  it("rejects a bad signature", () => {
    const body = JSON.stringify({ type: "succeeded", job_id: "j1", seq: 1, ts: new Date().toISOString(), result: {} });
    expect(() => verifyAndParseCallback(body, sign(body, "wrong-secret"), SECRET)).toThrow(CallbackAuthError);
  });

  it("rejects a missing signature", () => {
    const body = JSON.stringify({ type: "succeeded", job_id: "j1", seq: 1, ts: new Date().toISOString(), result: {} });
    expect(() => verifyAndParseCallback(body, undefined, SECRET)).toThrow(CallbackAuthError);
  });

  it("rejects a body that doesn't match the event schema", () => {
    const body = JSON.stringify({ type: "not-a-real-type" });
    expect(() => verifyAndParseCallback(body, sign(body), SECRET)).toThrow();
  });
});

describe("CallbackReceiver", () => {
  it("resolves awaitJob when a matching succeeded event is posted", async () => {
    const receiver = new CallbackReceiver(SECRET);
    await receiver.listen(0);
    const address = receiver["server"]?.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const pending = receiver.awaitJob("job-1");

    const body = JSON.stringify({
      type: "succeeded",
      job_id: "job-1",
      seq: 1,
      ts: new Date().toISOString(),
      result: { hello: "world" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/callback/job-1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(202);

    const event = await pending;
    expect(event.type).toBe("succeeded");
    if (event.type === "succeeded") {
      expect(event.result).toEqual({ hello: "world" });
    }

    await receiver.close();
  });

  it("rejects unsigned requests with 401 and does not resolve the pending job", async () => {
    const receiver = new CallbackReceiver(SECRET);
    await receiver.listen(0);
    const address = receiver["server"]?.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const body = JSON.stringify({ type: "succeeded", job_id: "job-2", seq: 1, ts: new Date().toISOString(), result: {} });
    const res = await fetch(`http://127.0.0.1:${port}/callback/job-2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);

    await receiver.close();
  });

  it("correlates by the URL path segment, not the body's job_id (tools generate their own job_id independently)", async () => {
    const receiver = new CallbackReceiver(SECRET);
    await receiver.listen(0);
    const address = receiver["server"]?.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // The orchestrator awaits its OWN generated id (as used in the callback
    // URL it hands the tool)...
    const pending = receiver.awaitJob("orchestrator-generated-id");

    // ...but the tool's own event payload carries a DIFFERENT, tool-generated
    // job_id (e.g. because a per-invocation JOB_ID env var never reached it --
    // this is exactly what happened in production before this fix).
    const body = JSON.stringify({
      type: "succeeded",
      job_id: "tool-generated-id",
      seq: 1,
      ts: new Date().toISOString(),
      result: { hello: "world" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/callback/orchestrator-generated-id`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(202);

    const event = await pending;
    expect(event.type).toBe("succeeded");

    await receiver.close();
  });
});
