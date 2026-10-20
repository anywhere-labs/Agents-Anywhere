export type ConnectorLogLevel =
  | "TRACE"
  | "DEBUG"
  | "INFO"
  | "SUCCESS"
  | "WARNING"
  | "ERROR"
  | "CRITICAL";

export type ConnectorLogSource = "connector" | "bridge";

export type ConnectorLogEntry = {
  seq: number;
  level: ConnectorLogLevel | string;
  message: string;
  time: string;
  name?: string;
  source?: ConnectorLogSource | string;
  details?: string | null;
  exception?: string | null;
  gapBefore?: boolean;
  [key: string]: unknown;
};

export type ConnectorLogQuery = {
  source?: ConnectorLogSource;
  pageSize?: number;
  beforeSeq?: number;
  afterSeq?: number;
};

export type ConnectorLogPage = {
  items: ConnectorLogEntry[];
  firstSeq: number | null;
  lastSeq: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter?: boolean;
  total: number;
  logsPath?: string;
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
  logsPath?: string;
  connectorDir: string;
  resolvedUvPath: string;
  uvMissing: boolean;
  /** The interpreter `uv run` is pinned to; empty when uv chooses one itself. */
  resolvedPythonPath: string;
  uvPath: string;
  pythonPath: string;
  uvPypiIndexUrl: string;
  uvPythonInstallMirror: string;
  logChunkSizeKb: number;
  logRetainChunks: number;
  logRetentionDays: number;
  openAtLogin: boolean;
  startConnectorOnLaunch: boolean;
  silentLaunch: boolean;
  notificationsEnabled: boolean;
};

export type DesktopSettings = {
  openAtLogin: boolean;
  startConnectorOnLaunch: boolean;
  silentLaunch: boolean;
  notificationsEnabled: boolean;
  uvPath: string;
  pythonPath: string;
  uvPypiIndexUrl: string;
  uvPythonInstallMirror: string;
  logChunkSizeKb: number;
  logRetainChunks: number;
  logRetentionDays: number;
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;

export type DesktopNotificationInput = {
  title: string;
  body: string;
  sessionId?: string;
};

export type DesktopNotificationResult = {
  shown: boolean;
  reason?: "disabled" | "unsupported" | "invalid";
};

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
