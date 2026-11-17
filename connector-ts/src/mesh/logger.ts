import { format } from 'node:util'

import type { RpcLogger } from 'meshcall'

export type LogSink = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

/** meshcall's RpcLogger onto the Connector's own log (never the console: `rpc` mode owns stdout). */
export function rpcLogger(sink: LogSink): RpcLogger {
  const logger: RpcLogger = {
    bind: () => logger,
    log: (level, message, ...args) => {
      const text = format(message, ...args)
      if (level === 'error') sink('error', text)
      else if (level === 'warning') sink('warn', text)
      else if (level === 'info') sink('info', text)
      else sink('debug', text)
    },
    debug: (message, ...args) => logger.log('debug', message, ...args),
    info: (message, ...args) => logger.log('info', message, ...args),
    warning: (message, ...args) => logger.log('warning', message, ...args),
    error: (message, ...args) => logger.log('error', message, ...args),
  }
  return logger
}
