import { RemoteDevice } from './DevicesApi';
import { RemoteProject, RemoteSession, RemoteSessionEventEnvelope } from './SessionDtos';

export interface RemoteWsTicket {
  ticket: string;
  expiresAt: string;
  serverTime: string;
}

export interface RemoteSessionPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RemoteDashboardSnapshot {
  devices: RemoteDevice[];
  projects: RemoteProject[];
  sessions: RemoteSession[];
  activePage: RemoteSessionPageInfo;
  archivedPage: RemoteSessionPageInfo;
  serverTime: string | null;
}

export interface RemoteEventRecoveryResponse {
  events: RemoteSessionEventEnvelope[];
  nextCursor: string;
  snapshotRequired: boolean;
  serverTime: string | null;
}
