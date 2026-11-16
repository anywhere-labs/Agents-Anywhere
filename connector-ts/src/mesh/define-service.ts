import { method, service, z } from 'meshcall'

/** One method of a programmatically defined MeshCall service. */
export interface MethodDef {
  readonly name: string
  readonly kind: 'unary' | 'server_stream' | 'duplex'
  readonly description: string
  /** Request schema; default: any object (unknown fields kept). */
  readonly request?: z.ZodType
  readonly idempotent?: boolean
  readonly readOnly?: boolean
  readonly handler: (...args: never[]) => unknown
}

const looseObject = z.looseObject({})
const anyItem = z.looseObject({})

/**
 * Builds a `@service` instance without decorator syntax (Node's type stripping does not run decorators, and some
 * services list their methods per mode): meshcall's decorators are plain functions of `(fn, context)`, so they are
 * applied here by hand. Requests and responses are loose objects; the handlers validate what they use.
 */
export function defineService(name: string, description: string, methods: readonly MethodDef[]): object {
  const Service = class {}
  Object.defineProperty(Service, 'name', { value: name.split('.').pop() ?? 'Service' })
  const prototype = Service.prototype as Record<string, unknown>
  for (const def of methods) {
    const fn = def.handler
    prototype[def.name] = fn
    const context = { kind: 'method', name: def.name, static: false, private: false, metadata: {}, access: { has: () => true, get: () => fn }, addInitializer: () => undefined } as unknown as ClassMethodDecoratorContext
    const request = def.request ?? looseObject
    const semantics = { description: def.description, ...(def.idempotent !== undefined ? { idempotent: def.idempotent } : {}), ...(def.readOnly !== undefined ? { readOnly: def.readOnly } : {}) }
    if (def.kind === 'unary') method({ ...semantics, request, response: looseObject })(fn as never, context)
    else if (def.kind === 'server_stream') method.serverStream({ ...semantics, request, outputItem: anyItem })(fn as never, context)
    else method.duplex({ description: def.description, reason: 'frames flow both ways for the life of one channel', request, inputItem: anyItem, outputItem: anyItem })(fn as never, context)
  }
  service(name, { description, targeted: true })(Service, { kind: 'class', name: Service.name, metadata: {}, addInitializer: () => undefined } as unknown as ClassDecoratorContext)
  return new Service()
}
