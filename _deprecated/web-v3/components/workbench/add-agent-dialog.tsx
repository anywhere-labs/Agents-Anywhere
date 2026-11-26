"use client"

// Adding an agent of one's own to a device: a name, the command that speaks ACP (typed as in a terminal) and extra
// environment variables. The command must be there; whether it really speaks ACP shows in the start check that runs in
// its settings right after.
import { useState } from "react"
import { MeshCallError } from "meshcall/web"
import { LoaderCircleIcon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { EnvEditor, hasEnvChanges, NO_ENV_CHANGES } from "@/components/workbench/env-editor"
import { Card } from "@/components/workbench/settings-parts"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, DeviceRecord } from "@/lib/types/v3"
import { splitArgs } from "@/lib/workbench/args"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export function AddAgentDialog({
  open,
  onOpenChange,
  ...props
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  onAdded: (entry: AgentEntry) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-xl">
        {open && <AddAgentBody {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function AddAgentBody({
  tunnelManager,
  device,
  onAdded,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  onAdded: (entry: AgentEntry) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [command, setCommand] = useState("")
  const [env, setEnv] = useState(NO_ENV_CHANGES)
  const [pending, setPending] = useState(false)
  const words = splitArgs(command)

  const add = async () => {
    if (!tunnelManager || !device) return
    setPending(true)
    try {
      onAdded(
        await tunnelManager.addAgent(device, {
          name: name.trim(),
          command: words[0] ?? "",
          args: words.slice(1),
          ...(hasEnvChanges(env) ? { env: env.set } : {}),
        })
      )
    } catch (err) {
      const reason = err instanceof MeshCallError ? err.reason : undefined
      toast.error(
        reason === "agent_name_taken"
          ? t("addAgent.nameTaken")
          : reason === "command_not_found"
            ? t("addAgent.commandNotFound", { command: words[0] ?? "" })
            : err instanceof Error
              ? err.message
              : String(err)
      )
      setPending(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && words.length > 0 && !pending) void add()
      }}
    >
      <DialogHeader className="border-b border-border px-6 py-4 text-left">
        <DialogTitle>{t("addAgent.title")}</DialogTitle>
        <DialogDescription>{t("addAgent.desc")}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <Card>
          <div className="space-y-1.5 py-3">
            <label className="text-sm text-foreground" htmlFor="add-agent-name">
              {t("addAgent.name")}
            </label>
            <Input id="add-agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} autoComplete="off" autoFocus />
          </div>
          <div className="space-y-1.5 py-3">
            <label className="text-sm text-foreground" htmlFor="add-agent-command">
              {t("addAgent.command")}
            </label>
            <Input
              id="add-agent-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="my-agent --acp"
              className="font-mono text-sm"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <EnvEditor saved={[]} draft={env} onDraft={setEnv} />
        </Card>
      </div>
      <div className="flex items-center justify-end border-t border-border px-6 py-3">
        <Button type="submit" size="sm" disabled={!name.trim() || words.length === 0 || pending || device?.presence !== "online"}>
          {pending && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          {t("addAgent.add")}
        </Button>
      </div>
    </form>
  )
}
