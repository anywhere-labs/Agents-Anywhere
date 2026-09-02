export type ConnectorLogLevel =
  | "TRACE"
  | "DEBUG"
  | "INFO"
  | "SUCCESS"
  | "WARNING"
  | "ERROR"
  | "CRITICAL";

export type ConnectorLogEntry = {
  seq: number;
  level: ConnectorLogLevel | string;
  message: string;
  time: string;
  [key: string]: unknown;
};

export type ConnectorLogQuery = {
  pageSize?: number;
  beforeSeq?: number;
  afterSeq?: number;
};

export type ConnectorLogPage = {
  items: ConnectorLogEntry[];
  firstSeq: number | null;
  lastSeq: number | null;
  hasMoreBefore: boolean;
  total: number;
};

export type ConnectorPrivateConfig = {
  serverUrl: string;
  connectorId: string;
  connectorToken: string;
  heartbeatSeconds?: number;
  reconnectSeconds?: number;
  syncExistingOnConnect?: boolean;
  syncIntervalSeconds?: number;
  statePath?: string | null;
};

export type ConnectorPublicConfig = Omit<ConnectorPrivateConfig, "connectorToken"> & {
  hasCredential: boolean;
};

export type ConnectorConfigPatch = Pick<
  ConnectorPrivateConfig,
  | "heartbeatSeconds"
  | "reconnectSeconds"
  | "syncExistingOnConnect"
  | "syncIntervalSeconds"
  | "statePath"
>;

export type LocalDesktopBinding = {
  connectorId: string;
  serverUrl: string;
  name: string;
  ownerUserId: string;
  manualDisconnected: boolean;
};

export type PublicLocalDesktopBinding = LocalDesktopBinding & {
  hasCredential: boolean;
};

export type ConnectorState = {
  platform: NodeJS.Platform;
  status: string;
  running: boolean;
  authFailed: boolean;
  lastError: string | null;
  hasConfig: boolean;
  hasCredential: boolean;
  connectorId: string;
  serverUrl: string;
  manualDisconnected: boolean;
  setupIssue: string;
  configPath: string;
  runtimePath: string;
  dataPath: string;
  connectorDir: string;
  resolvedUvPath: string;
  uvMissing: boolean;
  uvPath: string;
  uvPypiIndexUrl: string;
  logChunkSizeKb: number;
  logRetainChunks: number;
  logRetentionDays: number;
  openAtLogin: boolean;
  startConnectorOnLaunch: boolean;
  silentLaunch: boolean;
};

export type DesktopSettings = {
  openAtLogin: boolean;
  startConnectorOnLaunch: boolean;
  silentLaunch: boolean;
  uvPath: string;
  uvPypiIndexUrl: string;
  logChunkSizeKb: number;
  logRetainChunks: number;
  logRetentionDays: number;
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;

export type DesktopDeviceAuthInput = {
  userToken: string;
  userId: string;
  serverUrl?: string;
};

export type DesktopFactoryResetInput = {
  userToken?: string;
  userId?: string;
  serverUrl?: string;
  forceLocal?: boolean;
};

export type DesktopDeviceProvisionInput = DesktopDeviceAuthInput & {
  name?: string;
};

export type DesktopDeviceReconnectInput = DesktopDeviceAuthInput & {
  connectorId?: string;
};

export type DesktopDeviceNameInput = {
  name: string;
};

export type RpcErrorPayload = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type RpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: RpcErrorPayload;
  method?: string;
  params?: unknown;
};
