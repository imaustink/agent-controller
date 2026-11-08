{{- define "mcp-broker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mcp-broker.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "mcp-broker.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "mcp-broker.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "mcp-broker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-broker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mcp-broker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "mcp-broker.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Namespace the broker watches MCPServer CRs, reads their credential Secrets, and
writes derived MCPTool CRs in. Pinned to the same namespace as the rest of the
catalog (ADR 0045): precedence is this subchart's mcpNamespace, then the
umbrella chart's global.knowledgeBaseNamespace, then the release namespace. The
broker never reads or writes across namespaces.
*/}}
{{- define "mcp-broker.namespace" -}}
{{- $g := .Values.global | default dict -}}
{{- .Values.mcpNamespace | default $g.knowledgeBaseNamespace | default .Release.Namespace -}}
{{- end -}}
