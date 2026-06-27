// Pure-logic tests for command output normalization. No test runner needed:
//
//   yarn node test/commandOutput.test.mjs
import assert from "node:assert/strict";
import { normalizeCommandOutput } from "../src/lib/commandOutput.ts";

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok -", name);
};

console.log("normalizeCommandOutput:");
t("preserves Windows CRLF table output", () => {
  assert.equal(
    normalizeCommandOutput("LocalAddress LocalPort State\r\n127.0.0.1 8000 Listen\r\n"),
    "LocalAddress LocalPort State\n127.0.0.1 8000 Listen\n",
  );
});
t("keeps LF output unchanged", () => {
  assert.equal(normalizeCommandOutput(" M server/uv.lock\n?? .codex-run/\n"), " M server/uv.lock\n?? .codex-run/\n");
});
t("collapses bare carriage-return progress updates", () => {
  assert.equal(normalizeCommandOutput("10%\r55%\r100%\nDone\n"), "100%\nDone\n");
});

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
