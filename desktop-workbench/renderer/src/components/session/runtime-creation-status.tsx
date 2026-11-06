"use client"

import { useWorkspace } from "@/components/workspace-context"
import { RuntimeWorkflowPanel } from "./runtime-workflow-panel"

/** Keep initialization questions and recovered operations in the current page. */
export function RuntimeCreationStatus({ sessionId }: { sessionId?: string }) {
  const workspace = useWorkspace()
  const operations = Object.values(workspace.workflowCreations).filter(operation =>
    !sessionId || operation.id === sessionId || operation.sessionId === sessionId,
  )
  return <>{operations.map(operation => {
    const needsAttention = workspace.workflowError || operation.state.failure
      || operation.state.interactions.some(request => request.status === "open")
      || ["failed", "cancelled", "rejected", "outcome_unknown"].includes(operation.state.phase)
    if (!needsAttention) return null
    return <div key={operation.id} className="mx-auto mb-3 w-full max-w-3xl">
      <RuntimeWorkflowPanel operation={operation} pending={workspace.workflowPending} error={workspace.workflowError}
        onRespond={(request, action, input) => workspace.respondWorkflow(operation, request, action, input)}
        onCancel={() => workspace.cancelWorkflow(operation)} onRefresh={() => workspace.refreshWorkflow(operation)}
        onDismiss={() => workspace.dismissWorkflow(operation.id)} />
    </div>
  })}</>
}
