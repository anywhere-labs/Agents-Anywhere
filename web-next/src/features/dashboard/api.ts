import { ApiClient, apiClient } from "@/lib/api";
import type {
  ConnectorListResponse,
  SessionListResponse
} from "@/features/dashboard/types";

export class DashboardApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  listConnectors(token: string): Promise<ConnectorListResponse> {
    return this.client.get<ConnectorListResponse>("/connectors", { token });
  }

  listSessions(token: string): Promise<SessionListResponse> {
    return this.client.get<SessionListResponse>("/sessions", { token });
  }
}

export const dashboardApi = new DashboardApi();
