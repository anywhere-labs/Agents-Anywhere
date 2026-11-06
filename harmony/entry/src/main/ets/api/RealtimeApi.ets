import { HttpTransport } from './HttpTransport';
import { encodeUrlComponent, webSocketApiUrl } from './ApiUrls';
import {
  DashboardSnapshot, parseDashboardSnapshot, parseRemoteWsTicket, RemoteWsTicket, RemoteWsTicketDto,
} from './RealtimeDtos';

/**
 * Realtime resource client.
 *
 * Port of `api/RealtimeApi.kt`.
 *
 * Every socket connection starts by minting a short-lived ticket over HTTP; the
 * ticket is the only credential the socket carries, because a WebSocket upgrade
 * cannot set an Authorization header from a native client.
 */

/** Which channel a ticket is for. */
export interface TicketScope {
  dashboard: boolean;
  sessionId: string;
}

export function dashboardScope(): TicketScope {
  return { dashboard: true, sessionId: '' };
}

export function sessionScope(sessionId: string): TicketScope {
  return { dashboard: false, sessionId: sessionId };
}

export class RealtimeApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `POST /ws-ticket`. */
  async createTicket(
    serverUrl: string,
    token: string,
    clientId: string,
    scope: TicketScope,
  ): Promise<RemoteWsTicket> {
    const body: WsTicketRequest = {
      clientId: clientId,
      scope: scope.dashboard ? new DashboardScopeBody() : new SessionScopeBody(scope.sessionId),
    };
    const response: Object = await this.transport.postJson(serverUrl, '/ws-ticket', token, body);
    return parseRemoteWsTicket(response as RemoteWsTicketDto);
  }

  /** `wss://…/api/v2/dashboard/ws?ticket=…` */
  dashboardSocketUrl(serverUrl: string, ticket: string): string {
    return `${webSocketApiUrl(serverUrl, '/dashboard/ws')}?ticket=${encodeUrlComponent(ticket)}`;
  }

  /** `wss://…/api/v2/sessions/{id}/ws?ticket=…` */
  sessionSocketUrl(serverUrl: string, sessionId: string, ticket: string): string {
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/ws`;
    return `${webSocketApiUrl(serverUrl, path)}?ticket=${encodeUrlComponent(ticket)}`;
  }

  parseDashboard(text: string): DashboardSnapshot | null {
    return parseDashboardSnapshot(text);
  }
}

/** `{"dashboard": true}` */
class DashboardScopeBody {
  dashboard: boolean = true;
}

/** `{"sessionId": "..."}` */
class SessionScopeBody {
  sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}

interface WsTicketRequest {
  clientId: string;
  scope: DashboardScopeBody | SessionScopeBody;
}
