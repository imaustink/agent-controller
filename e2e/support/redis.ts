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

/** Writes a raw value. Used only for seeding fixtures, never for assertions. */
async function redisSet(key: string, value: string): Promise<void> {
  await redisCli(["SET", key, value]);
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

/**
 * Writes a Claude credential straight into the store, encrypted exactly the
 * way `RedisClaudeTokenStore` writes it (AES-256-GCM, packed
 * `iv:authTag:ciphertext` base64, under the `claudeAuth:` / `claudeAuthLogin:`
 * prefix for the given kind).
 *
 * Seeding is what makes the keying assertion possible at all. Starting a real
 * `claude` flow needs the PTY-driven `claude login` and a paid Anthropic
 * credential, which no hermetic test can supply -- so asserting "a credential
 * exists under github:<login>" could never pass. Seeding inverts it: put a
 * credential at the subject we believe the gate resolves, and assert the run
 * LAUNCHES. If the gate looked anywhere else it would find nothing and park.
 * That tests the behaviour rather than a log line.
 */
export async function seedClaudeCredential(subject: string, kind: "setup-token" | "login"): Promise<void> {
  const keyB64 = (
    await kubectl(["get", "secret", "e2e-integration-gateway-secrets", "-o", "jsonpath={.data.IDENTITY_LINK_ENCRYPTION_KEY}"])
  ).trim();
  if (!keyB64) throw new Error("e2e: IDENTITY_LINK_ENCRYPTION_KEY missing (run bootstrap-secrets.sh)");
  const key = Buffer.from(Buffer.from(keyB64, "base64").toString("utf8"), "base64");
  if (key.length !== 32) throw new Error(`e2e: encryption key decoded to ${key.length} bytes, expected 32`);

  const { createCipheriv, randomBytes } = await import("node:crypto");
  const encrypt = (plaintext: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  };

  const record =
    kind === "login"
      ? { kind, createdAt: new Date().toISOString(), credentialsJson: encrypt(JSON.stringify({ e2e: true })) }
      : { kind, createdAt: new Date().toISOString(), token: encrypt("sk-ant-oat01-e2e-seeded") };

  const prefix = kind === "login" ? "claudeAuthLogin:" : "claudeAuth:";
  await redisSet(`${prefix}${subject}`, JSON.stringify(record));
}

/** Seeds BOTH Claude record kinds for one subject -- what claude-code-swe-agent declares. */
export async function seedAllClaudeCredentials(subject: string): Promise<void> {
  await seedClaudeCredential(subject, "setup-token");
  await seedClaudeCredential(subject, "login");
}
