{{/*
Expand the name of the chart.
*/}}
{{- define "agent-orchestrator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name. Truncated at 63 chars because
some Kubernetes name fields are limited to that (by the DNS naming spec).
*/}}
{{- define "agent-orchestrator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "agent-orchestrator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agent-orchestrator.labels" -}}
helm.sh/chart: {{ include "agent-orchestrator.chart" . }}
{{ include "agent-orchestrator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agent-orchestrator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-orchestrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the ServiceAccount to use.
*/}}
{{- define "agent-orchestrator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent-orchestrator.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Namespace tools are discovered in / Jobs are launched into. Defaults to the
release namespace when not explicitly set.
*/}}
{{- define "agent-orchestrator.toolNamespace" -}}
{{- default .Release.Namespace .Values.namespace }}
{{- end }}

{{/*
In-cluster callback base URL, used as AGENT_CALLBACK_BASE_URL when
config.callbackBaseUrl is left empty.
*/}}
{{- define "agent-orchestrator.callbackBaseUrl" -}}
{{- if .Values.config.callbackBaseUrl }}
{{- .Values.config.callbackBaseUrl }}
{{- else }}
{{- printf "http://%s-callback.%s.svc.cluster.local:%d" (include "agent-orchestrator.fullname" .) .Release.Namespace (.Values.ports.callback | int) }}
{{- end }}
{{- end }}

{{/*
Qdrant URL: when qdrant.enabled, derive the in-cluster Service DNS name for
the bundled subchart (fullname pattern copied from qdrant-helm's own
_helpers.tpl: release name as-is if it already contains "qdrant", else
"<release>-qdrant" -- the subchart's Service has no extra suffix, port 6333).
Otherwise use config.qdrantUrl as-is (an existing/external instance).
*/}}
{{- define "agent-orchestrator.qdrantUrl" -}}
{{- if .Values.qdrant.enabled }}
{{- $name := "qdrant" }}
{{- $fullname := "" }}
{{- if contains $name .Release.Name }}
{{- $fullname = .Release.Name }}
{{- else }}
{{- $fullname = printf "%s-%s" .Release.Name $name }}
{{- end }}
{{- printf "http://%s.%s.svc.cluster.local:6333" $fullname .Release.Namespace }}
{{- else }}
{{- .Values.config.qdrantUrl }}
{{- end }}
{{- end }}

