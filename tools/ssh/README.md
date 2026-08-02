# ssh

A self-contained subagent container: a single allowlisted remote command
in, that host's stdout out, run over SSH. Read-only diagnostics by default;
read/write is an explicit per-deployment opt-in (see `SSH_ALLOWED_COMMANDS`
below).

## Contract

- **Input** (`argv[2]`): `"<target> <command> [args...]"`, where `<target>`
  is either a literal `user@host[:port]` or an alias resolved via
  `SSH_CONFIG` (see "Resolving a target" below), e.g.
  `"nas.kurpuis.internal df -h"`, `"monitor@bastion.kurpuis.internal:2222 systemctl status docker"`,
  or `"kube0 uptime"`.
- **Output**: the remote command's own stdout, wrapped in a fenced code
  block, delivered via the event contract in `docs/messaging.md`.

## Resolving a target

Two independent, each individually optional inputs govern what a caller's
`<target>` string actually dials (`src/target.ts`):

- **`SSH_ALLOWED_HOSTS`** -- the authorization boundary. A comma-separated
  `user@host[:port]` list with no wildcard; when set, the *resolved* target
  (after `SSH_CONFIG` alias resolution, if any) must match one of these
  entries exactly.
- **`SSH_CONFIG`** -- ssh_config(5)-shaped content (`src/sshconfig.ts`) for
  resolving an alias like `kube0` to its `HostName`/`User`/`Port`, the same
  way the operator's own `~/.ssh/config` already does. Only `Host`/
  `HostName`/`User`/`Port` are understood; every other directive
  (`IdentityFile`, `ProxyJump`, ...) is silently ignored -- this tool's
  identity is always `SSH_PRIVATE_KEY`, never something a config file
  should be able to redirect.

At least one of the two must be set (enforced at startup) -- with neither,
this tool would dial whatever `user@host` a caller supplied with no boundary
at all. They compose freely:

- **Allowlist only**: callers must spell out `user@host[:port]` literally;
  `SSH_ALLOWED_HOSTS` is the sole boundary.
