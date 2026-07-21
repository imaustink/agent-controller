import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  pollDeviceFlow,
  refreshUserToken,
  signState,
  startDeviceFlow,
  verifyState,
} from "@controller-agent/github-app-auth";
import type { IdentityLinkStore } from "./store.js";

const PROVIDER = "github";

/** A stored token is refreshed once it's within this many seconds of expiring (or already expired). */
const REFRESH_SKEW_SECONDS = 60;

/** How long an authcode `state` token remains valid between `startAuthCode` and `completeAuthCode` (10 minutes). */
const AUTH_CODE_STATE_TTL_SECONDS = 600;

export interface GithubDeviceFlowLinkerOptions {
  clientId: string;
  scope: string | undefined;
  store: IdentityLinkStore;
  githubBaseUrl?: string;
  /** Injectable for tests; defaults to global `fetch`. Used only for the post-link `GET /user` login lookup. */
  fetchImpl?: typeof fetch;
  /** GitHub App client secret; only required by `startAuthCode`/`completeAuthCode`, not device flow. */
  clientSecret?: string;
  /** HMAC secret used to sign/verify the authcode `state` param; only required by `startAuthCode`/`completeAuthCode`. */
  stateSecret?: string;
  /** Must exactly match the GitHub App's registered OAuth callback URL; only required by `startAuthCode`/`completeAuthCode`. */
  redirectUri?: string;
}

export interface AuthCodeStartResult {
  flow: "authcode";
  authorizeUrl: string;
  expiresInSeconds: number;
}

export interface DeviceFlowStartResult {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export type DeviceFlowPollResult = { status: "pending" | "complete" | "expired" | "denied" };

interface GithubUserResponse {
  login?: string;
}

/**
 * Orchestrates GitHub's OAuth Device Flow (via `packages/github-app-auth`'s
 * device-flow HTTP mechanics) on top of an {@link IdentityLinkStore}. Stateless
 * about in-flight device codes -- `start`/`poll` are plain passthroughs to
 * GitHub; the only durable state this owns is the linked credential itself,
 * written on `poll`'s `"complete"` outcome. The caller (the HTTP API layer)
 * is responsible for carrying `deviceCode` from `start` to `poll`.
 */
export class GithubDeviceFlowLinker {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubDeviceFlowLinkerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(_subject: string): Promise<DeviceFlowStartResult> {
    const started = await startDeviceFlow(this.options.clientId, this.options.scope, this.options.githubBaseUrl);
    return {
      verificationUri: started.verificationUri,
      userCode: started.userCode,
      deviceCode: started.deviceCode,
      expiresInSeconds: started.expiresInSeconds,
      pollIntervalSeconds: started.pollIntervalSeconds,
    };
  }

  async poll(subject: string, deviceCode: string): Promise<DeviceFlowPollResult> {
    const result = await pollDeviceFlow(this.options.clientId, deviceCode, this.options.githubBaseUrl);

    switch (result.status) {
      case "pending":
        return { status: "pending" };
      // This linker doesn't expose GitHub's renegotiated retry interval back
      // to the caller -- slow_down is simply treated as still-pending.
      case "slow_down":
        return { status: "pending" };
      case "expired":
        return { status: "expired" };
      case "denied":
        return { status: "denied" };
      case "complete": {
        const githubLogin = await this.fetchGithubLogin(result.token);
        await this.options.store.set(PROVIDER, subject, {
          githubLogin,
          token: result.token,
          expiresAt: result.expiresAt,
          refreshToken: result.refreshToken,
          refreshExpiresAt: result.refreshExpiresAt,
        });
        return { status: "complete" };
      }
    }
  }

  /**
   * Starts the OAuth authorization-code flow: signs a short-lived `state`
   * token binding this attempt to `subject`, and builds the URL a browser
   * should be redirected to. Unlike `start`/`poll`, this method (and
   * `completeAuthCode`) requires `stateSecret`/`redirectUri` (and, for
   * `completeAuthCode`, `clientSecret`) -- device-flow-only deployments need
   * not set them, so the check happens here rather than in the constructor.
   */
  async startAuthCode(subject: string): Promise<AuthCodeStartResult> {
    if (!this.options.stateSecret) {
      throw new Error("GithubDeviceFlowLinker.startAuthCode requires options.stateSecret to be configured");
    }
    if (!this.options.redirectUri) {
      throw new Error("GithubDeviceFlowLinker.startAuthCode requires options.redirectUri to be configured");
    }
    const state = signState({ provider: PROVIDER, subject }, this.options.stateSecret);
    const authorizeUrl = buildAuthorizeUrl(
      this.options.clientId,
      this.options.redirectUri,
      state,
      this.options.scope,
      this.options.githubBaseUrl,
    );
    return { flow: "authcode", authorizeUrl, expiresInSeconds: AUTH_CODE_STATE_TTL_SECONDS };
  }

