import { apiClient } from "@/lib/api"
import type { InlineAttachmentRef, ProtocolModelCatalog } from "./types"

export type RuntimeDialogValue = { kind: "confirm"; status: "submitted"; value: boolean }
  | { kind: "form"; values: Record<string, unknown> }
  | { kind: "select"; status: "submitted"; optionId: string }
  | { kind: "input" | "editor"; status: "submitted"; text: string }
export type WorkflowInteraction = {
  interactionId: string; ownerGeneration: string; requestRevision: number; revision: number;
  kind: string; title: string; message?: string; status: string; metadata: Record<string, unknown>;
  actions: { actionId: string; label: string; style: string; input: Record<string, unknown> }[]
}
export type WorkflowView = { protocolVersion: "1.1" | "1.2"; id: string; kind: "preparation" | "creation";
  connectorId: string; runtimeId: string; projectId: string; sessionId?: string | null;
  state: { phase: string; revision: number; catalogRevision?: number; catalog?: ProtocolModelCatalog;
    messageAccepted?: boolean | null; created?: boolean | null; initializationId?: string; workerGeneration?: string;
    configuration?: import("./runtime-forms").AgentConfiguration;
    interactions: WorkflowInteraction[]; canCancel?: boolean; canCancelInitialization?: boolean;
    failure?: { code: string; message: string } } }
export type PreparedWorkspace = { preparationId: string; expectedRevision: number; catalogRevision: number; configuration?: Record<string, string | boolean> }
export type AgentOperation = "authentication.status" | "resources.get" | "resources.reload" | "queue.get" | "queue.clear" | "message.follow_up" | "session.rename" | "session.fork" | "directories.add" | "tools.set"
export type AgentOperationResult = { operationId: string; phase: "accepted" | "running" | "completed" | "rejected" | "cancelled" | "outcome_unknown"; result?: { message?: string; commands?: { name: string }[] }; failure?: { code: string; message: string } }
export type AgentConfigurationView = { configuration: import("./runtime-forms").AgentConfiguration; ownerGeneration?: string; actions?: { operation: AgentOperation; title: string }[] }
export const workflowApi = {
  operate: (token: string, sessionId: string, body: { operation: AgentOperation; operationId: string; expectedGeneration: string; values: Record<string, unknown> }) => apiClient.post<AgentOperationResult>(`/runtime-workflows/sessions/${encodeURIComponent(sessionId)}/operations`, body, { token }),
  recover: (token: string, sessionId: string, body: { operationId: string; expectedGeneration: string }) => apiClient.post<Record<string, unknown>>(`/runtime-workflows/sessions/${encodeURIComponent(sessionId)}/recover`, body, { token }),
  configuration: (token: string, sessionId: string) => apiClient.get<AgentConfigurationView>(`/runtime-workflows/sessions/${encodeURIComponent(sessionId)}/configuration`, { token }),
  updateConfiguration: (token: string, sessionId: string, body: { operationId: string; expectedRevision: number; values: Record<string, string | boolean> }) => apiClient.post<{ phase: string; configuration: import("./runtime-forms").AgentConfiguration }>(`/runtime-workflows/sessions/${encodeURIComponent(sessionId)}/configuration`, body, { token }),
  components: (token: string, connectorId: string, runtimeId: string, body: { operation: "list" | "get_operation" | "install" | "activate" | "rollback" | "remove"; operationId?: string; releaseId?: string; profileId?: string }) => apiClient.post<Record<string, unknown>>(`/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/components`, body, { token }),
  prepare: (token: string, body: { connectorId: string; runtimeId: string; projectId: string; clientPreparationId: string }) =>
    apiClient.post<WorkflowView>("/runtime-workflows/preparations", body, { token }),
  begin: (token: string, body: PreparedWorkspace & { createOperationId: string; clientMessageId: string; content: string; selections: Record<string, string | null>; attachments?: InlineAttachmentRef[]; title?: string }) =>
    apiClient.post<WorkflowView>("/runtime-workflows/creations", body, { token }),
  get: (token: string, kind: WorkflowView["kind"], id: string) => apiClient.get<WorkflowView>(`/runtime-workflows/${kind}/${encodeURIComponent(id)}`, { token }),
  respond: (token: string, operation: WorkflowView, interaction: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) =>
    apiClient.post<{ disposition: string }>(`/runtime-workflows/${operation.kind}/${encodeURIComponent(operation.id)}/responses`, {
      interactionId: interaction.interactionId, requestRevision: interaction.requestRevision, ownerGeneration: interaction.ownerGeneration,
      responseOperationId: crypto.randomUUID(), actionId, ...(input === undefined ? {} : { input }),
    }, { token }),
  cancel: (token: string, operation: WorkflowView) => apiClient.post<WorkflowView>(`/runtime-workflows/${operation.kind}/${encodeURIComponent(operation.id)}/cancel`, { operationId: crypto.randomUUID() }, { token }),
}
