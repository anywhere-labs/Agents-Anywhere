/**
 * The agents Agents Anywhere knows: their own program (whether it is there says whether the agent is installed), how it
 * is started as an ACP agent, and how it is installed. Data only; looking for programs and running installs is the job
 * of `src/runtime/agent-finder.ts` and `agent-installer.ts`.
 *
 * Every entry was started in a clean container, installed with its `script` (or `npm`) command here: it answers
 * `initialize` and either opens sessions or asks for a sign-in first. Install commands are the ones in the agent's own
 * documentation.
 */

import {
  CLAUDE_GATEWAY,
  CODEX_GATEWAY,
  COPILOT_GATEWAY,
  GOOSE_GATEWAY,
  KILO_GATEWAY,
  KIMI_GATEWAY,
  OPENCODE_GATEWAY,
  QWEN_GATEWAY,
  type AgentGateway,
} from "./agent-gateway.js";
import type { AcpRuntimePreset, DevicePlatform } from "./config.js";

/** A way to install an agent: a command line for the platform's shell (POSIX sh, PowerShell on Windows). */
export interface AgentInstallMethod {
  id: "script" | "npm" | "brew" | "winget" | "uv";
  platforms: readonly DevicePlatform[];
  command: string;
  /** The program the command needs. */
  needs?: string;
}

export interface CatalogAgent {
  id: string;
  /** Its product name. */
  name: string;
  website: string;
  /** Its own program, by the names it may have. */
  programs: readonly string[];
  /** Folders its installers use that are none of the usual ones (`~`: home). */
  folders?: readonly string[];
  /**
   * How it speaks ACP: its own program with `args`, or an adapter from npm (`npx -y <adapter> …args`), which runs the
   * program it brings along unless `programEnv` names another.
   */
  args?: readonly string[];
  adapter?: string;
  programEnv?: string;
  env?: Readonly<Record<string, string>>;
  approvals?: "pi";
  ownProcess?: boolean;
  /** What its own program is given to sign in, in a terminal (agents that offer no such sign-in over ACP). */
  login?: readonly string[];
  /** It can be pointed at a model gateway. */
  gateway?: AgentGateway;
  install: readonly AgentInstallMethod[];
}

const UNIX: readonly DevicePlatform[] = ["macos", "linux"];
const WINDOWS: readonly DevicePlatform[] = ["windows"];
const ALL: readonly DevicePlatform[] = ["macos", "linux", "windows"];

const script = (command: string): AgentInstallMethod => ({ id: "script", platforms: UNIX, command, needs: "curl" });
const powershell = (command: string): AgentInstallMethod => ({ id: "script", platforms: WINDOWS, command });
const npm = (name: string, flags = "", platforms = ALL): AgentInstallMethod => ({ id: "npm", platforms, command: `npm install -g ${flags ? `${flags} ` : ""}${name}`, needs: "npm" });
const brew = (name: string, platforms: readonly DevicePlatform[] = ["macos"]): AgentInstallMethod => ({ id: "brew", platforms, command: `brew install ${name}`, needs: "brew" });
const winget = (name: string): AgentInstallMethod => ({ id: "winget", platforms: WINDOWS, command: `winget install ${name}`, needs: "winget" });

