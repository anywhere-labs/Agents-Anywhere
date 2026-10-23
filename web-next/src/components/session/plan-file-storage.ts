import { dashboardApi } from "@/features/dashboard/api"
import { isApiError } from "@/lib/api/errors"
import type { PlanStorage } from "./plan-draft"

export type PlanFileLocation = { token: string; connectorId: string; root: string }

export function createPlanFileStorage(location: PlanFileLocation, id: string): PlanStorage {
  const { token, connectorId, root } = location
  const path = crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)).then(hash =>
    `.agents-anywhere-plan-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}.md`)
  return {
    read: async () => {
      const name = await path
      try {
        const file = await dashboardApi.connectorFsReadText(token, connectorId, root, name, 1024 * 1024)
        if (file.truncated || file.binary) throw new Error("Plan file is too large or is not a text document")
        return { text: file.content, version: file.sha256, path: file.path }
      } catch (error) {
        if (isApiError(error) && error.detail.startsWith("file not found:")) return { text: null, version: "", path: name }
        throw error
      }
    },
    write: async (content, version) => {
      const response = await dashboardApi.connectorFsWrite(token, connectorId, root, { path: await path, content, ifMatch: version })
      return response.result.sha256
    },
  }
}
