// 官方提供 ACP 入口的 Agent：每个一份定义，没有方言或只有很小的类别修正（04 §5.5）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/{opencode,antigravity,codebuddy,commandcode,mimo,minimax}/definition.py
// runtime 取值与 v2 一致（不加 acp: 前缀）：会话 ID、Timeline ID 以它为输入。

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
  dialect: () => genericDialect('opencode'),
}

/** Google Antigravity 的 CLI，用它自带的 ACP 入口。 */
export const ANTIGRAVITY: AcpAgentDefinition = {
  runtime: 'antigravity',
  displayName: 'Google Antigravity',
  executable: { name: 'agy', candidates: ['~/.local/bin/agy', '%LOCALAPPDATA%/agy/bin/agy.exe'] },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  dialect: () => genericDialect('antigravity'),
}

/** 腾讯 CodeBuddy Code。 */
export const CODEBUDDY: AcpAgentDefinition = {
  runtime: 'codebuddy',
  displayName: 'CodeBuddy Code',
  executable: { name: 'codebuddy', candidates: ['~/.local/bin/codebuddy'], windowsNpmEntry: '@tencent-ai/codebuddy-code/bin/codebuddy' },
  arguments: ['--acp'],
  check: ['--acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  dialect: () => genericDialect('codebuddy'),
}

export const COMMAND_CODE_PERMISSION_MODE = 'command-code-permission-mode'

/** Command Code 用 ACP session modes 表达权限策略：没有权限类配置项时，把 modes 作为权限项。 */
export function commandCodeDialect(): AcpDialect {
  return {
    ...genericDialect('commandcode'),
    legacyModes: { id: COMMAND_CODE_PERMISSION_MODE, name: 'Permission mode', category: 'permission' },
  }
}

export const COMMAND_CODE: AcpAgentDefinition = {
  runtime: 'commandcode',
  displayName: 'Command Code',
  // npm 在所有平台都发布 cmdc。Windows 上 cmd 可能解析成 cmd.exe。
  executable: { name: 'cmdc', candidates: ['~/.local/bin/cmdc'], windowsNpmEntry: 'command-code/dist/index.mjs' },
  arguments: ['--no-auto-update', 'acp'],
  check: ['--no-auto-update', 'acp', '--help'],
  version: ['--version'],
  nativeInventory: false,
  dialect: () => commandCodeDialect(),
}

/** 小米 MiMo Code。它的 ACP 服务只接受进程 cwd 下的目录，所以每个工作目录一个进程。 */
export const MIMO: AcpAgentDefinition = {
  runtime: 'mimo',
  displayName: 'MiMo Code',
  executable: { name: 'mimo', candidates: ['~/.local/bin/mimo'], windowsNpmEntry: '@mimo-ai/cli/mimo.js' },
  arguments: ['acp'],
  check: ['acp', '--help'],
  version: ['--version'],
  launchInWorkspace: true,
  nativeInventory: false,
  dialect: () => genericDialect('mimo'),
}

/** MiniMax Code 把权限模式放在自定义的 ACP 类别里。 */
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
  dialect: () => miniMaxDialect(),
}

/** Connector 自带的全部官方 ACP Agent 定义（顺序即设备详情里的展示顺序）。 */
export const OFFICIAL_ACP_AGENTS: readonly AcpAgentDefinition[] = [OPENCODE, ANTIGRAVITY, CODEBUDDY, COMMAND_CODE, MIMO, MINIMAX]
