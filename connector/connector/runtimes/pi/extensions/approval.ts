import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This marker and JSON payload are consumed by pi_aa.permissions. Keep them stable.
const APPROVAL_TITLE = "PI_AA_TOOL_APPROVAL_V1";
const MODES = new Set(["full-auto", "ask-writes", "ask-all", "read-only"]);
const WRITING_TOOLS = new Set(["bash", "powershell", "edit", "write"]);

export default function approvalExtension(pi: ExtensionAPI): void {
  const requestedMode = process.env.PI_AA_PERMISSION_MODE ?? "ask-writes";
  const mode = MODES.has(requestedMode) ? requestedMode : "ask-writes";

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "full-auto") return;

    // Look up hints on each call: MCP and other extensions can register tools later.
    // Known mutating built-ins never become read-only through a misleading hint.
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    const readOnly =
      !WRITING_TOOLS.has(event.toolName) && tool?.annotations?.readOnlyHint === true;
    if (mode === "read-only") {
      if (readOnly) return;
      return { block: true, reason: `${event.toolName} is blocked by read-only permission mode` };
    }
    if (mode === "ask-writes" && readOnly) return;

    if (!ctx.hasUI) {
      return { block: true, reason: `${event.toolName} requires approval, but no UI is available` };
    }
    const approved = await ctx.ui.confirm(
      APPROVAL_TITLE,
      JSON.stringify({
        toolName: event.toolName,
        toolInput: event.input,
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        mode,
      }),
    );
    if (!approved) return { block: true, reason: `${event.toolName} was not approved` };
  });
}
