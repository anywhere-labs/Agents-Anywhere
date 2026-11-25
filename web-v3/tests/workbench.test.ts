import { describe, expect, it } from "vitest"
import { MeshCallError } from "meshcall/web"

import { outputText } from "@/components/conversation/text"
import { bytesToBase64Url, isUnimplemented, planTransfer, rpcCap } from "@/lib/attachments/transfer"
import type { AgentEntry, AgentInstallJob, ConfigOption, DriveQuotaView, SessionSummary } from "@/lib/types/v3"
import { AGENT_MARKS } from "@/components/workbench/agent-marks"
import {
  byName,
  installNews,
  isGatewayUrl,
  isInstalled,
  isInstalling,
  keepsGatewayKey,
  preferredMethod,
  splitAgents,
  type ListedAgent,
} from "@/lib/workbench/agents"
import { rememberStart, toggleIn } from "@/lib/workbench/local-prefs"
import { joinArgs, splitArgs } from "@/lib/workbench/args"
import { signInNeeded, signInText } from "@/lib/workbench/sign-in"
import { changedPicks, withPicks } from "@/lib/workbench/prepared-agent"
import { titleFromMessage } from "@/lib/workbench/title"
import { agentLabel, buildDeviceTree, deviceProjects, matchesQuery, projectName, tildePath } from "@/lib/workbench/tree"
import { parseUnifiedDiff } from "@/lib/workbench/unified-diff"

const MiB = 1024 * 1024

function session(id: string, agent: string, cwd: string, updated: string, device = "dev1"): SessionSummary {
  return { id, title: id, agent, device_id: device, cwd, state: "idle", unread: false, pinned: false, updated_at: updated }
}

function quota(patch: Partial<DriveQuotaView> = {}): DriveQuotaView {
  return {
    enabled: true,
    rpc_direct_max_bytes: 8 * MiB,
    quota_bytes: 1024 * MiB,
    used_bytes: 0,
    reserved_bytes: 0,
    remaining_bytes: 1024 * MiB,
    max_file_bytes: 100 * MiB,
    default_ttl_seconds: 604800,
    max_ttl_seconds: 604800,
    file_count: 0,
    policy_source: "default",
    ...patch,
  }
}

describe("workbench tree (device → agent → project → conversation)", () => {
  it("groups by agent then directory, newest first at every level", () => {
    const tree = buildDeviceTree([
      session("a", "pi", "/Users/me/web", "2026-11-20T10:00:00Z"),
      session("b", "claude", "/Users/me/web", "2026-11-22T10:00:00Z"),
      session("c", "pi", "/Users/me/api", "2026-11-21T10:00:00Z"),
      session("d", "pi", "/Users/me/web", "2026-11-23T10:00:00Z"),
    ])
    expect(tree.map((a) => a.agent)).toEqual(["pi", "claude"])
    expect(tree[0].projects.map((p) => p.name)).toEqual(["web", "api"])
    expect(tree[0].projects[0].sessions.map((s) => s.id)).toEqual(["d", "a"])
    expect(tree[0].count).toBe(3)
  })

  it("names projects by their last segment and home as ~", () => {
    expect(projectName("/Users/me/code/web/")).toBe("web")
    expect(projectName("/Users/me")).toBe("~")
    expect(projectName("/home/me")).toBe("~")
    expect(projectName("C:\\Users\\me\\repo")).toBe("repo")
    expect(tildePath("/Users/me/code")).toBe("~/code")
  })

  it("lists a device's projects once, most recent first", () => {
    const projects = deviceProjects(
      [session("a", "pi", "/x/one", "2026-11-20T00:00:00Z"), session("b", "codex", "/x/two", "2026-11-21T00:00:00Z"), session("c", "pi", "/x/one", "2026-11-22T00:00:00Z")],
      ["/x/three"]
    )
    expect(projects.map((p) => p.cwd)).toEqual(["/x/one", "/x/two", "/x/three"])
  })

  it("labels agents from the device first, then known names", () => {
    expect(agentLabel("claude")).toBe("Claude Code")
    expect(agentLabel("antigravity", [{ id: "antigravity", name: "Antigravity (Gemini)" }])).toBe("Antigravity (Gemini)")
    expect(agentLabel("mystery")).toBe("Mystery")
  })

  it("matches every word of a query", () => {
    expect(matchesQuery("web pi", "Fix login", "pi", "/Users/me/web")).toBe(true)
    expect(matchesQuery("web codex", "Fix login", "pi", "/Users/me/web")).toBe(false)
    expect(matchesQuery("  ", "anything")).toBe(true)
  })
})

