// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/hermes/definition.py @98dd0e6e5 (HERMES)
//
// Hermes Agent, connected through its own `hermes acp` stdio server.

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
  // Hermes's own edit approval policies and their names. Command approval is decided by Hermes and reaches AA as
  // approval requests.
  permissionOptions: [
    ['ask', 'Default'],
    ['workspace_session', 'Accept Edits'],
    ['session', "Don't Ask"],
  ],
  metadata: { localInstallation: true, nativeHistory: false },
  workspacePreparation: true,
  dialect: () => hermesDialect(),
}
