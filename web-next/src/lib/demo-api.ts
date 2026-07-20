// ─────────────────────────────────────────────────────────────
// Domain types  (mirrors backend OpenAPI / pseudocode shapes)
// ─────────────────────────────────────────────────────────────

export type UserRole = "admin" | "member"

export type AuthConfig = {
  needsBootstrap: boolean
  registrationOpen: boolean
  oauthRegistrationOpen: boolean
  oauthEnabled: boolean
  oauthProviderLabel?: string | null
  setupTokenExpiresAt?: string | null
}

export type AuthResponse = {
  userId: string
  role: UserRole
  accessToken: string
  tokenType: "bearer" | string
}

export type AuthMe = {
  userId: string
  role: UserRole
  disabled: boolean
  avatar?: string | null
}

// ── Dashboard ──────────────────────────────────────────────

export type ConnectorStatus = "online" | "offline"

export type ConnectorView = {
  id: string
  userId: string
  name: string
  deviceOs?: "macos" | "windows" | "linux" | null
  status: ConnectorStatus
  lastSeenAt?: string | null
  runtimeCapabilities: {
    version: number
    lastDiscoveredAt?: string | null
    attached: Record<string, {
      attachedAt: string
      report: {
        selected?: { source: string; path: string; version?: string }
        checked?: Array<{ source: string; path: string; status: "ok" | "failed" | "missing"; reason?: string }>
        error?: { code: string; message: string }
      }
    }>
    disabled: string[]
  }
}

export type SessionStatus = "idle" | "pending" | "running" | "stopping" | "blocked"

export type SessionView = {
  id: string
  connectorId: string
  connectorStatus: ConnectorStatus
  runtime: string
  title?: string | null
  cwd?: string | null
  status: SessionStatus
  takeover: boolean
  pinned: boolean
  archived: boolean
  unread: boolean
  lastReadSeq: number
  updatedSeq: number
  effectiveRunMode?: "chat" | "terminal" | null
  runtimeSettings?: Record<string, unknown> | null
  updatedAt: string // UI convenience field (not in backend)
}

// ── Admin ──────────────────────────────────────────────────

export type AdminUser = {
  userId: string
  role: "admin" | "member"
  disabled: boolean
  avatar?: string | null
  createdAt: string
  updatedAt: string
}

export type InstanceSettings = {
  registrationOpen: boolean
  oauthRegistrationOpen: boolean
  oauth?: {
    enabled: boolean
    provider: string
    label: string
    authorizeUrl: string
    tokenUrl: string
    userInfoUrl: string
    clientId: string
    scopes: string
    usernameClaim: string
    subjectClaim: string
    emailClaim: string
    nameClaim: string
    clientSecret?: string
  } | null
}

export type ServiceInfo = {
  endpoint: string
  version: string
  database: string
  databasePath?: string | null
  startedAt: string
  uptimeSeconds: number
}

// ── Connector detail ───────────────────────────────────────

export type ConnectorWorkspace = {
  /** Unique workspace path on the connector */
  path: string
  /** Display name (last segment of path) */
  name: string
  /** Number of sessions in this workspace */
  sessionCount: number
  /** Last active time */
  lastActiveAt?: string | null
}

export type AgentConfig = {
  /** Agent runtime name, e.g. "Codex" */
  name: string
  /** e.g. "ask_for_approval" | "auto_edit" | "full_auto" */
  defaultPermissionMode: string
  /** e.g. "codex-mini-latest" | "o4-mini" */
  defaultModel: string
  /** e.g. "low" | "medium" | "high" */
  defaultEffort: string
}

// ── Timeline ───────────────────────────────────────────────

export type TimelineItem = {
  id: string
  sessionId: string
  turnId?: string | null
  type: "turn.start" | "turn.end" | "message" | "tool" | "artifact" | "system"
  status: "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted"
  role?: "user" | "assistant" | "system" | "tool" | null
  content: Record<string, unknown>
  source: Record<string, unknown>
  orderSeq: number
  revision: number
  contentHash: string
  updatedSeq: number
}

