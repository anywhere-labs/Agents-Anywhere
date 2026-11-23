import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultAcpPresets } from "../src/runtime/acp-host.js";

describe("built-in ACP presets", () => {
  it("offer only agents whose programs are installed", () => {
    const installed = new Set(["npx", "codex"]);
    assert.deepEqual(
      defaultAcpPresets((program) => installed.has(program)).map((p) => p.id),
      ["codex"],
    );
  });

  it("are Claude Code, Codex, Antigravity and Pi (Gemini CLI is no longer one)", () => {
    assert.deepEqual(
      defaultAcpPresets(() => true).map((p) => p.id),
      ["claude", "codex", "antigravity", "pi"],
    );
  });

  it("start Pi without its startup banner, which would otherwise show up as a reply", () => {
    const pi = defaultAcpPresets(() => true).find((p) => p.id === "pi");
    assert.ok(pi?.args?.includes("--quiet-startup"), JSON.stringify(pi));
  });
});
