"use client"

import * as React from "react"
import { Archive, ArchiveRestore, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
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
import { logArchiveDebug } from "@/lib/archive-debug"

const ALL_PROJECTS = "all"
const STANDALONE_SESSIONS = "standalone"
const PROJECT_PREFIX = "project:"

type ArchivedSessionGroup = {
  key: string
  projectId: string | null
  name: string
  workspacePath: string | null
  sessions: SessionView[]
}

type ArchivedSessionsTabProps = {
  token: string
  projects: ProjectView[]
  onOpenSession: (sessionId: string) => void
  onSessionUpdated: (session: SessionView) => void
  onWorkspaceRefresh: () => void
}

function sessionTime(session: SessionView): string | null {
  return session.archivedAt ?? session.sortAt ?? session.lastActivityAt ?? session.lastItemAt
}

function sessionTimeValue(session: SessionView): number {
  const value = sessionTime(session)
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function mergeSessions(current: SessionView[], incoming: SessionView[]): SessionView[] {
  const merged = new Map(current.map((session) => [session.id, session]))
  incoming.forEach((session) => merged.set(session.id, session))
  return Array.from(merged.values()).sort((left, right) => sessionTimeValue(right) - sessionTimeValue(left))
}

export function ArchivedSessionsTab({
  token,
  projects,
  onOpenSession,
  onSessionUpdated,
  onWorkspaceRefresh,
}: ArchivedSessionsTabProps) {
  const t = useTranslations("pages.settings")
  const tActions = useTranslations("dashboard.actions")
  const locale = useLocale()
  const requestIdRef = React.useRef(0)
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [projectFilter, setProjectFilter] = React.useState(ALL_PROJECTS)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
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

  const loadInitial = React.useCallback(async () => {
    const requestId = ++requestIdRef.current
    logArchiveDebug("settings.archived.load.start", { requestId })
    if (!token) {
      setSessions([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await dashboardApi.listSessions(token, { archived: true, limit: 100 })
      logArchiveDebug("settings.archived.load.response", {
        requestId,
        sessionCount: response.sessions.length,
        sessionIds: response.sessions.map((session) => session.id),
        archivedStates: response.sessions.map((session) => ({
          id: session.id,
          archived: session.archived,
          userArchived: session.userArchived,
          projectId: session.projectId ?? null,
        })),
      })
      if (requestId !== requestIdRef.current) return
      setSessions(mergeSessions([], response.sessions))
      setHasMore(response.hasMore)
      setNextCursor(response.nextCursor)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : t("archivedLoadFailed"))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [t, token])

  React.useEffect(() => {
    void loadInitial()
    return () => {
      requestIdRef.current += 1
    }
  }, [loadInitial])

  React.useEffect(() => {
    if (!projectFilter.startsWith(PROJECT_PREFIX)) return
    const projectId = projectFilter.slice(PROJECT_PREFIX.length)
    if (!projects.some((project) => project.id === projectId)) setProjectFilter(ALL_PROJECTS)
  }, [projectFilter, projects])

  const selectedProject = projectFilter.startsWith(PROJECT_PREFIX)
    ? projects.find((project) => project.id === projectFilter.slice(PROJECT_PREFIX.length)) ?? null
    : null
  const projectFilterLabel = selectedProject
    ? `${selectedProject.name} · ${selectedProject.workspacePath}`
    : projectFilter === STANDALONE_SESSIONS
      ? t("archivedStandaloneSessions")
      : t("archivedAllProjects")

  const groups = React.useMemo<ArchivedSessionGroup[]>(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]))
    const filteredSessions = sessions.filter((session) => {
      if (projectFilter === ALL_PROJECTS) return true
      if (projectFilter === STANDALONE_SESSIONS) return !session.projectId
      return session.projectId === projectFilter.slice(PROJECT_PREFIX.length)
    })
    const grouped = new Map<string, ArchivedSessionGroup>()

    for (const session of filteredSessions) {
      const key = session.projectId ?? STANDALONE_SESSIONS
      const project = session.projectId ? projectById.get(session.projectId) : null
      const group = grouped.get(key) ?? {
        key,
        projectId: session.projectId ?? null,
        name: session.projectId
          ? project?.name ?? t("archivedUnknownProject")
          : t("archivedStandaloneSessions"),
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
  }, [locale, projectFilter, projects, sessions, t])

  const loadMore = async () => {
    if (!token || !hasMore || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const response = await dashboardApi.listSessions(token, {
        archived: true,
        limit: 100,
        cursor: nextCursor,
      })
      setSessions((current) => mergeSessions(current, response.sessions))
      setHasMore(response.hasMore)
      setNextCursor(response.nextCursor)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("archivedLoadFailed"))
    } finally {
      setLoadingMore(false)
    }
  }

  const unarchiveSession = async (sessionId: string) => {
    if (!token || unarchivingIds.includes(sessionId)) return
    setUnarchivingIds((current) => [...current, sessionId])
    try {
      const response = await dashboardApi.bulkArchiveSessions(token, [sessionId], false)
      logArchiveDebug("settings.archived.unarchive-session.response", {
        sessionId,
        affected: response.sessions.length,
        sessions: response.sessions.map((session) => ({
          id: session.id,
          archived: session.archived,
          userArchived: session.userArchived,
          projectId: session.projectId ?? null,
        })),
      })
      const unarchivedSession = response.sessions.find((session) => session.id === sessionId)
      if (!unarchivedSession) {
        toast.error(t("archivedUnarchiveFailed"))
        return
      }
      onSessionUpdated(unarchivedSession)
      setSessions((current) => current.filter((session) => session.id !== sessionId))
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
      logArchiveDebug("settings.archived.unarchive-project.response", {
        projectId,
        affected: response.affected,
        sessions: response.sessions.map((session) => ({
          id: session.id,
          archived: session.archived,
          userArchived: session.userArchived,
          projectId: session.projectId ?? null,
        })),
      })
      setSessions((current) => current.filter((session) => session.projectId !== projectId))
      onWorkspaceRefresh()
      toast.success(t("archivedUnarchiveAllSuccess"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("archivedUnarchiveAllFailed"))
    } finally {
      setUnarchivingProjectId(null)
    }
  }

  if (loading) return <LoadingState className="min-h-64" />

  if (error) {
    return (
      <Empty className="min-h-64 border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Archive /></EmptyMedia>
          <EmptyTitle>{t("archivedLoadFailed")}</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" onClick={() => void loadInitial()}>
            {t("archivedRetry")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("archivedSessions")}</h2>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-full sm:w-80" aria-label={t("archivedProjectFilter")}>
            <SelectValue>{projectFilterLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-80">
            <SelectGroup>
              <SelectItem value={ALL_PROJECTS}>{t("archivedAllProjects")}</SelectItem>
              <SelectItem value={STANDALONE_SESSIONS}>{t("archivedStandaloneSessions")}</SelectItem>
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
            <Card key={group.key} size="sm" className="gap-0 py-0">
              <CardHeader className="border-b py-4">
                <CardTitle className="flex min-w-0 items-start gap-2">
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
                </CardTitle>
                {group.projectId ? (
                  <CardAction>
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
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent className="p-0">
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <Spinner data-icon="inline-start" /> : null}
            {loadingMore ? t("archivedLoadingMore") : t("archivedLoadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
