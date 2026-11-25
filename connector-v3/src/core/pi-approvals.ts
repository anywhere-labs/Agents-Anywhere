// Approvals for Pi. Pi asks no one before it edits files or runs commands, by design, and neither does its ACP
// adapter; AA adds that with a small Pi extension, installed globally (`~/.pi/agent/extensions/`) when the user turns
// approvals on in Pi's agent settings and removed when they turn it off (`runtime/pi-approvals.ts`).
//
// The extension does nothing in a Pi that AA did not start (the user's own terminal, another app). AA starts Pi with
// `AA_APPROVALS_FILE`: a small JSON file with the mode of each session of that process
// (`{"default":"ask","modes":{"<session id>":"full_access"}}`; Pi's session id is its ACP session id, too), which the
// extension reads before every tool call, so a mode can change while Pi runs. A call that needs approval is confirmed
// through Pi's extension UI, which pi-acp turns into an ACP permission request about a tool call it makes up;
// `piApprovalRequest` points it back at the call it is about, so AA asks about that one, with all of it on the card.
//
// The mode is a conversation setting like the model (`aa_approvals`, in the composer's permission chip): the Connector
// adds it to the agent's own settings and keeps it itself; Pi never sees it as one.
//
// Portable: no Node built-ins. The runtime writes the files.

import type { AcpRequestPermissionParams, AcpToolCallUpdate } from "./acp-protocol.js";
import type { ConfigOption } from "./timeline.js";

export const PI_APPROVAL_MODES = ["ask", "accept_edits", "full_access"] as const;
export type PiApprovalMode = (typeof PI_APPROVAL_MODES)[number];

/** The conversation setting's id. */
export const PI_APPROVALS_CONFIG_ID = "aa_approvals";
/** A new conversation's mode when the agent's newest conversation had none (approvals were just turned on). */
export const DEFAULT_PI_APPROVAL_MODE: PiApprovalMode = "ask";
/** The environment variable naming the mode file. */
export const PI_APPROVALS_ENV = "AA_APPROVALS_FILE";
/** The extension's file name in Pi's global extensions folder. */
export const PI_APPROVALS_EXTENSION_FILE = "agents-anywhere-approvals.js";
/** Marks the extension's confirmations (a key of the JSON it passes as the dialog's message). */
const PI_APPROVAL_KEY = "agents_anywhere_approval";
/** First line of the extension: a file that does not start with it is not AA's, and is never overwritten or removed. */
export const PI_APPROVALS_EXTENSION_MARKER = "// Agents Anywhere: approvals for Pi. Managed by the Agents Anywhere Connector";

