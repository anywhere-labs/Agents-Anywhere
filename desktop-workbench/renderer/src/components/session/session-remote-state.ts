import { dashboardApi } from "@/features/dashboard/api"
import type {
  Notice,
  ProtocolCapabilitySet,
  ProtocolEventEnvelope,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  RuntimeStatusValue,
  SessionSnapshotResponse,
  SessionRuntimeState,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import type { SessionRemoteState } from "./session-state-cache"
import { mergeTimelineItems, mergeTimelineSnapshot } from "./optimistic-timeline"
import { mergeEffectiveCapabilities, stableStringify } from "./session-event-state"
import { nextTimelineResetVersion } from "./session-review-history"

export const INITIAL_TIMELINE_LIMIT = 100

export async function loadInitialSessionState(
  token: string,
  sessionId: string,
  options: { reason?: string } = {},
): Promise<SessionRemoteState> {
  const reason = options.reason ?? "session-detail.initial-load"
  const snapshot = await dashboardApi.getSessionSnapshot(token, sessionId, INITIAL_TIMELINE_LIMIT, {
    reason,
  })
  const state = sessionStateFromSnapshot(snapshot)
  console.info("[session_status_trace]", {
    layer: "frontend-snapshot",
    reason,
    sessionId,
    sessionStatus: state.session.status,
    runtimeStatus: state.state?.status ?? null,
    effectiveStatus: effectiveRuntimeStatus(state.state, state.session),
    sessionUpdatedSeq: state.session.updatedSeq,
    runtimeUpdatedSeq: state.state?.updatedSeq ?? null,
    runtimeSource: state.state?.metadata?.source ?? null,
    eventCursor: state.eventCursor,
  })
  return state
}

function sessionStateFromSnapshot(snapshot: SessionSnapshotResponse): SessionRemoteState {
  return {
    session: snapshot.session,
    state: snapshot.state ?? null,
    items: mergeTimelineItems([], snapshot.timeline.items),
    notices: snapshot.notices,
    nextSeq: snapshot.timeline.nextSeq,
    hasMore: snapshot.timeline.hasMore,
    timelineResetVersion: 0,
    serverTime: snapshot.serverTime,
    eventCursor: snapshot.eventCursor,
    effectiveCapabilities: snapshot.effectiveCapabilities,
    catalogs: snapshot.catalogs ?? {},
  }
}

export function mergeSessionSnapshot(current: SessionRemoteState, incoming: SessionRemoteState): SessionRemoteState {
  const timeline = mergeTimelineSnapshot(current.items, current.nextSeq, incoming.items, incoming.nextSeq)
  return {
    ...incoming,
    items: timeline.items,
    nextSeq: timeline.nextSeq,
    timelineResetVersion: nextTimelineResetVersion(current.timelineResetVersion, true),
    eventCursor: incoming.nextSeq >= current.nextSeq ? incoming.eventCursor : current.eventCursor,
  }
}

export function mergeSessionEvent(
  current: SessionRemoteState | null,
  event: ProtocolEventEnvelope,
): SessionRemoteState | null {
  if (!current) return current

  const session = event.type === "session.meta.updated" ? readPayloadValue<SessionView>(event.payload.session) : null
  const runtimeState =
    event.type === "runtime.state.updated" ? readPayloadValue<SessionRuntimeState>(event.payload.state) : null
  const item =
    event.type === "timeline.item_created" || event.type === "timeline.item_updated"
      ? readPayloadValue<TimelineItem>(event.payload.item)
      : null
  const timelineSnapshot =
    event.type === "timeline.snapshot" && Array.isArray(event.payload.items)
      ? event.payload.items.filter(isTimelineItem)
      : null
  const notice = event.type === "runtime.notice.updated" ? readPayloadValue<Notice>(event.payload.notice) : null
  const noticeSnapshot =
    event.type === "runtime.notice.snapshot" && Array.isArray(event.payload.notices)
      ? event.payload.notices.filter(isNotice)
      : null
  const capabilitySet =
    event.type === "runtime.capability.updated"
      ? readPayloadValue<ProtocolCapabilitySet>(event.payload.capabilitySet)
      : null
  const catalogUpdate = event.type === "runtime.catalog.updated" ? catalogUpdateFromEvent(event) : null

  const nextNotices = noticeSnapshot
    ? noticeSnapshot
    : notice
      ? mergeNotices(current.notices, [notice])
      : current.notices
  const nextItems = timelineSnapshot
    ? mergeTimelineSnapshot(current.items, current.nextSeq, timelineSnapshot, event.sequence).items
    : item
      ? mergeTimelineItems(current.items, [item])
      : current.items
  const timelineResetVersion = nextTimelineResetVersion(current.timelineResetVersion, timelineSnapshot !== null)
  const acceptsSession = Boolean(session && session.updatedSeq >= current.session.updatedSeq)
  const nextSession =
    acceptsSession && session && !sessionSemanticallyEqual(current.session, session) ? session : current.session
  const acceptsRuntimeState = Boolean(
    runtimeState &&
    runtimeState.sessionId === current.session.id &&
    runtimeState.updatedSeq >= (current.state?.updatedSeq ?? 0),
  )
  if (session || runtimeState) {
    console.info("[session_status_trace]", {
      layer: "frontend-event",
      sessionId: event.sessionId,
      eventType: event.type,
      eventId: event.eventId,
      eventSequence: event.sequence,
      currentSessionStatus: current.session.status,
      incomingSessionStatus: session?.status ?? null,
      currentRuntimeStatus: current.state?.status ?? null,
      incomingRuntimeStatus: runtimeState?.status ?? null,
      incomingRuntimeSource: runtimeState?.metadata?.source ?? null,
      currentSessionUpdatedSeq: current.session.updatedSeq,
      incomingSessionUpdatedSeq: session?.updatedSeq ?? null,
      currentRuntimeUpdatedSeq: current.state?.updatedSeq ?? null,
      incomingRuntimeUpdatedSeq: runtimeState?.updatedSeq ?? null,
      acceptsSession,
      acceptsRuntimeState,
    })
  }
  const nextRuntimeState = mergeRuntimeState(current.state, runtimeState, current.session.id)
  const nextEffectiveCapabilities = mergeEffectiveCapabilities(current.effectiveCapabilities, capabilitySet)
  const nextCatalogs =
    catalogUpdate && !catalogsSemanticallyEqual(current.catalogs[catalogUpdate.catalogType], catalogUpdate.catalog)
      ? {
          ...current.catalogs,
          [catalogUpdate.catalogType]: catalogUpdate.catalog,
        }
      : current.catalogs
  const nextSeq = Math.max(current.nextSeq, event.sequence)
  const nextEventCursor = event.sequence >= current.nextSeq ? event.cursor : current.eventCursor

  if (
    nextSession === current.session &&
    nextRuntimeState === current.state &&
    nextItems === current.items &&
    nextNotices === current.notices &&
    nextEffectiveCapabilities === current.effectiveCapabilities &&
    nextCatalogs === current.catalogs &&
    nextSeq === current.nextSeq &&
    timelineResetVersion === current.timelineResetVersion &&
    nextEventCursor === current.eventCursor
  ) {
    return current
  }

  return {
    ...current,
    session: nextSession,
    state: nextRuntimeState,
    items: nextItems,
    notices: nextNotices,
    nextSeq,
    timelineResetVersion,
    eventCursor: nextEventCursor,
    effectiveCapabilities: nextEffectiveCapabilities,
    catalogs: nextCatalogs,
    serverTime: event.emittedAt ?? current.serverTime,
  }
}

export function sessionEventCanUpdateState(event: ProtocolEventEnvelope): boolean {
  return (
    event.type === "session.meta.updated" ||
    event.type === "runtime.state.updated" ||
    event.type === "runtime.capability.updated" ||
    event.type === "runtime.catalog.updated" ||
    event.type === "runtime.notice.updated" ||
    event.type === "runtime.notice.snapshot" ||
    event.type === "timeline.item_created" ||
    event.type === "timeline.item_updated" ||
    event.type === "timeline.snapshot"
  )
}

function catalogUpdateFromEvent(
  event: ProtocolEventEnvelope,
):
  | { catalogType: "model"; catalog: ProtocolModelCatalog }
  | { catalogType: "permission"; catalog: ProtocolPermissionCatalog }
  | null {
  if (event.payload.catalogType === "model") {
    const catalog = readPayloadValue<ProtocolModelCatalog>(event.payload.catalog)
    return catalog ? { catalogType: "model", catalog } : null
  }
  if (event.payload.catalogType === "permission") {
    const catalog = readPayloadValue<ProtocolPermissionCatalog>(event.payload.catalog)
    return catalog ? { catalogType: "permission", catalog } : null
  }
  return null
}

function catalogsSemanticallyEqual(left: unknown, right: ProtocolModelCatalog | ProtocolPermissionCatalog): boolean {
  if (!left) return false
  return stableStringify(left) === stableStringify(right)
}

function sessionSemanticallyEqual(left: SessionView, right: SessionView): boolean {
  return (
    stableStringify({
      id: left.id,
      connectorId: left.connectorId,
      connectorStatus: left.connectorStatus,
      runtime: left.runtime,
      externalSessionId: left.externalSessionId,
      title: left.title,
      cwd: left.cwd,
      status: left.status,
      takeover: left.takeover,
      pinned: left.pinned,
      pinnedAt: left.pinnedAt,
      archived: left.archived,
      archivedAt: left.archivedAt,
      unread: left.unread,
      lastReadSeq: left.lastReadSeq,
      lastSyncedAt: left.lastSyncedAt,
      sourceObservedAt: left.sourceObservedAt,
      lastActivityAt: left.lastActivityAt,
      lastItemAt: left.lastItemAt,
      lastItemOrderSeq: left.lastItemOrderSeq,
      sortAt: left.sortAt,
      effectiveRunMode: left.effectiveRunMode,
      runtimeSettings: left.runtimeSettings,
      runtimeSettingsOverride: left.runtimeSettingsOverride,
    }) ===
    stableStringify({
      id: right.id,
      connectorId: right.connectorId,
      connectorStatus: right.connectorStatus,
      runtime: right.runtime,
      externalSessionId: right.externalSessionId,
      title: right.title,
      cwd: right.cwd,
      status: right.status,
      takeover: right.takeover,
      pinned: right.pinned,
      pinnedAt: right.pinnedAt,
      archived: right.archived,
      archivedAt: right.archivedAt,
      unread: right.unread,
      lastReadSeq: right.lastReadSeq,
      lastSyncedAt: right.lastSyncedAt,
      sourceObservedAt: right.sourceObservedAt,
      lastActivityAt: right.lastActivityAt,
      lastItemAt: right.lastItemAt,
      lastItemOrderSeq: right.lastItemOrderSeq,
      sortAt: right.sortAt,
      effectiveRunMode: right.effectiveRunMode,
      runtimeSettings: right.runtimeSettings,
      runtimeSettingsOverride: right.runtimeSettingsOverride,
    })
  )
}

export function mergeRuntimeState(
  current: SessionRuntimeState | null | undefined,
  incoming: SessionRuntimeState | null | undefined,
  sessionId: string,
): SessionRuntimeState | null | undefined {
  if (!incoming || incoming.sessionId !== sessionId || incoming.updatedSeq < (current?.updatedSeq ?? 0)) {
    return current
  }
  // Even identical facts must advance the version watermark. Otherwise a
  // later, older observation could replace them with different facts.
  return current && incoming.updatedSeq === current.updatedSeq && runtimeStatesSemanticallyEqual(current, incoming)
    ? current
    : incoming
}

function runtimeStatesSemanticallyEqual(left: SessionRuntimeState | null, right: SessionRuntimeState): boolean {
  if (!left) return false
  return (
    stableStringify({
      sessionId: left.sessionId,
      runtime: left.runtime,
      externalSessionId: left.externalSessionId,
      status: left.status,
      selections: left.selections,
      statusReason: left.statusReason,
      error: left.error,
    }) ===
    stableStringify({
      sessionId: right.sessionId,
      runtime: right.runtime,
      externalSessionId: right.externalSessionId,
      status: right.status,
      selections: right.selections,
      statusReason: right.statusReason,
      error: right.error,
    })
  )
}

export function effectiveRuntimeStatus(
  runtimeState: SessionRuntimeState | null | undefined,
  session: SessionView | null | undefined,
): RuntimeStatusValue {
  if (runtimeState) return runtimeState.status
  if (session?.connectorStatus === "offline") return "disconnected"
  return session?.status ?? "idle"
}

function mergeNotices(current: Notice[], incoming: Notice[]): Notice[] {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((notice) => [notice.noticeId, notice]))
  for (const notice of incoming) {
    const existing = byId.get(notice.noticeId)
    if (!existing || existing.updatedSeq <= notice.updatedSeq) byId.set(notice.noticeId, notice)
  }
  return Array.from(byId.values()).sort((a, b) => a.updatedSeq - b.updatedSeq || a.noticeId.localeCompare(b.noticeId))
}

