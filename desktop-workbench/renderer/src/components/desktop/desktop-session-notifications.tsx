"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import type { Notice } from "@/features/dashboard/types"
import type { SessionView } from "@/lib/demo-api"

type SessionNotificationKind = "approval" | "attention" | "completed"

export function DesktopSessionNotifications() {
  const t = useTranslations("desktopNotifications")
  const { session } = useAuth()
  const { sessions, openSession, page, activeSessionId } = useWorkspace()
  const previousSessionsRef = React.useRef<Map<string, SessionView>>(new Map())
  const initializedRef = React.useRef(false)
  // Sessions seen in `stopping` since their last active/paused state: the
  // completed notification uses it to say "interrupted" instead of "completed".
  const stoppedRef = React.useRef<Set<string>>(new Set())
  const statusRef = React.useRef<Map<string, SessionView["status"]>>(new Map())

  React.useEffect(() => {
    previousSessionsRef.current = new Map()
    initializedRef.current = false
    stoppedRef.current = new Set()
    statusRef.current = new Map()
  }, [session?.userId])

  // Track per-snapshot statuses in shared refs: `stopped` marks sessions that
  // passed through `stopping`, so the completed notification can distinguish
  // an interrupted turn from a normal completion.
  //
  // Best effort: snapshots arrive on dashboard invalidations, so a `stopping`
  // state that starts and ends between two snapshots is never observed and the
  // notification stays "completed".
  React.useEffect(() => {
    const stopped = stoppedRef.current
    const statusMap = statusRef.current
    for (const current of sessions) {
      const previousStatus = statusMap.get(current.id)
      statusMap.set(current.id, current.status)
      if (current.status === "stopping") {
        stopped.add(current.id)
      } else if (current.status === "idle" || current.status === "error") {
        // Turn over (interrupted/finished/failed): the stopping observation
        // stays for the completed check in the other effect and is cleared
        // once a new turn starts (below).
      } else if (previousStatus === undefined || previousStatus !== "stopping") {
        // First sight of the session, or a fresh turn (running/waiting/
        // pending) and paused states restart the tracking window. Clearing on
        // previousStatus === "stopping" is unnecessary: stopping itself already
        // (re)marks the set above.
        stopped.delete(current.id)
      }
    }
  }, [sessions])

  React.useEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.notifications) return
    const currentSessions = new Map(sessions.map((item) => [item.id, item]))

    if (!initializedRef.current) {
      previousSessionsRef.current = currentSessions
      initializedRef.current = true
      return
    }

    for (const current of sessions) {
      const previous = previousSessionsRef.current.get(current.id)
      if (!previous) continue
      // The user is looking at this session right now — no system notification.
      if (page === "session" && activeSessionId === current.id) continue
      const kind = notificationKind(previous, current)
      if (!kind) continue
      // approval is handled by useWaitingApprovalNotifications below, which
      // resolves the actual interaction notice (question prompt etc.).
      if (kind === "approval") continue
      const title = kind === "completed" && stoppedRef.current.has(current.id)
        ? t("interruptedTitle")
        : t(`${kind}Title`)
      void bridge.notifications.show({
        title,
        body: current.title?.trim() || t("untitledSession"),
        sessionId: current.id,
      })
    }

    previousSessionsRef.current = currentSessions
  }, [sessions, page, activeSessionId, t])

  React.useEffect(() => {
    const notifications = getDesktopWorkbenchBridge()?.notifications
    if (!notifications) return
    const unsubscribe = notifications.onClick(({ sessionId }) => {
      if (sessionId) openSession(sessionId)
    })
    return () => {
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [openSession])

  useWaitingApprovalNotifications(t)

  return null
}

/**
 * DSH "ask user question" prompts arrive as `runtime.notice.updated` events on
 * the per-session WebSocket, which is only subscribed while the session page is
 * open. The runtime flips the session into `waiting_approval` in the same
 * ingest batch, so the sessions list does see the transition — but the generic
 * approval notification alone would miss the question's actual title/message.
 *
 * When a not-open session enters `waiting_approval`, probe the runtime notices
 * REST endpoint once: an open interaction notice (a question, or any other
 * interaction) is announced with its own title and message; if the probe fails
 * or lists none, fall back to the generic approval notification so the user is
 * still woken up. One notification per waiting_approval episode.
 */
function useWaitingApprovalNotifications(
  t: ReturnType<typeof useTranslations<"desktopNotifications">>,
) {
  const { session } = useAuth()
  const { sessions, page, activeSessionId } = useWorkspace()
  const notifiedRef = React.useRef<Set<string>>(new Set())
  const inFlightRef = React.useRef<Set<string>>(new Set())
  const initializedRef = React.useRef(false)
  const tokenRef = React.useRef(session?.accessToken ?? null)
  tokenRef.current = session?.accessToken ?? null

  React.useEffect(() => {
    notifiedRef.current = new Set()
    inFlightRef.current = new Set()
    initializedRef.current = false
  }, [session?.userId])

  React.useEffect(() => {
    if (!getDesktopWorkbenchBridge()?.notifications) return
    const notified = notifiedRef.current
    const inFlight = inFlightRef.current

    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }

    for (const current of sessions) {
      if (current.status !== "waiting_approval") {
        notified.delete(current.id)
        continue
      }
      if (page === "session" && activeSessionId === current.id) continue
      if (notified.has(current.id) || inFlight.has(current.id)) continue
      inFlight.add(current.id)
      void probeWaitingSession(tokenRef.current, current, inFlight, notified, t)
    }
    // Status history (statusRef) and the stopping marks (stoppedRef) live in
    // the component scope and are updated by their own per-snapshot effect.
  }, [sessions, page, activeSessionId, t])
}

