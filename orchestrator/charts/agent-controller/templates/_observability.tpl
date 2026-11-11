{{/*
Agent observability (docs/adr/0050) helpers.
*/}}

{{/*
The Langfuse base URL the collector exports to: observability.langfuse.endpoint
when set (bring-your-own, or migrating off the bundled instance), else the
bundled subchart's web Service. Mirrors the upstream chart's fullname rule for
an aliased `langfuse` subchart: <release>-langfuse, or the release name alone
when it already contains "langfuse". Empty when neither applies.
*/}}
{{- define "agent-controller.langfuseEndpoint" -}}
{{- if .Values.observability.langfuse.endpoint -}}
{{- .Values.observability.langfuse.endpoint | trimSuffix "/" -}}
{{- else if .Values.langfuse.enabled -}}
{{- $name := ternary .Release.Name (printf "%s-langfuse" .Release.Name) (contains "langfuse" .Release.Name) | trunc 63 | trimSuffix "-" -}}
http://{{ $name }}-web:3000
{{- end -}}
{{- end -}}

{{/*
The collector's OTLP endpoint for emitters (engines, agent pods): the only
place they send telemetry; only the collector holds Langfuse keys.
*/}}
{{- define "agent-controller.otlpEndpoint" -}}
http://{{ .Release.Name }}-otel-collector:4318
{{- end -}}
