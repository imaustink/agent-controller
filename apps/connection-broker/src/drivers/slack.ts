import {
  PermanentError,
  PermissionDeniedError,
  TransientError,
  type Credentials,
  type Cursor,
  type Document,
  type Driver,
  type ListPage,
  type ProbeGranularity,
  type ProbeResult,
  type Scope,
} from "./types.js";
import type { FetchLike } from "./confluence.js";
import type { WebhookEvent, WebhookRequest } from "./types.js";
import { hmacHex, signaturesMatch, withinReplayWindow } from "./webhook-signature.js";

export interface SlackDriverOptions {
  fetch?: FetchLike;
  /** Messages per page; Slack caps this around 200 and recommends far less. */
  pageSize?: number;
  apiOrigin?: string;
  /** The workspace domain, for citation permalinks when Slack does not supply one. */
  workspaceUrl?: string;
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  subtype?: string;
  permalink?: string;
}

/**
 * Slack driver (docs/adr/0038).
 *
 * Scope is ONE channel. The difference from Confluence that shapes this whole
 * file: Slack authorizes at the CHANNEL, not the message. Membership is the
 * access unit and there is no per-message permission to check, so one probe
 * settles every candidate from this connection — cheaper than the per-resource
 * case rather than harder (ADR 0040).
 *
 * A "resource" here is a THREAD, not a message. A single message is rarely a
 * useful retrieval unit — the answer to a question usually lives in the replies
 * — and indexing per message would also multiply the corpus by the chattiness
 * of the channel.
 */
export class SlackDriver implements Driver {
  readonly provider = "slack";

  private readonly http: FetchLike;
  private readonly pageSize: number;
  private readonly apiOrigin: string;
  private readonly workspaceUrl: string | undefined;

  constructor(options: SlackDriverOptions = {}) {
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 100;
    this.apiOrigin = (options.apiOrigin ?? "https://slack.com/api").replace(/\/+$/, "");
    this.workspaceUrl = options.workspaceUrl?.replace(/\/+$/, "");
  }

  validateScope(scope: Scope): void {
    if (!scope.channel) throw new Error("a slack connection must be scoped to a channel");
    if (scope.space || scope.folderID) {
      throw new Error("a slack connection must set scope.channel and nothing else");
    }
    // A channel id reaches a query parameter, so it is constrained rather than
    // trusted. Slack ids are uppercase alphanumerics.
    if (!/^[A-Z0-9]+$/.test(scope.channel)) {
      throw new Error(`illegal slack channel id: ${scope.channel}`);
    }
  }

  /**
   * One probe per CONNECTION, not per message.
   *
   * Answering "resource" here would issue a probe per thread to ask a question
   * Slack answers once per channel, turning a cheap authorization model into
   * the most expensive one in the system.
   */
  probeGranularity(): ProbeGranularity {
    return "connection";
  }

  async list(scope: Scope, credentials: Credentials, since: Cursor): Promise<ListPage> {
    this.validateScope(scope);
    const token = requireToken(credentials.service);

    const body = (await this.call("conversations.history", token, {
      channel: scope.channel!,
      limit: String(this.pageSize),
      // Slack's cursor for "changed since" is a message timestamp. Carried
      // opaquely like any other driver's.
      ...(since ? { oldest: since, inclusive: "false" } : {}),
    })) as { messages?: SlackMessage[]; has_more?: boolean };

    const messages = body.messages ?? [];

    // Thread parents only: a reply is fetched as part of its thread, and
    // indexing it separately would both duplicate it and strand it from the
    // context that makes it meaningful.
    const parents = messages.filter(
      (message) => !message.thread_ts || message.thread_ts === message.ts,
    );

    return {
      resources: parents.map((message) => this.toRef(scope, message)),
      // Slack pages backwards through time; the oldest ts on this page is where
      // the next page resumes. An empty page ends the walk.
      cursor: body.has_more && messages.length > 0 ? messages[messages.length - 1]!.ts : undefined,
    };
  }

  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    const token = requireToken(credentials.delegated ?? credentials.service);

    const body = (await this.call("conversations.replies", token, {
      channel: scope.channel!,
      ts: id,
      limit: String(this.pageSize),
    })) as { messages?: SlackMessage[] };

    const messages = body.messages ?? [];
    if (messages.length === 0) {
      throw new PermissionDeniedError(`slack thread ${id} returned no messages`);
    }