export type Approval = {
  id: string
  sessionId: string
  turnId?: string | null
  status: "pending" | "approved" | "approved_for_session" | "rejected" | "cancelled" | "expired"
  kind: "command" | "file_change" | "permission" | "tool_call" | "input_request" | "unknown"
  targetItemId?: string | null
  title: string
  description?: string | null
  payload: unknown
  choices: Array<"approve" | "approve_for_session" | "reject" | "cancel">
  updatedSeq: number
}

// ── FS ─────────────────────────────────────────────────────

export type FsEntry = {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other" | string
  size?: number | null
  modifiedAt?: string | null
}

// ─────────────────────────────────────────────────────────────
// Mock data fixtures
// ─────────────────────────────────────────────────────────────

const MOCK_TOKEN = "mock-token"

const mockConnectors: ConnectorView[] = [
  {
    id: "conn-1",
    userId: "t4wefan",
    name: "windowshome",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    runtimeCapabilities: {
      version: 1,
      lastDiscoveredAt: new Date().toISOString(),
      attached: {
        Codex: {
          attachedAt: new Date(Date.now() - 3600000).toISOString(),
          report: { selected: { source: "npm", path: "/usr/local/bin/codex", version: "1.2.0" } },
        },
        Claude: {
          attachedAt: new Date(Date.now() - 7200000).toISOString(),
          report: { selected: { source: "brew", path: "/opt/homebrew/bin/claude", version: "0.3.1" } },
        },
      },
      disabled: [],
    },
  },
  {
    id: "conn-2",
    userId: "t4wefan",
    name: "windowslaptop",
    status: "offline",
    lastSeenAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    runtimeCapabilities: { version: 1, attached: {}, disabled: [] },
  },
  {
    id: "conn-3",
    userId: "t4wefan",
    name: "macmini",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    runtimeCapabilities: {
      version: 1,
      lastDiscoveredAt: new Date().toISOString(),
      attached: {
        Codex: {
          attachedAt: new Date(Date.now() - 1800000).toISOString(),
          report: { selected: { source: "brew", path: "/opt/homebrew/bin/codex", version: "1.2.0" } },
        },
        Claude: {
          attachedAt: new Date(Date.now() - 3600000).toISOString(),
          report: { selected: { source: "brew", path: "/opt/homebrew/bin/claude", version: "0.3.1" } },
        },
      },
      disabled: [],
    },
  },
  {
    id: "conn-4",
    userId: "t4wefan",
    name: "macbookair",
    status: "offline",
    lastSeenAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    runtimeCapabilities: { version: 1, attached: {}, disabled: [] },
  },
]

