// This file is kept for backward-compat imports.
// Canonical types and mock API functions now live in lib/api.ts.

export type { SessionStatus, FilterValue } from "@/lib/demo-api"
export { defaultFilter, filterSessions } from "@/lib/demo-api"

// ── Legacy chat / file fixture data used by session-view ─────

export type ChatMessage = {
  id: string
  role: "user" | "agent"
  content: string
  code?: { lang: string; lines: string[] }
  list?: string[]
}

export type FileNode = {
  name: string
  kind: "directory" | "file"
  hint?: string
}

export const sampleThread: ChatMessage[] = [
  {
    id: "m1",
    role: "agent",
    content:
      "CLI 已简化成通用默认实现。接下来做最终验证并安装成 uv tool；安装会用本地路径，不启动任何本地服务。",
  },
  {
    id: "m2",
    role: "agent",
    content:
      "headless 友好的验证都过了。我现在执行 uv tool install，再从工具命令跑一次 --dry-run 确认安装后的入口可用。",
  },
  {
    id: "m3",
    role: "agent",
    content: "工具安装成功，入口也确认可用。最后我会看一下 git 状态，然后把本次实现提交。",
  },
  {
    id: "m4",
    role: "agent",
    content: "已完成，项目在 /Users/t4wefan/code/local/cliptype。已安装为 uv tool，可直接运行：",
    code: { lang: "bash", lines: ["cliptype --delay 3 --speed 20"] },
  },
  {
    id: "m5",
    role: "agent",
    content: "常用命令：",
    code: {
      lang: "bash",
      lines: ["cliptype --dry-run", "cliptype --delay 5 --speed 12", "cliptype --max-chars 200"],
    },
  },
  {
    id: "m6",
    role: "agent",
    content: "已验证：",
    list: [
      "uv run python -m compileall src",
      "uv run cliptype --help",
      "uv run cliptype --dry-run --quiet",
      "uv tool install --reinstall /Users/t4wefan/code/local/cliptype",
    ],
  },
]

export const sampleFiles: FileNode[] = [
  { name: "..", kind: "directory", hint: "parent" },
  { name: "outputs", kind: "directory", hint: "directory" },
  { name: "work", kind: "directory", hint: "directory" },
  { name: "win_probe.py", kind: "file", hint: "py" },
  { name: "README.md", kind: "file", hint: "md" },
  { name: "pyproject.toml", kind: "file", hint: "toml" },
]

export const sampleCode: string[] = [
  "#!/usr/bin/env python3",
  '"""',
  "Windows-side probe — runs ON the Windows machine, driven via pywinpty.",
  "Validates:",
  "  1. JSONL path encoding rule on Windows (C:\\..., backslashes, drive letter)",
  "  2. pywinpty (ConPTY) can spawn claude TUI and feed stdin",
  "  3. Trust dialog bypass via ~/.claude.json works",
  "  4. ESC interrupt + Ctrl+C exit behaviors match Unix",
  '"""',
  "import os, sys, json, time, uuid, pathlib, re",
  "from winpty import PtyProcess",
  "import pyte",
  "",
  'CWD = r"C:\\claude-probe"',
  "os.makedirs(CWD, exist_ok=True)",
  "",
  "HOME = pathlib.Path.home()",
  'CONFIG = HOME / ".claude.json"',
  'PROJECTS_DIR = HOME / ".claude" / "projects"',
  "",
  "SESSION_ID = str(uuid.uuid4())",
  'CLAUDE = r"C:\\Users\\admin\\.local\\bin\\claude.exe"',
  "",
  'print(f"=== Windows probe ===")',
  'print(f"cwd: {CWD}")',
  'print(f"session_id: {SESSION_ID}")',
  'print(f"claude bin: {CLAUDE}")',
  'print(f"home: {HOME}")',
  'print(f"projects dir: {PROJECTS_DIR}")',
]