export function isPiApprovalMode(value: unknown): value is PiApprovalMode {
  return typeof value === "string" && (PI_APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * The conversation setting. Its values follow the composer's permission chip: `ask` shows as asking, `accept_edits`
 * as acting on its own within limits, `full_access` (amber) as never asking. The names are English like the other
 * agents' own settings.
 */
export function piApprovalsOption(mode: PiApprovalMode): ConfigOption {
  return {
    id: PI_APPROVALS_CONFIG_ID,
    name: "Approvals",
    description: "When Pi asks before it acts (added by Agents Anywhere)",
    category: "mode",
    current: mode,
    options: [
      { value: "ask", name: "Ask", description: "Ask before Pi edits files, runs commands or uses other tools" },
      { value: "accept_edits", name: "Accept edits", description: "Edit files without asking; ask before running commands or using other tools" },
      { value: "full_access", name: "Full access", description: "Never ask, as Pi does on its own" },
    ],
  };
}

/**
 * Whether Pi asks before this tool call, in `mode` (one of `PI_APPROVAL_MODES`; anything else counts as `ask`, the
 * safest). `toolName` is Pi's name for the tool: one of its own, or one an extension or MCP server added.
 *
 * It runs inside Pi: the extension's source embeds it with `Function.prototype.toString`, so it may use only its
 * arguments and the language itself. No imports, and no helpers or constants from this module.
 */
export function piToolNeedsApproval(mode: string, toolName: string): boolean {
  if (mode === "full_access") return false;
  // Pi's own file tools: reading never asks; changes ask unless edits are accepted.
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return false;
  if (toolName === "edit" || toolName === "write") return mode !== "accept_edits";
  // Commands, and every tool AA does not know: ask. A name says nothing reliable about what a tool does.
  return true;
}

/** The call a confirmation is about, as the extension describes it in the dialog's message. */
interface AskedCall {
  /** Pi's id of the call: its ACP tool call id too. */
  id: string;
  tool: string;
  input: unknown;
}

function askedCall(rawInput: unknown): AskedCall | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const { method, message } = rawInput as { method?: unknown; message?: unknown };
  if (method !== "confirm" || typeof message !== "string") return undefined;
  try {
    const asked = (JSON.parse(message) as Record<string, unknown> | null)?.[PI_APPROVAL_KEY] as Partial<AskedCall> | undefined;
    return typeof asked?.id === "string" && asked.id.length > 0 && typeof asked.tool === "string"
      ? { id: asked.id, tool: asked.tool, input: asked.input }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The permission request a Pi process sent, about the call it really is about. pi-acp reports every extension dialog
 * as a tool call of its own ("other", with the dialog's text), next to the call that waits. The extension's
 * confirmations name that call, so the request is moved to it (`isKnown`: the conversation has it) and the made-up one
 * never shows. Its title becomes the whole command, not its first line, and the options are worded like the other
 * agents' ("Allow" / "Reject"). Any other dialog (another extension's) is returned as it is.
 */
export function piApprovalRequest(params: AcpRequestPermissionParams, isKnown: (toolCallId: string) => boolean): AcpRequestPermissionParams {
  const asked = askedCall(params.toolCall.rawInput);
  if (asked === undefined) return params;
  const command = (asked.input as { command?: unknown } | null | undefined)?.command;
  const title = typeof command === "string" && command.length > 0 ? command : undefined;
  const toolCall: AcpToolCallUpdate = { toolCallId: asked.id };
  if (title !== undefined) toolCall.title = title;
  if (!isKnown(asked.id)) {
    toolCall.title ??= params.toolCall.title ?? asked.tool;
    toolCall.kind = title !== undefined ? "execute" : asked.tool === "edit" || asked.tool === "write" ? "edit" : "other";
    toolCall.status = "pending";
    toolCall.rawInput = asked.input;
  }
  const names: Partial<Record<string, string>> = { allow_once: "Allow", reject_once: "Reject" };
  return { ...params, toolCall, options: params.options.map((option) => ({ ...option, name: names[option.kind] ?? option.name })) };
}

/** The extension: an ES module Pi loads from its global extensions folder (`*.js` there are discovered). */
export function piApprovalsExtensionSource(): string {
  return `${PI_APPROVALS_EXTENSION_MARKER}: turned on and off in Pi's agent settings in Agents Anywhere,
// and overwritten or removed from there. It does nothing unless Agents Anywhere started this Pi (${PI_APPROVALS_ENV}).
import { readFileSync } from "node:fs";

const needsApproval = ${piToolNeedsApproval.toString()};

/** The session's mode; unreadable (it should not be while Agents Anywhere runs this Pi): ask. */
function modeOf(file, sessionId) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const mode = Object.hasOwn(state.modes, sessionId) ? state.modes[sessionId] : state.default;
    return typeof mode === "string" ? mode : "ask";
  } catch {
    return "ask";
  }
}

/** One line for the approval card: what Pi is about to do. */
function titleOf(toolName, input) {
  const args = input && typeof input === "object" ? input : {};
  const short = (text) => {
    const line = String(text).split("\\n")[0];
    return line.length > 160 ? line.slice(0, 159) + "…" : line;
  };
  if (typeof args.command === "string") return "Run: " + short(args.command);
  if (typeof args.path === "string") return (toolName === "write" ? "Write: " : toolName === "edit" ? "Edit: " : toolName + ": ") + short(args.path);
  return "Use " + toolName;
}

export default function agentsAnywhereApprovals(pi) {
  const file = process.env.${PI_APPROVALS_ENV};
  if (!file) return;
  pi.on("tool_call", async (event, ctx) => {
    if (!needsApproval(modeOf(file, String(ctx.sessionManager?.getSessionId?.())), event.toolName)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: "Agents Anywhere could not ask for approval." };
    // Read back by Agents Anywhere, which shows the call itself (by its id) rather than this dialog.
    const call = { id: event.toolCallId, tool: event.toolName, input: event.input ?? {} };
    const ok = await ctx.ui.confirm(titleOf(event.toolName, event.input), JSON.stringify({ ${PI_APPROVAL_KEY}: call }));
    return ok ? undefined : { block: true, reason: "The user declined this in Agents Anywhere." };
  });
}
`;
}
