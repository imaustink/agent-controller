{{- define "durable-agents.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "durable-agents.temporalEnv" -}}
- name: TEMPORAL_ADDRESS
  value: {{ .Values.temporal.address | quote }}
- name: TEMPORAL_NAMESPACE
  value: {{ .Values.temporal.namespace | quote }}
- name: TASK_QUEUE
  value: {{ .Values.taskQueue | quote }}
{{- end }}

{{- define "durable-agents.qdrantEnv" -}}
- name: QDRANT_HOST
  value: {{ .Values.qdrant.host | quote }}
- name: QDRANT_PORT
  value: {{ .Values.qdrant.port | quote }}
{{- end }}
