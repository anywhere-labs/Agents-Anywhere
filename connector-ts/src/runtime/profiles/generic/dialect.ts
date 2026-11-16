// 通用 ACP 方言：每个钩子都保持标准 ACP 行为（v2 acp/domain/dialect.py `GENERIC_DIALECT`）。
// 具体 Agent 的方言在它的基础上覆盖需要的钩子。

import type { RuntimeType } from '../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import type { AcpDialect } from '../../acp/dialect.js'

/** v2 AgentClient 的 clientCapabilities（录制里可见）。 */
export const GENERIC_CLIENT_CAPABILITIES = {
  auth: {},
  elicitation: { form: {} },
  session: { configOptions: { boolean: {} } },
}

export interface GenericDialectOptions {
  readonly permissionCatalog?: boolean
}

export function genericDialect(runtime: RuntimeType, options: GenericDialectOptions = {}): AcpDialect {
  return {
    runtime,
    clientCapabilities: () => structuredClone(GENERIC_CLIENT_CAPABILITIES),
    capabilities: info => negotiatedCapabilities(info, { steer: false, permissionCatalog: options.permissionCatalog === true }),
    steer: 'none',
  }
}