/** In the order agents are offered for a new conversation. */
export const AGENT_CATALOG: readonly CatalogAgent[] = [
  {
    id: "claude",
    name: "Claude Code",
    website: "https://code.claude.com/docs/en/setup",
    programs: ["claude"],
    adapter: "@agentclientprotocol/claude-agent-acp",
    programEnv: "CLAUDE_CODE_EXECUTABLE",
    gateway: CLAUDE_GATEWAY,
    install: [
      script("curl -fsSL https://claude.ai/install.sh | bash"),
      powershell("irm https://claude.ai/install.ps1 | iex"),
      brew("--cask claude-code"),
      winget("Anthropic.ClaudeCode"),
      npm("@anthropic-ai/claude-code@latest"),
    ],
  },
  {
    id: "codex",
    name: "Codex",
    website: "https://learn.chatgpt.com/docs/codex/cli",
    programs: ["codex"],
    adapter: "@agentclientprotocol/codex-acp",
    programEnv: "CODEX_PATH",
    gateway: CODEX_GATEWAY,
    login: ["login"],
    install: [script("curl -fsSL https://chatgpt.com/codex/install.sh | sh"), npm("@openai/codex"), brew("--cask codex")],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    website: "https://antigravity.google/docs/getting-started?tab=cli",
    programs: ["agy"],
    folders: ["%LOCALAPPDATA%/agy/bin"],
    args: ["acp"],
    install: [script("curl -fsSL https://antigravity.google/cli/install.sh | bash"), powershell("irm https://antigravity.google/cli/install.ps1 | iex")],
  },
  {
    id: "pi",
    name: "Pi",
    website: "https://pi.dev",
    programs: ["pi"],
    folders: ["~/.pi/agent/bin"],
    adapter: "@openma/pi-acp",
    // Pi prints a banner (version, skills, model) as plain agent text right after session/new; it has no marker, so it
    // would land in the conversation as a reply. The model is already in the session's config options.
    args: ["--quiet-startup"],
    // Pi asks no one before it acts; AA can add that with its extension (off until turned on).
    approvals: "pi",
    install: [script("curl -fsSL https://pi.dev/install.sh | sh"), powershell("irm https://pi.dev/install.ps1 | iex"), npm("@earendil-works/pi-coding-agent", "--ignore-scripts")],
  },
  {
    id: "amp",
    name: "Amp",
    website: "https://ampcode.com/manual",
    programs: ["amp"],
    adapter: "amp-acp",
    install: [script("curl -fsSL https://ampcode.com/install.sh | bash")],
  },
  {
    id: "auggie",
    name: "Auggie",
    website: "https://docs.augmentcode.com/cli/overview",
    programs: ["auggie"],
    args: ["--acp"],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
    login: ["auth", "login"],
    install: [npm("@augmentcode/auggie")],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    website: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    programs: ["copilot"],
    args: ["--acp"],
    gateway: COPILOT_GATEWAY,
    install: [script("curl -fsSL https://gh.io/copilot-install | bash"), winget("GitHub.Copilot"), npm("@github/copilot"), brew("--cask copilot-cli", UNIX)],
  },
  {
    id: "cursor",
    name: "Cursor",
    website: "https://cursor.com/docs/cli/installation",
    // It is also installed as `agent`, which other programs are called as well.
    programs: ["cursor-agent"],
    folders: ["%LOCALAPPDATA%/cursor-agent"],
    args: ["acp"],
    login: ["login"],
    install: [script("curl -fsSL https://cursor.com/install | bash"), powershell("irm 'https://cursor.com/install?win32=true' | iex")],
  },
  {
    id: "devin",
    name: "Devin",
    website: "https://docs.devin.ai/cli",
    programs: ["devin"],
    args: ["acp"],
    install: [script("curl -fsSL https://cli.devin.ai/install.sh | bash"), powershell("irm https://static.devin.ai/cli/setup.ps1 | iex"), brew("--cask devin-cli")],
  },
  {
    id: "dirac",
    name: "Dirac",
    website: "https://dirac.run",
    programs: ["dirac"],
    args: ["--acp"],
    install: [npm("dirac-cli")],
  },
  {
    id: "droid",
    name: "Droid",
    website: "https://docs.factory.com/cli/getting-started/quickstart",
    programs: ["droid"],
    args: ["exec", "--output-format", "acp-daemon"],
    env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    install: [script("curl -fsSL https://app.factory.ai/cli | sh"), npm("droid")],
  },
  {
    id: "goose",
    name: "goose",
    website: "https://goose-docs.ai/docs/getting-started/installation",
    programs: ["goose"],
    args: ["acp"],
    gateway: GOOSE_GATEWAY,
    login: ["configure"],
    install: [script("curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash"), brew("block-goose-cli")],
  },
  {
    id: "grok",
    name: "Grok Build",
    website: "https://docs.x.ai/build/overview",
    programs: ["grok"],
    folders: ["~/.grok/bin"],
    args: ["agent", "stdio"],
    login: ["login"],
    install: [script("curl -fsSL https://x.ai/cli/install.sh | bash"), powershell("irm https://x.ai/cli/install.ps1 | iex")],
  },
  {
    id: "junie",
    name: "Junie",
    website: "https://junie.jetbrains.com/docs/junie-cli.html",
    programs: ["junie"],
    args: ["--acp=true"],
    install: [script("curl -fsSL https://junie.jetbrains.com/install.sh | bash"), powershell("iex (irm 'https://junie.jetbrains.com/install.ps1')"), npm("@jetbrains/junie")],
  },
  {
    id: "kilo",
    name: "Kilo Code",
    website: "https://kilo.ai/docs/cli",
    programs: ["kilo"],
    args: ["acp"],
    gateway: KILO_GATEWAY,
    login: ["auth", "login"],
    install: [npm("@kilocode/cli")],
  },
  {
    id: "kimi",
    name: "Kimi Code",
    website: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    programs: ["kimi"],
    folders: ["~/.kimi-code/bin"],
    args: ["acp"],
    gateway: KIMI_GATEWAY,
    install: [
      script("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"),
      powershell("irm https://code.kimi.com/kimi-code/install.ps1 | iex"),
      npm("@moonshot-ai/kimi-code"),
    ],
  },
  {
    id: "minimax",
    name: "MiniMax Code",
    website: "https://agent.minimax.io",
    programs: ["mcode"],
    adapter: "@minimax-ai/code-acp",
    args: ["acp"],
    install: [npm("@minimax-ai/code")],
  },
  {
    id: "opencode",
    name: "OpenCode",
    website: "https://opencode.ai/docs",
    programs: ["opencode"],
    folders: ["~/.opencode/bin"],
    args: ["acp"],
    gateway: OPENCODE_GATEWAY,
    install: [script("curl -fsSL https://opencode.ai/v2/install | bash"), npm("@opencode/cli"), brew("anomalyco/tap/opencode-v2", UNIX)],
  },
  {
    id: "qoder",
    name: "Qoder",
    website: "https://docs.qoder.com/cli/installation",
    programs: ["qodercli"],
    args: ["--acp"],
    install: [script("curl -fsSL https://qoder.com/install | bash"), powershell("irm https://qoder.com/install.ps1 | iex"), npm("@qoder-ai/qodercli")],
  },
  {
    id: "qwen",
    name: "Qwen Code",
    website: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
    programs: ["qwen"],
    args: ["--acp"],
    gateway: QWEN_GATEWAY,
    install: [
      script("curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash"),
      powershell("irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex"),
      npm("@qwen-code/qwen-code@latest"),
      brew("qwen-code", UNIX),
    ],
  },
  {
    id: "vibe",
    name: "Mistral Vibe",
    website: "https://docs.mistral.ai/mistral-vibe/introduction/install",
    programs: ["vibe-acp"],
    args: [],
    install: [script("curl -LsSf https://mistral.ai/vibe/install.sh | bash"), { id: "uv", platforms: ALL, command: "uv tool install mistral-vibe", needs: "uv" }],
  },
  {
    id: "vtcode",
    name: "VT Code",
    website: "https://github.com/vinhnx/vtcode",
    programs: ["vtcode"],
    args: ["acp"],
    env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" },
    install: [script("curl -fsSL https://raw.githubusercontent.com/vinhnx/vtcode/main/scripts/install.sh | bash"), brew("vinhnx/tap/vtcode", UNIX)],
  },
];