async function probeWaitingSession(
  token: string | null,
  sessionView: SessionView,
  inFlight: Set<string>,
  notified: Set<string>,
  t: ReturnType<typeof useTranslations<"desktopNotifications">>,
): Promise<void> {
  const notifications = getDesktopWorkbenchBridge()?.notifications
  const sessionId = sessionView.id
  try {
    if (!notifications) return
    const fallbackTitle = t("approvalTitle")
    const fallbackBody = sessionView.title?.trim() || t("untitledSession")
    let title = fallbackTitle
    let body = fallbackBody
    try {
      if (token) {
        const response = await dashboardApi.listSessionRuntimeNotices(token, sessionId)
        const interaction = findOpenInteraction(response.notices)
        if (interaction) {
          title = interaction.title?.trim() || fallbackTitle
          body = interaction.message?.trim() || fallbackBody
        }
      }
    } catch {
      // Keep the generic fallback when the runtime does not answer the probe.
    }
    void notifications.show({ title, body, sessionId })
  } finally {
    inFlight.delete(sessionId)
    // The episode stays notified even if show() failed: the user was not
    // watching, and retrying until they react would risk notification spam.
    notified.add(sessionId)
  }
}

function findOpenInteraction(notices: Notice[]): Notice | null {
  let fallback: Notice | null = null
  for (const notice of notices) {
    if (notice.status !== "open") continue
    if (notice.interactionType === "input_request") return notice
    if (!fallback && notice.type === "interaction") fallback = notice
  }
  return fallback
}

function notificationKind(
  previous: SessionView,
  current: SessionView,
): SessionNotificationKind | null {
  if (current.status === "waiting_approval" && previous.status !== "waiting_approval") {
    return "approval"
  }
  if (
    (current.status === "error" || current.status === "blocked") &&
    (previous.status !== current.status || (!previous.unread && current.unread))
  ) {
    return "attention"
  }
  if (
    current.status === "idle" &&
    (sessionStatusIsBusy(previous.status) ||
      current.latestTurnEndSeq > previous.latestTurnEndSeq) &&
    current.unread
  ) {
    return "completed"
  }
  return null
}

function sessionStatusIsBusy(status: SessionView["status"]): boolean {
  return (
    status === "running" ||
    status === "waiting" ||
    status === "pending" ||
    status === "stopping"
  )
}
