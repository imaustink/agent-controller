import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLLER_DIR = join(REPO_ROOT, "controllers", "core-controller");
const CHART_DIR = join(REPO_ROOT, "charts", "agent-controller", "charts", "core-controller");

/** The ServiceAccount the deployed core-controller runs as. */
export const CORE_CONTROLLER_SA = "system:serviceaccount:controller-agent:core-controller";

/**
 * One `(apiGroup, resource, verb)` triple, rendered `group/resource:verb`.
 *
 * Grants are compared as flat triples rather than as rule objects because the
 * three sources express the SAME permission with different groupings:
 * `+kubebuilder:rbac` markers are per-controller, `make manifests` merges them
 * into alphabetised rules, and the Helm template hand-writes a third shape.
 * Comparing rules would report a reordering as a difference and a missing
 * resource as one line of noise among many; comparing triples reports exactly
 * the permissions that differ.
 */
export type Grant = string;

export function grant(apiGroup: string, resource: string, verb: string): Grant {
  return `${apiGroup || "core"}/${resource}:${verb}`;
}

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

function rulesToGrants(rules: Rule[]): Set<Grant> {
  const grants = new Set<Grant>();
  for (const rule of rules) {
    for (const g of rule.apiGroups ?? []) {
      for (const r of rule.resources ?? []) {
        for (const v of rule.verbs ?? []) grants.add(grant(g, r, v));
      }
    }
  }
  return grants;
}

/**
 * Every grant the controller's `+kubebuilder:rbac` markers declare.
 *
 * The markers are the authority here, not `config/rbac/role.yaml`: the
 * generated file is itself an artifact that can go stale when someone adds a
 * marker and never runs `make manifests`. Reading the Go sources means the
 * chain is checked from the code that actually calls the API server.
 */
export function grantsFromMarkers(): Set<Grant> {
  const dir = join(CONTROLLER_DIR, "internal", "controller");
  const grants = new Set<Grant>();

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".go"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/\/\/\s*\+kubebuilder:rbac:(\S+)/g)) {
      const fields = new Map<string, string>();
      for (const field of (match[1] ?? "").split(",")) {
        const eq = field.indexOf("=");
        if (eq > 0) fields.set(field.slice(0, eq), field.slice(eq + 1).replace(/^"|"$/g, ""));
      }
      // Kubebuilder separates repeats within one field with ';' -- `groups=a;b`
      // and `verbs=get;list` are both legal and both appear in this module.
      const split = (key: string) => (fields.get(key) ?? "").split(";").filter(Boolean);
      // `groups=""` is the CORE API group, not an absent field: dropping it as
      // empty silently discarded the serviceaccounts grant and made the
      // "nothing beyond the markers" assertion read it as privilege creep.
      const groups = fields.has("groups") ? (fields.get("groups") as string).split(";") : [];
      for (const g of groups) {
        for (const r of split("resources")) {
          for (const v of split("verbs")) grants.add(grant(g, r, v));
        }
      }
    }
  }

  if (grants.size === 0) throw new Error(`e2e: parsed no +kubebuilder:rbac markers out of ${dir}`);
  return grants;
}

/** Grants in `make manifests`' generated ClusterRole. */
export function grantsFromGeneratedRole(): Set<Grant> {
  const path = join(CONTROLLER_DIR, "config", "rbac", "role.yaml");
  const role = clusterRolesIn(readFileSync(path, "utf8"))[0];
  if (!role) throw new Error(`e2e: found no ClusterRole in ${path}`);
  return rulesToGrants(role.rules ?? []);
}

/**
 * Grants in the ClusterRole the Helm chart RENDERS -- the only one of the three
 * that is ever installed, and so the only one whose omissions crashloop the
 * controller.
 */
export function grantsFromChart(): Set<Grant> {
  const rendered = execFileSync(
    "helm",
    ["template", "core-controller", CHART_DIR, "--show-only", "templates/rbac.yaml"],
    { encoding: "utf8" },
  );
  const role = clusterRolesIn(rendered).find((r) => r.metadata?.name === "core-controller");
  if (!role) throw new Error("e2e: the chart rendered no core-controller ClusterRole");
  return rulesToGrants(role.rules ?? []);
}

interface ClusterRole {
  kind?: string;
  metadata?: { name?: string };
  rules?: Rule[];
}

function clusterRolesIn(yaml: string): ClusterRole[] {
  return parseAllDocuments(yaml)
    .map((doc) => doc.toJS() as ClusterRole | null)
    .filter((doc): doc is ClusterRole => doc?.kind === "ClusterRole");
}

/** Renders a grant set as sorted lines, so a diff in a failure message is readable. */
export function sorted(grants: Iterable<Grant>): string[] {
  return [...grants].sort();
}

export function missingFrom(required: Set<Grant>, actual: Set<Grant>): Grant[] {
  return sorted([...required].filter((g) => !actual.has(g)));
}
