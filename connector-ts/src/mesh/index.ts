// MeshCall helpers: build @service without decorator syntax, shared by link/ (device link) and host/ (local Router); depends only on meshcall.

export { defineService, type MethodDef } from './define-service.js'
export { rpcLogger, type LogSink } from './logger.js'
