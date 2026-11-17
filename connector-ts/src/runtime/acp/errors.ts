import type { RuntimeError } from '../../application/ports/runtime-session.js'

/** An exception carrying a port error code: a definite failure during discovery, launch or session open (missing install, unsupported version, invalid selection...). */
export class RuntimeFailure extends Error {
  constructor(readonly error: RuntimeError) {
    super(error.message)
    this.name = 'RuntimeFailure'
  }
}

export function fail(code: string, message: string, details?: RuntimeError['details']): never {
  throw new RuntimeFailure({ code, message, ...(details !== undefined ? { details } : {}) })
}
