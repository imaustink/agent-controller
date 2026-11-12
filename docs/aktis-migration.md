# Migrating a cluster to Aktis

The Aktis rename ([ADR 0047 §6](adr/0047-decouple-framework-from-orchestrator.md))
moves the CRD API group from `core.controller-agent.dev` to `core.aktis.ai`,
and every label, annotation and finalizer key from `controller-agent.dev` /
`controller-agent.io` to `aktis.ai`. Kubernetes treats the two groups as
unrelated, so nothing converts in place: every CR is recreated under the new
group, and every credential Secret is relabelled.

**Skipping this loses data visibly.** The new release reads only the new group
and the new keys, so on an unmigrated cluster it starts with an empty catalog
and every linked account (GitHub, Claude, Atlassian…) disappears until each user
links it again.

Namespace, release name and image paths do not change. The system chart is now
published as `oci://ghcr.io/imaustink/charts/aktis` (it was `.../charts/agent-controller`).
Keep your release name (`agent-controller`), and the rendered resource names
stay the same.

## GitOps (Argo CD): no hand-applied steps

If an Argo CD Application owns the release with `prune: true`, the upgrade is a
Git change only. **Do not run `migrate-to-aktis.sh` against the cluster.**

In one commit to the repository holding your Application and values:

1. Point the Application at the new chart (`chart: aktis`, at or above the first
   version shipping the `migrate-aktis` hook) and pin every image to that same
   upstream commit or later. The hook runs `core-controller migrate-aktis`, which
   older core-controller images don't have.
2. Rename the group in your values: `agent-orchestrator.crdGroup`,
   community-components' `crdApiVersion`, any `AGENT_CRD_GROUP` / `CRD_GROUP`
   overrides, and the `apiVersion` of every `extraManifests` CR.
3. Change the `apiVersion` of every CR you deploy from other Applications (KBs,
   EventTriggers, …) to `core.aktis.ai/v1alpha1`. Those Applications cannot
   apply until the new CRDs exist, so give them a sync `retry` policy. Then
   merge order doesn't matter: they converge once the chart lands.

On sync, Argo CD installs the `core.aktis.ai` CRDs from the chart, creates the
new-group CRs from your manifests, and prunes the old-group CRs and CRDs. The
chart's `migrate-aktis` PostSync hook Job does the two parts no manifest can:

- adds the `aktis.ai` keys to the credential Secrets/ConfigMaps the old release
  wrote, so linked accounts survive. It never overwrites a new key, and it
  leaves the old keys in place for rollback.
- strips old-domain finalizers (such as `corpora-exist` on a Connection) from
  old-group CRs, so the pruned CRDs finish deleting instead of hanging in
  `Terminating`.

The hook is idempotent and does nothing on a cluster that never ran the old group.
`core-controller.migrateAktis.namespaces` lists the namespaces it relabels and
defaults to the release namespace. Set it if your credential Secrets live
elsewhere.

In-flight agent and tool runs belong to the old group and are not carried over.

## Plain Helm / hand-applied CRs

`helm upgrade` never installs CRDs from a chart's `crds/` directory, and nothing
recreates CRs you applied by hand. In that case, use the script below. The chart's
hook still runs post-upgrade, and both are idempotent.

## Before you start

- Run from a checkout of the version you are upgrading **to**: `copy` installs
  the new CRDs from it.
- Needs `kubectl` (1.27+, for `--subresource=status`) and `jq`, with a context
  that can manage CRDs, Secrets and every CR in the cluster.
- **Check the context.** The script acts on the current context and prints it
  before asking to continue.
- **Check your own values for the old names.** The charts' defaults are renamed,
  but an override in a deployment's values file wins. Search the repository that
  holds them for `controller-agent.dev` and `controller-agent.io`. The keys that
  matter are `agent-orchestrator.crdGroup`, `crdApiVersion` (community-components),
  and any `AGENT_CRD_GROUP` / `CRD_GROUP` environment overrides.
- **Check your own manifests for the old `apiVersion`.** CRs you deploy outside
  the charts (a GitOps repository, the agent-controller chart's
  `extraManifests`, the `examples/event-triggers` copies) name
  `core.controller-agent.dev/v1alpha1`. Change them to `core.aktis.ai/v1alpha1`
  in the same change as the upgrade: once `cleanup` deletes the old CRDs, a
  manifest still naming the old group cannot be applied.
- **Pick a quiet window.** Agent and tool runs in flight during the upgrade
  belong to the old group and are not carried over; those turns may fail.

## Steps

### 1. Copy (old release still running)

```bash
./scripts/migrate-to-aktis.sh copy --dry-run   # review
./scripts/migrate-to-aktis.sh copy
```

This:

- installs the `core.aktis.ai` CRDs
- recreates every **hand-applied** CR under the new group: labels and
  annotations keep their values with keys renamed, finalizers renamed, and status
  copied when the API server allows it
- **adds** the new keys to credential Secrets, next to the old ones

The old release reads only the old group and the old keys, so it carries on
untouched.

CRs a release manages (Helm or Argo ownership metadata, as with
`community-components`) are **not** copied: the upgrade creates them from the
new chart. A copy would pin the old chart's content, because Helm adopts an
existing object without patching it. `copy` warns about any hand-applied CR
whose spec still mentions the old names, for example a Skill prompt that tells
the agent which `apiVersion` to write. Edit those by hand.

Runtime records are not copied: `AgentRun`, `ToolRun`, and `MCPTool` (mcp-broker
rebuilds MCPTools from MCPServers).

### 2. Upgrade the release

Upgrade or sync as usual: `helm upgrade`, or an Argo CD sync. Because `copy`
already installed the new CRDs, it doesn't matter that `helm upgrade` never
installs CRDs from a chart's `crds/` directory.

On upgrade, Helm deletes the old-group objects it managed and creates new-group
ones. If Argo CD prunes, it may also delete the old CRDs, and with them every
old CR. That's harmless after `copy`. An old `Connection` holds a finalizer
nothing serves any more (`corpora-exist`), so the pruned CRD can sit in
`Terminating` until step 3 clears it.

### 3. Cleanup (new release healthy)

```bash
./scripts/migrate-to-aktis.sh cleanup --dry-run
./scripts/migrate-to-aktis.sh cleanup
```

This first re-runs the copy, to catch anything the old release wrote while you
upgraded. That includes credentials users linked during the window, which
otherwise would carry only the old keys. Then:

- it checks that every old CR has a new-group counterpart, and **aborts without
  deleting anything** if one is missing. The usual cause is running cleanup
  before the upgrade.
- it strips the old finalizers, then deletes the old CRs and CRDs. Deleting an
  old run cascades to its Job. A Corpus's sync CronJob and a cron EventSource's
  tick CronJob and ServiceAccount survive, because the new controller re-adopts
  them on startup. The retired `IntegrationRoute` CRD (ADR 0048) is deleted too
  if it is still there.
- it removes the old keys from Secrets.

Both phases are idempotent, so a failed run can simply be re-run.

## Rolling back

| You are after | To undo |
|-|-|
| `copy` | Nothing to undo; the old release never sees the new group. Delete the `core.aktis.ai` CRDs if you want them gone. |
| the upgrade, before `cleanup` | Roll the release back. Hand-applied old CRs and the old Secret keys are still in place, and the rollback recreates the release-managed CRs. Accounts linked *after* the upgrade carry only the new keys and need linking again. |
| `cleanup` | Restore from backup, or migrate forward again: the old objects are gone. |
