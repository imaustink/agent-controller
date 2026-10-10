import type { ClaudeAuthKind, ClaudeTokenStore } from "../claude-auth/store.js";
import type { GithubDeviceFlowLinker } from "../identity-link/device-flow-linker.js";
import type { OAuthAuthCodeLinker } from "../identity-link/oauth-authcode-linker.js";
import type { IdentityLinkStore, LinkedCredential } from "../identity-link/store.js";

/**
 * One row on the Connections page (docs/adr/0046): what the user has linked
 * for a provider, and how to link or unlink it.
 *
 * Every method takes the user's CHAT subject (`openwebui:<id>`). A provider
 * whose credentials are keyed differently -- Claude, on the canonical
 * `github:<login>` principal (docs/adr/0029) -- resolves that itself, the same
 * way agent-orchestrator does, so the page never invents a key.
 */
export interface ConnectionProvider {
  id: string;
  label: string;
  description: string;
  /** Where to revoke the grant at the provider itself; Disconnect only forgets our copy. */
  revokeUrl?: string;
  status(subject: string): Promise<ConnectionStatus>;
  connect(subject: string): Promise<ConnectStart>;
  disconnect(subject: string): Promise<void>;
}

export type ConnectionState = "connected" | "needs-reconnect" | "not-connected" | "blocked";

export interface ConnectionStatus {
  state: ConnectionState;
  /** The linked account, as the provider names it -- a login or an account id. */
  account?: string;
  /** Why a `blocked` row cannot be connected yet. */
  detail?: string;
}

/** Where to send the browser to link, or why it cannot be linked from here. */
export type ConnectStart = { redirect: string } | { blocked: string };

const DESCRIPTORS: Record<string, { label: string; description: string; revokeUrl?: string; order: number }> = {
  github: {
    label: "GitHub",
    description: "Lets agents read repositories you can see and act on GitHub as you.",
    revokeUrl: "https://github.com/settings/apps/authorizations",
    order: 0,
  },
  claude: {
    label: "Claude",
    description: "Runs coding agents on your own Claude subscription.",
    order: 1,
  },
  "claude-remote": {
    label: "Claude Remote Control",
    description: "Lets you watch and steer a running coding agent from the Claude app.",
    order: 2,
  },
  atlassian: {
    label: "Atlassian",
    description: "Answers from Confluence knowledge bases, limited to pages you can read.",
    revokeUrl: "https://id.atlassian.com/manage-profile/apps",
    order: 3,
  },
  google: {
    label: "Google Drive",
    description: "Answers from Drive knowledge bases, limited to files you can open.",
    revokeUrl: "https://myaccount.google.com/connections",
    order: 4,
  },
  slack: {
    label: "Slack",
    description: "Answers from Slack knowledge bases, limited to channels you're in.",
    revokeUrl: "https://slack.com/apps/manage",
    order: 5,
  },
};

function describe(id: string): { label: string; description: string; revokeUrl?: string; order: number } {
  return (
    DESCRIPTORS[id] ?? {
      label: id.charAt(0).toUpperCase() + id.slice(1),
      description: "Lets agents act on this service as you.",
      order: 100,
    }
  );
}

/**
 * Whether a stored credential can still produce a working token: either the
 * access token is unexpired, or a refresh token is there to mint a new one.
 * An empty `expiresAt` means the provider issued a non-expiring token (Slack).
 */
export function credentialStatus(cred: LinkedCredential | undefined, now: number): ConnectionStatus {
  if (!cred) return { state: "not-connected" };
  const accessAlive = !cred.expiresAt || Date.parse(cred.expiresAt) > now;
  const refreshAlive =
    Boolean(cred.refreshToken) && (!cred.refreshExpiresAt || Date.parse(cred.refreshExpiresAt) > now);
  const account = cred.githubLogin || cred.accountId;
  return { state: accessAlive || refreshAlive ? "connected" : "needs-reconnect", ...(account ? { account } : {}) };
}

export interface BuildProvidersOptions {
  store: IdentityLinkStore;
  /** Present only when the GitHub authcode flow is configured; the page cannot drive the device flow. */
  githubLinker?: GithubDeviceFlowLinker;
  authCodeLinkers?: ReadonlyMap<string, OAuthAuthCodeLinker>;
  claude?: {
    store: ClaudeTokenStore;
    /** Starts a PTY flow and returns its paste-the-code page URL. */
    start(subject: string, kind: ClaudeAuthKind): Promise<string>;
    /** Whether the `login` (Remote Control) flow is wired up on this gateway. */
    loginEnabled: boolean;
  };
  now?: () => number;
}

export function buildConnectionProviders(opts: BuildProvidersOptions): ConnectionProvider[] {
  const now = opts.now ?? Date.now;
  const providers: ConnectionProvider[] = [];

  const identityLinkProvider = (id: string, start: (subject: string) => Promise<string>): ConnectionProvider => ({
    id,
    ...describe(id),
    status: async (subject) => credentialStatus(await opts.store.get(id, subject), now()),
    connect: async (subject) => ({ redirect: await start(subject) }),
    disconnect: (subject) => opts.store.delete(id, subject),
  });

  if (opts.githubLinker) {
    const linker = opts.githubLinker;
    providers.push(identityLinkProvider("github", async (s) => (await linker.startAuthCode(s)).authorizeUrl));
  }
  for (const [id, linker] of opts.authCodeLinkers ?? []) {
    providers.push(identityLinkProvider(id, async (s) => linker.startAuthCode(s).authorizeUrl));
  }

  if (opts.claude) {
    const claude = opts.claude;
    const kinds: Array<[string, ClaudeAuthKind]> = [["claude", "setup-token"]];
    if (claude.loginEnabled) kinds.push(["claude-remote", "login"]);
    for (const [id, kind] of kinds) {
      // Claude credentials are keyed on the GitHub-derived principal so one
      // authorization serves chat and triage alike (docs/adr/0029, 0031).
      // Without a GitHub link there is no principal to file it under.
      const principalFor = async (subject: string): Promise<string | undefined> => {
        const login = (await opts.store.get("github", subject))?.githubLogin;
        return login ? `github:${login.toLowerCase()}` : undefined;
      };
      providers.push({
        id,
        ...describe(id),
        status: async (subject) => {
          const principal = await principalFor(subject);
          if (!principal) return { state: "blocked", detail: "Connect GitHub first." };
          // A record may still sit under the raw subject if it predates
          // principals; agent-orchestrator moves it on next use.
          const record = (await claude.store.get(principal, kind)) ?? (await claude.store.get(subject, kind));
          return record ? { state: "connected" } : { state: "not-connected" };
        },
        connect: async (subject) => {
          const principal = await principalFor(subject);
          if (!principal) return { blocked: "Connect GitHub first." };
          return { redirect: await claude.start(principal, kind) };
        },
        disconnect: async (subject) => {
          const principal = await principalFor(subject);
          if (principal) await claude.store.delete(principal, kind);
          await claude.store.delete(subject, kind);
        },
      });
    }
  }

  return providers.sort((a, b) => describe(a.id).order - describe(b.id).order);
}
