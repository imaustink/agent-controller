// Proves that using this package without NATS never loads the NATS client
// (ADR 0047): the built package runs in a child Node process whose module
// resolver throws the moment anything asks for `nats`. vi.mock can't prove
// this, because already-built dependencies bypass it.
//
// Runs against dist/, so it needs `npm run build` first (CI builds before it
// tests).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const DIST = pathToFileURL(fileURLToPath(new URL("../dist/index.js", import.meta.url))).href;
const dir = mkdtempSync(join(tmpdir(), "no-nats-"));
writeFileSync(
  join(dir, "hooks.mjs"),
  `export async function resolve(specifier, context, next) {
    if (specifier === "nats" || specifier.startsWith("nats/")) {
      throw new Error("NATS_LOADED: " + specifier + " from " + context.parentURL);
    }
    return next(specifier, context);
  }`,
);
writeFileSync(join(dir, "register.mjs"), `import { register } from "node:module"; register("./hooks.mjs", import.meta.url);`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runIsolated(script: string): { status: number | null; stdout: string; stderr: string } {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, script);
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(dir, "register.mjs")).href, file], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("without NATS", () => {
  it("imports the package and runs a tool's event stream in memory without loading the NATS client", () => {
    const r = runIsolated(`
      const { JobEmitter, MemorySink, NATS_RECONNECT_OPTIONS } = await import(${JSON.stringify(DIST)});
      const sink = new MemorySink();
      const emitter = new JobEmitter("job-1", sink);
      await emitter.accepted("http://local/jobs/job-1");
      await emitter.progress("fetch", { pct: 50 });
      await emitter.succeeded({ title: "Soup" });
      await emitter.close();
      console.log(JSON.stringify({ types: sink.events.map((e) => e.type), reconnect: NATS_RECONNECT_OPTIONS.maxReconnectAttempts }));
    `);
    expect(r.stderr).not.toContain("NATS_LOADED");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ types: ["accepted", "progress", "succeeded"], reconnect: -1 });
  });

  it("the guard is real: emitting through a NatsSink does load the client, and trips it", () => {
    const r = runIsolated(`
      const { NatsSink } = await import(${JSON.stringify(DIST)});
      await new NatsSink({ natsUrl: "nats://127.0.0.1:1", subject: "callbacks.x" })
        .emit({ job_id: "j", seq: 0, ts: "t", type: "accepted", url: "u" });
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NATS_LOADED");
  });
});
