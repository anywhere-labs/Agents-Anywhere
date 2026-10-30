// Generated into AA's adapter cache with an absolute, verified SDK URL.
// Never copied into the user's Pi installation or global extension settings.
import * as sdk from '__AA_PI_SDK_URL__'
export * from '__AA_PI_SDK_URL__'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'

const guard = process.env.AA_PI_GUARD
const digest = path => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex')
let expected = process.env.AA_PI_SOURCE_REVISION
let conflict = false

function report(manager) {
  const path = process.env.AA_PI_WRITE_STATE
  if (!path) return
  const state = { revision: expected, conflict, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() }
  writeFileSync(path + '.tmp', JSON.stringify(state), { mode: 0o600 })
  renameSync(path + '.tmp', path)
}

function checkSource(manager) {
  if (!process.env.AA_PI_SESSION_FILE) return
  const file = manager.getSessionFile()
  if (conflict || !existsSync(file) || digest(file) !== expected) {
    conflict = true
    report(manager)
    throw new Error('pi_source_conflict: 原生历史已被其他来源修改，已阻止继续写入。')
  }
}

function protect(manager) {
  if (!process.env.AA_PI_SESSION_FILE || manager.__aaProtected) return manager
  manager.__aaProtected = true
  for (const key of ['_persist', '_rewriteFile']) {
    if (typeof manager[key] !== 'function') throw new Error('Unsupported Pi history writer')
    const original = manager[key].bind(manager)
    manager[key] = (...args) => {
      checkSource(manager)
      const result = original(...args)
      expected = digest(manager.getSessionFile())
      report(manager)
      return result
    }
  }
  const append = manager.appendMessage.bind(manager)
  manager.appendMessage = message => append(message.role === 'user' && globalThis.__AA_PI_MESSAGE_ID
    ? { ...message, aaClientMessageId: globalThis.__AA_PI_MESSAGE_ID } : message)
  report(manager)
  return manager
}

export class SessionManager extends sdk.SessionManager {
  static open(path, ...args) {
    if (process.env.AA_PI_SESSION_FILE) {
      if (!existsSync(path) || realpathSync(path) !== realpathSync(process.env.AA_PI_SESSION_FILE)) {
        throw new Error('Pi session source mismatch; refusing to create a replacement session')
      }
      if (digest(path) !== expected) throw new Error('pi_source_conflict: Pi history changed before resume')
      const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0])
      if (header.type !== 'session' || header.id !== process.env.AA_PI_SESSION_ID || header.version !== 3) {
        throw new Error('Pi session identity or version mismatch')
      }
    }
    return protect(sdk.SessionManager.open(path, ...args))
  }
  static create(...args) {
    if (process.env.AA_PI_SESSION_FILE) throw new Error('Cannot create a session while restoring native history')
    return sdk.SessionManager.create(...args)
  }
  static forkFrom(...args) {
    if (process.env.AA_PI_SESSION_FILE) throw new Error('Cannot implicitly fork native history')
    return sdk.SessionManager.forkFrom(...args)
  }
}

export async function createAgentSessionServices(options) {
  if (digest(guard) !== process.env.AA_PI_GUARD_DIGEST) throw new Error('AA permission guard integrity mismatch')
  const services = await sdk.createAgentSessionServices({ ...options, resourceLoaderOptions: {
    ...options.resourceLoaderOptions,
    additionalExtensionPaths: [guard, ...(options.resourceLoaderOptions?.additionalExtensionPaths ?? [])],
  } })
  const loader = services.resourceLoader
  const get = loader.getExtensions.bind(loader)
  loader.getExtensions = () => {
    if (digest(guard) !== process.env.AA_PI_GUARD_DIGEST) throw new Error('AA permission guard changed; reload refused')
    const result = get()
    const first = result.extensions.find(extension => extension.path === guard)
    if (!first) throw new Error('AA permission guard missing; execution refused')
    // SDK reload and extension-runner reconstruction use the same accessor.
    return { ...result, extensions: [first, ...result.extensions.filter(extension => extension !== first)] }
  }
  loader.getExtensions()
  return services
}

export async function createAgentSessionFromServices(options) {
  const result = await sdk.createAgentSessionFromServices(options)
  if (result.modelFallbackMessage) {
    await result.session.dispose?.()
    throw new Error('pi_model_unavailable: 原会话模型不可用，已阻止静默切换模型。')
  }
  return result
}

export function aaFindSession(sessionId) {
  const path = process.env.AA_PI_SESSION_FILE
  if (!path) return undefined
  if (sessionId !== process.env.AA_PI_SESSION_ID || !existsSync(path)) throw new Error('Native Pi source no longer exists')
  const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0])
  if (header.id !== sessionId) throw new Error('Native Pi identity changed')
  return { sessionId, path, cwd: header.cwd, updatedAt: header.timestamp, additionalDirectories: [] }
}

export function aaBeforePrompt(params) {
  globalThis.__AA_PI_MESSAGE_ID = params._meta?.aa?.clientMessageId ?? params.aa?.clientMessageId
}

export function aaLoadingReport() {
  return { sdkEntry: '__AA_PI_SDK_URL__', sdkVersion: sdk.VERSION, guard, mandatoryGuard: true }
}