describe("local workbench preferences", () => {
  it("toggles list entries", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"])
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"])
    expect(toggleIn(["a"], "a", true)).toEqual(["a"])
  })

  it("remembers the last start per device", () => {
    const first = rememberStart(null, "d1", "pi", "/x")
    const second = rememberStart(first, "d2", "codex")
    expect(second).toMatchObject({ deviceId: "d2", agent: "codex" })
    expect(second.agentByDevice).toEqual({ d1: "pi", d2: "codex" })
    expect(second.cwdByDevice).toEqual({ d1: "/x" })
    // Starting in the home directory makes it the default again.
    expect(rememberStart(second, "d1", "pi", null).cwdByDevice).toEqual({})
  })
})

describe("unified diff content lines that look like headers", () => {
  it("keeps removed and added lines starting with -- and ++ inside a hunk", () => {
    const [file] = parseUnifiedDiff(
      ["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- old comment", "+++ new comment", " select 1;"].join("\n")
    )
    expect(file.deletions).toBe(1)
    expect(file.additions).toBe(1)
    expect(file.lines.map((l) => l.kind)).toEqual(["hunk", "del", "add", "same"])
  })
})

describe("attachment transfer planning (client-experience-proposal §3.2)", () => {
  it("sends files up to the device's RPC cap directly", () => {
    expect(planTransfer(8 * MiB, { rpcMaxBytes: 8 * MiB, quota: quota() })).toEqual({ kind: "rpc" })
    expect(planTransfer(2 * MiB, { rpcMaxBytes: 1 * MiB, quota: quota() })).toEqual({ kind: "drive" })
  })

  it("falls back to the control plane hint, then 8 MiB", () => {
    expect(rpcCap({ quota: quota({ rpc_direct_max_bytes: 4 * MiB }) })).toBe(4 * MiB)
    expect(rpcCap({})).toBe(8 * MiB)
  })

  it("checks drive limits when the file is picked", () => {
    expect(planTransfer(9 * MiB, { quota: null })).toMatchObject({ kind: "reject", reason: "drive_disabled" })
    expect(planTransfer(9 * MiB, { quota: quota({ enabled: false }) })).toMatchObject({ kind: "reject", reason: "drive_disabled" })
    expect(planTransfer(200 * MiB, { quota: quota() })).toMatchObject({ kind: "reject", reason: "too_large", limit: 100 * MiB })
    expect(planTransfer(50 * MiB, { quota: quota({ remaining_bytes: 10 * MiB }) })).toMatchObject({ kind: "reject", reason: "quota" })
    expect(planTransfer(0, { quota: quota() })).toMatchObject({ kind: "reject", reason: "empty" })
  })

  it("recognises a Connector without fetch_drive_file", () => {
    expect(isUnimplemented({ code: "method_not_found" })).toBe(true)
    expect(isUnimplemented({ code: "unimplemented" })).toBe(true)
    expect(isUnimplemented({ code: "internal" })).toBe(false)
  })

  it("encodes keys as base64url without padding", () => {
    const key = bytesToBase64Url(new Uint8Array(32).fill(255))
    expect(key).toHaveLength(43)
    expect(key).not.toMatch(/[+/=]/)
  })
})

describe("unified diff parsing", () => {
  it("splits files and counts lines", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
        "+more",
        "diff --git a/new.md b/new.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.md",
        "@@ -0,0 +1 @@",
        "+hello",
      ].join("\n")
    )
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: "src/a.ts", additions: 2, deletions: 1, status: "modified" })
    expect(files[1]).toMatchObject({ path: "new.md", additions: 1, status: "added" })
    expect(files[0].lines.map((l) => l.kind)).toEqual(["hunk", "same", "del", "add", "add"])
  })
})

describe("titleFromMessage", () => {
  it("takes the first non-empty line, collapsed", () => {
    expect(titleFromMessage("\n\n  修一下   登录跳转  \n后面的内容")).toBe("修一下 登录跳转")
  })
  it("cuts long text by characters, not bytes", () => {
    const title = titleFromMessage("一".repeat(50), 40)
    expect(title).toBe(`${"一".repeat(40)}…`)
  })
  it("gives nothing for empty text", () => {
    expect(titleFromMessage("  \n ")).toBeUndefined()
  })
})

