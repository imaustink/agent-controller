import { assertPublicUrl } from "./ssrf.js";

/**
 * Reference LocalTool (ADR 0014), node runtime. Implements the stdio ABI:
 * reads a URL from stdin, GETs it (behind the SSRF guard), and writes a single
 * JSON envelope to stdout. Exit 0 on success, non-zero on failure (the
 * executor sidecar reads the envelope either way).
 */

interface Succeeded {
  type: "succeeded";
  result: { status: number; body: string };
}
interface Failed {
  type: "failed";
  code: string;
  message: string;
}

const MAX_BODY = 100_000;

function emit(envelope: Succeeded | Failed): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = (await readStdin()).trim();
  if (!input) {
    emit({ type: "failed", code: "usage", message: "no URL provided on stdin" });
    process.exit(1);
  }

  let url: URL;
  try {
    url = await assertPublicUrl(input);
  } catch (err) {
    emit({ type: "failed", code: "blocked_url", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  try {
    // redirect: "error" so a 3xx to an internal host can't slip past the guard.
    const res = await fetch(url, { redirect: "error" });
    const body = (await res.text()).slice(0, MAX_BODY);
    emit({ type: "succeeded", result: { status: res.status, body } });
  } catch (err) {
    emit({ type: "failed", code: "http_error", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

void main();
