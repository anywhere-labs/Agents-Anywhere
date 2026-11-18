// Codex: drives anywhere-labs/codex-acp (04 §5.2). codex-acp bundles the Codex app-server and can also follow a
// running Codex App (IPC; S1: App 26.1111 uses IPC v13, codex-acp#5).
//
// - Instance config offers no `environment` or custom launch arguments (research/06 §6.2).
// - codex-acp is installed by the user or its path is set in instance config; see the codex-acp repository for
//   managed installs and releases.

import { instanceSchema, type AcpAgentDefinition, type ConfigSchema } from '../definition.js'
import { codexDialect } from './dialect.js'
import { codexPermissionCatalog } from './permissions.js'

/** Companion layer switches (runtime/companions/codex): booleans, so they cannot carry launch instructions. */
export const CODEX_COMPANION_SETTINGS = {
  autoFollow: { title: '自动跟随 Codex App 正在使用的线程', default: true },
  deeplinkHandoff: { title: '打开被 Codex App 占用的线程时，让 App 接手（codex:// 链接）', default: true },
  announceNewThreads: {
    title: '新建的线程立即出现在 Codex App 侧边栏（需要 codex-acp 支持）',
    description: '这样出现的新线程不会进入 Codex App 的项目分组。',
    default: true,
  },
} as const satisfies Record<string, { title: string; description?: string; default: boolean }>

const BASE: AcpAgentDefinition = {
  runtime: 'codex',
  displayName: 'Codex',
  executable: {
    name: 'codex-acp',
    candidates: ['~/.local/bin/codex-acp', '~/.npm-global/bin/codex-acp'],
    windowsNpmEntry: '@agentclientprotocol/codex-acp/dist/index.js',
  },
  arguments: [],
  check: ['--version'],
  // `cli` passes the remaining arguments to the bundled Codex CLI. `--version` cannot be used: codex-acp prints
  // its own version when it sees it.
  version: ['cli', '-V'],
  adapterVersion: ['--version'],
  settings: [
    { key: 'codexHome', title: 'Codex 数据目录（可选，缺省 ~/.codex）', environment: 'CODEX_HOME' },
    { key: 'codexPath', title: '本机 Codex CLI 路径（可选）', environment: 'CODEX_PATH' },
  ],
  permissionCatalog: codexPermissionCatalog,
  workspacePreparation: true,
  // Always running: codex-acp keeps following Codex App sessions and receiving history replacements; reclaiming
  // it when idle would lose the follow state.
  idleMs: 0,
  metadata: { localInstallation: true, nativeHistory: true, package: '@agentclientprotocol/codex-acp' },
  dialect: context => codexDialect({ announceNewThreads: context.settings.announceNewThreads !== false }),
}

function codexConfigSchema(): ConfigSchema {
  const base = instanceSchema(BASE)
  const properties = { ...(base.schema.properties as Record<string, unknown>) }
  const defaults: Record<string, boolean> = {}
  for (const [key, setting] of Object.entries(CODEX_COMPANION_SETTINGS)) {
    properties[key] = { type: 'boolean', title: setting.title, ...('description' in setting ? { description: setting.description } : {}) }
    defaults[key] = setting.default
  }
  return {
    schema: { ...base.schema, properties: properties as ConfigSchema['schema'] },
    uiSchema: { order: Object.keys(properties), fields: {} },
    defaults,
  }
}

export const CODEX: AcpAgentDefinition = { ...BASE, configSchema: codexConfigSchema() }