  /**
   * Completes the OAuth authorization-code flow from the GitHub redirect
   * callback. Returns `undefined` (never throws) for any expected "bad
   * request" outcome -- an invalid/expired/tampered `state`, or GitHub
   * rejecting the `code` -- since those are routine callback-abuse/expiry
   * cases, not bugs. Throws only on genuine misconfiguration (missing
   * `clientSecret`/`stateSecret`/`redirectUri`), which should never happen in
   * practice since the callback route only exists when authcode is
   * configured.
   */
  async completeAuthCode(state: string, code: string): Promise<{ subject: string } | undefined> {
    if (!this.options.clientSecret) {
      throw new Error("GithubDeviceFlowLinker.completeAuthCode requires options.clientSecret to be configured");
    }
    if (!this.options.stateSecret) {
      throw new Error("GithubDeviceFlowLinker.completeAuthCode requires options.stateSecret to be configured");
    }
    if (!this.options.redirectUri) {
      throw new Error("GithubDeviceFlowLinker.completeAuthCode requires options.redirectUri to be configured");
    }

    const verifiedState = verifyState(state, this.options.stateSecret, AUTH_CODE_STATE_TTL_SECONDS);
    if (!verifiedState) return undefined;

    let exchanged: Awaited<ReturnType<typeof exchangeCodeForToken>>;
    try {
      exchanged = await exchangeCodeForToken(
        this.options.clientId,
        this.options.clientSecret,
        code,
        this.options.redirectUri,
        this.options.githubBaseUrl,
      );
    } catch {
      // GitHub rejected the code (already used/expired) -- expected failure, not a bug.
      return undefined;
    }

    const githubLogin = await this.fetchGithubLogin(exchanged.token);
    await this.options.store.set(PROVIDER, verifiedState.subject, {
      githubLogin,
      token: exchanged.token,
      expiresAt: exchanged.expiresAt,
      refreshToken: exchanged.refreshToken,
      refreshExpiresAt: exchanged.refreshExpiresAt,
    });
    return { subject: verifiedState.subject };
  }

  /**
   * Blocks until a credential lands for `subject`, or resolves `undefined`
   * once `timeoutMs` elapses. Delegates entirely to the store's own
   * pub/sub wait (no polling/renewal logic here, unlike `getValidToken`) --
   * the API layer's `/wait` route calls this directly from the OAuth
   * callback's write, not from a refreshed token flow.
   */
  async waitForCompletion(subject: string, timeoutMs: number): Promise<{ token: string; githubLogin: string } | undefined> {
    const cred = await this.options.store.waitForCompletion(PROVIDER, subject, timeoutMs);
    if (!cred) return undefined;
    return { token: cred.token, githubLogin: cred.githubLogin };
  }

  async getValidToken(subject: string): Promise<{ token: string; githubLogin: string } | undefined> {
    const cred = await this.options.store.get(PROVIDER, subject);
    if (!cred) return undefined;

    const expiresAtMs = Date.parse(cred.expiresAt);
    const stillFresh = Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_SKEW_SECONDS * 1000;
    if (stillFresh) return { token: cred.token, githubLogin: cred.githubLogin };

    if (!cred.refreshToken) return undefined;

    try {
      const refreshed = await refreshUserToken(this.options.clientId, cred.refreshToken, this.options.githubBaseUrl);
      await this.options.store.set(PROVIDER, subject, {
        githubLogin: cred.githubLogin,
        token: refreshed.token,
        expiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
        refreshExpiresAt: refreshed.refreshExpiresAt,
      });
      return { token: refreshed.token, githubLogin: cred.githubLogin };
    } catch {
      // The link is dead (refresh token expired/revoked) -- caller must re-link.
      return undefined;
    }
  }

  private async fetchGithubLogin(token: string): Promise<string> {
    const res = await this.fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to look up linked GitHub user: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as GithubUserResponse;
    if (!body.login) throw new Error("GitHub /user response was missing login");
    return body.login;
  }
}
