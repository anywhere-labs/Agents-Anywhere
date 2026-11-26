"use client"

// An agent's extra environment variables: the names that are set (their values stay on the device and are not shown
// again), new ones, and removals, all only a draft until the form around it is saved.
import { useState } from "react"
import { PlusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface EnvDraft {
  set: Record<string, string>
  removed: string[]
}
export const NO_ENV_CHANGES: EnvDraft = { set: {}, removed: [] }

export function hasEnvChanges(draft: EnvDraft): boolean {
  return Object.keys(draft.set).length > 0 || draft.removed.length > 0
}

export function EnvEditor({ saved, draft, onDraft }: { saved: readonly string[]; draft: EnvDraft; onDraft: (draft: EnvDraft) => void }) {
  const { t } = useI18n()
  const [added, setAdded] = useState({ key: "", value: "" })
  const keys = [...new Set([...saved, ...Object.keys(draft.set)])].filter((key) => !draft.removed.includes(key))

  const add = () => {
    const key = added.key.trim()
    if (!ENV_NAME.test(key)) {
      toast.error(t("agent.envNameInvalid"))
      return
    }
    onDraft({ set: { ...draft.set, [key]: added.value }, removed: draft.removed.filter((k) => k !== key) })
    setAdded({ key: "", value: "" })
  }
  const remove = (key: string) => {
    const set = { ...draft.set }
    delete set[key]
    onDraft({ set, removed: saved.includes(key) ? [...draft.removed, key] : draft.removed })
  }

  return (
    <div className="space-y-2 py-3">
      <p className="text-sm text-foreground">{t("agent.env")}</p>
      {keys.length > 0 && (
        <ul className="space-y-1">
          {keys.map((key) => (
            <li key={key} className="flex items-center gap-2 rounded-lg bg-background px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{key}</span>
              <span className="text-xs text-muted-foreground">{key in draft.set ? t("agent.envPending") : t("agent.envSet")}</span>
              <Button variant="ghost" size="icon-xs" aria-label={t("common.delete")} onClick={() => remove(key)}>
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={added.key}
          onChange={(e) => setAdded((n) => ({ ...n, key: e.target.value }))}
          placeholder={t("agent.envName")}
          aria-label={t("agent.envName")}
          className="h-8 w-40 font-mono text-sm"
          spellCheck={false}
        />
        <Input
          type="password"
          value={added.value}
          onChange={(e) => setAdded((n) => ({ ...n, value: e.target.value }))}
          placeholder={t("agent.envValue")}
          aria-label={t("agent.envValue")}
          className="h-8 min-w-40 flex-1 font-mono text-sm"
          autoComplete="off"
        />
        <Button type="button" variant="outline" size="sm" disabled={!added.key.trim()} onClick={add}>
          <PlusIcon className="size-3.5" />
          {t("agent.envAdd")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("agent.envHint")}</p>
    </div>
  )
}
