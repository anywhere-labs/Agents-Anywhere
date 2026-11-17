// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/dialect.py @98dd0e6e5 (GENERIC_DIALECT)
//
// Generic ACP dialect: every hook keeps standard ACP behaviour. Agent-specific dialects override the hooks they
// need on top of it.

import type { RuntimeType } from '../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import type { AcpDialect } from '../../acp/dialect.js'

/** clientCapabilities sent in initialize (visible in recordings). */
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
