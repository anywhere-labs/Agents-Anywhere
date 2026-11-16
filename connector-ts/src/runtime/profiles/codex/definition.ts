// Codex：驱动 anywhere-labs/codex-acp（04 §5.2）。codex-acp 自带 Codex app-server，也能跟随正在运行的
// Codex App（IPC，S1：App 26.1111 用 IPC v13，codex-acp#5）。
//
// 与 v2 的差别：
// - v2 直接用 Codex SDK + 自己的 IPC 跟随；v3 一律走 codex-acp。
// - v2 实例配置里的 `environment`、自定义启动参数不再提供（research/06 §6.2）。
// - codex-acp 由用户安装或在实例配置里填路径；受管安装与发布流程见 codex-acp 仓库。

import type { AcpAgentDefinition } from '../definition.js'
import { codexDialect } from './dialect.js'
import { codexPermissionCatalog } from './permissions.js'

export const CODEX: AcpAgentDefinition = {
  runtime: 'codex',
  displayName: 'Codex',
  executable: {
    name: 'codex-acp',
    candidates: ['~/.local/bin/codex-acp', '~/.npm-global/bin/codex-acp'],
    windowsNpmEntry: '@agentclientprotocol/codex-acp/dist/index.js',
  },
  arguments: [],
  check: ['--version'],
  // `cli` 把后面的参数交给内置的 Codex CLI。不能用 `--version`：codex-acp 见到它就先打印自己的版本。
  version: ['cli', '-V'],
  adapterVersion: ['--version'],
  settings: [
    { key: 'codexHome', title: 'Codex 数据目录（可选，缺省 ~/.codex）', environment: 'CODEX_HOME' },
    { key: 'codexPath', title: '本机 Codex CLI 路径（可选）', environment: 'CODEX_PATH' },
  ],
  permissionCatalog: codexPermissionCatalog,
  // 常驻：codex-acp 要一直跟随 Codex App 的会话、接收历史替换，空闲回收会丢掉跟随状态。
  idleMs: 0,
  metadata: { localInstallation: true, nativeHistory: true, package: '@agentclientprotocol/codex-acp' },
  dialect: () => codexDialect(),
}
