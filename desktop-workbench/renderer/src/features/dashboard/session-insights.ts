/**
 * Detailed AI-call insights carried on `SessionRuntimeState.metadata.insights`
 * (DSH bridge contract 1.x, additive). Every member is independently optional
 * and absent when the owning runtime unit is not mounted. Readers must treat
 * the whole object as best-effort display data.
 */

export type SessionInsightTokenUsage = {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type SessionInsightContextPressure = {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
};

export type SessionInsightSessionStats = {
  turns?: number;
  steps?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  ttftSteps?: number;
  decodeMs?: number;
  decodeTokens?: number;
};

export type SessionInsightGoal = {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionInsightTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type SessionInsightSubagent = {
  id: string;
  createdAt: number;
  mode: "one-shot" | "continuable" | "unknown";
  label?: string;
};

export type SessionInsights = {
  tokenUsage?: SessionInsightTokenUsage;
  contextPressure?: SessionInsightContextPressure;
  sessionStats?: SessionInsightSessionStats;
  goal?: SessionInsightGoal | null;
  todos?: SessionInsightTodo[] | null;
  subagentCatalog?: SessionInsightSubagent[];
};

/** Exact per-turn token accounting attached to a finished turn. */
export type TurnUsage = {
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

export function readSessionInsights(
  metadata: Record<string, unknown> | undefined | null,
): SessionInsights | null {
  const raw = metadata?.insights;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SessionInsights;
}

/** Provider-visible total: everything the model was billed to read or write. */
export function insightTotalTokens(usage: SessionInsightTokenUsage): number {
  return (
    (usage.uncachedInputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/** Share of prompt tokens served from cache, mirroring the DSH status bar. */
export function insightCacheHitPercent(usage: SessionInsightTokenUsage): number | null {
  const prompt =
    (usage.uncachedInputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  if (prompt <= 0) return null;
  return ((usage.cacheReadTokens ?? 0) / prompt) * 100;
}

/** Decode throughput in tokens per second, when both figures are known. */
export function insightDecodeTokensPerSecond(
  stats: SessionInsightSessionStats,
): number | null {
  const tokens = stats.decodeTokens ?? 0;
  const ms = stats.decodeMs ?? 0;
  if (tokens <= 0 || ms <= 0) return null;
  return tokens / (ms / 1000);
}

/** Context occupancy fraction of the newest known window. */
export function insightContextPercent(
  pressure: SessionInsightContextPressure,
): number | null {
  const used = pressure.projectedTokens ?? pressure.pressureTokens;
  const window = pressure.contextWindow;
  if (!used || !window || window <= 0) return null;
  return (used / window) * 100;
}

/** Compact display: 1234 -> "1.2K", 17_900_000 -> "17.9M". */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000_000) return `${trimOne(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimOne(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimOne(value / 1_000)}K`;
  return String(Math.round(value));
}

function trimOne(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}