const mockSessions: SessionView[] = [
  { id: "s1", connectorId: "conn-3", connectorStatus: "online", runtime: "Codex", title: "创建剪贴板延迟输入CLI", cwd: "/Users/t4wefan/code/local/cliptype", status: "running", takeover: true, pinned: false, archived: false, unread: false, lastReadSeq: 0, updatedSeq: 42, effectiveRunMode: "chat", updatedAt: "刚刚" },
  { id: "s2", connectorId: "conn-1", connectorStatus: "online", runtime: "Codex", title: "生成 ed SSH 密钥和公钥", cwd: "C:\\Users\\admin", status: "idle", takeover: false, pinned: false, archived: false, unread: true, lastReadSeq: 5, updatedSeq: 8, effectiveRunMode: "chat", updatedAt: "12 分钟前" },
  { id: "s3", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "看一下 fastfetch", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 12, updatedSeq: 12, effectiveRunMode: "chat", updatedAt: "1 小时前" },
  { id: "s4", connectorId: "conn-1", connectorStatus: "online", runtime: "Codex", title: "更新一下仓库先", cwd: "C:\\Users\\admin\\repos\\agents-anywhere", status: "idle", takeover: false, pinned: true, archived: false, unread: false, lastReadSeq: 30, updatedSeq: 30, effectiveRunMode: "terminal", updatedAt: "2 小时前" },
  { id: "s5", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "现在仓库是最新的吗", cwd: "/Users/t4wefan/repos", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 10, updatedSeq: 10, updatedAt: "3 小时前" },
  { id: "s6", connectorId: "conn-4", connectorStatus: "offline", runtime: "Claude", title: "这是猫还是老鼠", cwd: null, status: "blocked", takeover: false, pinned: false, archived: false, unread: true, lastReadSeq: 2, updatedSeq: 5, updatedAt: "昨天" },
  { id: "s7", connectorId: "conn-2", connectorStatus: "offline", runtime: "Codex", title: "现在的 agents anywhere…", cwd: "C:\\Users\\admin\\dev", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 20, updatedSeq: 20, updatedAt: "昨天" },
  { id: "s8", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "你好", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 3, updatedSeq: 3, updatedAt: "昨天" },
  { id: "s9", connectorId: "conn-1", connectorStatus: "online", runtime: "Codex", title: "# Context from my IDE s…", cwd: "C:\\Users\\admin\\work", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 7, updatedSeq: 7, updatedAt: "2 天前" },
  { id: "s10", connectorId: "conn-3", connectorStatus: "online", runtime: "Codex", title: "Fix missing font warnin…", cwd: "/Users/t4wefan/code/web", status: "blocked", takeover: false, pinned: false, archived: false, unread: true, lastReadSeq: 4, updatedSeq: 9, updatedAt: "2 天前" },
  { id: "s11", connectorId: "conn-1", connectorStatus: "online", runtime: "Codex", title: "检查 connector 和 deskt…", cwd: "C:\\Users\\admin", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 15, updatedSeq: 15, updatedAt: "3 天前" },
  { id: "s12", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "https://github.com/Coi…", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 6, updatedSeq: 6, updatedAt: "3 天前" },
  { id: "s13", connectorId: "conn-4", connectorStatus: "offline", runtime: "Claude", title: "计算 MacBook Air 横向 …", cwd: null, status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 5, updatedSeq: 5, updatedAt: "4 天前" },
  { id: "s14", connectorId: "conn-1", connectorStatus: "online", runtime: "Codex", title: "创建 PyQt6 CV 基础项目", cwd: "C:\\Users\\admin\\projects\\cv", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 22, updatedSeq: 22, updatedAt: "5 天前" },
  { id: "s15", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "你可以控制我的电脑吗", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 4, updatedSeq: 4, updatedAt: "6 天前" },
  { id: "s16", connectorId: "conn-2", connectorStatus: "offline", runtime: "Codex", title: "分析 PixPin 崩溃原因", cwd: null, status: "blocked", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 8, updatedSeq: 11, updatedAt: "上周" },
  { id: "s17", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "你看一下现在是什么情况", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 9, updatedSeq: 9, updatedAt: "上周" },
  { id: "s18", connectorId: "conn-4", connectorStatus: "offline", runtime: "Claude", title: "你是美国人吗", cwd: null, status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 2, updatedSeq: 2, updatedAt: "上周" },
  { id: "s19", connectorId: "conn-3", connectorStatus: "online", runtime: "Claude", title: "人民币是信用货币吗", cwd: "/Users/t4wefan", status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 3, updatedSeq: 3, updatedAt: "上周" },
  { id: "s20", connectorId: "conn-4", connectorStatus: "offline", runtime: "Claude", title: "这是猫还是狗", cwd: null, status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 1, updatedSeq: 1, updatedAt: "上周" },
  { id: "s21", connectorId: "conn-4", connectorStatus: "offline", runtime: "Claude", title: "这是猫还是鼠.", cwd: null, status: "idle", takeover: false, pinned: false, archived: false, unread: false, lastReadSeq: 1, updatedSeq: 1, updatedAt: "上周" },
]

const mockMe: AuthMe = {
  userId: "t4wefan",
  role: "admin",
  disabled: false,
  avatar: null,
}

const mockAuthConfig: AuthConfig = {
  needsBootstrap: false,
  registrationOpen: true,
  oauthRegistrationOpen: true,
  oauthEnabled: true,
  oauthProviderLabel: "GitLab",
  setupTokenExpiresAt: null,
}