describe("options picked before the conversation exists (prepare)", () => {
  const config: ConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      current: "a",
      options: [
        { value: "a", name: "A" },
        { value: "b", name: "B" },
      ],
    },
    { id: "thinking", name: "Thinking", category: "thought_level", current: "high", options: [{ value: "off", name: "off" }, { value: "high", name: "high" }] },
  ]

  it("shows picks in place of the agent's defaults, ignoring values the agent does not offer", () => {
    const shown = withPicks(config, { model: "b", thinking: "max", unknown: "x" })
    expect(shown.map((o) => o.current)).toEqual(["b", "high"])
    expect(config[0]!.current).toBe("a")
  })

  it("sends only what differs from the started agent", () => {
    expect(changedPicks(config, withPicks(config, { model: "b", thinking: "high" }))).toEqual({ model: "b" })
    expect(changedPicks(config, config)).toEqual({})
  })
})

describe("agent arguments as one line (splitArgs / joinArgs)", () => {
  it("splits like a shell", () => {
    expect(splitArgs("-y @openma/pi-acp --quiet-startup")).toEqual(["-y", "@openma/pi-acp", "--quiet-startup"])
    expect(splitArgs(`--name "two words" 'it''s' a\\ b ""`)).toEqual(["--name", "two words", "its", "a b", ""])
    expect(splitArgs("   ")).toEqual([])
  })

  it("writes back what it reads", () => {
    for (const args of [["-y", "pkg"], ["two words", "it's", "", "a\\b", 'say "hi"']]) {
      expect(splitArgs(joinArgs(args))).toEqual(args)
    }
  })
})

describe("tool output as text (outputText)", () => {
  it("shows an MCP tool result's text blocks instead of its JSON", () => {
    const result = {
      content: [
        { type: "text", text: "# Title" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "body" },
      ],
      structuredContent: "# Title",
    }
    expect(outputText(result)).toBe("# Title\nbody")
  })

  it("keeps the other shapes as before", () => {
    expect(outputText({ stdout: "ok" })).toBe("ok")
    expect(outputText({ exit_code: 0 })).toBe("")
    expect(outputText({ content: [] })).toBe('{\n  "content": []\n}')
  })
})

