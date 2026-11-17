import { apiClient, type ApiClient } from "@/lib/api"
import type { PreviewListResponse } from "@/generated/preview/v1_0/preview-list-response"
import type { PreviewTicketResponse } from "@/generated/preview/v1_0/preview-ticket-response"
import type { PreviewView } from "@/generated/preview/v1_0/preview-view"

export type { PreviewView, PreviewTicketResponse }

/** `CreatePreviewRequest` (preview 1.0; the client sends it, so it is not generated). */
export type CreatePreviewRequest = {
  deviceId: string
  port: number
  sessionId?: string | null
  visibility?: "private" | "link"
  ttlHours?: number | null
}

/** Port preview lives under the v3 namespace (contracts/preview/1.0). */
const PREVIEWS = "/api/v3/previews"

export class PreviewApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  list(token: string): Promise<PreviewListResponse> {
    return this.client.get<PreviewListResponse>(PREVIEWS, { token })
  }

  create(token: string, request: CreatePreviewRequest): Promise<PreviewView> {
    return this.client.post<PreviewView>(PREVIEWS, request, { token })
  }

  close(token: string, previewId: string): Promise<PreviewView | undefined> {
    return this.client.delete<PreviewView | undefined>(`${PREVIEWS}/${encodeURIComponent(previewId)}`, { token })
  }

  /** A one-time, 60-second ticket that the preview domain exchanges for its own cookie. */
  ticket(token: string, previewId: string): Promise<PreviewTicketResponse> {
    return this.client.post<PreviewTicketResponse>(`${PREVIEWS}/${encodeURIComponent(previewId)}/ticket`, undefined, { token })
  }
}

export const previewApi = new PreviewApi()
