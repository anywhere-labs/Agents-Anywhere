"use client"

// The agent's session options in the composer's bottom row (after Effi Cloud's config.tsx): a model chip ("Opus 5.5 ·
// High ⌄") whose menu lists the models, the thinking levels and any other option; and the permission mode as its own
// chip — an icon for how much the agent may do unasked (amber when it asks nothing) and the mode's name. Each choice
// goes through set_config (before the conversation exists: kept and passed to create).
import type * as React from "react"
import {
  ChevronDownIcon,
  ClipboardListIcon,
  EyeIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroupButton } from "@/components/ui/input-group"
import type { ConfigOption } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

type Choice = ConfigOption["options"][number]

export const isModeOption = (o: ConfigOption) => o.category === "mode" || (!o.category && o.id === "mode")
export const isModelOption = (o: ConfigOption) => o.category === "model" || (!o.category && o.id === "model")
export const isThoughtOption = (o: ConfigOption) =>
  o.category === "thought_level" || (!o.category && /^(effort|reasoning_effort|thought_level)$/.test(o.id))

const ON = /^(true|on|enabled?)$/i
const OFF = /^(false|off|disabled?)$/i
function switchValues(o: ConfigOption) {
  if (o.options.length !== 2) return null
  const on = o.options.find((x) => ON.test(x.value) || ON.test(x.name))
  const off = o.options.find((x) => OFF.test(x.value) || OFF.test(x.name))
  return on && off && on !== off ? { on: on.value, off: off.value } : null
}

const TRIGGER =
  "h-8 min-w-0 gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground hover:text-foreground aria-expanded:bg-surface-hover aria-expanded:text-foreground"

type Level = "read" | "plan" | "ask" | "auto" | "all"
const LEVEL_ICON: Record<Level, React.ReactNode> = {
  read: <EyeIcon />,
  plan: <ClipboardListIcon />,
  ask: <ShieldCheckIcon />,
  auto: <ShieldIcon />,
  all: <ShieldAlertIcon />,
}

/** How much a permission mode lets the agent do unasked, guessed from its value (Claude Code's and Codex's names). */
export function modeLevel(value: string): Level {
  const v = value.toLowerCase()
  if (/bypass|full|yolo|danger|never/.test(v)) return "all"
  if (/plan/.test(v)) return "plan"
  if (/read/.test(v)) return "read"
  if (/accept|auto|edit|write|agent/.test(v)) return "auto"
  return "ask"
}

function ModePicker({
  option,
  agent,
  onChange,
  disabled,
}: {
  option: ConfigOption
  agent: string
  onChange: (id: string, value: string) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const cur = option.options.find((x) => x.value === option.current) ?? { value: option.current, name: option.current }
  const level = modeLevel(cur.value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`${option.name}: ${cur.name}`}
            className={cn(TRIGGER, "shrink-0 [&_svg]:size-[15px]", level === "all" && "text-warning hover:text-warning")}
          />
        }
      >
        {LEVEL_ICON[level]}
        <span className="max-w-28 truncate max-sm:sr-only">{cur.name}</span>
        <ChevronDownIcon className="size-3.5! shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("composer.permissions", { agent })}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={option.current}
            onValueChange={(v) => v !== option.current && onChange(option.id, String(v))}
          >
            {option.options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick className="items-start py-2">
                <span
                  className={cn("mt-0.5 flex [&_svg]:size-4", modeLevel(o.value) === "all" && "text-warning")}
                >
                  {LEVEL_ICON[modeLevel(o.value)]}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span>{o.name}</span>
                  {o.description && (
                    <span className="text-xs whitespace-normal text-muted-foreground">{o.description}</span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const modelName = (c: Choice) => c.name.replace(/\s*\((recommended|latest)\)\s*$/i, "")

function Radio({
  option,
  onChange,
  label,
}: {
  option: ConfigOption
  onChange: (id: string, value: string) => void
  label?: string
}) {
  // Choices with a group (a model's provider) are listed under it, so the names keep the whole row.
  const groups: { name: string | undefined; items: Choice[] }[] = []
  for (const o of option.options) {
    const last = groups[groups.length - 1]
    if (last && last.name === o.group) last.items.push(o)
    else groups.push({ name: o.group, items: [o] })
  }
  return (
    <DropdownMenuGroup>
      {label && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
      <DropdownMenuRadioGroup
        value={option.current}
        onValueChange={(v) => v !== option.current && onChange(option.id, String(v))}
      >
        {groups.map((g, i) => (
          <div key={`${g.name ?? ""}-${i}`} role="presentation">
            {g.name && groups.length > 1 && (
              <div className="truncate px-2 pt-2 pb-1 text-xs text-muted-foreground">{g.name}</div>
            )}
            {g.items.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick title={o.description}>
                <span className="min-w-0 truncate">{modelName(o)}</span>
              </DropdownMenuRadioItem>
            ))}
          </div>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}

/**
 * `place="model"`: the model / thinking / other options chip on the left; `place="mode"`: the permission chip on the
 * right. `loading`: the agent has not reported its options yet.
 */
export function ConfigPickers({
  config,
  agent,
  onChange,
  disabled,
  loading,
  place,
}: {
  config?: ConfigOption[]
  agent: string
  onChange: (configId: string, value: string) => void
  disabled?: boolean
  loading?: boolean
  place: "model" | "mode"
}) {
  const { t } = useI18n()
  const options = config ?? []
  const mode = options.find(isModeOption)
  const model = options.find(isModelOption)
  const thought = options.find((o) => o !== model && o !== mode && isThoughtOption(o))
  const rest = options.filter((o) => o !== mode && o !== model && o !== thought)
  if (place === "mode") {
    return mode ? <ModePicker option={mode} agent={agent} onChange={onChange} disabled={disabled} /> : null
  }
  if (loading && !options.length) {
    return (
      <span className="flex h-8 items-center gap-1.5 px-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-3 animate-spin" />
        {agent}
      </span>
    )
  }
  if (!model && !thought && !rest.length) {
    return <span className="flex h-8 items-center px-2 text-sm text-muted-foreground">{agent}</span>
  }
  const cur = model?.options.find((x) => x.value === model.current)
  const name = model ? (cur ? modelName(cur) : model.current || t("composer.defaultModel")) : agent
  const level = thought?.options.find((x) => x.value === thought.current)
  const levelText = level && level.value !== "default" ? level.name : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            disabled={disabled}
            className={cn(TRIGGER, "max-w-56")}
            aria-label={`${t("composer.model")}: ${name}${levelText ? `, ${levelText}` : ""}`}
          />
        }
      >
        <span className="truncate">{name}</span>
        {levelText && <span className="shrink-0 opacity-70">{levelText}</span>}
        <ChevronDownIcon className="size-3.5! shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-[min(34rem,var(--available-height))] w-72">
        {model && <Radio option={model} onChange={onChange} label={`${agent} · ${t("composer.model")}`} />}
        {thought && (
          <>
            {model && <DropdownMenuSeparator />}
            <Radio option={thought} onChange={onChange} label={t("composer.thinking")} />
          </>
        )}
        {rest.length > 0 && (model || thought) && <DropdownMenuSeparator />}
        {rest.map((o) => {
          const sw = switchValues(o)
          if (sw) {
            return (
              <DropdownMenuGroup key={o.id}>
                <DropdownMenuCheckboxItem
                  checked={o.current === sw.on}
                  onCheckedChange={(on) => onChange(o.id, on ? sw.on : sw.off)}
                  title={o.description}
                >
                  {o.name}
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            )
          }
          return <Radio key={o.id} option={o} onChange={onChange} label={o.name} />
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
