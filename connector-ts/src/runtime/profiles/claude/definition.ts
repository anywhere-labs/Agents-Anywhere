// Claude: drives @agentclientprotocol/claude-agent-acp (04 §5.3). The adapter bundles the Claude CLI;
// `CLAUDE_CODE_EXECUTABLE` can point it at the user's own Claude Code instead.
//
// - Instance config has no `environment` (arbitrary env overrides): instance config must not carry launch
//   instructions (research/06 §6.2). The model gateway is injected by the Profile (RuntimeInstanceConfig.modelGateway).
// - The adapter is installed by the user (`npm i -g @agentclientprotocol/claude-agent-acp`) or its path is set in
//   instance config; a managed install (pinned version, shipped with Desktop) will come with Pi's npm runtime.

import type { AcpAgentDefinition } from '../definition.js'
import { claudeDialect } from './dialect.js'
import { claudeEnvironment } from './environment.js'
import { claudePermissionCatalog } from './permissions.js'

/** Verified adapter version (S2). */
export const CLAUDE_AGENT_ACP_VERSION = '0.107.2'

export const CLAUDE: AcpAgentDefinition = {
  runtime: 'claude',
  displayName: 'Claude Code',
  executable: {
    name: 'claude-agent-acp',
    candidates: ['~/.local/bin/claude-agent-acp', '~/.npm-global/bin/claude-agent-acp'],
    windowsNpmEntry: '@agentclientprotocol/claude-agent-acp/dist/index.js',
  },
  arguments: [],
  check: ['--version'],
  // `--cli` passes the remaining arguments to the bundled Claude CLI.
  version: ['--cli', '--version'],
  adapterVersion: ['--version'],
  settings: [{ key: 'claudeExecutable', title: '本机 Claude Code 路径（可选）', environment: 'CLAUDE_CODE_EXECUTABLE' }],
  permissionCatalog: claudePermissionCatalog,
  workspacePreparation: true,
  metadata: { localInstallation: true, nativeHistory: true, package: '@agentclientprotocol/claude-agent-acp', packageVersion: CLAUDE_AGENT_ACP_VERSION },
  environment: (env, instance) => claudeEnvironment(env, instance.modelGateway),
  dialect: () => claudeDialect(),
}
