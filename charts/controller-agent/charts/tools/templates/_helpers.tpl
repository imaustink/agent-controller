{{/*
Common labels for every catalog CR.
*/}}
{{- define "tools.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: controller-agent
{{- end }}

{{/*
Hook annotations so catalog CRs apply after the core-controller Deployment
(post-install/post-upgrade), re-apply cleanly on upgrade, and are ordered by
weight. Call with the root context: {{- include "tools.hookAnnotations" . | nindent 4 }}
*/}}
{{- define "tools.hookAnnotations" -}}
helm.sh/hook: post-install,post-upgrade
helm.sh/hook-weight: {{ .Values.hookWeight | quote }}
helm.sh/hook-delete-policy: before-hook-creation
{{- end }}
