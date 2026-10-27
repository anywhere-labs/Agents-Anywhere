import { ApiClient } from './ApiClient';
import { webSocketApiUrl } from 'common';
import {
  objGetArray,
  objGetBool,
  objGetOptString,
  objGetRecord,
  objGetString,
  parseJsonRecord,
  recordsFromArray
} from 'common';
import { parseRemoteDevice, RemoteDevice } from './DevicesApi';
import { parseRemoteProject, parseRemoteSession, parseSessionEventEnvelope, RemoteProject, RemoteSession, RemoteSessionEventEnvelope } from './SessionDtos';
import {
  RemoteDashboardSnapshot,
  RemoteEventRecoveryResponse,
  RemoteSessionPageInfo,
  RemoteWsTicket
} from './RealtimeDtos';

const MAX_RECOVERY_PAGES = 8;

function recoveryResult(events: RemoteSessionEventEnvelope[], nextCursor: string,
  snapshotRequired: boolean, serverTime: string | null): RemoteEventRecoveryResponse {
  const recovery: RemoteEventRecoveryResponse = {
    events: events,
    nextCursor: nextCursor,
    snapshotRequired: snapshotRequired,
    serverTime: serverTime
  };
  return recovery;
}

export class RealtimeApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async createDashboardTicket(serverUrl: string, authorizationToken: string,
    clientId: string): Promise<RemoteWsTicket> {
    const scope: Record<string, Object> = { 'dashboard': true };
    return this.createTicket(serverUrl, authorizationToken, clientId, scope);
  }

  async createSessionTicket(serverUrl: string, authorizationToken: string, clientId: string,
    sessionId: string): Promise<RemoteWsTicket> {
    const scope: Record<string, Object> = { 'sessionId': sessionId };
    return this.createTicket(serverUrl, authorizationToken, clientId, scope);
  }

  dashboardWebSocketUrl(serverUrl: string, ticket: string): string {
    return webSocketApiUrl(serverUrl, `/dashboard/ws?ticket=${encodeURIComponent(ticket)}`);
  }

  sessionWebSocketUrl(serverUrl: string, sessionId: string, ticket: string): string {
    return webSocketApiUrl(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/ws?ticket=${encodeURIComponent(ticket)}`);
  }

  async recoverSessionEvents(serverUrl: string, authorizationToken: string, sessionId: string,
    after: string): Promise<RemoteEventRecoveryResponse> {
    let cursor = after;
    const events: RemoteSessionEventEnvelope[] = [];
    let serverTime: string | null = null;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
      const response = await this.fetchRecoveryPage(serverUrl, authorizationToken, sessionId, cursor);
      serverTime = response.serverTime;
      if (response.snapshotRequired) {
        return recoveryResult(events, cursor, true, serverTime);
      }
      for (const event of response.events) {
        events.push(event);
      }
      const next = response.nextCursor;
      if (next === cursor) {
        return recoveryResult(events, cursor, false, serverTime);
      }
      cursor = next;
    }
    return recoveryResult(events, cursor, true, serverTime);
  }

  private async fetchRecoveryPage(serverUrl: string, authorizationToken: string, sessionId: string,
    after: string): Promise<RemoteEventRecoveryResponse> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}`,
      authorizationToken);
    const events: RemoteSessionEventEnvelope[] = [];
    for (const item of recordsFromArray(objGetArray(response, 'events'))) {
      events.push(parseSessionEventEnvelope(item));
    }
    const recovery: RemoteEventRecoveryResponse = {
      events: events,
      nextCursor: objGetString(response, 'nextCursor', after),
      snapshotRequired: objGetBool(response, 'snapshotRequired', false),
      serverTime: objGetOptString(response, 'serverTime')
    };
    return recovery;
  }

  parseDashboardMessage(text: string): RemoteDashboardSnapshot | null {
    let message: Record<string, Object>;
    try {
      message = parseJsonRecord(text);
    } catch (error) {
      return null;
    }
    if (objGetString(message, 'type', '') !== 'dashboard.snapshot') {
      return null;
    }
    const sessionPages = objGetRecord(message, 'sessionPages');
    if (sessionPages === null) {
      return null;
    }
    const activePage = objGetRecord(sessionPages, 'active');
    if (activePage === null) {
      return null;
    }
    const archivedPage = objGetRecord(sessionPages, 'archived');
    if (archivedPage === null) {
      return null;
    }
    const devices: RemoteDevice[] = [];
    for (const item of recordsFromArray(objGetArray(message, 'connectors'))) {
      devices.push(parseRemoteDevice(item));
    }
    const projects: RemoteProject[] = [];
    for (const item of recordsFromArray(objGetArray(message, 'projects'))) {
      projects.push(parseRemoteProject(item));
    }
    const sessions: RemoteSession[] = [];
    for (const item of recordsFromArray(objGetArray(message, 'sessions'))) {
      sessions.push(parseRemoteSession(item));
    }
    const snapshot: RemoteDashboardSnapshot = {
      devices: devices,
      projects: projects,
      sessions: sessions,
      activePage: parseSessionPageInfo(activePage),
      archivedPage: parseSessionPageInfo(archivedPage),
      serverTime: objGetOptString(message, 'serverTime')
    };
    return snapshot;
  }

  parseSessionMessage(text: string): RemoteSessionEventEnvelope | null {
    let message: Record<string, Object>;
    try {
      message = parseJsonRecord(text);
    } catch (error) {
      return null;
    }
    if (objGetString(message, 'type', '') === 'keepalive') {
      return null;
    }
    try {
      return parseSessionEventEnvelope(message);
    } catch (error) {
      return null;
    }
  }

  private async createTicket(serverUrl: string, authorizationToken: string, clientId: string,
    scope: Record<string, Object>): Promise<RemoteWsTicket> {
    const body: Record<string, Object> = {
      'clientId': clientId,
      'scope': scope
    };
    const response = await this.client.postJson(serverUrl, '/ws-ticket', body, authorizationToken);
    const ticket: RemoteWsTicket = {
      ticket: objGetString(response, 'ticket', ''),
      expiresAt: objGetString(response, 'expiresAt', ''),
      serverTime: objGetString(response, 'serverTime', '')
    };
    return ticket;
  }
}

function parseSessionPageInfo(value: Record<string, Object>): RemoteSessionPageInfo {
  const pageInfo: RemoteSessionPageInfo = {
    hasMore: objGetBool(value, 'hasMore', false),
    nextCursor: objGetOptString(value, 'nextCursor')
  };
  return pageInfo;
}
