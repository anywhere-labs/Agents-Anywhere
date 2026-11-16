// Pi：OpenMA 发布的 ACP 可执行文件（`@openma/pi-acp`）绑定到一个 Pi SDK。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/definition.py `PI`
//
// 用 `piProvider()` 接入：它在通用 ACP 引擎之上加了按会话的进程、原生历史与交接、审批与计划的交互改写。
// 定义本身也能交给通用 AcpAgentProvider（共享进程、没有原生历史），只用于诊断。

import type { JsonObject } from '../../../application/ports/runtime-session.js'
import type { AcpAgentDefinition, ConfigSchema } from '../definition.js'
import { piDialect } from './dialect.js'
import { preparePiLaunch } from './launch.js'

const LINE = '^[^\\u0000\\r\\n]+$'

const CUSTOM_MODELS_SCHEMA: JsonObject = {
  type: 'array',
  title: 'Custom models',
  description: 'Additional model IDs to show in the model catalog for this runtime.',
  maxItems: 64,
  items: {
    type: 'object',
    required: ['modelId', 'displayName'],
    properties: {
      modelId: { type: 'string', title: 'Model ID', minLength: 1, maxLength: 256, pattern: LINE },
      displayName: { type: 'string', title: 'Display model name', minLength: 1, maxLength: 128 },
      efforts: {
        type: 'array',
        title: 'Efforts',
        maxItems: 16,
        items: {
          type: 'object',
          required: ['effortId', 'displayName'],
          properties: {
            effortId: { type: 'string', title: 'Effort ID', minLength: 1, maxLength: 128, pattern: LINE },
            displayName: { type: 'string', title: 'Display effort name', minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
        default: [],
      },
    },
    additionalProperties: false,
  },
  default: [],
}

/** 实例配置。模型网关不在这里（RuntimeInstanceConfig.modelGateway）；只有受管环境用它。 */
export const PI_CONFIG_SCHEMA: ConfigSchema = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      executionMode: { type: 'string', title: '运行环境', enum: ['auto', 'local', 'managed'], enumNames: ['优先本机 Pi', '本机 Pi', 'AA 受管环境'] },
      cliPath: { type: 'string', title: '本机 pi 路径（可选）', maxLength: 4096 },
      agentDir: { type: 'string', title: 'Pi 配置目录（可选）', maxLength: 4096 },
      historyDirs: { type: 'array', title: '额外历史目录', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4096 } },
      customModels: CUSTOM_MODELS_SCHEMA,
    },
  },
  uiSchema: {
    order: ['executionMode', 'cliPath', 'agentDir', 'historyDirs', 'customModels'],
    fields: { customModels: { component: 'customModels' } },
  },
  defaults: { customModels: [], historyDirs: [] },
}

export const PI_PERMISSION_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['ask', '写入与命令审批'],
  ['ask_all', '全部工具审批'],
  ['readonly', '只读'],
]

export const PI: AcpAgentDefinition = {
  runtime: 'pi',
  displayName: 'Pi',
  // 本机模式的 pi CLI；真正的启动命令由 prepareLaunch 给出（Node + 打过补丁的适配器）。
  executable: { name: 'pi', candidates: ['~/.nvmd/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi', '/opt/homebrew/bin/pi', '/usr/local/bin/pi'] },
  arguments: [],
  configSchema: PI_CONFIG_SCHEMA,
  permissionOptions: PI_PERMISSION_OPTIONS,
  metadata: { managedInstallation: true, localInstallation: true, nativeHistory: true, package: '@openma/pi-acp' },
  maturity: 'beta',
  dialect: () => piDialect(),
  prepareLaunch: context => preparePiLaunch(context),
}
