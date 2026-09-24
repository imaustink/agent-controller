{{- /*
  An E2E-only stub Agent, rendered once per stub (agent-stub.yaml,
  agent-stub-swe.yaml). The two differ only in name and which
  identityProviders they declare, so the definition lives here once.

  Params: root (the chart context), name (the Agent CR name), values (that
  stub's values block).
*/}}
{{- define "communityComponents.stubAgent" }}
{{- $root := .root }}
{{- $name := .name }}
{{- $v := .values }}
{{- /*
  E2E-ONLY Agent. Default-disabled in values.yaml and enabled solely by
  values-e2e.yaml -- it returns a canned reply and does no work, so a
  production cluster that switched a route to it would silently answer every
  request with a stub. Fail loudly rather than let that be a values typo.
*/}}
{{- if not $v.acknowledgeNotForProduction }}
{{- fail (printf "%s is an e2e-only test double that answers every request with a canned reply. Set its acknowledgeNotForProduction=true to enable it." $name) }}
{{- end }}
apiVersion: {{ $root.Values.crdApiVersion }}
kind: Agent
metadata:
  name: {{ $name }}
  labels:
    {{- include "tools.labels" $root | nindent 4 }}
    e2e: "true"
  annotations:
    # Mirrors claude-code-swe-agent/opencode-swe-agent (the pod/NATS-protocol
    # agents this stands in for): without this, the Temporal engine's
    # agentWorkflowNameFor (engines/temporal/internal/temporal/workflows/agent_workflow.go)
    # would route this Agent to the declarative planner loop instead of
    # BridgedAgentWorkflow, making the stub an unfaithful stand-in once a
    # cluster routes turns through the Temporal engine.
    durable-agents.dev/bridged: "true"
spec:
  description: >-
    E2E test double. Speaks the real NATS agent protocol and returns a canned
    reply without calling a model. Not for production use.
  input: Anything; the goal is echoed back rather than acted on.
  output: A fixed acknowledgement carrying the goal and the credential env var names that arrived.
  allowedRoles:
    - writer
  # Unprivileged, unlike claude-code-swe-agent: the stub needs NATS and nothing
  # else -- no repo checkout, no git/gh, no egress.
  tier: standard
  {{- if $v.identityLink.enabled }}
  {{- /*
    Mirrors the agent this stands in for. The authorization pre-flight derives
    which credentials to resolve, and which secretEnv names to inject, purely
    from this list (PROVIDER_ENV_VAR in agent-orchestrator/src/agent/graph.ts),
    so declaring the same providers means the identity gate behaves identically
    -- including refusing to launch when a credential is missing, which is what
    the identity-keying spec's negative controls assert. A stub that declared
    no providers would sail past the gate and make that suite vacuous.
  */}}
  identityProviders:
    {{- range $v.identityLink.providers }}
    - {{ . }}
    {{- end }}
  {{- end }}
  image: {{ $v.image }}
  serviceAccountName: {{ $v.serviceAccountName }}
  {{- /*
    Turn pacing (apps/stub-agent/src/pacing.ts). Absent, the stub replies
    immediately and behaves exactly as before. resilience.e2e.ts PATCHES these
    on this CR between tests -- it needs a turn still in flight while it bounces
    NATS or rolls the orchestrator, and a silent turn to trip the idle window.
    Declared here (rather than only patched in) so the field exists to patch and
    so the default is visible.
  */}}
  env:
    - name: STUB_NARRATE_FOR_MS
      value: {{ $v.pacing.narrateForMs | quote }}
    - name: STUB_NARRATE_EVERY_MS
      value: {{ $v.pacing.narrateEveryMs | quote }}
    - name: STUB_SILENT_FOR_MS
      value: {{ $v.pacing.silentForMs | quote }}
    {{- if $v.replyAckTimeoutMs }}
    - name: AGENT_REPLY_ACK_TIMEOUT_MS
      value: {{ $v.replyAckTimeoutMs | quote }}
    {{- end }}
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "500m"
      memory: "256Mi"
  orchestratorPrompt: |
    {{- $v.orchestratorPrompt | default "Do not delegate to this agent. It is an end-to-end test double that\nreturns a canned reply without doing the requested work." | nindent 4 }}
  agentPrompt: |
    Unused: this agent makes no model call.
{{- end }}