let mockUsers: AdminUser[] = [
  { userId: "t4wefan", role: "admin", disabled: false, avatar: null, createdAt: new Date(Date.now() - 86400000 * 7).toISOString(), updatedAt: new Date(Date.now() - 86400000 * 6).toISOString() },
  { userId: "bensonwang", role: "admin", disabled: false, avatar: null, createdAt: new Date(Date.now() - 86400000 * 3).toISOString(), updatedAt: new Date(Date.now() - 86400000 * 3).toISOString() },
  { userId: "2522", role: "member", disabled: false, avatar: null, createdAt: new Date(Date.now() - 86400000 * 2).toISOString(), updatedAt: new Date(Date.now() - 86400000 * 2).toISOString() },
]

let mockInstanceSettings: InstanceSettings = {
  registrationOpen: true,
  oauthRegistrationOpen: true,
  oauth: {
    enabled: true,
    provider: "gitlab",
    label: "GitLab",
    authorizeUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    userInfoUrl: "https://gitlab.com/api/v4/user",
    clientId: "your-client-id",
    scopes: "read_user",
    usernameClaim: "username",
    subjectClaim: "sub",
    emailClaim: "email",
    nameClaim: "name",
  },
}

const mockServiceInfo: ServiceInfo = {
  endpoint: "https://anywhere.t4wefan.pub",
  version: "0.1.7.2",
  database: "PostgreSQL",
  databasePath: "postgres:5432/agents_anywhere",
  startedAt: new Date(Date.now() - 86400000 * 7).toISOString(),
  uptimeSeconds: 86400 * 7,
}

/** Map from connectorId → workspaces */
const mockWorkspaces: Record<string, ConnectorWorkspace[]> = {
  "conn-1": [
    { path: "C:\\Users\\admin\\repos\\agents-anywhere", name: "agents-anywhere", sessionCount: 4, lastActiveAt: new Date(Date.now() - 3600000 * 2).toISOString() },
    { path: "C:\\Users\\admin\\projects\\cv", name: "cv", sessionCount: 3, lastActiveAt: new Date(Date.now() - 86400000).toISOString() },
    { path: "C:\\Users\\admin\\work", name: "work", sessionCount: 2, lastActiveAt: new Date(Date.now() - 86400000 * 2).toISOString() },
    { path: "C:\\Users\\admin\\dev", name: "dev", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000 * 3).toISOString() },
    { path: "C:\\Users\\admin", name: "admin (home)", sessionCount: 6, lastActiveAt: new Date(Date.now() - 3600000).toISOString() },
    { path: "C:\\Users\\admin\\Documents\\notes", name: "notes", sessionCount: 2, lastActiveAt: new Date(Date.now() - 86400000 * 4).toISOString() },
    { path: "C:\\Users\\admin\\Desktop", name: "Desktop", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000 * 5).toISOString() },
  ],
  "conn-2": [
    { path: "C:\\Users\\admin\\dev", name: "dev", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000 * 7).toISOString() },
  ],
  "conn-3": [
    { path: "/Users/t4wefan/Documents/Codex/py-cli-uv-tools", name: "py-cli-uv-tools", sessionCount: 1, lastActiveAt: new Date(Date.now() - 3600000).toISOString() },
    { path: "/Users/t4wefan/Documents/Codex/ed-ssh", name: "ed-ssh", sessionCount: 1, lastActiveAt: new Date(Date.now() - 3600000 * 2).toISOString() },
    { path: "/Users/t4wefan", name: "t4wefan", sessionCount: 26, lastActiveAt: new Date(Date.now() - 1800000).toISOString() },
    { path: "/Users/t4wefan/Documents/Codex/macbook-air-ppi", name: "macbook-air-ppi", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000).toISOString() },
    { path: "/Users/t4wefan/Documents/Codex/files-mentioned-by-the-user-last", name: "files-mentioned-by-the-user-last", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000).toISOString() },
    { path: "/Users/t4wefan/code/github/Agents-Anywhere-dev", name: "Agents-Anywhere-dev", sessionCount: 13, lastActiveAt: new Date(Date.now() - 3600000 * 3).toISOString() },
    { path: "/Users/t4wefan/code/local/cv-qt", name: "cv-qt", sessionCount: 4, lastActiveAt: new Date(Date.now() - 86400000 * 2).toISOString() },
    { path: "/Users/t4wefan/Documents/Codex/2026-06-20", name: "https-www-macrumors-com-2026-…", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000 * 3).toISOString() },
    { path: "/Users/t4wefan/Documents/Codex/zhiyiyo-pyqt-fluent-widgets-git-h", name: "zhiyiyo-pyqt-fluent-widgets-git-h…", sessionCount: 1, lastActiveAt: new Date(Date.now() - 86400000 * 4).toISOString() },
  ],
  "conn-4": [
    { path: "/Users/macbookair", name: "macbookair (home)", sessionCount: 3, lastActiveAt: new Date(Date.now() - 86400000 * 5).toISOString() },
  ],
}

