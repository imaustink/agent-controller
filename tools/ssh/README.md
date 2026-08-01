# ssh

A self-contained subagent container: a single allowlisted remote diagnostic
command in, that host's stdout out, run over SSH against a fixed set of
allowlisted hosts.

## Contract

- **Input** (`argv[2]`): `"<target> <command> [args...]"`, e.g.
  `"nas.kurpuis.internal df -h"` or `"monitor@bastion.kurpuis.internal:2222 systemctl status docker"`.
- **Output**: the remote command's own stdout, wrapped in a fenced code
  block, delivered via the event contract in `docs/messaging.md`.

## Safety model (defense in depth)

Unlike `tools/kubectl-readonly` (RBAC-backed) or `tools/github` (the calling
user's own GitHub permissions), there is no cluster- or API-level backstop
here -- the target boxes are outside this cluster's control plane, so every
layer below is this codebase's own responsibility:

1. **Fixed host allowlist** (`SSH_ALLOWED_HOSTS`, `src/config.ts`) -- the
   authoritative boundary. A comma-separated `user@host[:port]` list with no
   wildcard; a caller-supplied target must match one of these entries
   exactly (host, user, and port).
2. **In-process command allowlist** (`src/allowlist.ts`) -- only a fixed set
   of read-only diagnostic binaries may run at all (`df`, `ps`, `journalctl`,
   `systemctl status`, `docker ps`/`logs`/`inspect`, ...); `systemctl` and
   `docker` are further restricted to a read-only subcommand set. Nothing
   here writes, deletes, restarts a service, or opens an interactive shell.
3. **Plain-argument charset** -- every argument after the command itself must
   match `^[A-Za-z0-9._\-/:=@,]+$`. This matters more here than in the other
   tools: `ssh user@host cmd args...` never runs a local shell, but OpenSSH
   concatenates the remote argv with spaces and hands that string to the
   **remote** login shell unless the target forces a fixed command. A
   caller-supplied `;`, `|`, `` ` ``, or `$(...)` would otherwise be a real
   remote shell injection primitive.
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
```

To test the actual in-cluster path, create the `ssh-tool-secrets` Secret
(see `charts/community-components/values.yaml`'s `sshTool` block), enable
`sshTool.enabled=true`, and invoke it as a real `ToolRun`/Job in a cluster
(e.g. minikube).
