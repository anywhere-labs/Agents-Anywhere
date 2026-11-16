import type { RuntimeError } from '../../application/ports/runtime-session.js'

/** 携带端口错误码的异常：发现、启动、打开会话时的确定失败（安装缺失、版本不支持、选择无效…）。 */
export class RuntimeFailure extends Error {
  constructor(readonly error: RuntimeError) {
    super(error.message)
    this.name = 'RuntimeFailure'
  }
}

export function fail(code: string, message: string, details?: RuntimeError['details']): never {
  throw new RuntimeFailure({ code, message, ...(details !== undefined ? { details } : {}) })
}
