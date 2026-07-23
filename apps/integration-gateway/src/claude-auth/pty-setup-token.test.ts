import { describe, expect, it } from "vitest";
import { ClaudeSetupTokenFlows } from "./pty-setup-token.js";

/**
 * Fake `IPty` -- just enough of node-pty's surface (`onData`/`onExit`/
 * `write`/`kill`) for `ClaudeSetupTokenFlows` to drive, with test-controlled
 * `emitData`/`emitExit` hooks standing in for the real subprocess's output.
 *
 * `dispose()` REALLY removes the handler (unlike a prior version of this fake,
 * which made `dispose()` a no-op) -- that gap let a real production bug pass
 * every test here: `ClaudeSetupTokenFlows.start()` used to tear down its own
 * `onData` subscription (the only thing appending to `flow.output`) as soon
 * as it found the authorize URL, so `submitCode()`'s later, separate
 * subscription never saw anything new and every real submission hung until
 * its own timeout. A no-op `dispose()` here meant `start()`'s handler stayed
 * subscribed anyway, silently masking that. Keep this fake honest.
 */
class FakePty {
  private dataHandlers: ((chunk: string) => void)[] = [];
  private exitHandlers: ((e: { exitCode: number }) => void)[] = [];
  public written: string[] = [];
  public killed = false;

  onData(handler: (chunk: string) => void) {
    this.dataHandlers.push(handler);
    return { dispose: () => (this.dataHandlers = this.dataHandlers.filter((h) => h !== handler)) };
  }
  onExit(handler: (e: { exitCode: number }) => void) {
    this.exitHandlers.push(handler);
    return { dispose: () => (this.exitHandlers = this.exitHandlers.filter((h) => h !== handler)) };
  }
  write(data: string): void {
    this.written.push(data);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(chunk: string): void {
    for (const h of this.dataHandlers) h(chunk);
  }
  emitExit(exitCode = 0): void {
    for (const h of this.exitHandlers) h({ exitCode });
  }
}

describe("ClaudeSetupTokenFlows", () => {
  it("resolves start() once the authorize URL appears in PTY output", async () => {
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-1");
    fake.emitData("Please visit: https://claude.ai/oauth/authorize?code_challenge=abc to continue\n");

    const result = await startPromise;
    expect(result.authorizeUrl).toBe("https://claude.ai/oauth/authorize?code_challenge=abc");
    expect(flows.getSubject(result.flowId)).toBe("user-1");
  });

  it("writes the submitted code to the pty's stdin and resolves with the captured token", async () => {
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-2");
    fake.emitData("Visit https://claude.ai/oauth/authorize?x=1 and paste the code below\n");
    const { flowId } = await startPromise;

    const submitPromise = flows.submitCode(flowId, "abc-123-code");
    expect(fake.written).toContain("abc-123-code\r");
    fake.emitData("Success! Your token: sk-ant-oat01-abcdefghijklmnop\n");

    await expect(submitPromise).resolves.toEqual({ status: "complete", token: "sk-ant-oat01-abcdefghijklmnop" });
    expect(fake.killed).toBe(true);
  });

  it("resolves an error when the process exits without producing a token", async () => {
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-3");
    fake.emitData("Visit https://claude.ai/oauth/authorize?x=1\n");
    const { flowId } = await startPromise;

    const submitPromise = flows.submitCode(flowId, "wrong-code");
    fake.emitData("Error: invalid code\n");
    fake.emitExit(1);

    const result = await submitPromise;
    expect(result.status).toBe("error");
  });

  it("reports an error for an unknown/expired flowId without touching any process", async () => {
    const flows = new ClaudeSetupTokenFlows(() => {
      throw new Error("should not spawn for an unknown flow");
    });
    const result = await flows.submitCode("nonexistent-flow", "123456");
    expect(result.status).toBe("error");
  });

  it("regression: still captures the token when it arrives in several separate chunks well after start() has already resolved", async () => {
    // Reproduces the real hang: some output (a progress line) arrives between
    // the URL and the eventual token, and each event is its own onData call
    // (not, as the other tests happen to also cover, a single emitData per
    // phase) -- exercising exactly the "does output keep accumulating across
    // the start()/submitCode() boundary" question the bug was in.
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-4");
    fake.emitData("Visit https://claude.ai/oauth/authorize?x=1\n");
    const { flowId } = await startPromise;

    fake.emitData("Waiting for you to authorize in the browser...\n");

    const submitPromise = flows.submitCode(flowId, "abc-123-code");
    fake.emitData("Verifying code...\n");
    fake.emitData("Success! Your token: sk-ant-oat01-abcdefghijklmnop\n");

    await expect(submitPromise).resolves.toEqual({ status: "complete", token: "sk-ant-oat01-abcdefghijklmnop" });
  });
});
