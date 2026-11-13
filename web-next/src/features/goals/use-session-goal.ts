"use client";
import * as React from "react";
import { apiClient, isApiError } from "@/lib/api";
import { useTranslations } from "next-intl";
import type { GoalState } from "@/generated/protocol/v1_1/goal-state";
import type { GoalRequest } from "@/generated/protocol/v1_1/goal-request";
import type { GoalResponse } from "@/generated/protocol/v1_1/goal-response";
export type { GoalState };
type Visit = { sessionId: string; token: string };
export function useSessionGoal(
  token: string,
  sessionId: string,
  canControl = true,
  enabled = true,
) {
  const t = useTranslations("goal");
  const visit = React.useRef<Visit>({ token, sessionId });
  if (visit.current.token !== token || visit.current.sessionId !== sessionId)
    visit.current = { token, sessionId };
  const [projection, setProjection] = React.useState<{
    visit: Visit;
    state: GoalState;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [replacement, setReplacement] = React.useState<{
    objective: string;
    resolve: (yes: boolean) => void;
  } | null>(null);
  const active = React.useRef<{ visit: Visit; id: string } | null>(null);
  const latest = React.useRef<GoalState | null>(null);
  const state = projection?.visit === visit.current ? projection.state : null;
  latest.current = state;
  const path = `/sessions/${encodeURIComponent(sessionId)}/goal`;
  const ingest = React.useCallback((next: GoalState) => {
    if (next.sessionId !== visit.current.sessionId) return;
    const current = visit.current;
    setProjection((old) =>
      old?.visit === current && (old.state.revision ?? 0) > (next.revision ?? 0)
        ? old
        : { visit: current, state: next },
    );
  }, []);
  const refresh = React.useCallback(async () => {
    const current = visit.current;
    const next = await apiClient.get<GoalState>(path, { token });
    if (current === visit.current) {
      ingest(next);
      if (next.freshness === "fresh")
        setError((old) => (old === t("stateUnavailable") ? null : old));
      if (next.pendingOperationId && !active.current) {
        active.current = { visit: current, id: next.pendingOperationId };
        setBusy(true);
      }
    }
    return next;
  }, [path, token, ingest, t]);
  React.useEffect(() => {
    let cancelled = false;
    const current = visit.current;
    setBusy(false);
    setError(null);
    active.current = null;
    setReplacement((old) => {
      old?.resolve(false);
      return null;
    });
    // A session still being created exists only on this client; the Server has no goal state for it yet.
    if (!enabled) return;
    const tick = async () => {
      if (cancelled) return;
      try {
        const operation = active.current;
        if (operation?.visit === current) {
          const result = await apiClient.get<GoalResponse>(
            `${path}/operations/${operation.id}`,
            { token },
          );
          if (cancelled || visit.current !== current) return;
          if (result.state) ingest(result.state);
          if (result.outcome === "applied" || result.outcome === "rejected") {
            active.current = null;
            setBusy(false);
            setError(result.ok ? null : result.message || t("operationFailed"));
          }
        }
        await refresh();
      } catch {
        if (!cancelled && visit.current === current)
          setError(t("stateUnavailable"));
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, token, refresh, ingest, t, enabled]);
  const execute = async (
    action: GoalRequest["action"],
    objective?: string,
    attachments: GoalRequest["attachments"] = [],
  ) => {
    const current = visit.current,
      snapshot = latest.current;
    if (!canControl || active.current) return false;
    if (
      !snapshot ||
      snapshot.freshness !== "fresh" ||
      !snapshot.capabilities?.actions?.includes(action)
    ) {
      setError(t("stateUnavailable"));
      return false;
    }
    const operation = { visit: current, id: crypto.randomUUID() };
    active.current = operation;
    setBusy(true);
    setError(null);
    try {
      let result = await apiClient.post<GoalResponse>(
        path,
        {
          action,
          objective,
          attachments,
          operationId: operation.id,
          expectedRevision: snapshot.revision,
        },
        { token },
      );
      for (
        let i = 0;
        i < 10 &&
        (result.outcome === "unknown" || result.outcome === "pending");
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (visit.current !== current) return false;
        result = await apiClient.get<GoalResponse>(
          `${path}/operations/${operation.id}`,
          { token },
        );
      }
      if (visit.current !== current) return false;
      if (result.state) ingest(result.state);
      if (result.outcome === "unknown" || result.outcome === "pending") {
        setError(t("operationUnknown"));
        return false;
      }
      active.current = null;
      setBusy(false);
      if (!result.ok) setError(result.message || t("operationFailed"));
      return result.ok;
    } catch (error) {
      if (visit.current === current) {
        if (isApiError(error) && error.status >= 400 && error.status < 500) {
          active.current = null;
          setBusy(false);
          setError(t("operationFailed"));
        } else setError(t("operationUnknown"));
        void refresh().catch(() => undefined);
      }
      return false;
    }
  };
  const set = async (
    objective: string,
    attachments: GoalRequest["attachments"] = [],
  ) => {
    if (latest.current?.goal) {
      const confirmed = await new Promise<boolean>((resolve) =>
        setReplacement({ objective, resolve }),
      );
      if (!confirmed) return false;
    }
    return execute("set", objective, attachments);
  };
  const resolveReplacement = (yes: boolean) => {
    replacement?.resolve(yes);
    setReplacement(null);
  };
  return {
    state:
      state && !canControl
        ? { ...state, capabilities: { ...state.capabilities, actions: [] } }
        : state,
    busy,
    error,
    ingest,
    refresh,
    execute,
    set,
    replacement,
    resolveReplacement,
  };
}