- **`SSH_CONFIG` only**: callers use short aliases; the config file's own
  Host list is the boundary (only safe if that list is itself closed and
  trusted -- there's no wildcard `Host *` restriction check here).
- **Both**: aliases resolve via `SSH_CONFIG`, and the resolved
  `user@host:port` must *also* be on `SSH_ALLOWED_HOSTS` -- config for
  convenience, allowlist for the actual boundary.

## Command allowlist: read-only default, or wide open

`SSH_ALLOWED_COMMANDS` governs which top-level remote commands are accepted
(`src/allowlist.ts`), independent of target resolution above:

- **Unset (default)**: the built-in curated read-only diagnostic set (`df`,
  `ps`, `journalctl`, `systemctl status`, `docker ps`/`logs`/`inspect`,
  `ip addr show`, ...). `systemctl`/`docker` are further restricted to a
  read-only subcommand set, and `ip`/`find` reject their write/exec forms
  specifically. Nothing in this mode writes, deletes, restarts a service, or
  opens an interactive shell.
- **A comma-separated custom list**: only those top-level commands are
  accepted; the `systemctl`/`docker`/`ip`/`find` restrictions above still
  apply if you include them.
- **`"*"` (wide open)**: no command-name or subcommand restriction at all.
  This is a deliberate escape hatch for a deployment that has decided the
  read-only posture isn't worth maintaining a list for -- e.g. a homelab the
  operator is fine with an agent breaking, not infrastructure that matters.
  Choosing this is a real, per-deployment risk decision; see
  `charts/community-components/values-production.yaml`'s `sshTool` block for
  how it's documented there.

**The plain-argument charset check always applies, in every mode,
including `"*"`.** Every token -- including the command name -- must match
`^[A-Za-z0-9._\-/:=@,]+$`. This matters more here than in the other tools:
`ssh user@host cmd args...` never runs a local shell, but OpenSSH
concatenates the remote argv with spaces and hands that string to the
**remote** login shell unless the target forces a fixed command. A
caller-supplied `;`, `|`, `` ` ``, or `$(...)` would otherwise be a real
remote shell injection primitive regardless of which command was allowed --
so "wide open" means "any command, no shell injection", not "no restriction
at all".

## Safety model (defense in depth)

Unlike `tools/kubectl-readonly` (RBAC-backed) or `tools/github` (the calling
user's own GitHub permissions), there is no cluster- or API-level backstop
here -- the target boxes are outside this cluster's control plane, so every
layer below is this codebase's own responsibility:

1. **Target resolution/restriction** (`src/target.ts`) -- see "Resolving a
   target" above.
2. **In-process command allowlist** (`src/allowlist.ts`) -- see "Command
   allowlist" above; can be relaxed to `"*"` per deployment.
3. **Plain-argument charset** -- unconditional in every mode; see above.
4. **No shell locally** -- the validated argv is passed straight to
   `child_process.spawn("ssh", ...)`, never interpolated into a local shell
   string.
5. **Pinned host keys, no TOFU** -- `StrictHostKeyChecking=yes` with an
   operator-supplied `SSH_KNOWN_HOSTS`, so an unrecognized or changed host
   key fails the connection instead of silently trusting it.
6. **No persisted credential beyond the Job's lifetime** -- the private key
   and known_hosts content are materialized to a `tmpfs` `/tmp` (this
   container's root filesystem is read-only) fresh on every invocation and
   never leave the pod.

## Choosing a credential

The shared key this tool authenticates with should itself be scoped as
narrowly as possible on the target side, since this tool's allowlist is the
only thing standing between "read-only diagnostics" and whatever else that
key's `authorized_keys` entry permits. At minimum, disable everything this
tool never needs (port forwarding, X11, agent forwarding, an interactive
pty) on the target:

```
# ~monitor/.ssh/authorized_keys on the target box
no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... ssh-tool@controller-agent
```

A `command="..."` forced-command restriction is NOT a drop-in option here:
it overrides every request with one fixed command, but this tool sends a
different remote command depending on what's asked (`df -h`, `ps`,
`systemctl status docker`, ...). The stronger version of this hardening is a
target-side wrapper script that reads `$SSH_ORIGINAL_COMMAND`, re-validates
it against the same (or a stricter) allowlist, and only then execs it --
genuine defense in depth since it doesn't have to trust this tool's own
allowlist at all. No such wrapper exists in this repo yet; write one per
target if you want that extra layer.

There is no precedent in this repo for per-user SSH credentials (contrast
`tools/github`'s identity-link model) -- this tool always authenticates as
one shared, operator-provisioned identity.

## Local development

```sh
npm install
npm run typecheck --workspace=ssh
npm run test --workspace=ssh
npm run build --workspace=ssh
docker build -f tools/ssh/Dockerfile -t ssh:latest .
SSH_ALLOWED_HOSTS="monitor@nas.kurpuis.internal" \
  SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519_monitor)" \
  SSH_KNOWN_HOSTS="$(ssh-keyscan nas.kurpuis.internal)" \
  ./tools/ssh/run.sh "nas.kurpuis.internal df -h"

# Or, using SSH_CONFIG aliases instead of (or alongside) SSH_ALLOWED_HOSTS:
SSH_CONFIG=$'Host nas\n  HostName nas.kurpuis.internal\n  User monitor' \
  SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519_monitor)" \
  SSH_KNOWN_HOSTS="$(ssh-keyscan nas.kurpuis.internal)" \
  ./tools/ssh/run.sh "nas df -h"
```

To test the actual in-cluster path, create the `ssh-tool-secrets` Secret
(see `charts/community-components/values.yaml`'s `sshTool` block), enable
`sshTool.enabled=true`, and invoke it as a real `ToolRun`/Job in a cluster
(e.g. minikube).