/** Default agent config per connector. In real API this lives on the connector. */
const mockAgentConfigs: Record<string, AgentConfig[]> = {
  "conn-1": [
    { name: "Codex", defaultPermissionMode: "ask_for_approval", defaultModel: "codex-mini-latest", defaultEffort: "low" },
    { name: "Claude", defaultPermissionMode: "auto_edit", defaultModel: "claude-opus-4-5", defaultEffort: "medium" },
  ],
  "conn-3": [
    { name: "Codex", defaultPermissionMode: "ask_for_approval", defaultModel: "o4-mini", defaultEffort: "low" },
    { name: "Claude", defaultPermissionMode: "ask_for_approval", defaultModel: "claude-opus-4-5", defaultEffort: "medium" },
  ],
}

// ─────────────────────────────────────────────────────────────
// Mock API functions  (same signatures as the real API contract)
// ─────────────────────────────────────────────────────────────

function delay(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Auth
export async function getAuthConfig(): Promise<AuthConfig> {
  await delay()
  return { ...mockAuthConfig }
}

export async function login(_input: { userId: string; password?: string }): Promise<AuthResponse> {
  await delay(200)
  return { userId: mockMe.userId, role: mockMe.role, accessToken: MOCK_TOKEN, tokenType: "bearer" }
}

export async function register(_input: { userId: string; password?: string }): Promise<AuthResponse> {
  await delay(200)
  return { userId: _input.userId, role: "member", accessToken: MOCK_TOKEN, tokenType: "bearer" }
}

export async function getMe(_token: string): Promise<AuthMe> {
  await delay()
  return { ...mockMe }
}

// Dashboard
export async function listConnectors(_token: string): Promise<{ connectors: ConnectorView[] }> {
  await delay()
  return { connectors: mockConnectors }
}

export async function listSessions(_token: string): Promise<{ sessions: SessionView[] }> {
  await delay()
  return { sessions: mockSessions }
}

export async function getConnector(_token: string, connectorId: string): Promise<ConnectorView | null> {
  await delay()
  return mockConnectors.find((c) => c.id === connectorId) ?? null
}

export async function revokeConnector(_token: string, connectorId: string): Promise<void> {
  await delay(200)
  const c = mockConnectors.find((c) => c.id === connectorId)
  if (c) c.status = "offline"
}

export async function listConnectorWorkspaces(
  _token: string,
  connectorId: string,
): Promise<{ workspaces: ConnectorWorkspace[] }> {
  await delay()
  return { workspaces: mockWorkspaces[connectorId] ?? [] }
}

export async function listConnectorSessions(
  _token: string,
  connectorId: string,
): Promise<{ sessions: SessionView[] }> {
  await delay()
  return { sessions: mockSessions.filter((s) => s.connectorId === connectorId) }
}

export async function getAgentConfigs(
  _token: string,
  connectorId: string,
): Promise<{ agents: AgentConfig[] }> {
  await delay()
  return { agents: mockAgentConfigs[connectorId] ?? [] }
}

export async function updateAgentConfig(
  _token: string,
  connectorId: string,
  agentName: string,
  patch: Partial<AgentConfig>,
): Promise<AgentConfig> {
  await delay(200)
  const list = mockAgentConfigs[connectorId] ?? []
  const idx = list.findIndex((a) => a.name === agentName)
  if (idx !== -1) {
    const current = list[idx]
    if (current) {
      const updated: AgentConfig = { ...current, ...patch }
      list[idx] = updated
      return updated
    }
  }
  const newConfig: AgentConfig = {
    name: agentName,
    defaultPermissionMode: patch.defaultPermissionMode ?? "ask_for_approval",
    defaultModel: patch.defaultModel ?? "codex-mini-latest",
    defaultEffort: patch.defaultEffort ?? "low",
  }
  list.push(newConfig)
  mockAgentConfigs[connectorId] = list
  return newConfig
}

export async function listWorkspaceSessions(
  _token: string,
  connectorId: string,
  workspacePath: string,
): Promise<{ sessions: SessionView[] }> {
  await delay()
  return {
    sessions: mockSessions.filter(
      (s) => s.connectorId === connectorId && s.cwd === workspacePath,
    ),
  }
}

export async function patchSession(
  _token: string,
  sessionId: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean },
): Promise<{ session: SessionView }> {
  await delay()
  const idx = mockSessions.findIndex((s) => s.id === sessionId)
  const current = idx !== -1 ? mockSessions[idx] : undefined
  if (current) Object.assign(current, patch)
  const session = mockSessions[idx] ?? mockSessions[0]
  if (!session) throw new Error("Session not found")
  return { session }
}

