// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/opencode/definition.py @98dd0e6e5 (OPENCODE)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/antigravity/definition.py @98dd0e6e5 (ANTIGRAVITY)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/codebuddy/definition.py @98dd0e6e5 (CODEBUDDY)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/commandcode/definition.py @98dd0e6e5 (CommandCodeDialect, COMMAND_CODE)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/mimo/definition.py @98dd0e6e5 (MIMO)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/minimax/definition.py @98dd0e6e5 (MiniMaxDialect, MINIMAX)
//
// Agents that ship an official ACP entry: one definition each, with no dialect or only a small category fix
// (04 §5.5). `runtime` values carry no `acp:` prefix and must stay stable: session IDs and Timeline IDs are
// derived from them.

import type { ConfigOption } from '../../../application/ports/runtime-session.js'
import type { AcpDialect } from '../../acp/dialect.js'
import type { AcpAgentDefinition } from '../definition.js'
import { genericDialect } from './dialect.js'

export const OPENCODE: AcpAgentDefinition = {
  runtime: 'opencode',
  displayName: 'OpenCode',
  executable: { name: 'opencode', candidates: ['~/.opencode/bin/opencode', '~/.local/bin/opencode'] },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => genericDialect('opencode'),
}

/** Google Antigravity's CLI, using its built-in ACP entry. */
export const ANTIGRAVITY: AcpAgentDefinition = {
  runtime: 'antigravity',
  displayName: 'Google Antigravity',
  executable: { name: 'agy', candidates: ['~/.local/bin/agy', '%LOCALAPPDATA%/agy/bin/agy.exe'] },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => genericDialect('antigravity'),
}

/** Tencent CodeBuddy Code. */
export const CODEBUDDY: AcpAgentDefinition = {
  runtime: 'codebuddy',
  displayName: 'CodeBuddy Code',
  executable: { name: 'codebuddy', candidates: ['~/.local/bin/codebuddy'], windowsNpmEntry: '@tencent-ai/codebuddy-code/bin/codebuddy' },
  arguments: ['--acp'],
  check: ['--acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => genericDialect('codebuddy'),
}

export const COMMAND_CODE_PERMISSION_MODE = 'command-code-permission-mode'

/**
 * Command Code expresses its permission policy as ACP session modes: with no permission-category config option,
 * the modes are used as the permission option.
 */
export function commandCodeDialect(): AcpDialect {
  return {
    ...genericDialect('commandcode'),
    legacyModes: { id: COMMAND_CODE_PERMISSION_MODE, name: 'Permission mode', category: 'permission' },
  }
}

export const COMMAND_CODE: AcpAgentDefinition = {
  runtime: 'commandcode',
  displayName: 'Command Code',
  // npm publishes cmdc on every platform. On Windows, `cmd` may resolve to cmd.exe.
  executable: { name: 'cmdc', candidates: ['~/.local/bin/cmdc'], windowsNpmEntry: 'command-code/dist/index.mjs' },
  arguments: ['--no-auto-update', 'acp'],
  check: ['--no-auto-update', 'acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => commandCodeDialect(),
}

/** Xiaomi MiMo Code. Its ACP server only accepts directories under the process cwd, so there is one process per working directory. */
export const MIMO: AcpAgentDefinition = {
  runtime: 'mimo',
  displayName: 'MiMo Code',
  executable: { name: 'mimo', candidates: ['~/.local/bin/mimo'], windowsNpmEntry: '@mimo-ai/cli/mimo.js' },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  launchInWorkspace: true,
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => genericDialect('mimo'),
}

/** MiniMax Code puts its permission mode in a custom ACP category. */
export function miniMaxDialect(): AcpDialect {
  return {
    ...genericDialect('minimax'),
    adaptConfig: options => options.map((option): ConfigOption => (option.id === 'permissionMode' ? { ...option, category: 'permission' } : option)),
  }
}

export const MINIMAX: AcpAgentDefinition = {
  runtime: 'minimax',
  displayName: 'MiniMax Code',
  executable: { name: 'mcode', candidates: ['~/.local/bin/mcode'], windowsNpmEntry: '@minimax-ai/code/cli.js' },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  workspacePreparation: true,
  dialect: () => miniMaxDialect(),
}

/** All official ACP Agent definitions shipped with the Connector (in the order shown in device details). */
export const OFFICIAL_ACP_AGENTS: readonly AcpAgentDefinition[] = [OPENCODE, ANTIGRAVITY, CODEBUDDY, COMMAND_CODE, MIMO, MINIMAX]
