import type { ProjectView } from "./types"

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
  projects, connectorId, path, deviceOs, resolve,
}: {
  projects: ProjectView[]
  connectorId: string
  path: string
  deviceOs?: string | null
  resolve: (payload: { connectorId: string; workspacePath: string }) => Promise<ProjectView>
}): Promise<ProjectView> {
  if (!connectorId || !path.trim()) throw new Error("A device and workspace are required")
  return findWorkspaceProject(projects, connectorId, path, deviceOs)
    ?? await resolve({ connectorId, workspacePath: path.trim() })
}