// Admin
export async function listUsers(_token: string): Promise<{ users: AdminUser[] }> {
  await delay()
  return { users: [...mockUsers] }
}

export async function createUser(
  _token: string,
  input: { userId: string; role: "admin" | "member" },
): Promise<AdminUser> {
  await delay(200)
  const user: AdminUser = {
    userId: input.userId,
    role: input.role,
    disabled: false,
    avatar: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  mockUsers = [...mockUsers, user]
  return user
}

export async function updateUser(
  _token: string,
  userId: string,
  patch: { role?: "admin" | "member"; disabled?: boolean },
): Promise<AdminUser> {
  await delay()
  const idx = mockUsers.findIndex((u) => u.userId === userId)
  if (idx !== -1) {
    const current = mockUsers[idx]
    if (current) {
      mockUsers[idx] = { ...current, ...patch, updatedAt: new Date().toISOString() }
    }
  }
  const user = mockUsers[idx]
  if (!user) throw new Error("User not found")
  return user
}

export async function deleteUser(_token: string, userId: string): Promise<void> {
  await delay()
  mockUsers = mockUsers.filter((u) => u.userId !== userId)
}

export async function getSettings(_token: string): Promise<InstanceSettings> {
  await delay()
  return { ...mockInstanceSettings, oauth: mockInstanceSettings.oauth ? { ...mockInstanceSettings.oauth } : null }
}

export async function updateSettings(
  _token: string,
  patch: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  await delay()
  mockInstanceSettings = { ...mockInstanceSettings, ...patch }
  return { ...mockInstanceSettings }
}

export async function getServiceInfo(_token: string): Promise<ServiceInfo> {
  await delay()
  return { ...mockServiceInfo }
}

// ── Connector pairing ──────────────────────────────────────

export type ConnectorCreateResult = {
  connectorId: string
  token: string
}

export type ConnectorPairCodeResult = {
  pairCode: string
}

let mockNewConnectors: ConnectorView[] = []

export async function createConnector(
  _token: string,
  input: { name: string },
): Promise<ConnectorCreateResult> {
  await delay(300)
  const id = `conn-new-${Date.now()}`
  const connector: ConnectorView = {
    id,
    userId: "t4wefan",
    name: input.name,
    status: "offline",
    lastSeenAt: null,
    runtimeCapabilities: { version: 1, attached: {}, disabled: [] },
  }
  mockNewConnectors.push(connector)
  mockConnectors.push(connector)
  return { connectorId: id, token: `tok_${id}_${Math.random().toString(36).slice(2)}` }
}

export async function deleteConnector(_token: string, connectorId: string): Promise<void> {
  await delay(200)
  const idx = mockConnectors.findIndex((c) => c.id === connectorId)
  if (idx !== -1) mockConnectors.splice(idx, 1)
}

export async function pollConnectorOnline(
  _token: string,
  connectorId: string,
): Promise<{ online: boolean }> {
  await delay(1000)
  // After ~3 polls the device comes "online" in the mock
  const connector = mockConnectors.find((c) => c.id === connectorId)
  if (!connector) return { online: false }
  // Increment a counter stored on the connector id to simulate eventual online
  const key = `__poll_${connectorId}`
  const pollState = globalThis as unknown as Record<string, number>
  const count = (pollState[key] ?? 0) + 1;
  pollState[key] = count
  if (count >= 3) {
    connector.status = "online"
    connector.lastSeenAt = new Date().toISOString()
    return { online: true }
  }
  return { online: false }
}

export async function getPairCode(
  _token: string,
  _connectorId: string,
): Promise<ConnectorPairCodeResult> {
  await delay(200)
  // Generate a random 6-char alphanumeric code
  const code = Math.random().toString(36).slice(2, 8).toUpperCase()
  return { pairCode: code }
}

export async function claimConnector(
  _token: string,
  connectorId: string,
  _pairCode: string,
): Promise<{ ok: boolean }> {
  await delay(400)
  // Reset the poll counter so polling starts fresh after claim
  const key = `__poll_${connectorId}`;
  const pollState = globalThis as unknown as Record<string, number>
  pollState[key] = 0
  return { ok: true }
}

// FS (for workspace picker)
export async function fsList(
  _token: string,
  _connectorId: string,
  input: { root: string; path?: string | null },
): Promise<{ ok: boolean; result: { path: string; entries: FsEntry[]; truncated?: boolean } }> {
  await delay(120)
  const isWindows = input.root.includes("\\") || /^[A-Z]:/.test(input.root)
  const base: FsEntry[] = isWindows
    ? [
        { name: "Desktop", path: "Desktop", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "Documents", path: "Documents", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "Downloads", path: "Downloads", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "projects", path: "projects", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "repos", path: "repos", type: "directory", modifiedAt: new Date().toISOString() },
        { name: ".gitconfig", path: ".gitconfig", type: "file", size: 512, modifiedAt: new Date().toISOString() },
      ]
    : [
        { name: "code", path: "code", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "repos", path: "repos", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "Desktop", path: "Desktop", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "Documents", path: "Documents", type: "directory", modifiedAt: new Date().toISOString() },
        { name: "Downloads", path: "Downloads", type: "directory", modifiedAt: new Date().toISOString() },
        { name: ".zshrc", path: ".zshrc", type: "file", size: 2048, modifiedAt: new Date().toISOString() },
        { name: ".gitconfig", path: ".gitconfig", type: "file", size: 512, modifiedAt: new Date().toISOString() },
      ]
  return { ok: true, result: { path: input.path ?? ".", entries: base } }
}

// ─────────────────────────────────────────────────────────────
// UI filter helpers (pure, no API)
// ─────────────────────────────────────────────────────────────

export type FilterValue = {
  connectorId: string | "all"
  runtime: string | "all"
  status: SessionStatus | "all"
}

export const defaultFilter: FilterValue = { connectorId: "all", runtime: "all", status: "all" }

export function filterSessions(
  list: SessionView[],
  filter: FilterValue,
  query: string,
): SessionView[] {
  return list.filter((s) => {
    if (filter.connectorId !== "all" && s.connectorId !== filter.connectorId) return false
    if (filter.runtime !== "all" && s.runtime !== filter.runtime) return false
    if (filter.status !== "all" && s.status !== filter.status) return false
    if (query.trim() && !(s.title ?? "").toLowerCase().includes(query.trim().toLowerCase())) return false
    return true
  })
}