describe("agents of a device", () => {
  it("are listed by name, installed or not, whatever their case", () => {
    const names = ["goose", "Claude Code", "Grok Build", "Amp", "cline", "Agent 10", "Agent 9"]
    expect(names.map((name) => ({ id: name, name })).sort(byName).map((a) => a.name)).toEqual([
      "Agent 9",
      "Agent 10",
      "Amp",
      "Claude Code",
      "cline",
      "goose",
      "Grok Build",
    ])
    // Same name: their ids decide, so the order does not change between reads.
    expect([{ id: "b", name: "Pi" }, { id: "a", name: "pi" }].sort(byName).map((a) => a.id)).toEqual(["a", "b"])
  })

  const entry = (id: string, patch: Partial<AgentEntry> = {}): AgentEntry => ({
    id,
    name: id,
    builtin: true,
    enabled: true,
    command: id,
    args: [],
    env_keys: [],
    customized: false,
    running: 0,
    busy: 0,
    ...patch,
  })
  const job = (state: AgentInstallJob["state"]): AgentEntry["install"] => ({
    methods: [],
    job: { method: "script", command: "install", state, started_at: "2026-11-24T10:00:00Z", output: "" },
  })

  it("are there, or apart from them can be installed, each by name", () => {
    const listed = (e: AgentEntry | null, id = e?.id ?? ""): ListedAgent => ({
      id,
      name: id,
      entry: e,
      installed: isInstalled(e),
      enabled: true,
      running: false,
      count: 0,
    })
    const { usable, more } = splitAgents([
      listed(entry("pi", { installed: true, install: { methods: [] } })),
      listed(entry("kimi", { installed: false, install: { methods: [] } })),
      listed(entry("amp", { installed: false, install: { methods: [] } })),
      // Its own program is there, only what starts it is not.
      listed(entry("codex", { installed: false, missing: "npx", install: { methods: [] } })),
      // Added by the user, and its command is gone: theirs to put right, not one to install.
      listed(entry("custom-mine", { installed: false, custom: true })),
      // A Connector that does not manage agents.
      listed(null, "claude"),
    ])
    expect(usable.map((a) => a.id)).toEqual(["claude", "codex", "custom-mine", "pi"])
    expect(more.map((a) => a.id)).toEqual(["amp", "kimi"])
  })

  it("are news once installed, or when their install ended without them", () => {
    const before = [
      entry("a", { installed: false, install: job("running") }),
      entry("b", { installed: false, install: job("running") }),
      entry("c", { installed: false, install: job("waiting") }),
      entry("d", { installed: false }),
      entry("e", { installed: true }),
      entry("f", { installed: false, install: job("failed") }),
      entry("g", { installed: false, install: job("running") }),
    ]
    const now = [
      entry("a", { installed: true, install: job("succeeded") }),
      entry("b", { installed: false, install: job("failed") }),
      entry("c", { installed: false, install: job("cancelled") }),
      // In a terminal, say.
      entry("d", { installed: true }),
      entry("e", { installed: true }),
      entry("f", { installed: false, install: job("failed") }),
      // Its command ended well, but the program is not there.
      entry("g", { installed: false, install: job("succeeded") }),
      entry("new", { installed: true }),
    ]
    expect(installNews(before, now).map((n) => `${n.kind} ${n.entry.id}`)).toEqual(["installed a", "failed b", "installed d", "failed g"])
    expect(installNews(now, now)).toEqual([])
  })

  it("have marks that fill a square box", () => {
    expect(Object.keys(AGENT_MARKS).sort()).toEqual([
      "amp", "antigravity", "auggie", "claude", "codex", "copilot", "cursor", "devin", "dirac", "droid", "goose",
      "grok", "junie", "kilo", "kimi", "minimax", "opencode", "pi", "qoder", "qwen", "vibe", "vtcode",
    ])
    for (const [id, mark] of Object.entries(AGENT_MARKS)) {
      const [, , width, height] = mark.viewBox.split(" ").map(Number)
      expect(width, id).toBe(height)
      expect(mark.shapes.length, id).toBeGreaterThan(0)
    }
  })

  it("count as installed when a Connector does not say", () => {
    expect(isInstalled({})).toBe(true)
    expect(isInstalled(null)).toBe(true)
    expect(isInstalled({ installed: false })).toBe(false)
  })

  it("are followed while an install waits or runs, and offered the first method that can run", () => {
    expect((["waiting", "running", "succeeded", "failed", "cancelled"] as const).filter((state) => isInstalling({ state }))).toEqual([
      "waiting",
      "running",
    ])
    expect(isInstalling(undefined)).toBe(false)
    const methods = [
      { id: "npm", command: "npm install -g x", available: false, needs: "npm" },
      { id: "brew", command: "brew install x", available: true, needs: "brew" },
    ]
    expect(preferredMethod({ install: { methods } })).toBe("brew")
    expect(preferredMethod({ install: { methods: methods.slice(0, 1) } })).toBe("npm")
    expect(preferredMethod({})).toBeUndefined()
  })

  it("take http(s) gateways only, and send a saved key to no other host", () => {
    for (const url of ["https://gw.example.com", "http://127.0.0.1:4000/v1"]) expect(isGatewayUrl(url), url).toBe(true)
    for (const url of ["", "gw.example.com", "ftp://gw.example.com", "https://a:b@gw.example.com", "https://gw.example.com?x", "https://gw.example.com#x"]) {
      expect(isGatewayUrl(url), url).toBe(false)
    }
    expect(keepsGatewayKey("https://gw.example.com", "https://gw.example.com/v1")).toBe(true)
    for (const url of ["http://gw.example.com", "https://gw.example.com:8443", "https://other.example.com", "gw.example.com"]) {
      expect(keepsGatewayKey("https://gw.example.com", url), url).toBe(false)
    }
    expect(keepsGatewayKey(undefined, "https://gw.example.com")).toBe(false)
  })
})

describe("signing in to an agent", () => {
  const refused = (details: Record<string, unknown>) =>
    new MeshCallError("failed_precondition", "could not start Cursor: Authentication required", { details: { reason: "agent_auth_required", ...details } })
  const t = (key: string, values: Record<string, string>) => `${key}:${Object.values(values).join("|")}`

  it("reads the ways the device offers, and leaves out what an older Connector sent", () => {
    const needed = signInNeeded(
      refused({
        agent_message: "Run 'agent login'.",
        auth_methods: [{ id: "cursor_login", name: "Cursor Login", kind: "agent" }, { id: "aa:program", name: "cursor-agent login", kind: "terminal" }, { id: "old", name: "Old" }],
      })
    )
    expect(needed?.methods.map((m) => m.id)).toEqual(["cursor_login", "aa:program"])
    expect(signInText(t, "Cursor", needed)).toBe("agentSignIn.needed:Cursor")
    expect(signInNeeded(new MeshCallError("unavailable", "x", { details: { reason: "agent_start_failed" } }))).toBeNull()
  })

  it("with nothing to sign in with here, says what the agent said", () => {
    const needed = signInNeeded(refused({ agent_message: "Run `mcode login` and try again.", auth_methods: [{ id: "x", name: "X" }] }))
    expect(signInText(t, "MiniMax", needed)).toBe("agentSignIn.neededSays:MiniMax|Run `mcode login` and try again.")
    expect(signInText(t, "MiniMax", signInNeeded(refused({})))).toBe("agentSignIn.needed:MiniMax")
  })
})
