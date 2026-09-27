import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Runs a fake provider's server OUT OF THE MANIFEST THE CLUSTER DEPLOYS.
 *
 * The extraction is the point. Every cluster spec that indexes a corpus rests
 * on these fakes answering what the real drivers ask, and a fake that has
 * drifted makes those specs pass against a fiction — reporting a working
 * pipeline while the real one is broken. Running a COPY would reproduce that
 * same drift one level up, so the fidelity specs run the exact script the
 * ConfigMap mounts.
 *
 * Needs no cluster: it is a node process and a port.
 */

const MANIFESTS = join(dirname(fileURLToPath(import.meta.url)), "..", "manifests");

export interface FakeProvider {
  origin: string;
  stop: () => void;
  /** Whatever the fake records about the requests it received. */
  introspect: <T>(path: string) => Promise<T>;
}

/** The `server.js` value out of a ConfigMap, without parsing the whole YAML. */
function extractServer(manifest: string): string {
  const yaml = readFileSync(join(MANIFESTS, manifest), "utf8");
  const start = yaml.indexOf("  server.js: |");
  if (start < 0) throw new Error(`${manifest} has no server.js key`);

  const body: string[] = [];
  for (const line of yaml.slice(start).split("\n").slice(1)) {
    // The block ends at the first non-blank line indented less than the
    // scalar's own indentation — the document separator, in practice.
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return body.join("\n");
}

/**
 * Starts the fake and waits for it to listen.
 *
 * Waits on the health endpoint rather than sleeping a guessed interval: a
 * fixed sleep is either slower than it needs to be or flaky, and usually both
 * on a loaded machine.
 */
export async function startFake(manifest: string, port: number): Promise<FakeProvider> {
  const dir = mkdtempSync(join(tmpdir(), "fake-provider-"));
  const script = join(dir, "server.js");
  writeFileSync(script, extractServer(manifest));

  const child: ChildProcess = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port) },
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${manifest} did not start on ${port}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    origin,
    stop: () => child.kill(),
    introspect: async <T>(path: string): Promise<T> =>
      (await fetch(`${origin}${path}`)).json() as Promise<T>,
  };
}
