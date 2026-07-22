/**
 * Defense-in-depth validation of a caller-supplied kubectl command line, on
 * top of the RBAC restrictions already bound to this container's
 * ServiceAccount (see the ClusterRole templated by
 * charts/community-components/templates/clusterrole-kubectl-readonly.yaml).
 * RBAC is the authoritative boundary; this allowlist exists so a mistaken or
 * adversarial `tool_args` string fails fast and loud instead of relying on
 * the API server alone, and so nothing here can ever construct a request
 * this tool should never make even if RBAC were misconfigured.
 *
 * Resource kinds are an explicit ALLOWLIST, not "everything except secrets".
 * A blocklist approach would silently start exposing whatever new resource
 * kind (built-in or CRD) shows up in the cluster later -- including
 * operator-managed CRs that embed credentials in spec fields, which is a
 * real anti-pattern some Helm charts use instead of a proper Secret. Keeping
 * an explicit list means adding a new kind is a deliberate, reviewed change.
 *
 * Secrets get a narrower carve-out than every other kind: `get`/`describe`
 * are allowed, but `-o json`/`-o yaml` are rejected specifically for
 * secrets, because those output forms include the full (base64-decodable)
 * `.data` field. `describe` and the default table `get` output both already
 * print only key names and byte lengths, never values -- that's kubectl's
 * own long-standing behavior, not something this tool has to implement.
 */

export class BlockedCommandError extends Error {}

const ALLOWED_VERBS = new Set(["get", "describe", "logs", "events", "top"]);

/** verb -> whether it takes a leading "resource kind" positional to validate. */
const VERBS_WITH_RESOURCE_KIND = new Set(["get", "describe", "top"]);

/** Canonical resource kind -> accepted aliases (plural, singular, kubectl shorthand). */
const ALLOWED_RESOURCE_ALIASES: Record<string, string[]> = {
  pods: ["pods", "pod", "po"],
  deployments: ["deployments", "deployment", "deploy"],
  replicasets: ["replicasets", "replicaset", "rs"],
  statefulsets: ["statefulsets", "statefulset", "sts"],
  daemonsets: ["daemonsets", "daemonset", "ds"],
  services: ["services", "service", "svc"],
  endpoints: ["endpoints", "endpoint", "ep"],
  events: ["events", "event", "ev"],
  nodes: ["nodes", "node", "no"],
  namespaces: ["namespaces", "namespace", "ns"],
  ingresses: ["ingresses", "ingress", "ing"],
  networkpolicies: ["networkpolicies", "networkpolicy", "netpol"],
  jobs: ["jobs", "job"],
  cronjobs: ["cronjobs", "cronjob", "cj"],
  configmaps: ["configmaps", "configmap", "cm"],
  persistentvolumes: ["persistentvolumes", "persistentvolume", "pv"],
  persistentvolumeclaims: ["persistentvolumeclaims", "persistentvolumeclaim", "pvc"],
  storageclasses: ["storageclasses", "storageclass", "sc"],
  resourcequotas: ["resourcequotas", "resourcequota", "quota"],
  limitranges: ["limitranges", "limitrange", "limits"],
  poddisruptionbudgets: ["poddisruptionbudgets", "poddisruptionbudget", "pdb"],
  horizontalpodautoscalers: ["horizontalpodautoscalers", "horizontalpodautoscaler", "hpa"],
  serviceaccounts: ["serviceaccounts", "serviceaccount", "sa"],
  // Narrow carve-out (see file header): key names + byte lengths only, never
  // values -- enforced below via RESOURCE_OUTPUT_RESTRICTIONS, not by RBAC.
  secrets: ["secrets", "secret"],
};

const ALLOWED_RESOURCE_KINDS = new Set(Object.values(ALLOWED_RESOURCE_ALIASES).flat());

/** Output values forbidden for specific resource kinds, on top of the flag's own allowedValues. */
const RESOURCE_OUTPUT_RESTRICTIONS: Record<string, string[]> = {
  secrets: ["json", "yaml"],
};

interface FlagSpec {
  /** Long-form canonical name, for error messages only. */
  name: string;
  takesValue: boolean;
  allowedValues?: string[];
}

