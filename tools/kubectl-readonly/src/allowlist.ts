/**
 * Defense-in-depth validation of a caller-supplied kubectl command line, on
 * top of the RBAC restrictions already bound to this container's
 * ServiceAccount (see rbac.yaml). RBAC is the authoritative boundary; this
 * allowlist exists so a mistaken or adversarial `tool_args` string fails
 * fast and loud instead of relying on the API server alone, and so nothing
 * here can ever construct a request for a resource kind (e.g. `secrets`)
 * this tool should never touch even if RBAC were misconfigured.
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
  jobs: ["jobs", "job"],
  cronjobs: ["cronjobs", "cronjob", "cj"],
  persistentvolumeclaims: ["persistentvolumeclaims", "persistentvolumeclaim", "pvc"],
  horizontalpodautoscalers: ["horizontalpodautoscalers", "horizontalpodautoscaler", "hpa"],
};

const ALLOWED_RESOURCE_KINDS = new Set(Object.values(ALLOWED_RESOURCE_ALIASES).flat());

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
  // A resource positional may be "pods" or "pods/my-name" — only the kind before
  // the slash is validated here; the name half is an opaque cluster-internal string.
  return (positional.split("/")[0] ?? "").toLowerCase();
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
      resourceKindChecked = true;
    }
    argv.push(token);
  }

  // Fixed, non-overridable server-side timeout — caller-controlled input can
  // never disable or extend this.
  argv.push("--request-timeout=10s");
  return argv;
}
