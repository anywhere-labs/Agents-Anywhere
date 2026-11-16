// Assigning sessions the device found on its own to a project (contracts/e2ee/1.0 「会话归属项目」).
//
// In E2EE mode the Server cannot read a session's working directory, so sessions the device imported or
// scanned arrive with `projectId: null`. A client that opened `displayDevice` matches the decrypted `cwd`
// against the user's projects on the same device and sets the project with `PATCH /sessions/{id}/meta`.
// Each session is tried at most once per app run; failures stay silent (the session simply stays unassigned).

import type { SessionDisplay } from "./display"

export interface AssignableSession {
  readonly id: string
  readonly connectorId: string
  readonly projectId?: string | null
}

export interface AssignableProject {
  readonly id: string
  readonly connectorId: string
  readonly workspacePath: string
}

const WINDOWS_PATH = /^[a-z]:[\\/]/i

function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path)
}

/** Trimmed, without trailing separators; Windows-style paths (`X:\`) compare case-insensitively with `\`. */
export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim()
  if (isWindowsPath(trimmed)) return trimmed.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase()
  const stripped = trimmed.replace(/\/+$/, "")
  return stripped || (trimmed.startsWith("/") ? "/" : "")
}

function isPathPrefix(prefix: string, path: string, windows: boolean): boolean {
  const separator = windows ? "\\" : "/"
  return path.startsWith(prefix.endsWith(separator) ? prefix : prefix + separator)
}

/** The project whose workspace is `cwd` on the session's device, else the deepest one containing it. */
export function matchSessionProject<P extends AssignableProject>(
  session: Pick<AssignableSession, "connectorId">,
  cwd: string,
  projects: readonly P[],
): P | null {
  const target = normalizeWorkspacePath(cwd)
  if (!target) return null
  const windows = isWindowsPath(cwd.trim())
  let best: { project: P; length: number } | null = null
  for (const project of projects) {
    if (project.connectorId !== session.connectorId) continue
    if (isWindowsPath(project.workspacePath.trim()) !== windows) continue
    const path = normalizeWorkspacePath(project.workspacePath)
    if (!path) continue
    if (path === target) return project
    if (isPathPrefix(path, target, windows) && (!best || path.length > best.length)) best = { project, length: path.length }
  }
  return best?.project ?? null
}

export interface SessionProjectAssignerOptions {
  /** `PATCH /sessions/{id}/meta {projectId}`, then refresh the list entry. */
  assign(sessionId: string, projectId: string): Promise<unknown>
  debug?: (message: string, detail: unknown) => void
}

export class SessionProjectAssigner {
  readonly #attempted = new Set<string>()
  readonly #options: SessionProjectAssignerOptions

  constructor(options: SessionProjectAssignerOptions) {
    this.#options = options
  }

  /** Assigns every unassigned session whose decrypted `cwd` matches a project; returns the attempts started. */
  consider<S extends AssignableSession>(
    sessions: readonly S[],
    projects: readonly AssignableProject[],
    displayOf: (session: S) => SessionDisplay,
  ): Promise<void>[] {
    const started: Promise<void>[] = []
    for (const session of sessions) {
      if (session.projectId || this.#attempted.has(session.id) || session.id.startsWith("local:")) continue
      const display = displayOf(session)
      // Normal mode: the Server assigns by the plaintext cwd itself.
      if (display.state === "plain" || !display.cwd) continue
      const project = matchSessionProject(session, display.cwd, projects)
      if (!project) continue
      this.#attempted.add(session.id)
      started.push(
        Promise.resolve().then(() => this.#options.assign(session.id, project.id)).then(
          () => undefined,
          (error: unknown) => this.#options.debug?.(`[e2ee] could not assign session ${session.id} to a project`, error),
        ),
      )
    }
    return started
  }
}

let shared: SessionProjectAssigner | null = null
let sharedAssign: SessionProjectAssignerOptions["assign"] = () => Promise.resolve()

/** One assigner per app run, so a session is tried once even across sign-ins and re-renders. */
export function sessionProjectAssigner(assign: SessionProjectAssignerOptions["assign"]): SessionProjectAssigner {
  sharedAssign = assign
  shared ??= new SessionProjectAssigner({
    assign: (sessionId, projectId) => sharedAssign(sessionId, projectId),
    debug: (message, detail) => console.debug(message, detail),
  })
  return shared
}
