// Claude：驱动 @agentclientprotocol/claude-agent-acp（04 §5.3）。适配器内含 Claude CLI，也可以用
// `CLAUDE_CODE_EXECUTABLE` 指向用户已有的 Claude Code。
//
// 与 v2 的差别：
// - v2 直接用 Claude Agent SDK；v3 一律走 ACP。
// - v2 实例配置的 `environment`（任意环境变量覆盖）不再提供：实例配置不能携带启动指令（research/06 §6.2）。
//   模型网关改由 Profile 注入（RuntimeInstanceConfig.modelGateway）。
// - 适配器由用户安装（`npm i -g @agentclientprotocol/claude-agent-acp`）或在实例配置里填路径；
//   受管安装（锁定版本、随 Desktop 分发）跟 Pi 的 npm 运行时一起做。

import type { AcpAgentDefinition } from '../definition.js'
import { claudeDialect } from './dialect.js'
import { claudeEnvironment } from './environment.js'
import { claudePermissionCatalog } from './permissions.js'

/** 验证过的适配器版本（S2）。 */
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
  // `--cli` 把后面的参数交给内置的 Claude CLI。
  version: ['--cli', '--version'],
  adapterVersion: ['--version'],
  settings: [{ key: 'claudeExecutable', title: '本机 Claude Code 路径（可选）', environment: 'CLAUDE_CODE_EXECUTABLE' }],
  permissionCatalog: claudePermissionCatalog,
  metadata: { localInstallation: true, nativeHistory: true, package: '@agentclientprotocol/claude-agent-acp', packageVersion: CLAUDE_AGENT_ACP_VERSION },
  environment: (env, instance) => claudeEnvironment(env, instance.modelGateway),
  dialect: () => claudeDialect(),
}
