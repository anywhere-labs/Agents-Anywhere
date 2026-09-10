import { isApiError } from "../../lib/api/errors.ts"
import type { ProjectCreateRequest, ProjectView } from "./types"

export function isWindowsWorkspace(path: string, deviceOs?: string | null): boolean {
  return deviceOs === "windows" || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\")
}

export function workspacePathKey(path: string, deviceOs?: string | null): string {
  const trimmed = path.trim()
  const windows = isWindowsWorkspace(trimmed, deviceOs)
  const slashes = windows ? trimmed.replaceAll("\\", "/") : trimmed
  const parts: string[] = []
  for (const part of slashes.split("/")) {
    if (!part || part === ".") continue
    if (!windows && part === "..") parts.pop()
    else parts.push(part)
  }
  const prefix = slashes.startsWith("//") && !slashes.startsWith("///") ? "//" : slashes.startsWith("/") ? "/" : ""
  const key = prefix + parts.join("/")
  return windows ? key.toLowerCase() : key
}

export function workspaceName(path: string, fallback = "Workspace"): string {
  const trimmed = path.trim()
  const windows = isWindowsWorkspace(trimmed)
  const normalized = windows ? trimmed.replaceAll("\\", "/") : trimmed
  const clean = normalized.replace(/\/+$/, "")
  if (windows && (/^[a-z]:$/i.test(clean) || /^\/\/[^/]+\/[^/]+$/.test(clean))) return fallback
  return clean.split("/").at(-1) || fallback
}

export function availableProjectName(name: string, projects: Pick<ProjectView, "id" | "name">[], ignoreId?: string): string {
  const base = Array.from(name.trim() || "Workspace").slice(0, 255).join("")
  const names = new Set(projects.filter((project) => project.id !== ignoreId).map((project) => project.name))
  let candidate = base
  for (let suffix = 1; names.has(candidate); suffix++) {
    const ending = ` (${suffix})`
    candidate = Array.from(base).slice(0, 255 - ending.length).join("") + ending
  }
  return candidate
}

export function findWorkspaceProject(
  projects: ProjectView[], connectorId: string, path: string, deviceOs?: string | null,
): ProjectView | undefined {
  const key = workspacePathKey(path, deviceOs)
  if (!key) return undefined
  return projects.find((project) => project.connectorId === connectorId
    && workspacePathKey(project.workspacePath, deviceOs) === key)
}

export async function resolveWorkspaceProject({
  projects, connectorId, path, deviceOs, list, create,
}: {
  projects: ProjectView[]
  connectorId: string
  path: string
  deviceOs?: string | null
  list: () => Promise<ProjectView[]>
  create: (payload: ProjectCreateRequest) => Promise<ProjectView>
}): Promise<ProjectView> {
  if (!connectorId || !path.trim()) throw new Error("A device and workspace are required")
  const existing = findWorkspaceProject(projects, connectorId, path, deviceOs)
  if (existing) return existing

  let currentProjects = await list()
  for (let attempt = 0; ; attempt++) {
    const current = findWorkspaceProject(currentProjects, connectorId, path, deviceOs)
    if (current) return current
    try {
      return await create({
        name: availableProjectName(workspaceName(path), currentProjects),
        connectorId,
        workspacePath: path.trim(),
        manuallyCreated: false,
      })
    } catch (error) {
      if (attempt >= 2 || !isApiError(error) || error.status !== 409 || error.code !== "project_name_conflict") throw error
      // Another client may have created this workspace or claimed its name.
      currentProjects = await list()
    }
  }
}
