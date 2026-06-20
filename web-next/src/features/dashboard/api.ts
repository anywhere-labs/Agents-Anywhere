import { ApiClient, apiClient } from "@/lib/api";
import type {
  ConnectorListResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionListResponse,
  SessionPatchRequest,
  SessionResponse
} from "@/features/dashboard/types";

export class DashboardApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  listConnectors(token: string): Promise<ConnectorListResponse> {
    return this.client.get<ConnectorListResponse>("/connectors", { token });
  }

  listSessions(token: string): Promise<SessionListResponse> {
    return this.client.get<SessionListResponse>("/sessions", { token });
  }

  createSession(
    token: string,
    body: SessionCreateRequest,
  ): Promise<SessionCreateResponse> {
    return this.client.post<SessionCreateResponse>("/sessions", body, { token });
  }

  patchSession(
    token: string,
    sessionId: string,
    body: SessionPatchRequest,
  ): Promise<SessionResponse> {
    return this.client.patch<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      body,
      { token },
    );
  }

  markSessionRead(token: string, sessionId: string): Promise<SessionResponse> {
    return this.client.post<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/read`,
      {},
      { token },
    );
  }

  dashboardEventsUrl(token: string): string {
    return `/sessions/events/dashboard?token=${encodeURIComponent(token)}`;
  }
}

export const dashboardApi = new DashboardApi();
