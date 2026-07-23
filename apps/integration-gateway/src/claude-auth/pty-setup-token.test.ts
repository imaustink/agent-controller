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

  it("regression: extracts the clean url from a real OSC 8 terminal hyperlink instead of the garbled wrapped-duplicate text", async () => {
    // Byte-for-byte shape confirmed by actually running `claude setup-token`
    // v2.1.218 in a real PTY: the CLI emits the url as a genuine OSC 8
    // hyperlink (ESC ] 8 ; id=... ; <url> BEL), immediately followed by a
    // human-readable fallback rendering of the SAME url wrapped across
    // several cursor-positioned cells for terminals that don't support
    // hyperlinks. A naive `https://\S+` match has no whitespace to stop at
    // until well past the BEL/escape codes, so it swallows the real url,
    // the escapes, AND the wrapped duplicate into one garbled string.
    const realUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=ZKANrZFlr20DBvod-WsVO1-Gb5SZLcRNJOdo_h0ZWh0&code_challenge_method=S256&state=4Wxdim99pDUHYXgnPicljuRRCv0HiWqdEIsJvkiTREo";
    const rawChunk =
      `\x1b[37m *\x1b[36G░░░░\x1b[39m\r\r\n\x1b]8;id=7kcak1;${realUrl}\x07\x1b[37m${realUrl.slice(0, 90)}\x1b[39m\x1b]8;;\x07\r\r\n` +
      `\x1b]8;id=7kcak1;${realUrl}\x07\x1b[37m${realUrl.slice(90, 130)}\x1b[39m\x1b]8;;\x07\r\r\n\r\r\n`;

    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);
    const startPromise = flows.start("user-5");
    fake.emitData(rawChunk);

    const result = await startPromise;
    expect(result.authorizeUrl).toBe(realUrl);
  });

  it("regression: spawns the PTY wide enough that the CLI's long lines never wrap", async () => {
    // THE fix for valid codes timing out: at a narrow width (the old 120)
    // the CLI hard-wraps its ~110-char token and redraws it with cursor
    // escapes spliced into the value, so `sk-ant-oat01-…` never appears
    // contiguously and never matches. Confirmed empirically that the longest
    // line the CLI prints is the ~346-char authorize URL. Lock in a width
    // comfortably past that so nobody silently reintroduces the wrap bug.
    let capturedOpts: { cols?: number } | undefined;
    const flows = new ClaudeSetupTokenFlows(((_file: string, _args: string[], opts: { cols?: number }) => {
      capturedOpts = opts;
      return new FakePty() as unknown as ReturnType<typeof import("node-pty").spawn>;
    }) as unknown as typeof import("node-pty").spawn);

    void flows.start("user-width");
    expect(capturedOpts?.cols).toBeGreaterThanOrEqual(400);
  });

  it("regression: captures a token even when wrapped in color escapes (escape-stripping)", async () => {
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-color");
    fake.emitData("Visit https://claude.ai/oauth/authorize?x=1\n");
    const { flowId } = await startPromise;

    const submitPromise = flows.submitCode(flowId, "good-code");
    // Token bracketed by SGR color escapes, as the TUI is apt to render it.
    fake.emitData("\x1b[1m\x1b[32msk-ant-oat01-abcdefghijklmnop\x1b[39m\x1b[22m\r\n");

    await expect(submitPromise).resolves.toEqual({ status: "complete", token: "sk-ant-oat01-abcdefghijklmnop" });
  });

  it("regression: resolves immediately (not after the full timeout) with a clear message when the pasted code is rejected", async () => {
    // Confirmed empirically: an invalid/incomplete code makes the CLI print
    // this and wait for "Enter" to retry -- it neither exits nor prints a
    // token, so without detecting this text explicitly, submitCode() would
    // sit through the entire CODE_SUBMIT_TIMEOUT_MS for the single most
    // common failure (a mistyped or truncated paste), which reads exactly
    // like a hang.
    let fake!: FakePty;
    const flows = new ClaudeSetupTokenFlows(() => (fake = new FakePty()) as unknown as ReturnType<typeof import("node-pty").spawn>);

    const startPromise = flows.start("user-6");
    fake.emitData("Visit https://claude.ai/oauth/authorize?x=1\n");
    const { flowId } = await startPromise;

    const submitPromise = flows.submitCode(flowId, "wrong-code");
    fake.emitData("\x1b[95mOAuth error: Invalid code. Please make sure the full code was copied\x1b[39m\r\r\n");

    const result = await submitPromise;
    expect(result).toEqual({ status: "error", message: "OAuth error: Invalid code. Please make sure the full code was copied" });
  });
});