/** Every accepted flag (long and short forms both keyed here). */
const ALLOWED_FLAGS: Record<string, FlagSpec> = {
  "-n": { name: "--namespace", takesValue: true },
  "--namespace": { name: "--namespace", takesValue: true },
  "-A": { name: "--all-namespaces", takesValue: false },
  "--all-namespaces": { name: "--all-namespaces", takesValue: false },
  "-l": { name: "--selector", takesValue: true },
  "--selector": { name: "--selector", takesValue: true },
  "--field-selector": { name: "--field-selector", takesValue: true },
  "-c": { name: "--container", takesValue: true },
  "--container": { name: "--container", takesValue: true },
  "--tail": { name: "--tail", takesValue: true },
  "--previous": { name: "--previous", takesValue: false },
  "--since": { name: "--since", takesValue: true },
  "--since-time": { name: "--since-time", takesValue: true },
  "-o": { name: "--output", takesValue: true, allowedValues: ["json", "yaml", "wide", "name"] },
  "--output": { name: "--output", takesValue: true, allowedValues: ["json", "yaml", "wide", "name"] },
  "--sort-by": { name: "--sort-by", takesValue: true },
};

/** Splits a command line into tokens, honoring single/double-quoted spans (no shell involved). */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function resourceKindOf(positional: string): string {
  // A resource positional may be "pods" or "pods/my-name" -- only the kind before
  // the slash is validated here; the name half is an opaque cluster-internal string.
  return (positional.split("/")[0] ?? "").toLowerCase();
}

function canonicalKindOf(alias: string): string | undefined {
  for (const [canonical, aliases] of Object.entries(ALLOWED_RESOURCE_ALIASES)) {
    if (aliases.includes(alias)) return canonical;
  }
  return undefined;
}

/**
 * Validates a tokenized kubectl command line and returns the exact argv to
 * spawn (verb + validated flags/positionals), with a fixed request timeout
 * appended. Throws {@link BlockedCommandError} on anything outside the
 * allowlist.
 */
export function validateCommand(tokens: string[]): string[] {
  const [verb, ...rest] = tokens;
  if (!verb) {
    throw new BlockedCommandError("No kubectl command given.");
  }
  if (!ALLOWED_VERBS.has(verb)) {
    throw new BlockedCommandError(
      `Verb "${verb}" is not allowed. Allowed verbs: ${[...ALLOWED_VERBS].join(", ")}.`,
    );
  }

  const argv: string[] = [verb];
  let resourceKindChecked = !VERBS_WITH_RESOURCE_KIND.has(verb);
  let canonicalKind: string | undefined;
  let outputValue: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;

    if (token.startsWith("-")) {
      const eqIdx = token.indexOf("=");
      const flagName = eqIdx === -1 ? token : token.slice(0, eqIdx);
      const spec = ALLOWED_FLAGS[flagName];
      if (!spec) {
        throw new BlockedCommandError(`Flag "${flagName}" is not allowed.`);
      }

      let value: string | undefined;
      if (spec.takesValue) {
        if (eqIdx !== -1) {
          value = token.slice(eqIdx + 1);
          argv.push(token);
        } else {
          value = rest[++i];
          if (value === undefined) {
            throw new BlockedCommandError(`Flag "${flagName}" requires a value.`);
          }
          argv.push(token, value);
        }
        if (spec.allowedValues && !spec.allowedValues.includes(value)) {
          throw new BlockedCommandError(
            `Flag "${flagName}" only allows: ${spec.allowedValues.join(", ")} (got "${value}").`,
          );
        }
        if (spec.name === "--output") {
          outputValue = value;
        }
      } else {
        if (eqIdx !== -1) {
          throw new BlockedCommandError(`Flag "${flagName}" does not take a value.`);
        }
        argv.push(token);
      }
      continue;
    }

    // A bare positional: the first one after a get/describe/top verb is the
    // resource kind and must be allowlisted; every later positional (a name,
    // e.g. "my-pod-abc123") is passed through opaque.
    if (!resourceKindChecked) {
      const kind = resourceKindOf(token);
      if (!ALLOWED_RESOURCE_KINDS.has(kind)) {
        throw new BlockedCommandError(
          `Resource kind "${kind}" is not allowed. Allowed kinds: ${Object.keys(ALLOWED_RESOURCE_ALIASES).join(", ")}.`,
        );
      }
      canonicalKind = canonicalKindOf(kind);
      resourceKindChecked = true;
    }
    argv.push(token);
  }

  // Checked once at the end (not inline) since `-o`/`--output` can appear
  // before or after the resource-kind positional on a real kubectl command
  // line -- e.g. both "get secrets -o json" and "get -o json secrets" are
  // valid kubectl syntax.
  if (canonicalKind && outputValue) {
    const restricted = RESOURCE_OUTPUT_RESTRICTIONS[canonicalKind];
    if (restricted?.includes(outputValue)) {
      throw new BlockedCommandError(
        `Output format "${outputValue}" is not allowed for ${canonicalKind} -- it would include raw values. ` +
          `Use "describe" or the default table output to see keys and lengths only.`,
      );
    }
  }

  // Fixed, non-overridable server-side timeout -- caller-controlled input can
  // never disable or extend this.
  argv.push("--request-timeout=10s");
  return argv;
}
