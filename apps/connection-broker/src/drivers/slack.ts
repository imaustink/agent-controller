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
import { matchPath } from "./path-allowlist.js";
import type { FetchLike } from "./confluence.js";
import type { ApiRequest, ApiResponse, WebhookEvent, WebhookRequest } from "./types.js";
import { hmacHex, signaturesMatch, withinReplayWindow } from "./webhook-signature.js";

export interface SlackDriverOptions {
  fetch?: FetchLike;
  /** Messages per page; Slack caps this around 200 and recommends far less. */
  pageSize?: number;
  apiOrigin?: string;
  /** The workspace domain, for citation permalinks when Slack does not supply one. */
  workspaceUrl?: string;
  /**
   * Join the scoped channel automatically when a read is refused for want of
   * membership.
   *
   * Off unless a Connection asks for it. Joining is a WRITE — it changes
   * workspace state and posts a visible "joined the channel" event — so it is
   * an operator's decision rather than a default, and it needs the extra
   * `channels:join` scope on the bot token.
   */
  autoJoin?: boolean;
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
  private readonly autoJoin: boolean;

  constructor(options: SlackDriverOptions = {}) {
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 100;
    this.apiOrigin = (options.apiOrigin ?? "https://slack.com/api").replace(/\/+$/, "");
    this.workspaceUrl = options.workspaceUrl?.replace(/\/+$/, "");
    this.autoJoin = options.autoJoin ?? false;
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

    const body = (await this.callJoining("conversations.history", token, scope, {
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
    //
    // System messages are dropped here too. Found by running this against a
    // real channel: "<@U0C35PG2PK5> has joined the channel" was the first
    // indexed document, because a join event is a message like any other as far
    // as conversations.history is concerned. A busy channel is mostly these,
    // and each one is a chunk of machine chatter embedded as though somebody
    // had written it.
    const parents = messages.filter(
      (message) =>
        isProse(message) && (!message.thread_ts || message.thread_ts === message.ts),
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

    const body = (await this.callJoining("conversations.replies", token, scope, {
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
      //
      // System messages are filtered out of the BODY as well as out of listing:
      // a thread whose replies include three join events should not carry them
      // into the chunk. The parent survives regardless — it is what this
      // document is, and dropping it would leave a thread with no opening.
      markdown: [parent, ...messages.slice(1).filter(isProse)]
        .map((message) => renderMessage(message))
        .join("\n\n"),
    };
  }

  async probe(scope: Scope, credentials: Credentials, _id?: string): Promise<ProbeResult> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("a slack probe requires the calling user's delegated token");
    }

    // The channel IS the access unit. If this user can see the channel, they
    // can see every message in it, so no message id is needed or used.
    //
    // Deliberately NOT the joining path. A probe asks whether this USER may
    // read something; joining on their behalf would change the answer instead
    // of reporting it, add them to a channel they never asked to join, and
    // announce it to everyone in that channel.
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
   * The live GET face (ADR 0038 §5).
   *
   * One path: re-read a thread. Slack's API is enormous and almost none of it
   * is a read a knowledge base needs — the channel is already the retrieval
   * unit, and anything wider would be a proxy onto the workspace rather than a
   * live view of what was indexed.
   */
  async api(scope: Scope, credentials: Credentials, request: ApiRequest): Promise<ApiResponse> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("the slack GET face requires the calling user's delegated token");
    }

    const ts = matchPath(request.path, [/^threads\/([0-9.]+)$/]);
    if (!ts) {
      throw new PermissionDeniedError(
        `slack GET face does not serve ${request.path}; it serves threads/<ts>`,
      );
    }

    // No autoJoin here, deliberately: this runs as the USER, and the join path
    // exists for ingestion. A user who cannot see the channel gets a denial,
    // which is the answer rather than a problem to work around.
    const body = (await this.call("conversations.replies", credentials.delegated, {
      channel: scope.channel!,
      ts,
      limit: String(this.pageSize),
    })) as { messages?: SlackMessage[] };

    const messages = body.messages ?? [];
    return {
      body: {
        messages: messages.map((message) => ({
          ts: message.ts,
          user: message.user,
          text: renderText(message.text ?? ""),
        })),
      },
      url: this.messageUrl(scope.channel!, ts),
    };
  }

  /**
   * A read that may first have to join the channel.
   *
   * LAZY on purpose: the join is attempted only after Slack has actually
   * refused for want of membership, so the ordinary path stays read-only and a
   * connection whose channel we are already in never writes anything.
   *
   * Retried exactly ONCE. If the read still fails after a successful join, the
   * refusal is about something else and repeating would spin against Slack with
   * a credential that is not going to start working.
   */
  private async callJoining(
    method: string,
    token: string,
    scope: Scope,
    params: Record<string, string>,
  ): Promise<unknown> {
    try {
      return await this.call(method, token, params);
    } catch (err) {
      if (!this.autoJoin || !isNotInChannel(err)) throw err;

      // Only ever the channel this connection is SCOPED to. The id comes from
      // the Connection CR, never from a caller, so this cannot be steered into
      // joining anything else.
      await this.call("conversations.join", token, { channel: scope.channel! });
      return this.call(method, token, params);
    }
  }

  /**
   * Verifies a Slack Events API delivery.
   *
   * Slack signs `v0:<timestamp>:<body>` with the app's signing secret. Both
   * halves matter: the signature proves Slack sent it, the timestamp stops a
   * captured delivery being replayed forever to make this broker spend a
   * client's credential on demand.
   *
   * It reports which CHANNEL changed rather than filtering to one: a Slack app
   * is one Connection serving many Corpora (ADR 0043 §4).
   */
  parseWebhook(request: WebhookRequest, secret: string): WebhookEvent | undefined {
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
    // No channel means nothing routable. Verified, but not something to act on.
    if (!event?.channel) return undefined;

    // The THREAD is the indexed unit, so a reply names its parent. Which
    // Corpora cover this channel is the broker's to decide (ADR 0043 §4).
    const sourceId = event.thread_ts ?? event.ts;
    return { scopeKey: event.channel, sourceIds: sourceId ? [sourceId] : [] };
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

/**
 * Whether Slack refused because we are not in the channel.
 *
 * Matched on the error string Slack returns, which is carried verbatim into the
 * message. `channel_not_found` is deliberately NOT treated as joinable: Slack
 * returns it both for a channel that does not exist and for a private one we
 * cannot see, and attempting to join either is a request that cannot succeed.
 */
function isNotInChannel(err: unknown): boolean {
  return err instanceof PermissionDeniedError && err.message.includes("not_in_channel");
}

const firstLine = (text: string): string =>
  renderText(text).split("\n")[0]?.slice(0, 120).trim() ?? "";

/**
 * Turns Slack's mrkdwn into text worth embedding.
 *
 * Found by running against a real channel: a message linking a pull request
 * arrived as `<https://github.com/org/repo/pull/259|PR>` and went into the
 * vector as written. The URL dominates the embedding, the word a human would
 * search for is buried inside the markup, and the same happens to every
 * mention and channel reference. It is the Confluence macro-parameter problem
 * in a different syntax.
 *
 * ORDER MATTERS here, and subtly. Slack escapes `&`, `<` and `>` in whatever a
 * person typed, but the angle brackets around its OWN entities are literal. So
 * entities are parsed first and the escapes undone afterwards — do it the other
 * way and a message quoting "a <b|c> d" becomes an entity we then mangle.
 */
export function renderText(text: string): string {
  return (
    text
      // <url|label> — keep both: the label is what a person searches for, the
      // URL is evidence a model may want to cite.
      .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_m, url: string, label: string) =>
        label.trim() ? `[${label}](${url})` : url,
      )
      // <url> — nothing to show but the URL itself.
      .replace(/<(https?:\/\/[^|>]+)>/g, "$1")
      // <mailto:a@b|a@b>
      .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
      // <@U123|name> and <@U123>. Without a users.info lookup the id is all
      // there is; the brackets are markup and go regardless.
      .replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, "@$2")
      .replace(/<@([UW][A-Z0-9]+)>/g, "@$1")
      // <#C123|general> and <#C123>
      .replace(/<#(C[A-Z0-9]+)\|([^>]+)>/g, "#$2")
      .replace(/<#(C[A-Z0-9]+)>/g, "#$1")
      // <!here>, <!channel>, <!subteam^S123|@team>
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, handle: string | undefined) => handle ?? "@team")
      .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
      // Only now the escapes, and only the three Slack actually applies.
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Whether a message is something a person wrote, rather than something Slack
 * emitted about the channel.
 *
 * Joins, leaves, topic and purpose changes, pins and channel renames all arrive
 * through conversations.history as ordinary messages carrying a `subtype`. A
 * plain human message has no subtype at all, which makes the test a presence
 * check rather than a denylist — a denylist would silently start indexing
 * whatever subtype Slack adds next.
 *
 * `bot_message` and `thread_broadcast` are the deliberate exceptions: both are
 * real content. A bot posting a deploy summary or an alert is often exactly
 * what somebody later searches for.
 */
const PROSE_SUBTYPES = new Set(["bot_message", "thread_broadcast"]);

function isProse(message: SlackMessage): boolean {
  if (message.subtype !== undefined && !PROSE_SUBTYPES.has(message.subtype)) return false;
  // A message with no text is a file share or an attachment-only post; there is
  // nothing to embed, and an empty chunk is worse than no chunk.
  return (message.text ?? "").trim().length > 0;
}

/**
 * One message as Markdown.
 *
 * Author ids are still ids: resolving them to names needs a users.info per
 * distinct author and a cache the broker has nowhere to put. That is a real
 * cost to retrieval — an opaque `@U0C14S3U61W` embeds as noise where a name
 * would help — and it is deliberately deferred rather than unnoticed.
 */
function renderMessage(message: SlackMessage): string {
  const author = message.user ? `@${message.user}` : "unknown";
  return `**${author}**: ${renderText(message.text ?? "")}`.trim();
}
