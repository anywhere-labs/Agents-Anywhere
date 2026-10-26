export type ProjectSyncTranslator = (key: "createFailed" | "resultUnknown" | "createdPending" | "runtimeRequired" | "projectUnavailable" | "explicitSelectionRequired") => string

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

export function projectWorkspacePath(project: ProjectView, selectedPath?: string): string {
  if (selectedPath && project.roots?.some(root => workspacePathKey(root) === workspacePathKey(selectedPath))) return selectedPath;
  return project.roots?.find(root => project.rootStates?.[root] === "present") ?? project.workspacePath;
}

export async function resolveWorkspaceProject({ projects, connectorId, path, deviceOs, runtime, runtimeId, projectId, requestId, create, translate }: {
  projects: ProjectView[]; connectorId: string; path: string; deviceOs?: string | null;
  runtime?: string; runtimeId?: string; projectId?: string; requestId: string;
  translate: ProjectSyncTranslator;
  create: (payload: ProjectCreateRequest) => Promise<ProjectView>;
}): Promise<ProjectView> {
  if (!runtime || !runtimeId) throw new Error(translate("runtimeRequired"))
  if (projectId) {
    const selected = projects.find(p => p.id === projectId && p.connectorId === connectorId && p.runtimeId === runtimeId)
    if (!selected || selected.sourceState !== "active") throw new Error(translate("projectUnavailable"))
    return selected
  }
  const matches = projects.filter(p => p.connectorId === connectorId && p.runtimeId === runtimeId
    && workspacePathKey(p.workspacePath, deviceOs) === workspacePathKey(path, deviceOs))
  if (matches.length > 0) throw new Error(translate("explicitSelectionRequired"))
  return create({ name: workspaceName(path), connectorId, workspacePath: path, runtime, runtimeId, requestId })
}