    const parent = messages[0]!;
    return {
      ...this.toRef(scope, parent),
      // The whole thread as one document. A question and its answer belong
      // together; splitting them is what makes chat corpora useless.
      markdown: messages.map((message) => renderMessage(message)).join("\n\n"),
    };
  }

  async probe(scope: Scope, credentials: Credentials, _id?: string): Promise<ProbeResult> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("a slack probe requires the calling user's delegated token");
    }

    // The channel IS the access unit. If this user can see the channel, they
    // can see every message in it, so no message id is needed or used.
    const body = (await this.call("conversations.info", credentials.delegated, {
      channel: scope.channel!,
    })) as { channel?: { name?: string; is_archived?: boolean } };

    const name = body.channel?.name ?? scope.channel!;
    return {
      allowed: true,
      title: `#${name}`,
      url: this.channelUrl(scope.channel!),
      // A channel has no version. Slack edits are rare and carry no monotonic
      // marker, so claiming one would be inventing a guarantee.
      version: undefined,
    };
  }

  /**
   * Verifies a Slack Events API delivery.
   *
   * Slack signs `v0:<timestamp>:<body>` with the app's signing secret. Both
   * halves matter: the signature proves Slack sent it, the timestamp stops a
   * captured delivery being replayed forever to make this broker spend a
   * client's credential on demand.
   */
  parseWebhook(request: WebhookRequest, secret: string, scope: Scope): WebhookEvent | undefined {
    this.validateScope(scope);

    const timestamp = request.headers["x-slack-request-timestamp"];
    const provided = request.headers["x-slack-signature"];
    if (!provided) throw new PermissionDeniedError("slack webhook carried no signature");
    if (!withinReplayWindow(timestamp, Date.now())) {
      throw new PermissionDeniedError("slack webhook timestamp is outside the replay window");
    }

    const expected = `v0=${hmacHex(secret, `v0:${timestamp}:${request.rawBody}`)}`;
    if (!signaturesMatch(provided, expected)) {
      throw new PermissionDeniedError("slack webhook signature did not verify");
    }

    let body: {
      type?: string;
      challenge?: string;
      event?: { channel?: string; ts?: string; thread_ts?: string };
    };
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      throw new PermissionDeniedError("slack webhook body was not JSON");
    }

    // The one-time URL verification handshake. Verified, but about nothing.
    if (body.type === "url_verification") return undefined;

    const event = body.event;
    // An event for a channel this connection does not cover is verified but
    // irrelevant — not an error, and emphatically not a reason to sync.
    if (!event?.channel || event.channel !== scope.channel) return undefined;

    // The THREAD is the indexed unit, so a reply names its parent.
    const sourceId = event.thread_ts ?? event.ts;
    return { sourceIds: sourceId ? [sourceId] : [] };
  }

  private toRef(scope: Scope, message: SlackMessage) {
    return {
      id: message.ts,
      title: firstLine(message.text ?? "") || `Thread ${message.ts}`,
      url: message.permalink ?? this.messageUrl(scope.channel!, message.ts),
      // Slack's ts IS the version: any edit produces a new one on the message
      // that changed.
      version: message.ts,
      updatedAt: new Date(Number(message.ts.split(".")[0]) * 1000).toISOString(),
      // Channel membership governs, and this driver does not enumerate members.
      // Permissive rather than guessed: the probe is the authority, and
      // under-inclusion is the only direction that hurts (ADR 0040).
      acl: { principals: [], permissive: true },
    };
  }

  private channelUrl(channel: string): string {
    return this.workspaceUrl ? `${this.workspaceUrl}/archives/${channel}` : `slack://channel/${channel}`;
  }

  private messageUrl(channel: string, ts: string): string {
    // Slack permalinks strip the dot from the timestamp.
    return `${this.channelUrl(channel)}/p${ts.replace(".", "")}`;
  }

  /**
   * Slack answers 200 with `ok: false` for most failures, so the HTTP status is
   * not the answer. The error STRING is, and it distinguishes the cases that
   * must not be blurred (ADR 0040).
   */
  private async call(
    method: string,
    token: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.apiOrigin}/${method}?${new URLSearchParams(params).toString()}`;

    let response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (cause) {
      throw new TransientError(`slack request failed: ${String(cause)}`);
    }

    if (response.status === 429) {
      throw new TransientError("slack rate limited this request");
    }
    if (!response.ok) {
      throw new TransientError(`slack returned ${response.status}`);
    }

    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (body.ok) return body;

    const error = body.error ?? "unknown_error";
    if (DENIALS.has(error)) throw new PermissionDeniedError(`slack: ${error}`);
    if (PERMANENT.has(error)) throw new PermanentError(`slack: ${error}`);
    throw new TransientError(`slack: ${error}`);
  }
}

/** This caller may not read it. Drop the candidate. */
const DENIALS = new Set([
  "channel_not_found", // Slack's answer for "not a member", indistinguishable by design.
  "not_in_channel",
  "is_archived",
  "thread_not_found",
  "message_not_found",
]);

/** Retrying cannot help: the app or token is wrong, not busy. */
const PERMANENT = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "not_allowed_token_type",
]);

function requireToken(token: string | undefined): string {
  if (!token) throw new Error("no credential supplied for a slack request");
  return token;
}

const firstLine = (text: string): string => text.split("\n")[0]?.slice(0, 120).trim() ?? "";

/**
 * One message as Markdown.
 *
 * Deliberately minimal — enough for chunking to have seams, without resolving
 * user ids to names, which would need a second API call per distinct author and
 * a cache the broker has nowhere to put.
 */
function renderMessage(message: SlackMessage): string {
  const author = message.user ? `<@${message.user}>` : "unknown";
  return `**${author}**: ${message.text ?? ""}`.trim();
}
