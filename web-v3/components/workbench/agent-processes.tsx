"use client"

// Start and stop an agent's processes from its row on the device page. Start runs the same warm start a new
// conversation uses (aa.v3.Sessions/prepare, in the home folder): it shows whether the agent can be used, and the
// process waits up to 10 minutes for a new conversation to take it over before it is closed. Stop ends all of the
// agent's processes (aa.v3.Device/stop_agent); while conversations are replying it asks first, then forces.
import { useState, type ReactNode } from "react"
import { DeadlineExceededError, MeshCallError } from "meshcall/web"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { useI18n } from "@/components/i18n-provider"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord } from "@/lib/types/v3"

type Agent = { id: string; name: string }
type Pending = "starting" | "stopping"

export function useAgentProcesses({
  tunnelManager,
  device,
  onChanged,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: Pick<DeviceRecord, "id" | "mode_hint" | "presence"> | null
  /** After a start or stop: read the agents' process counts again. */
  onChanged: () => void
}): {
  pending: (id: string) => Pending | null
  start: (agent: Agent) => void
  stop: (agent: Agent) => void
  dialogs: ReactNode
} {
  const { t } = useI18n()
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [confirm, setConfirm] = useState<(Agent & { busy: number }) | null>(null)

  const mark = (id: string, value: Pending | null) =>
    setPending((cur) => {
      const next = { ...cur }
      if (value) next[id] = value
      else delete next[id]
      return next
    })

  const start = async (agent: Agent) => {
    if (!tunnelManager || !device) return
    mark(agent.id, "starting")
    try {
      for (;;) {
        try {
          await tunnelManager.prepareSession(device, { agent: agent.id })
          toast.success(t("agent.started", { agent: agent.name }))
          return
        } catch (err) {
          // Still starting (a first download): asking again joins the start in progress.
          if (err instanceof DeadlineExceededError) continue
          throw err
        }
      }
    } catch (err) {
      toast.error(startError(err, agent.name))
    } finally {
      mark(agent.id, null)
      onChanged()
    }
  }

  const startError = (err: unknown, agent: string): string => {
    const message = err instanceof Error ? err.message : String(err)
    if (!(err instanceof MeshCallError)) return t("newConv.agentStartFailed", { agent, error: message })
    if (err.reason === "agent_auth_required") {
      const raw = err.details?.auth_methods
      const methods = Array.isArray(raw)
        ? raw.flatMap((m) => (m && typeof m === "object" && typeof m.name === "string" ? [m.name as string] : []))
        : []
      return t("newConv.agentAuthRequired", { agent }) + (methods.length ? ` ${t("newConv.agentAuthMethods", { methods: methods.join("、") })}` : "")
    }
    if (err.reason === "agent_disabled") return t("newConv.agentDisabled", { agent })
    return t("newConv.agentStartFailed", { agent, error: message })
  }

  const stop = async (agent: Agent, force = false) => {
    if (!tunnelManager || !device) return
    setConfirm(null)
    mark(agent.id, "stopping")
    try {
      const res = await tunnelManager.stopAgent(device, agent.id, force)
      toast.success(t("agent.stoppedAgent", { agent: agent.name, count: res.stopped }))
    } catch (err) {
      if (err instanceof MeshCallError && err.reason === "turns_running") {
        const count = typeof err.details?.count === "number" ? err.details.count : 1
        setConfirm({ ...agent, busy: count })
      } else toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      mark(agent.id, null)
      onChanged()
    }
  }

  const dialogs = (
    <ConfirmDialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) setConfirm(null)
      }}
      title={t("agent.stopBusyTitle", { agent: confirm?.name ?? "" })}
      description={t("agent.stopBusyDesc", { count: confirm?.busy ?? 0 })}
      confirmLabel={t("agent.stop")}
      cancelLabel={t("common.cancel")}
      destructive
      onConfirm={() => {
        if (confirm) void stop(confirm, true)
      }}
    />
  )

  return {
    pending: (id) => pending[id] ?? null,
    start: (agent) => void start(agent),
    stop: (agent) => void stop(agent),
    dialogs,
  }
}
