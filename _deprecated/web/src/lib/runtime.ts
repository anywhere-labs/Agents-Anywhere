// Display metadata for each agent runtime. Kept in one place so labels,
// accent colors, and the Add modal's selectable list never drift.
//
// "Is this agent on this device?" is no longer derived from the report —
// it's an explicit lookup against `DeviceAgentsState.attached`. So this
// file is purely presentation now.

import type { RuntimeReport } from "./api";

export type RuntimeMeta = {
  id: string;
  label: string;
  accentVar: string; // CSS custom property reference for the status dot
};

const RUNTIMES: Record<string, RuntimeMeta> = {
  codex: { id: "codex", label: "Codex", accentVar: "var(--agent-codex)" },
  claude: { id: "claude", label: "Claude Code", accentVar: "var(--agent-claude)" },
  opencode: { id: "opencode", label: "OpenCode", accentVar: "var(--agent-opencode)" },
  acp: { id: "acp", label: "ACP", accentVar: "var(--agent-cursor)" },
};

// Runtimes the daemon can actually drive end-to-end today. Add modal
// reads this to know what the user can pick.
export const SUPPORTED_RUNTIMES: RuntimeMeta[] = [RUNTIMES.codex!, RUNTIMES.claude!];

export function runtimeLabel(runtime: string | null | undefined): string {
  if (!runtime) return "Agent";
  return RUNTIMES[runtime]?.label ?? runtime;
}

export function runtimeAccent(runtime: string | null | undefined): string {
  if (!runtime) return "var(--agent-codex)";
  return RUNTIMES[runtime]?.accentVar ?? "var(--agent-codex)";
}

// Did the daemon find a usable binary for this attached agent? Drives the
// OK / `?` warning rendering in the Device → Agents row. (We attach even
// for failed-check reports so the user can see + Delete a broken agent.)
export function reportIsHealthy(report: RuntimeReport | undefined): boolean {
  return report?.execution === "ok";
}
