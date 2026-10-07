"use client"

import * as React from "react"
import { Bot, CircleCheck, CircleDashed, ListChecks, Loader2, Target } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  readSessionInsights,
  type SessionInsightGoal,
  type SessionInsightSubagent,
  type SessionInsightTodo,
} from "@/features/dashboard/session-insights"
import type { SessionRuntimeState } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

/**
 * Conversation goal / task / sub-agent panels for runtimes that report them
 * through `SessionRuntimeState.metadata.insights` (DSH). Renders nothing when
 * the runtime reports none of the three.
 */
export function SessionInsightsPanel({
  runtimeState,
  onOpenSubagent,
}: {
  runtimeState?: SessionRuntimeState | null
  onOpenSubagent?: (sessionId: string) => void
}) {
  const t = useTranslations("dashboard.session")
  const insights = React.useMemo(
    () => readSessionInsights(runtimeState?.metadata),
    [runtimeState?.metadata],
  )
  if (!insights) return null

  const goal = insights.goal
  const todos = insights.todos ?? []
  const subagents = insights.subagentCatalog ?? []
  const agentPreset = runtimeState?.metadata?.agentPreset
  const presetLabel = typeof agentPreset === "string" && agentPreset.trim() ? agentPreset : null

  if (!goal && todos.length === 0 && subagents.length === 0 && !presetLabel) return null

  const activeTodos = todos.filter((todo) => todo.status !== "completed").length
  const summaryParts: string[] = []
  if (presetLabel) summaryParts.push(presetLabel)
  if (goal) summaryParts.push(t("insightsGoalShort"))
  if (todos.length > 0) summaryParts.push(t("insightsTodosShort", { count: activeTodos, total: todos.length }))
  if (subagents.length > 0) summaryParts.push(t("insightsSubagentsShort", { count: subagents.length }))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          variant="secondary"
          className="max-w-[40%] shrink-0 cursor-pointer gap-1.5 font-normal hover:bg-accent"
        >
          <Target className="size-3" />
          <span className="truncate">{summaryParts.join(" · ")}</span>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-[380px] rounded-xl p-4">
        <div className="space-y-4">
          {presetLabel ? (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("insightsAgentPreset")}
              </h3>
              <p className="mt-1 text-sm font-medium">{presetLabel}</p>
            </section>
          ) : null}
          {goal ? <GoalSection goal={goal} /> : null}
          {todos.length > 0 ? <TodosSection todos={todos} /> : null}
          {subagents.length > 0 ? <SubagentsSection subagents={subagents} onOpenSubagent={onOpenSubagent} /> : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GoalSection({ goal }: { goal: SessionInsightGoal }) {
  const t = useTranslations("dashboard.session")
  const phaseLabel = t(`insightsGoalPhase.${goal.phase}`)
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Target className="size-3" />
        {t("insightsGoal")}
      </h3>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-snug">{goal.objective}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px]",
            goal.phase === "active" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            goal.phase === "paused" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            goal.phase === "blocked" && "bg-destructive/10 text-destructive",
            goal.phase === "complete" && "bg-muted text-muted-foreground",
          )}
        >
          {phaseLabel}
        </span>
        <span>
          {t("insightsGoalRounds", { rounds: goal.roundsStarted, max: goal.maxGoalRounds })}
        </span>
      </div>
      {goal.phase === "blocked" && goal.blockedReason ? (
        <p className="mt-1.5 text-xs leading-snug text-destructive">{goal.blockedReason.message}</p>
      ) : null}
    </section>
  )
}

function TodosSection({ todos }: { todos: SessionInsightTodo[] }) {
  const t = useTranslations("dashboard.session")
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <ListChecks className="size-3" />
        {t("insightsTodos")}
      </h3>
      <ul className="mt-1.5 space-y-1.5">
        {todos.map((todo, index) => (
          <li key={index} className="flex items-start gap-2 text-sm leading-snug">
            {todo.status === "completed" ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : todo.status === "in_progress" ? (
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <span className={cn("min-w-0 break-words", todo.status === "completed" && "text-muted-foreground line-through")}>
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SubagentsSection({
  subagents,
  onOpenSubagent,
}: {
  subagents: SessionInsightSubagent[]
  onOpenSubagent?: (sessionId: string) => void
}) {
  const t = useTranslations("dashboard.session")
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Bot className="size-3" />
        {t("insightsSubagents")}
      </h3>
      <ul className="mt-1.5 space-y-1.5">
        {subagents.map((subagent) => (
          <li key={subagent.id}>
            <button
              type="button"
              disabled={!onOpenSubagent}
              onClick={() => onOpenSubagent?.(subagent.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm leading-snug",
                onOpenSubagent && "hover:bg-accent hover:text-accent-foreground",
                !onOpenSubagent && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  subagent.mode === "continuable" ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              <span className="min-w-0 truncate">
                {subagent.label ?? t("insightsSubagentUnnamed")}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {t(`insightsSubagentMode.${subagent.mode}`)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
