"use client"

import * as React from "react"
import { Archive, ArchiveRestore, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/settings/settings-section"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { dashboardApi } from "@/features/dashboard/api"
import type { ProjectView, SessionView } from "@/features/dashboard/types"
import type { WorkspaceSessionView } from "@/components/workspace-context"

const ALL_PROJECTS = "all"
const UNKNOWN_PROJECT_GROUP = "unknown-project"
const PROJECT_PREFIX = "project:"

function projectIdFromFilter(filter: string): string | null {
  return filter.startsWith(PROJECT_PREFIX)
    ? filter.slice(PROJECT_PREFIX.length)
    : null
}

type ArchivedSessionGroup = {
  key: string
  projectId: string | null
  name: string
  workspacePath: string | null
  sessions: WorkspaceSessionView[]
}

type ArchivedSessionsTabProps = {
  token: string
  projects: ProjectView[]
  sessions: WorkspaceSessionView[]
  loading: boolean
  onOpenSession: (sessionId: string) => void
  onSessionUpdated: (session: SessionView) => void
  onWorkspaceRefresh: () => void
}

function sessionTime(session: WorkspaceSessionView): string | null {
  return session.archivedAt ?? session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ?? null
}

function sessionTimeValue(session: WorkspaceSessionView): number {
  const value = sessionTime(session)
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function ArchivedSessionsTab({
  token,
  projects,
  sessions,
  loading,
  onOpenSession,
  onSessionUpdated,
  onWorkspaceRefresh,
}: ArchivedSessionsTabProps) {
  const t = useTranslations("pages.settings")
  const tActions = useTranslations("dashboard.actions")
  const locale = useLocale()
  const [projectFilter, setProjectFilter] = React.useState(ALL_PROJECTS)
  const [unarchivingIds, setUnarchivingIds] = React.useState<string[]>([])
  const [unarchivingProjectId, setUnarchivingProjectId] = React.useState<string | null>(null)

  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    [locale],
  )

  React.useEffect(() => {
    if (!projectFilter.startsWith(PROJECT_PREFIX)) return
    const projectId = projectIdFromFilter(projectFilter)
    if (!projectId) return
    if (!projects.some((project) => project.id === projectId)) setProjectFilter(ALL_PROJECTS)
  }, [projectFilter, projects])

  const selectedProjectId = projectIdFromFilter(projectFilter)
  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null
  const projectFilterLabel = selectedProject
    ? `${selectedProject.name} · ${selectedProject.workspacePath}`
    : t("archivedAllProjects")

  const groups = React.useMemo<ArchivedSessionGroup[]>(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]))
    const filteredSessions = sessions.filter((session) => {
      if (!session.archived) return false
      if (projectFilter === ALL_PROJECTS) return true
      return session.projectId === selectedProjectId
    }).sort((left, right) => sessionTimeValue(right) - sessionTimeValue(left))
    const grouped = new Map<string, ArchivedSessionGroup>()

    for (const session of filteredSessions) {
      const key = session.projectId ?? UNKNOWN_PROJECT_GROUP
      const project = session.projectId ? projectById.get(session.projectId) : null
      const group = grouped.get(key) ?? {
        key,
        projectId: session.projectId ?? null,
        name: session.projectId
          ? project?.name ?? t("archivedUnknownProject")
          : t("archivedUnknownProject"),
        workspacePath: project?.workspacePath ?? null,
        sessions: [],
      }
      group.sessions.push(session)
      grouped.set(key, group)
    }

    const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
    return Array.from(grouped.values()).sort((left, right) => {
      if (left.projectId === null) return 1
      if (right.projectId === null) return -1
      const leftOrder = projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.name.localeCompare(right.name, locale)
    })
  }, [locale, projectFilter, projects, selectedProjectId, sessions, t])

  const unarchiveSession = async (sessionId: string) => {
    if (!token || unarchivingIds.includes(sessionId)) return
    setUnarchivingIds((current) => [...current, sessionId])
    try {
      const response = await dashboardApi.bulkArchiveSessions(token, [sessionId], false)
      const unarchivedSession = response.sessions.find((session) => session.id === sessionId)
      if (!unarchivedSession || unarchivedSession.archived) {
        toast.error(t("archivedUnarchiveFailed"))
        return
      }
      onSessionUpdated(unarchivedSession)
      onWorkspaceRefresh()
      toast.success(t("archivedUnarchiveSuccess"), {
        action: {
          label: tActions("viewNow"),
          onClick: () => onOpenSession(sessionId),
        },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("archivedUnarchiveFailed"))
    } finally {
      setUnarchivingIds((current) => current.filter((id) => id !== sessionId))
    }
  }

  const unarchiveProject = async (projectId: string) => {
    if (!token || unarchivingProjectId) return
    setUnarchivingProjectId(projectId)
    try {
      const response = await dashboardApi.archiveProjectSessions(token, projectId, {
        archived: false,
        scope: "archived",
      })
      if (response.affected === 0 || response.sessions.some((session) => session.archived)) {
        toast.error(t("archivedUnarchiveAllFailed"))
        return
      }
      response.sessions.forEach(onSessionUpdated)
      onWorkspaceRefresh()
      toast.success(t("archivedUnarchiveAllSuccess"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("archivedUnarchiveAllFailed"))
    } finally {
      setUnarchivingProjectId(null)
    }
  }

  if (loading) return <LoadingState className="min-h-64" />

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("archivedSessions")}</h2>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-full sm:w-80" aria-label={t("archivedProjectFilter")}>
            <SelectValue>{projectFilterLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-80 max-h-[min(15rem,30vh)]">
            <SelectGroup>
              <SelectItem value={ALL_PROJECTS}>{t("archivedAllProjects")}</SelectItem>
              {projects.map((project) => (
                <SelectItem
                  key={project.id}
                  value={`${PROJECT_PREFIX}${project.id}`}
                  textValue={`${project.name} ${project.workspacePath}`}
                  className="items-start py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="max-w-full truncate">{project.name}</span>
                    <span className="max-w-full truncate code-mono text-xs text-muted-foreground">
                      {project.workspacePath}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {groups.length === 0 ? (
        <Empty className="min-h-64 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Archive /></EmptyMedia>
            <EmptyTitle>{t("archivedEmptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("archivedEmptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <SettingsSection
              key={group.key}
              contentClassName="p-0"
              title={
                <span className="flex min-w-0 items-start gap-2">
                  <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{group.name}</span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">
                        {t("archivedCount", { count: group.sessions.length })}
                      </span>
                    </span>
                    {group.workspacePath ? (
                      <span className="truncate code-mono text-xs font-normal text-muted-foreground">
                        {group.workspacePath}
                      </span>
                    ) : null}
                  </span>
                </span>
              }
              action={group.projectId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={unarchivingProjectId !== null}
                  onClick={() => void unarchiveProject(group.projectId!)}
                >
                  {unarchivingProjectId === group.projectId
                    ? <Spinner data-icon="inline-start" />
                    : <ArchiveRestore data-icon="inline-start" />}
                  {t("archivedUnarchiveAll")}
                </Button>
              ) : undefined}
            >
              {group.sessions.map((session, index) => {
                const time = sessionTime(session)
                const unarchiving = unarchivingIds.includes(session.id)
                return (
                  <React.Fragment key={session.id}>
                    {index > 0 ? <Separator /> : null}
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {session.title?.trim() || t("archivedUntitled")}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {time ? dateFormatter.format(new Date(time)) : t("archivedTimeUnavailable")}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={unarchiving || unarchivingProjectId !== null}
                        onClick={() => void unarchiveSession(session.id)}
                      >
                        {unarchiving
                          ? <Spinner data-icon="inline-start" />
                          : <ArchiveRestore data-icon="inline-start" />}
                        {t("archivedUnarchive")}
                      </Button>
                    </div>
                  </React.Fragment>
                )
              })}
            </SettingsSection>
          ))}
        </div>
      )}

    </div>
  )
}
