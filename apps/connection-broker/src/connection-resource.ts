import { ConfluenceDriver } from "./drivers/confluence.js";
import type { Driver, Scope } from "./drivers/types.js";
import type { ConnectionBinding } from "./registry.js";

/**
 * A `Connection` custom resource, mirroring
 * `controllers/core-controller/api/v1alpha1/connection_types.go`.
 *
 * Only the fields the BROKER acts on are declared. Retrieval-side fields
 * (description, allowedRoles, identityProviders) are the orchestrator's
 * business and are deliberately absent: the broker dereferences credentials and
 * must not grow opinions about who may retrieve what.
 */
export interface ConnectionCustomResource {
  metadata: { name: string; namespace?: string };
  spec: {
    provider: string;
    displayName?: string;
    /**
     * Carried for one reason: the broker stamps these onto every chunk it
     * writes. It never evaluates them — deciding who may retrieve is the
     * orchestrator's job, and the broker must not grow opinions about it.
     */
    allowedRoles?: string[];
    scope: { space?: string; channel?: string; folderID?: string };
    site?: { baseURL: string; cloudId?: string };
    secretEnv?: { name: string; secretRef: { name: string; key: string } }[];
    sync?: { mode?: string; reconcileInterval?: string };
  };
  status?: { collection?: string };
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

export class ConnectionConfigError extends Error {
  readonly name = "ConnectionConfigError";
}

/**
 * Builds the broker's binding for one Connection CR.
 *
 * Every failure here is a REFUSAL rather than a degraded binding. A connection
 * the broker half-understands is worse than one it refuses to serve: the
 * request path would answer with a driver pointed somewhere unintended, and
 * every scope check downstream would pass, because they would all be evaluated
 * against whatever it was pointed at.
 */
export async function toBinding(
  cr: ConnectionCustomResource,
  readSecret: SecretReader,
): Promise<ConnectionBinding> {
  const name = cr.metadata.name;
  const { spec } = cr;

  const serviceToken = await resolveServiceToken(name, spec.secretEnv, readSecret);
  const scope: Scope = {
    space: spec.scope?.space,
    channel: spec.scope?.channel,
    folderID: spec.scope?.folderID,
  };

  return {
    name,
    driver: driverFor(name, spec),
    scope,
    allowedRoles: spec.allowedRoles ?? [],
    serviceToken,
  };
}

function driverFor(name: string, spec: ConnectionCustomResource["spec"]): Driver {
  switch (spec.provider) {
    case "confluence": {
      // Required by a CEL rule on the CRD, and re-checked here. Admission
      // validation covers resources created through the API server; it does not
      // cover a CR that predates the rule, so the consumer checks too.
      if (!spec.site?.baseURL) {
        throw new ConnectionConfigError(
          `connection ${name}: a confluence connection needs spec.site.baseURL; ` +
            `every citation is built from it`,
        );
      }
      return new ConfluenceDriver({
        siteBaseUrl: spec.site.baseURL,
        cloudId: spec.site.cloudId,
      });
    }
    default:
      // Including providers the CRD's enum allows but no driver implements yet.
      // Serving them with a stand-in would be worse than refusing.
      throw new ConnectionConfigError(
        `connection ${name}: no driver implements provider "${spec.provider}"`,
      );
  }
}

async function resolveServiceToken(
  name: string,
  secretEnv: ConnectionCustomResource["spec"]["secretEnv"],
  readSecret: SecretReader,
): Promise<string> {
  const entry = (secretEnv ?? []).find((candidate) => candidate.name === SERVICE_TOKEN_ENV);
  if (!entry) {
    throw new ConnectionConfigError(
      `connection ${name}: no secretEnv entry named ${SERVICE_TOKEN_ENV}; ` +
        `ingestion has no credential to run as`,
    );
  }

  const value = await readSecret(entry.secretRef.name, entry.secretRef.key);
  if (!value) {
    throw new ConnectionConfigError(
      `connection ${name}: Secret ${entry.secretRef.name}/${entry.secretRef.key} is missing or empty`,
    );
  }
  return value;
}

/**
 * How often this Connection's full reconcile runs, in milliseconds.
 *
 * `undefined` means "do not schedule": mode `none` indexes nothing and exists
 * only for the GET face. A missing interval on any other mode is a CR that
 * should not have passed admission (a CEL rule requires it), so it is treated
 * as unschedulable rather than defaulted — a default here would silently
 * reconcile on a cadence nobody chose.
 */
export function reconcileIntervalMs(cr: ConnectionCustomResource): number | undefined {
  const sync = cr.spec.sync;
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

/**
 * The Qdrant collection this connection's chunks live in.
 *
 * Read from status rather than recomputed, so the controller stays the single
 * source of truth for it (the CRD's own field comment says so). A broker that
 * derived its own name would disagree with the controller the first time the
 * naming scheme changed, and the disagreement would look like an empty corpus
 * rather than like a bug.
 */
export function collectionOf(cr: ConnectionCustomResource): string | undefined {
  return cr.status?.collection;
}
