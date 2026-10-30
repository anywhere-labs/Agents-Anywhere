"use client"
import * as React from "react"
import { workflowApi, type RuntimeDialogValue, type WorkflowInteraction, type WorkflowView } from "@/features/dashboard/runtime-workflows"

type PreparationRequest = { connectorId: string; runtimeId: string; projectId: string }
export function useWorkspacePreparation(token: string | undefined, target: string, request?: () => Promise<PreparationRequest>) {
  const scope = JSON.stringify([token, target])
  const [stateScope, setStateScope] = React.useState(scope)
  const [operation, setOperation] = React.useState<WorkflowView | null>(null)
  const [error, setError] = React.useState<string>()
  const [pending, setPending] = React.useState(false)
  const generation = React.useRef(0)
  const busy = React.useRef(false)
  const started = React.useRef(false)
  React.useEffect(() => {
    generation.current++
    busy.current = false
    started.current = false
    setStateScope(scope); setOperation(null); setError(undefined); setPending(false)
    return () => { generation.current++ }
  }, [scope])

  const prepare = React.useCallback(async (resolve: () => Promise<PreparationRequest>) => {
    if (!token || busy.current) return
    const version = ++generation.current
    busy.current = true; setPending(true); setError(undefined); setOperation(null)
    try {
      const body = await resolve()
      if (version !== generation.current) return
      const value = await workflowApi.prepare(token, { ...body, clientPreparationId: crypto.randomUUID() })
      if (version === generation.current) setOperation(value)
    } catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) { busy.current = false; setPending(false) } }
  }, [token, target])

  React.useEffect(() => {
    if (!request || started.current) return
    started.current = true
    void prepare(request)
  }, [request, prepare])

  React.useEffect(() => {
    if (!token || stateScope !== scope || !operation || ["failed", "cancelled", "expired", "consumed"].includes(operation.state.phase)) return
    let closed = false, querying = false
    const timer = window.setInterval(async () => {
      if (querying || busy.current) return
      const version = generation.current
      querying = true
      try {
        const value = await workflowApi.get(token, "preparation", operation.id)
        if (!closed && version === generation.current) { setOperation(value); setError(undefined) }
      } catch (reason) { if (!closed && version === generation.current) setError(String(reason)) }
      finally { querying = false }
    }, 1500)
    return () => { closed = true; window.clearInterval(timer) }
  }, [token, scope, stateScope, operation?.id, operation?.state.phase])

  const respond = async (interaction: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) => {
    if (!token || !operation || busy.current || stateScope !== scope) return
    const version = ++generation.current; busy.current = true; setPending(true)
    try {
      await workflowApi.respond(token, operation, interaction, actionId, input)
      const value = await workflowApi.get(token, "preparation", operation.id)
      if (version === generation.current) { setOperation(value); setError(undefined) }
    } catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) { busy.current = false; setPending(false) } }
  }
  const cancel = async () => {
    if (!token || !operation || busy.current || stateScope !== scope) return
    const version = ++generation.current; busy.current = true; setPending(true)
    try {
      const value = await workflowApi.cancel(token, operation)
      if (version === generation.current) setOperation(value)
    } catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) { busy.current = false; setPending(false) } }
  }
  return { operation: stateScope === scope ? operation : null, pending: stateScope === scope && pending,
    error: stateScope === scope ? error : undefined, respond, cancel,
    retry: () => { if (request) void prepare(request) } }
}
