{{- define "temporal-engine.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "temporal-engine.temporalEnv" -}}
- name: TEMPORAL_ADDRESS
  value: {{ .Values.temporal.address | quote }}
- name: TEMPORAL_NAMESPACE
  value: {{ .Values.temporal.namespace | quote }}
- name: TASK_QUEUE
  value: {{ .Values.taskQueue | quote }}
{{- end }}

{{- define "temporal-engine.qdrantEnv" -}}
- name: QDRANT_HOST
  value: {{ .Values.qdrant.host | quote }}
- name: QDRANT_PORT
  value: {{ .Values.qdrant.port | quote }}
{{- with .Values.qdrant.collectionPrefix }}
- name: QDRANT_COLLECTION_PREFIX
  value: {{ . | quote }}
{{- end }}
{{- end }}

{{- define "temporal-engine.callbackBaseURL" -}}
{{- if .Values.callback.baseURL -}}
{{ .Values.callback.baseURL }}
{{- else -}}
http://{{ .Release.Name }}-temporal-engine-gateway-callback.{{ .Release.Namespace }}.svc:8081
{{- end -}}
{{- end }}
