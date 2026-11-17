// Hermes Agent，经它自己的 `hermes acp` stdio 服务接入。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/hermes/definition.py `HERMES`

import type { AcpAgentDefinition } from '../definition.js'
import { hermesDialect } from './dialect.js'

export const HERMES: AcpAgentDefinition = {
  runtime: 'hermes',
  displayName: 'Hermes',
  executable: {
    name: 'hermes',
    candidates: ['~/.local/bin/hermes', '~/.hermes/hermes-agent/venv/bin/hermes'],
  },
  arguments: ['acp'],
  check: ['acp', '--check'],
  version: ['acp', '--version'],
  settings: [{ key: 'hermesHome', title: 'Hermes 配置目录（可选）', environment: 'HERMES_HOME' }],
  // Hermes 自己的编辑审批策略和它给的名字。命令审批由 Hermes 决定，以审批请求的形式到达 AA。
  permissionOptions: [
    ['ask', 'Default'],
    ['workspace_session', 'Accept Edits'],
    ['session', "Don't Ask"],
  ],
  metadata: { localInstallation: true, nativeHistory: false },
  workspacePreparation: true,
  dialect: () => hermesDialect(),
}
