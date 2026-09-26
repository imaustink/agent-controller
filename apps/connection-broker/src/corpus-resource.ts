import { ConfluenceDriver } from "./drivers/confluence.js";
import { GDriveDriver } from "./drivers/gdrive.js";
import { SlackDriver } from "./drivers/slack.js";
import type { Driver, Scope } from "./drivers/types.js";
import type { CorpusBinding } from "./registry.js";

/**
 * A `Corpus` custom resource — a scoped subset of one system's material
 * (ADR 0043), mirroring `controllers/core-controller/api/v1alpha1/corpus_types.go`.
 *
 * Only the fields the BROKER acts on are declared. `description` is the
 * orchestrator's business and is deliberately absent: the broker dereferences
 * credentials and must not grow opinions about who may retrieve what.
 * `allowedRoles` is the one exception, and only because the broker WRITES it
 * onto the chunks it indexes.
 */
export interface CorpusCustomResource {
  metadata: { name: string; namespace?: string };
  spec: {
    connectionRef: string;
    displayName?: string;
    allowedRoles?: string[];
    scope: { space?: string; channel?: string; folderID?: string };
    sync?: { mode?: string; reconcileInterval?: string };
  };
  status?: { collection?: string; provider?: string };
}

/**
 * A `Connection` custom resource — an authenticated route to one system
 * (ADR 0043). One per Slack workspace, Confluence site or Drive account.
 */
export interface ConnectionCustomResource {
  metadata: { name: string; namespace?: string };
  spec: {
    provider: string;
    displayName?: string;
    site?: { baseURL: string; cloudId?: string };
    allowedScopes?: { spaces?: string[]; channels?: string[]; folderIDs?: string[] };
    autoJoin?: boolean;
    secretEnv?: { name: string; secretRef: { name: string; key: string } }[];
  };
}

/** Reads one key from one Secret. Injected so the mapping stays pure and testable. */
export type SecretReader = (secretName: string, key: string) => Promise<string | undefined>;

/**
 * The name of the env var carrying a connection's ingestion credential.
 *
 * Fixed rather than "whichever secretEnv entry happens to be first": a
 * connection may legitimately carry several secrets, and picking the wrong one
 * would authenticate to the source with something that is not the ingestion
 * credential and fail in a way that looks like a permissions problem.
 */
export const SERVICE_TOKEN_ENV = "SERVICE_TOKEN";

export class CorpusConfigError extends Error {
  readonly name = "CorpusConfigError";
}

/**
 * Builds the broker's binding for one Corpus over its Connection.
 *
 * Every failure here is a REFUSAL rather than a degraded binding. A corpus the
 * broker half-understands is worse than one it declines to serve: the request
 * path would answer with a driver pointed somewhere unintended, and every scope
 * check downstream would pass, because they would all be evaluated against
 * wherever it was pointed.
 */
export async function toBinding(
  corpus: CorpusCustomResource,
  connection: ConnectionCustomResource,
  readSecret: SecretReader,
): Promise<CorpusBinding> {
  const name = corpus.metadata.name;

  if (corpus.spec.connectionRef !== connection.metadata.name) {
    // A wiring mistake rather than a user error, and the one that would be
    // worst to serve: a driver addressed at one system with another's scope.
    throw new CorpusConfigError(
      `corpus ${name} references connection ${corpus.spec.connectionRef}, ` +
        `but was given ${connection.metadata.name}`,
    );
  }

  const serviceToken = await resolveServiceToken(name, connection, readSecret);
  const scope: Scope = {
    space: corpus.spec.scope?.space,
    channel: corpus.spec.scope?.channel,
    folderID: corpus.spec.scope?.folderID,
  };

  assertWithinConnectionScopes(name, scope, connection);

  return {
    name,
    connection: connection.metadata.name,
    driver: driverFor(name, connection),
    scope,
    allowedRoles: corpus.spec.allowedRoles ?? [],
    serviceToken,
  };
}

/**
 * Re-checks the Connection's `allowedScopes` cap.
 *
 * The controller checks this too and degrades a Corpus that violates it. Both
 * exist because they answer at different moments: admission and reconcile can
 * be bypassed by a CR that predates the rule, and this is the last point before
 * a credential is actually spent.
 */
