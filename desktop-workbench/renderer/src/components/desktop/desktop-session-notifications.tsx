"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import type { SessionView } from "@/lib/demo-api"

type SessionNotificationKind = "approval" | "attention" | "completed"

export function DesktopSessionNotifications() {
  const t = useTranslations("desktopNotifications")
  const { session } = useAuth()
  const { sessions, openSession } = useWorkspace()
  const previousSessionsRef = React.useRef<Map<string, SessionView>>(new Map())
  const initializedRef = React.useRef(false)

  React.useEffect(() => {
    previousSessionsRef.current = new Map()
    initializedRef.current = false
  }, [session?.userId])

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
      const kind = notificationKind(previous, current)
      if (!kind) continue
      void bridge.notifications.show({
        title: t(`${kind}Title`),
        body: current.title?.trim() || t("untitledSession"),
        sessionId: current.id,
      })
    }

    previousSessionsRef.current = currentSessions
  }, [sessions, t])

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

  return null
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