export function parseProtocolEvent(data: string): ProtocolEventEnvelope | null {
  try {
    const event = JSON.parse(data) as Partial<ProtocolEventEnvelope>
    if (!event || typeof event.type !== "string") return null
    if (event.type === "keepalive") return null
    if (
      event.protocolVersion !== "1.0" ||
      typeof event.eventId !== "string" ||
      typeof event.emittedAt !== "string" ||
      typeof event.sessionId !== "string" ||
      typeof event.sequence !== "number" ||
      typeof event.cursor !== "string"
    ) {
      return null
    }
    return {
      protocolVersion: event.protocolVersion,
      eventId: event.eventId,
      sequence: event.sequence,
      cursor: event.cursor,
      type: event.type,
      sessionId: event.sessionId,
      emittedAt: event.emittedAt,
      payload: event.payload ?? {},
    }
  } catch {
    return null
  }
}

export function cursorSequence(cursor: string | null | undefined): number {
  if (!cursor) return 0
  const raw = cursor.startsWith("seq:") ? cursor.slice(4) : cursor
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

export function readPayloadValue<T>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null
}

export function isTimelineItem(value: unknown): value is TimelineItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<TimelineItem>
  return typeof item.id === "string" && typeof item.updatedSeq === "number"
}

function isNotice(value: unknown): value is Notice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const notice = value as Partial<Notice>
  return typeof notice.noticeId === "string" && typeof notice.updatedSeq === "number"
}