function assertWithinConnectionScopes(
  name: string,
  scope: Scope,
  connection: ConnectionCustomResource,
): void {
  const caps = connection.spec.allowedScopes;
  if (!caps) return; // No cap set is not an empty cap — it permits anything.

  const [unit, allowed] =
    scope.space !== undefined
      ? [scope.space, caps.spaces]
      : scope.channel !== undefined
        ? [scope.channel, caps.channels]
        : [scope.folderID, caps.folderIDs];

  if (!allowed || allowed.length === 0) return;
  if (unit !== undefined && allowed.includes(unit)) return;

  throw new CorpusConfigError(
    `corpus ${name} is scoped to ${String(unit)}, which connection ` +
      `${connection.metadata.name} does not permit`,
  );
}

function driverFor(name: string, connection: ConnectionCustomResource): Driver {
  const spec = connection.spec;
  switch (spec.provider) {
    case "confluence": {
      // Required by a CEL rule on the Connection, and re-checked here.
      // Admission validation covers resources created through the API server;
      // it does not cover a CR that predates the rule.
      if (!spec.site?.baseURL) {
        throw new CorpusConfigError(
          `corpus ${name}: connection ${connection.metadata.name} needs spec.site.baseURL; ` +
            `every citation is built from it`,
        );
      }
      return new ConfluenceDriver({
        siteBaseUrl: spec.site.baseURL,
        cloudId: spec.site.cloudId,
      });
    }

    case "slack":
      // No site coordinates: a channel is reached by id alone.
      return new SlackDriver({
        workspaceUrl: spec.site?.baseURL,
        // An operator's decision on the CONNECTION, never a default: joining is
        // the one write this driver can perform, and it is a property of the
        // credential rather than of any one channel.
        autoJoin: spec.autoJoin ?? false,
      });

    case "gdrive":
      return new GDriveDriver();

    default:
      // A provider the CRD's enum does not cover, or one added to the enum
      // ahead of its driver. Serving it with a stand-in would be worse than
      // refusing.
      throw new CorpusConfigError(
        `corpus ${name}: no driver implements provider "${spec.provider}"`,
      );
  }
}

async function resolveServiceToken(
  name: string,
  connection: ConnectionCustomResource,
  readSecret: SecretReader,
): Promise<string> {
  const entry = (connection.spec.secretEnv ?? []).find(
    (candidate) => candidate.name === SERVICE_TOKEN_ENV,
  );
  if (!entry) {
    throw new CorpusConfigError(
      `corpus ${name}: connection ${connection.metadata.name} has no secretEnv entry named ` +
        `${SERVICE_TOKEN_ENV}; ingestion has no credential to run as`,
    );
  }

  const value = await readSecret(entry.secretRef.name, entry.secretRef.key);
  if (!value) {
    throw new CorpusConfigError(
      `corpus ${name}: Secret ${entry.secretRef.name}/${entry.secretRef.key} is missing or empty`,
    );
  }
  return value;
}

/**
 * The Qdrant collection this corpus's chunks live in.
 *
 * Read from status rather than recomputed, so the controller stays the single
 * source of truth for it (the CRD's own field comment says so). A broker that
 * derived its own name would disagree with the controller the first time the
 * naming scheme changed, and the disagreement would look like an empty corpus
 * rather than like a bug.
 */
export function collectionOf(corpus: CorpusCustomResource): string | undefined {
  return corpus.status?.collection;
}

/**
 * How often this Corpus's full reconcile runs, in milliseconds.
 *
 * `undefined` means "do not schedule": mode `none` indexes nothing and exists
 * only for the GET face. A missing interval on any other mode is a CR that
 * should not have passed admission (a CEL rule requires it), so it is treated
 * as unschedulable rather than defaulted — a default here would silently
 * reconcile on a cadence nobody chose.
 */
export function reconcileIntervalMs(corpus: CorpusCustomResource): number | undefined {
  const sync = corpus.spec.sync;
  if (!sync || sync.mode === "none") return undefined;
  return parseDuration(sync.reconcileInterval);
}

/** Parses a Go-style duration ("6h", "30m", "90s") into milliseconds. */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!match) return undefined;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return Number(match[1]) * scale;
}
