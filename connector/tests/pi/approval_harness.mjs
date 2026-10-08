// Execute the shipped TypeScript extension with the same tool-call/UI API surface as Pi.
import { readFileSync } from "node:fs";
import approvalExtension from "../../connector/runtimes/pi/extensions/approval.ts";

const results = [];
for (const scenario of JSON.parse(readFileSync(0, "utf8"))) {
  if (scenario.mode === null) delete process.env.PI_AA_PERMISSION_MODE;
  else process.env.PI_AA_PERMISSION_MODE = scenario.mode;
  let handler;
  let registryReads = 0;
  let tools = [];
  const prompts = [];
  approvalExtension({
    on(event, callback) {
      if (event !== "tool_call") throw new Error(`Unexpected handler ${event}`);
      handler = callback;
    },
    getAllTools() {
      registryReads += 1;
      return tools;
    },
  });
  // Populating the registry after factory registration covers dynamically loaded tools.
  tools = scenario.tools ?? [];
  const result = await handler(
    { type: "tool_call", toolName: scenario.name, toolCallId: "tool-123", input: { path: "file.txt" } },
    {
      cwd: "/test/workspace",
      hasUI: scenario.hasUI ?? true,
      ui: {
        async confirm(title, message) {
          prompts.push({ title, message });
          return scenario.approve;
        },
      },
    },
  );
  results.push({ result: result ?? null, prompts, registryReads });
}
process.stdout.write(JSON.stringify(results));
