{{/*
Common labels for every catalog CR.
*/}}
{{- define "tools.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: controller-agent
{{- end }}

{{/*
GitHub-credential wiring shared by the SWE agents (claudeCodeSweAgent,
opencodeSweAgent), which take the same three mutually-exclusive credentials.
Pass the agent's own values sub-map, e.g.:
  include "tools.githubAppFullyConfigured" .Values.claudeCodeSweAgent

`tools.githubAppFullyConfigured` is non-empty only when ALL THREE
githubApp*SecretKey values are set. `resolveGithubToken`
(packages/github-app-auth) mints an installation token whenever all three
GITHUB_APP_* env vars are present and never looks at GITHUB_TOKEN in that
case, so the PAT secretEnv is dropped rather than forcing a placeholder key
into the Secret just to satisfy the secretRef. A PARTIAL set is deliberately
not treated as configured -- the agent rejects it at runtime, and each
template fails the render for it up front.
*/}}
{{- define "tools.githubAppFullyConfigured" -}}
{{- if and .githubAppIdSecretKey .githubAppPrivateKeySecretKey .githubAppInstallationIdSecretKey -}}
true
{{- end -}}
{{- end }}

{{/*
Count of githubApp*SecretKey values set, as a string -- used to tell "none"
(the PAT path) from a partial set (an error).
*/}}
{{- define "tools.githubAppKeyCount" -}}
{{- len (compact (list .githubAppIdSecretKey .githubAppPrivateKeySecretKey .githubAppInstallationIdSecretKey)) -}}
{{- end }}