/** The folders of the agents' own installers. */
export function agentFolders(catalog: readonly CatalogAgent[]): string[] {
  return [...new Set(catalog.flatMap((agent) => agent.folders ?? []))];
}

/** What starts the agent besides its own program. */
export function launcherOf(agent: CatalogAgent): string | undefined {
  return agent.adapter !== undefined ? "npx" : undefined;
}

/** How the agent is started; `program`: where the user said its program is. */
export function presetOf(agent: CatalogAgent, program?: string): AcpRuntimePreset {
  const own = program ?? (agent.programs[0] as string);
  const args = [...(agent.args ?? [])];
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.adapter !== undefined ? { command: "npx", args: ["-y", agent.adapter, ...args] } : { command: own, args }),
    ...(agent.env !== undefined ? { env: { ...agent.env } } : {}),
    ...(agent.approvals !== undefined ? { approvals: agent.approvals } : {}),
    ...(agent.ownProcess ? { own_process: true } : {}),
  };
}

/** What tells an adapter to run the program the user named. */
export function programEnv(agent: CatalogAgent, program: string | undefined): Record<string, string> {
  return agent.adapter !== undefined && agent.programEnv !== undefined && program !== undefined ? { [agent.programEnv]: program } : {};
}

/** The ways to install it on a platform, the preferred one first. */
export function installMethods(agent: CatalogAgent, platform: DevicePlatform): AgentInstallMethod[] {
  return agent.install.filter((method) => method.platforms.includes(platform));
}
