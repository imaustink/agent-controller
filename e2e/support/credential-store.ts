import { createHash } from "node:crypto";
import { kubectl, kubectlApplyStdin } from "./k8s.js";

/**
 * Reads and seeds the durable credential store (docs/adr/0034) through
 * `kubectl` rather than a client library: it needs no extra dependency, no open
 * local port, and matches how you'd inspect this by hand when a credential ends
 * up under an unexpected subject.
 *
 * Replaces `support/redis.ts`. These records were Redis keys until that Redis --
 * running with persistence disabled on an emptyDir -- restarted and deleted every
 * credential in the cluster. They are Kubernetes Secrets now, and this module
 * moved with them.
 */

/**
 * Object names are `<prefix>-<sha256(subject)[:16]>`, mirroring
 * `SecretRecordStore.nameFor` (apps/integration-gateway/src/credential-store/).
 *
 * Duplicated here deliberately, rather than imported from the app: this is a
 * black-box suite against a deployed image, and computing the name INDEPENDENTLY
 * is what makes the assertion meaningful. Importing the app's own function would
 * make a change to the naming scheme invisible to these tests -- they would
 * simply look wherever the new code looks and agree with themselves.
 */
function nameFor(prefix: string, subject: string): string {
  return `${prefix}-${createHash("sha256").update(subject).digest("hex").slice(0, 16)}`;
}

const PREFIX = {
  identityLink: "identity-link-github",
  "setup-token": "claude-auth-setup-token",
  login: "claude-auth-login",
} as const;

/** Label every credential Secret carries, so a sweep can find them all. */
const CREDENTIAL_LABEL = "controller-agent.io/credential";

/** Field carrying a record's exact plaintext subject -- see `RECORD_KEY_FIELD` in the app. */
const RECORD_KEY_FIELD = "_recordKey";

async function secretNames(labelSelector: string): Promise<string[]> {
  const out = await kubectl(["get", "secrets", "-l", labelSelector, "-o", "name"]);
  return out
    .trim()
    .split("\n")
    .map((n) => n.replace("secret/", "").trim())
    .filter(Boolean)
    .sort();
}

/** One field of one credential Secret, decoded, or `undefined` if absent. */
async function secretField(name: string, field: string): Promise<string | undefined> {
  const out = (
    await kubectl(["get", "secret", name, "-o", `jsonpath={.data.${field}}`, "--ignore-not-found"])
  ).trim();
  return out ? Buffer.from(out, "base64").toString("utf8") : undefined;
}

/**
 * Applies a credential Secret. Used only for seeding fixtures, never for
 * assertions.
 *
 * `kubectl apply` rather than `create`, so re-seeding the same subject within a
 * run replaces rather than 409s.
 */
async function putRecord(prefix: string, subject: string, fields: Record<string, string>): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: nameFor(prefix, subject),
      labels: {
        [CREDENTIAL_LABEL]: prefix.startsWith("identity-link") ? "identity-link" : "claude-auth",
        "controller-agent.io/e2e-seeded": "true",
      },
    },
    stringData: { ...fields, [RECORD_KEY_FIELD]: subject },
  };
  await kubectlApplyStdin(JSON.stringify(manifest));
}

/**
 * Deletes every seeded and real credential record, so a test starts from a
 * known-unlinked state.
 *
 * By label, which is why the app stamps one: the object names are hashes, so
 * there is no glob that finds them and no way to enumerate the subjects that
 * might exist.
 */
export async function deleteCredentials(kind?: "identity-link" | "claude-auth"): Promise<number> {
  const selector = kind ? `${CREDENTIAL_LABEL}=${kind}` : CREDENTIAL_LABEL;
  const names = await secretNames(selector);
  for (const name of names) await kubectl(["delete", "secret", name, "--ignore-not-found"]);
  return names.length;
}

/**
 * The subjects Claude credentials of `kind` are currently filed under.
 *
 * SUBJECTS ONLY -- this module never reads a credential VALUE. The subject a
 * credential is keyed under is the entire thing these tests assert on (ADR
 * 0029/0031), and the encrypted blob behind it is both useless to assert on and
 * dangerous to surface in a failure message.
 *
 * Read from each record's `_recordKey` rather than reversed out of the object
 * name, which is a hash and cannot be.
 */
export async function claudeCredentialSubjects(kind: "setup-token" | "login"): Promise<string[]> {
  const names = await secretNames(`${CREDENTIAL_LABEL}=claude-auth`);
  const subjects: string[] = [];
  for (const name of names) {
    // The two kinds share a label and are told apart by their name prefix, the
    // same way the app keeps them in separate objects so one subject can hold
    // both at once.
    if (!name.startsWith(PREFIX[kind])) continue;
    const subject = await secretField(name, RECORD_KEY_FIELD);
    if (subject) subjects.push(subject);
  }
  return subjects.sort();
}

