import { kubectl } from "./k8s.js";

/**
 * Reads the orchestrator's Redis through `kubectl exec` rather than a
 * port-forward + client library: it needs no extra dependency, no open local
 * port, and matches how you'd inspect this by hand when a credential ends up
 * under an unexpected key.
 */
async function redisCli(args: string[]): Promise<string> {
  // `app.kubernetes.io/name`, not `app` -- the chart uses the standard
  // recommended labels, and the obvious-looking `app=` selector silently
  // matches nothing (kubectl exits 0 with empty output, so it reads as "no
  // Redis" rather than "wrong selector").
  const pod = (
    await kubectl(["get", "pods", "-l", "app.kubernetes.io/name=agent-orchestrator-redis", "-o", "name"])
  )
    .trim()
    .split("\n")
    .filter(Boolean)[0];
  if (!pod) throw new Error("e2e: no agent-orchestrator-redis pod found (label app.kubernetes.io/name=agent-orchestrator-redis)");
  return (await kubectl(["exec", pod.replace("pod/", ""), "--", "redis-cli", ...args])).trim();
}

/**
 * Every key matching `pattern`.
 *
 * KEY NAMES ONLY -- this module never reads a credential VALUE. The subject a
 * credential is keyed under is the entire thing these tests assert on (see
 * ADR 0029), and the encrypted blob behind it is both useless to assert on
 * and dangerous to surface in a failure message.
 */
export async function credentialKeys(pattern: string): Promise<string[]> {
  const out = await redisCli(["--scan", "--pattern", pattern]);
  return out ? out.split("\n").map((k) => k.trim()).filter(Boolean).sort() : [];
}

/** Deletes keys matching `pattern`, so a test starts from a known-unlinked state. */
export async function deleteCredentialKeys(pattern: string): Promise<number> {
  const keys = await credentialKeys(pattern);
  for (const key of keys) await redisCli(["DEL", key]);
  return keys.length;
}

/**
 * The subject portion of a Claude credential key, for the assertion these
 * tests exist to make: that a triage turn and a chat turn by the same human
 * converge on ONE subject.
 *
 * `kind` maps to the two prefixes `RedisClaudeTokenStore` uses -- `setup-token`
 * records live under `claudeAuth:`, full-login (Remote Control) records under
 * `claudeAuthLogin:`.
 */
export async function claudeCredentialSubjects(kind: "setup-token" | "login"): Promise<string[]> {
  const prefix = kind === "login" ? "claudeAuthLogin:" : "claudeAuth:";
  const keys = await credentialKeys(`${prefix}*`);
  return keys
    // `claudeAuth:` is a prefix of `claudeAuthLogin:` and `claudeAuthWriteback:`,
    // so a glob on it alone would sweep in both other record types.
    .filter((k) => !k.startsWith("claudeAuthLogin:") || kind === "login")
    .filter((k) => !k.startsWith("claudeAuthWriteback:"))
    .map((k) => k.slice(prefix.length));
}