/**
 * The field encryptor both stores share: AES-256-GCM under the deployment's own
 * `IDENTITY_LINK_ENCRYPTION_KEY`, packed `iv:authTag:ciphertext` in base64.
 *
 * Read from the cluster rather than generated, because these records are read
 * back by the gateway -- a locally-invented key produces blobs it can only fail
 * to decrypt, which surfaces as "no credential linked" rather than as a test bug.
 */
async function fieldEncrypter(): Promise<(plaintext: string) => string> {
  const keyB64 = (
    await kubectl(["get", "secret", "e2e-integration-gateway-secrets", "-o", "jsonpath={.data.IDENTITY_LINK_ENCRYPTION_KEY}"])
  ).trim();
  if (!keyB64) throw new Error("e2e: IDENTITY_LINK_ENCRYPTION_KEY missing (run bootstrap-secrets.sh)");
  const key = Buffer.from(Buffer.from(keyB64, "base64").toString("utf8"), "base64");
  if (key.length !== 32) throw new Error(`e2e: encryption key decoded to ${key.length} bytes, expected 32`);

  const { createCipheriv, randomBytes } = await import("node:crypto");
  return (plaintext: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  };
}

/**
 * Seeds a Claude credential straight into the store, encrypted exactly the way
 * the gateway writes it.
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
  const encrypt = await fieldEncrypter();
  const fields: Record<string, string> =
    kind === "login"
      ? { kind, createdAt: new Date().toISOString(), credentialsJson: encrypt(JSON.stringify({ e2e: true })) }
      : { kind, createdAt: new Date().toISOString(), token: encrypt("sk-ant-oat01-e2e-seeded") };
  await putRecord(PREFIX[kind], subject, fields);
}

/**
 * Seeds a `github` identity link for a subject, carrying `githubLogin`.
 *
 * This is what gives a CHAT caller a resolvable principal (docs/adr/0031)
 * without a real GitHub OAuth round trip -- which no hermetic test can perform.
 * The orchestrator only ever reads `githubLogin` off this record to establish
 * the mapping, so a seeded link exercises exactly the same code path a linked
 * one would; the token itself is never used by the paths under test (the
 * principal step is deliberately link-only, and it injects nothing).
 */
export async function seedGithubLink(
  subject: string,
  githubLogin: string,
  opts: { expired?: boolean; refreshToken?: boolean } = {},
): Promise<void> {
  const encrypt = await fieldEncrypter();
  await putRecord(PREFIX.identityLink, subject, {
    githubLogin,
    // `expired` is the state the whole re-prompt bug lived in (docs/adr/0031):
    // a link the human really did establish, whose ACCESS TOKEN has since
    // aged out. Seeding only fresh links is why a suite built to catch keying
    // bugs could not see it. Default stays far-future so every other spec is
    // unaffected.
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 365 * 24 * 60 * 60 * 1000)).toISOString(),
    token: encrypt("gho_e2e-seeded"),
    // Omitted by default so an expired link is DEAD deterministically, with no
    // refresh attempt and therefore no dependence on the OAuth stub. Set it
    // when the refresh path itself is what's under test.
    ...(opts.refreshToken
      ? {
          refreshToken: encrypt("ghr_e2e-seeded"),
          refreshExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        }
      : {}),
  });
}

/**
 * The `expiresAt` on a subject's stored GitHub link, or `undefined` if none.
 *
 * Metadata only -- never the token. Exists so a spec can assert that a REFRESH
 * actually happened (the expiry moved forward) rather than inferring it from a
 * request the gateway may or may not have made.
 */
export async function githubLinkExpiry(subject: string): Promise<Date | undefined> {
  const at = await secretField(nameFor(PREFIX.identityLink, subject), "expiresAt");
  return at ? new Date(at) : undefined;
}

/** Whether a subject currently has a stored GitHub link at all. */
export async function hasGithubLink(subject: string): Promise<boolean> {
  return (await secretField(nameFor(PREFIX.identityLink, subject), "githubLogin")) !== undefined;
}

/** Seeds BOTH Claude record kinds for one subject -- what claude-code-swe-agent declares. */
export async function seedAllClaudeCredentials(subject: string): Promise<void> {
  await seedClaudeCredential(subject, "setup-token");
  await seedClaudeCredential(subject, "login");
}
