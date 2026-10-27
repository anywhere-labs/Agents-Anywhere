import { fileIo, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { vibrator } from '@kit.SensorServiceKit';
import { componentUtils, curves } from '@kit.ArkUI';
import { abilityAccessCtrl } from '@kit.AbilityKit';
import { Callback } from '@kit.BasicServicesKit';
import { ApiClient } from 'network';
import { SessionsApi } from 'network';
import {
  RemoteSession,
  RemoteProject,
  RemoteSessionCreateAndStartRequest,
  RemoteInlineAttachmentRef,
  buildRemoteInlineAttachmentRef
} from 'network';
import { SharedApiClient } from '../api/SharedApiClient';
import {
  RemoteDevice,
  RemoteDeviceRuntime,
  DevicesApi,
  MODEL_CATALOG_CAPABILITY,
  PERMISSION_CATALOG_CAPABILITY,
  RemoteModelCatalog,
  RemoteModelItem,
  RemotePermissionCatalog,
  RemotePermissionItem,
  RemoteReasoningItem,
  RemoteRuntimeCapabilityDetail,
  findRuntimeCapability,
  isRuntimeCapabilityUsable
} from 'network';
import { FilesApi, RemoteDirectoryEntry } from 'network';
import { RealtimeApi } from 'network';
import { RemoteDashboardSnapshot } from 'network';
import { RealtimeSocketListener, RealtimeWebSocket } from 'network';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import {
  SidebarViewModeStore,
  SIDEBAR_VIEW_MODE_KEY,
  SIDEBAR_VIEW_PROJECT,
  SIDEBAR_VIEW_SESSION
} from '../auth/SidebarViewModeStore';
import {
  NewSessionPreferenceStore,
  NewSessionStoredSelection
} from '../auth/NewSessionPreferenceStore';
import {
  HomeProjectPreferenceStore,
  PROJECT_STATUS_FILTER_ACTIVE,
  PROJECT_STATUS_FILTER_ARCHIVED,
  PROJECT_STATUS_FILTER_ALL
} from '../auth/HomeProjectPreferenceStore';
import { ApiException, errorMessageFrom } from 'common';
import { NetworkMonitor } from 'common';
import {
  initialRemoteFilePath,
  isHiddenFileEntryName,
  isWindowsDeviceOs,
  isWindowsDriveRootPath,
  isWindowsDriveStylePath,
  windowsDriveRootOf,
  windowsParentPath
} from 'common';
import {
  RuntimePermissionStrings,
  LocalizedRuntimePermission,
  localizeRuntimePermission
} from 'common';
import { availableProjectName, workspaceProject, workspaceProjectName } from '../common/WorkspaceProjects';
import {
  NewSessionSheetOverlay,
  NewSessionPendingAttachment,
  NewSessionCatalogOption,
  NewSessionCatalogView,
  NewSessionBrowserEntryView,
  NewSessionBrowserView,
  emptyNewSessionCatalogView,
  emptyNewSessionBrowserView
} from '../components/NewSessionSheetOverlay';
import { sessionListIndicator, HomeSessionStatusIndicator } from '../components/HomeSessionIndicators';
import { SessionAgentIcon } from '../components/SessionAgentIcon';
import { HomeProjectActionMenuOverlay, HomeMenuAnchor } from '../components/HomeProjectActionMenuOverlay';
import { HomeProjectEditSheetOverlay } from '../components/HomeProjectEditSheetOverlay';
import { HomeProjectArchiveDialog } from '../components/HomeProjectArchiveDialog';
import { HomeProjectFilterOverlay, HomeFilterDeviceOption } from '../components/HomeProjectFilterOverlay';
import { SessionActionMenuOverlay } from '../components/SessionActionMenuOverlay';
import { EmptyState, ErrorState } from '../components/StateViews';
import { StringInputDialog } from '../components/StringInputDialog';
import { ProfileDrawerOverlay } from '../components/ProfileDrawerOverlay';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
// Mirrors Android MAX_CREATE_ATTACHMENTS / MAX_CREATE_ATTACHMENT_BYTES.
const MAX_NEW_SESSION_ATTACHMENTS = 10;
const MAX_NEW_SESSION_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const HOME_SESSIONS_LIMIT = 100;
const PROJECT_SESSIONS_LIMIT = 100;
const PROJECT_SESSION_CACHE_MS = 30000;
const LOG_TAG = 'HomePage';

// Mirrors Android RealtimeRetry.reconnectDelayMillis: exponential backoff with
// a 30s cap and ±25% jitter.
function dashboardRetryDelayMs(attempt: number): number {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  const exponent = safeAttempt > 5 ? 5 : safeAttempt;
  const base = Math.min(RETRY_BASE_DELAY_MS * (1 << exponent), RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(base * 0.25 * Math.random());
  return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
}

// Mirrors Android SidebarSelectors.timestampMillis. The server may emit
// microsecond-precision fractional seconds which Date.parse rejects outright,
// so the fraction is clamped to milliseconds before parsing.
function timestampMillis(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  let normalized = value;
  const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(value);
  if (match !== null) {
    let fraction = match[2] ?? '';
    if (fraction.length > 3) {
      fraction = fraction.substring(0, 3);
    }
    const rest = match[3] ?? '';
    normalized = `${match[1]}${fraction.length > 0 ? '.' + fraction : ''}${rest}`;
  }
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function archiveStatesForStatus(status: string): boolean[] {
  if (status === PROJECT_STATUS_FILTER_ACTIVE) {
    return [false];
  }
  if (status === PROJECT_STATUS_FILTER_ARCHIVED) {
    return [true];
  }
  return [false, true];
}

// Mirrors Android SidebarSelectors.projectSessionMatchesStatus: the Active
// status hides pinned sessions (they render in the pinned section instead),
// All shows archived plus unpinned ones.
function projectSessionMatchesStatus(item: SessionListItem, status: string): boolean {
  if (status === PROJECT_STATUS_FILTER_ACTIVE) {
    return !item.archived && !item.pinned;
  }
  if (status === PROJECT_STATUS_FILTER_ARCHIVED) {
    return item.archived;
  }
  return item.archived || !item.pinned;
}

// Mirrors Android SidebarSelectors.projectHasVisibleSessions without the
// sidebarSessionCounts fast path: when no device/agent filter is set a
// manually created project always shows, other projects need at least one
// session matching the status filter.
function projectHasVisibleSessions(project: RemoteProject, allSessions: SessionListItem[],
  status: string, filterDeviceId: string, filterRuntime: string): boolean {
  const filterActive = filterDeviceId.length > 0 || filterRuntime.length > 0;
  if (filterActive) {
    if (filterDeviceId.length > 0 && project.connectorId !== filterDeviceId) {
      return false;
    }
    for (const item of allSessions) {
      if (item.projectId === project.id && projectSessionMatchesStatus(item, status) &&
        (filterDeviceId.length === 0 || item.connectorId === filterDeviceId) &&
        (filterRuntime.length === 0 || item.runtime === filterRuntime)) {
        return true;
      }
    }
    return false;
  }
  if (project.manuallyCreated) {
    return true;
  }
  for (const item of allSessions) {
    if (item.projectId === project.id && projectSessionMatchesStatus(item, status)) {
      return true;
    }
  }
  return false;
}

// Mirrors Android SidebarSelectors.sortProjectsByActivity: empty manual
// projects sink to the bottom, everything else sorts by last activity
// (project field or newest session), then by creation time, name and id.
function projectIsEmptyForSort(project: RemoteProject, activity: Map<string, number>): boolean {
  return project.manuallyCreated && (project.lastActivityAt ?? '').length === 0 &&
    !activity.has(project.id) && project.activeSessionCount === 0;
}

function sortProjectsByActivity(projects: RemoteProject[], allSessions: SessionListItem[]): RemoteProject[] {
  const activity: Map<string, number> = new Map<string, number>();
  for (const item of allSessions) {
    if (item.projectId !== null && item.projectId.length > 0) {
      const value = timestampMillis(item.sortKey);
      const existing = activity.get(item.projectId);
      if (existing === undefined || value > existing) {
        activity.set(item.projectId, value);
      }
    }
  }
  const ordered: RemoteProject[] = projects.slice(0);
  ordered.sort((left: RemoteProject, right: RemoteProject): number => {
    const leftEmpty = projectIsEmptyForSort(left, activity);
    const rightEmpty = projectIsEmptyForSort(right, activity);
    if (leftEmpty !== rightEmpty) {
      return leftEmpty ? 1 : -1;
    }
    const leftActivity = Math.max(timestampMillis(left.lastActivityAt ?? ''), activity.get(left.id) ?? 0);
    const rightActivity = Math.max(timestampMillis(right.lastActivityAt ?? ''), activity.get(right.id) ?? 0);
    if (leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    const byCreated = timestampMillis(right.createdAt ?? '') - timestampMillis(left.createdAt ?? '');
    if (byCreated !== 0) {
      return byCreated;
    }
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return left.id.localeCompare(right.id);
  });
  return ordered;
}

interface SessionListItem {
  id: string;
  connectorId: string;
  runtime: string;
  title: string;
  runtimeLabel: string;
  statusLabel: string;
  unread: boolean;
  connectorStatus: string;
  pinned: boolean;
  archived: boolean;
  projectId: string | null;
  sortKey: string;
}

// One rendered row of the project tree list: a section header, a project row
// or one of its expanded children, or a pinned session row.
interface HomeTreeRow {
  kind: string;
  key: string;
  projectId: string;
  projectName: string;
  workspacePath: string;
  projectPinned: boolean;
  projectExpanded: boolean;
  session: SessionListItem | null;
}

interface ProjectSessionCacheEntry {
  loadedAt: number;
  items: SessionListItem[];
}

// A locally picked attachment waiting to be inlined into the create request.
interface NewSessionAttachmentEntry {
  localId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

// Resolved (model, reasoning) pair while applying catalog defaults.
interface NewSessionModelSelection {
  model: RemoteModelItem | null;
  effort: RemoteReasoningItem | null;
}

// Mirrors Android sessionListComparator without optimisticTopUntil: pinned
// first, then running sessions (by id), the rest by sort-key timestamp
// descending (id as tie-breaker).
function sessionListCompare(left: SessionListItem, right: SessionListItem): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  const leftRunning = left.statusLabel === 'running' || left.statusLabel === 'waiting' ||
    left.statusLabel === 'pending';
  const rightRunning = right.statusLabel === 'running' || right.statusLabel === 'waiting' ||
    right.statusLabel === 'pending';
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    return left.id.localeCompare(right.id);
  }
  const bySortKey = timestampMillis(right.sortKey) - timestampMillis(left.sortKey);
  if (bySortKey !== 0) {
    return bySortKey;
  }
  return right.id.localeCompare(left.id);
}

// Mirrors Android activeNewSessionRuntimes: only configured, active and
// running instances are offered, sorted by display name then runtime id.
function runnableRuntimes(runtimes: RemoteDeviceRuntime[]): RemoteDeviceRuntime[] {
  const runnable: RemoteDeviceRuntime[] = [];
  for (const runtime of runtimes) {
    if (runtime.configured && runtime.active && runtime.status === 'running') {
      runnable.push(runtime);
    }
  }
  runnable.sort((left: RemoteDeviceRuntime, right: RemoteDeviceRuntime): number => {
    const byName = left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase());
    if (byName !== 0) {
      return byName;
    }
    return left.runtimeId.localeCompare(right.runtimeId);
  });
  return runnable;
}

function mimeTypeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return 'application/octet-stream';
  }
  const ext = name.substring(dot + 1).toLowerCase();
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'txt') {
    return 'text/plain';
  }
  if (ext === 'json') {
    return 'application/json';
  }
  if (ext === 'pdf') {
    return 'application/pdf';
  }
  if (ext === 'md') {
    return 'text/markdown';
  }
  if (ext === 'zip') {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

@Component
export struct HomePage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  pathStack: NavPathStack = new NavPathStack();
  onSignedOut: () => void = () => {};
  @StorageLink('homeRefreshTick') @Watch('onHomeRefreshTick') homeRefreshTick: number = 0;
  @StorageLink('profileDrawerOpen') profileDrawerVisible: boolean = false;
  @State loading: boolean = true;
  @State hasLoaded: boolean = false;
  @State refreshing: boolean = false;
  @State errorMessage: string = '';
  @State sessions: SessionListItem[] = [];
  @State archivedSessions: SessionListItem[] = [];
  @State projects: RemoteProject[] = [];
  @State homeDevices: RemoteDevice[] = [];
  @State homeDevicesLoaded: boolean = false;
  @State agentGateState: string = 'checking';
  @State treeRows: HomeTreeRow[] = [];
  // Mirrors Android HomeProjectList's empty check: the account has no visible
  // project and no pinned session. Section collapse must NOT trigger the empty
  // state, so this is computed from data, not from rendered rows.
  @State treeHasAnyContent: boolean = false;
  @State expandedProjectIds: Set<string> = new Set<string>();
  @State pinnedSectionExpanded: boolean = true;
  @State projectsSectionExpanded: boolean = true;
  // Session view mode section collapse (Android keeps these in-memory,
  // defaulting to expanded).
  @State sessionPinnedExpanded: boolean = true;
  @State sessionRecentExpanded: boolean = true;
  @StorageProp(SIDEBAR_VIEW_MODE_KEY) @Watch('onSidebarViewModeChange')
  sidebarViewMode: string = SIDEBAR_VIEW_PROJECT;
  @State filterStatus: string = PROJECT_STATUS_FILTER_ACTIVE;
  @State filterDeviceId: string = '';
  @State filterRuntime: string = '';
  @State filterMenuVisible: boolean = false;
  @State filterAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @State filterAgents: string[] = [];
  @State filterDevices: HomeFilterDeviceOption[] = [];
  // Smart reach (智感握姿): the home FAB follows the operating hand so it stays
  // within thumb reach; defaults to the right side when unsupported or denied.
  @State fabOnRight: boolean = true;
  @State fabHasAppeared: boolean = false;
  private operatingHandSubscribed: boolean = false;
  // OperatingHandStatus enum values, refreshed from the runtime module once
  // the dynamic import resolves; 1/2 are the API 15+ LEFT/RIGHT members.
  private operatingHandLeftValue: number = 1;
  private operatingHandRightValue: number = 2;
  private operatingHandCallback: Callback<number> =
    (status: number): void => {
      if (status === this.operatingHandLeftValue) {
        this.fabOnRight = false;
      } else if (status === this.operatingHandRightValue) {
        this.fabOnRight = true;
      }
    };
  @State projectActionMenuId: string = '';
  @State projectActionMenuAnchored: boolean = true;
  @State projectActionAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @State projectActionHighlightExpanded: boolean = false;
  @State editProjectId: string = '';
  @State editProjectNameInput: string = '';
  @State editProjectBusy: boolean = false;
  @State editProjectError: string = '';
  @State archiveProjectId: string = '';
  @State archiveProjectBusy: boolean = false;
  @State newSessionVisible: boolean = false;
  @State devices: RemoteDevice[] = [];
  @State runtimes: RemoteDeviceRuntime[] = [];
  @State runtimesLoading: boolean = false;
  @State selectedDeviceId: string = '';
  @State selectedRuntimeType: string = '';
  @State selectedRuntimeId: string = '';
  @State newSessionAttachments: NewSessionAttachmentEntry[] = [];
  @State pickingAttachment: boolean = false;
  @State newSessionCwd: string = '~';
  @State newSessionMessage: string = '';
  @State creatingSession: boolean = false;
  @State newSessionError: string = '';
  @State newSessionSetupState: string = 'checking';
  @State newSessionTitleInput: string = '';
  @State newSessionCatalogView: NewSessionCatalogView = emptyNewSessionCatalogView();
  @State newSessionBrowserView: NewSessionBrowserView = emptyNewSessionBrowserView();
  @State newSessionStartEnabled: boolean = false;
  @State actionMenuSessionId: string = '';
  @State renameTargetId: string = '';
  @State renameInput: string = '';
  @State actionBusy: boolean = false;
  private pageActive: boolean = false;
  private dashboardRetries: number = 0;
  private agentGateSeq: number = 0;
  private lastGateOnlineKey: string = '';
  private retryTimer: number = -1;
  private optCounter: number = 0;
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private sessionsApi: SessionsApi = new SessionsApi(this.client);
  private realtimeApi: RealtimeApi = new RealtimeApi(this.client);
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private filesApi: FilesApi = new FilesApi(this.client);
  private newSessionPreferenceStore: NewSessionPreferenceStore = NewSessionPreferenceStore.getInstance();
  private projectPreferenceStore: HomeProjectPreferenceStore = HomeProjectPreferenceStore.getInstance();
  private projectSessionCache: Map<string, ProjectSessionCacheEntry> = new Map<string, ProjectSessionCacheEntry>();
  private projectSessionLoading: Set<string> = new Set<string>();
  private projectSessionErrors: Map<string, string> = new Map<string, string>();
  private prefetchedProjectIds: Set<string> = new Set<string>();
  private newSessionRuntimeRequestSeq: number = 0;
  private newSessionCapabilities: RemoteRuntimeCapabilityDetail[] = [];
  private newSessionCapabilityError: string = '';
  private newSessionCatalogLoading: boolean = false;
  private newSessionModelCatalog: RemoteModelCatalog | null = null;
  private newSessionModelCatalogError: string = '';
  private newSessionPermissionCatalog: RemotePermissionCatalog | null = null;
  private newSessionPermissionCatalogError: string = '';
  private newSessionSelectedModelId: string = '';
  private newSessionSelectedEffortId: string = '';
  private newSessionSelectedPermissionId: string = '';
  private newSessionPreferredConnectorId: string = '';
  private newSessionPreferredRuntimeId: string = '';
  private newSessionBrowserRequestSeq: number = 0;
  private newSessionBrowserVisible: boolean = false;
  private newSessionBrowserLoading: boolean = false;
  private newSessionBrowserError: string = '';
  private newSessionBrowserPath: string = '.';
  private newSessionBrowserLastRequestPath: string = '.';
  private newSessionBrowserRoot: string = '~';
  private newSessionBrowserEntries: RemoteDirectoryEntry[] = [];
  private socket: RealtimeWebSocket = new RealtimeWebSocket();
  private networkMonitor: NetworkMonitor = new NetworkMonitor();

  aboutToAppear(): void {
    this.pageActive = true;
    this.networkMonitor.start({
      onNetworkAvailable: (): void => {
        this.onNetworkRestored();
      }
    });
    this.projectPreferenceStore.init(getContext(this));
    this.projectPreferenceStore.waitUntilReady().then((): void => {
      if (!this.pageActive) {
        return;
      }
      this.applyProjectPreferences();
      this.rebuildProjectTree();
    }).catch((): void => {
    });
    this.loadSessions();
    this.loadAgentGate();
    this.connectDashboard();
    this.subscribeOperatingHand();
  }

  aboutToDisappear(): void {
    this.pageActive = false;
    this.networkMonitor.stop();
    if (this.retryTimer >= 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
    this.socket.destroy();
    this.unsubscribeOperatingHand();
  }

  // The motion kit module is @since 15, so the import must stay dynamic: a
  // static import would crash HomePage on API 12 devices before canIUse runs.
  // Kit paths resolve to an empty module at runtime; import the underlying
  // @ohos module (which does `export default motion`) instead.
  private async subscribeOperatingHand(): Promise<void> {
    if (this.operatingHandSubscribed ||
      !canIUse('SystemCapability.MultimodalAwareness.Motion')) {
      return;
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const grant = await atManager.requestPermissionsFromUser(getContext(this),
        ['ohos.permission.ACTIVITY_MOTION']);
      if (grant.authResults.length === 0 || grant.authResults[0] !== 0) {
        return;
      }
      const motionModule = await import('@ohos.multimodalAwareness.motion');
      this.operatingHandLeftValue = motionModule.default.OperatingHandStatus.LEFT_HAND_OPERATED;
      this.operatingHandRightValue = motionModule.default.OperatingHandStatus.RIGHT_HAND_OPERATED;
      motionModule.default.on('operatingHandChanged', this.operatingHandCallback);
      this.operatingHandSubscribed = true;
    } catch (error) {
      hilog.warn(0x0000, LOG_TAG, `operating hand subscribe failed err=%{public}s`,
        errorMessageFrom(error));
    }
  }

  private async unsubscribeOperatingHand(): Promise<void> {
    if (!this.operatingHandSubscribed) {
      return;
    }
    this.operatingHandSubscribed = false;
    try {
      const motionModule = await import('@ohos.multimodalAwareness.motion');
      motionModule.default.off('operatingHandChanged', this.operatingHandCallback);
    } catch (error) {
      hilog.warn(0x0000, LOG_TAG, `operating hand unsubscribe failed err=%{public}s`,
        errorMessageFrom(error));
    }
  }

  // NewProjectPage bumps the AppStorage tick after creating a project.
  onHomeRefreshTick(): void {
    this.loadSessions();
  }

  // Switching the sidebar view mode in the profile drawer re-renders the list.
  onSidebarViewModeChange(): void {
    this.rebuildProjectTree();
  }

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private nextClientId(): string {
    this.optCounter++;
    return `hmos_${Date.now().toString(36)}_${this.optCounter}`;
  }

  private toListItem(session: RemoteSession): SessionListItem {
    const title = session.title === null || session.title.length === 0
      ? 'Untitled session' : session.title;
    const item: SessionListItem = {
      id: session.id,
      connectorId: session.connectorId,
      runtime: session.runtime,
      title: title,
      runtimeLabel: session.runtimeName,
      statusLabel: session.status,
      unread: session.unread,
      connectorStatus: session.connectorStatus,
      pinned: session.pinned,
      archived: session.archived,
      projectId: session.projectId,
      sortKey: session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ?? ''
    };
    return item;
  }

  private async loadSessions(): Promise<void> {
    try {
      const serverUrl = this.serverUrl();
      const accessToken = this.token();
      if (serverUrl.length === 0 || accessToken.length === 0) {
        this.errorMessage = 'Not signed in.';
        this.loading = false;
        this.refreshing = false;
        return;
      }
      const activePage = await this.sessionsApi.listSessions(serverUrl, accessToken, false, HOME_SESSIONS_LIMIT, null);
      if (!this.pageActive) {
        return;
      }
      const active: SessionListItem[] = [];
      for (const session of activePage.sessions) {
        active.push(this.toListItem(session));
      }
      this.sessions = active;
      const archivedPage = await this.sessionsApi.listSessions(serverUrl, accessToken, true, HOME_SESSIONS_LIMIT, null);
      if (!this.pageActive) {
        return;
      }
      const archived: SessionListItem[] = [];
      for (const session of archivedPage.sessions) {
        archived.push(this.toListItem(session));
      }
      this.archivedSessions = archived;
      const projectList = await this.sessionsApi.listProjects(serverUrl, accessToken);
      if (!this.pageActive) {
        return;
      }
      this.projects = projectList.projects;
      const deviceList = await this.devicesApi.listDevices(serverUrl, accessToken);
      if (!this.pageActive) {
        return;
      }
      this.homeDevices = deviceList;
      this.homeDevicesLoaded = true;
      this.hasLoaded = true;
      this.errorMessage = '';
      this.rebuildProjectTree();
      this.prefetchProjectSessions();
    } catch (error) {
      if (this.pageActive) {
        this.errorMessage = errorMessageFrom(error as Object);
      }
    }
    this.loading = false;
    this.refreshing = false;
  }

  // Mirrors Android SessionsState.replacedByDashboardSnapshot: the dashboard
  // snapshot replaces the session/project/device views wholesale.
  private applySnapshot(snapshot: RemoteDashboardSnapshot): void {
    const active: SessionListItem[] = [];
    const archived: SessionListItem[] = [];
    for (const session of snapshot.sessions) {
      if (session.archived) {
        archived.push(this.toListItem(session));
      } else {
        active.push(this.toListItem(session));
      }
    }
    this.sessions = active;
    this.archivedSessions = archived;
    this.projects = snapshot.projects;
    this.homeDevices = snapshot.devices;
    this.homeDevicesLoaded = true;
    this.hasLoaded = true;
    this.loading = false;
    this.refreshing = false;
    const snapshotOnlineIds: string[] = [];
    for (const device of snapshot.devices) {
      if (device.status === 'online') {
        snapshotOnlineIds.push(device.id);
      }
    }
    if (snapshotOnlineIds.join(',') !== this.lastGateOnlineKey) {
      this.loadAgentGate();
    }
    this.rebuildProjectTree();
  }

  private async connectDashboard(): Promise<void> {
    if (!this.pageActive) {
      return;
    }
    try {
      const ticket = await this.realtimeApi.createDashboardTicket(this.serverUrl(), this.token(),
        this.nextClientId());
      if (!this.pageActive) {
        return;
      }
      const url = this.realtimeApi.dashboardWebSocketUrl(this.serverUrl(), ticket.ticket);
      this.socket.connect(url, this.createDashboardListener());
    } catch (error) {
      this.scheduleDashboardRetry();
    }
  }

  private createDashboardListener(): RealtimeSocketListener {
    const listener: RealtimeSocketListener = {
      onOpen: (): void => {
        this.dashboardRetries = 0;
      },
      onMessage: (text: string): void => {
        const snapshot = this.realtimeApi.parseDashboardMessage(text);
        if (snapshot !== null) {
          this.applySnapshot(snapshot);
        }
      },
      onClose: (code: number, reason: string): void => {
        this.scheduleDashboardRetry();
      },
      onError: (message: string): void => {
        this.scheduleDashboardRetry();
      }
    };
    return listener;
  }

  private scheduleDashboardRetry(): void {
    if (!this.pageActive) {
      return;
    }
    if (this.retryTimer >= 0) {
      return;
    }
    const attempt = this.dashboardRetries;
    this.dashboardRetries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = -1;
      this.connectDashboard();
    }, dashboardRetryDelayMs(attempt));
  }

  /**
   * Connectivity just returned: if the dashboard socket is down and a backoff
   * retry is pending, cancel it and reconnect immediately.
   */
  private onNetworkRestored(): void {
    if (!this.pageActive || this.retryTimer < 0) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = -1;
    this.dashboardRetries = 0;
    this.connectDashboard();
  }

  private openDevices(): void {
    this.pathStack.pushPathByName('devices', '');
  }

  private openTerminal(): void {
    this.pathStack.pushPathByName('terminal', '');
  }

  private openFiles(): void {
    this.pathStack.pushPathByName('files', '');
  }

  private openPairing(): void {
    this.pathStack.pushPathByName('pairing', '');
  }

  private applyProjectPreferences(): void {
    try {
      const serverUrl = this.serverUrl();
      const userId = this.authStore.readUserId();
      const expandedIds = this.projectPreferenceStore.readExpandedIds(serverUrl, userId);
      const expanded: Set<string> = new Set<string>();
      for (const id of expandedIds) {
        expanded.add(id);
      }
      this.expandedProjectIds = expanded;
      this.projectsSectionExpanded = this.projectPreferenceStore.readProjectsExpanded(serverUrl, userId);
      this.filterStatus = this.projectPreferenceStore.readSessionStatus(serverUrl, userId);
      const deviceId = this.projectPreferenceStore.readSelectedDeviceId(serverUrl, userId);
      this.filterDeviceId = deviceId === null ? '' : deviceId;
      const agent = this.projectPreferenceStore.readSelectedAgentRuntime(serverUrl, userId);
      this.filterRuntime = agent === null ? '' : agent;
    } catch (error) {
    }
  }

  // Mirrors Android collectAllSessions: the per-project cache, the global
  // active list and the archived list merged by id, with the global lists
  // taking precedence over cached rows.
  private collectAllSessions(): SessionListItem[] {
    const byId: Map<string, SessionListItem> = new Map<string, SessionListItem>();
    this.projectSessionCache.forEach((entry: ProjectSessionCacheEntry) => {
      for (const item of entry.items) {
        byId.set(item.id, item);
      }
    });
    for (const item of this.sessions) {
      byId.set(item.id, item);
    }
    for (const item of this.archivedSessions) {
      byId.set(item.id, item);
    }
    const all: SessionListItem[] = [];
    byId.forEach((item: SessionListItem) => {
      all.push(item);
    });
    return all;
  }

  // Recomputes the rendered tree rows: the pinned section (pinned projects,
  // then pinned sessions) and the projects section (sorted by activity), each
  // expanded project followed by error/loading/placeholder rows or its sorted
  // session children. Mirrors Android HomeScreen HomeProjectModeList +
  // HomeProjectComponents HomeProjectList.
  private rebuildProjectTree(): void {
    const allSessions = this.collectAllSessions();
    if (this.sidebarViewMode === SIDEBAR_VIEW_SESSION) {
      this.rebuildSessionModeRows();
      return;
    }
    const archiveStates = archiveStatesForStatus(this.filterStatus);
    const visibleByProject: Map<string, SessionListItem[]> = new Map<string, SessionListItem[]>();
    for (const item of allSessions) {
      if (item.projectId === null || item.projectId.length === 0) {
        continue;
      }
      if (!projectSessionMatchesStatus(item, this.filterStatus)) {
        continue;
      }
      if (this.filterDeviceId.length > 0 && item.connectorId !== this.filterDeviceId) {
        continue;
      }
      if (this.filterRuntime.length > 0 && item.runtime !== this.filterRuntime) {
        continue;
      }
      const list = visibleByProject.get(item.projectId);
      if (list === undefined) {
        visibleByProject.set(item.projectId, [item]);
      } else {
        list.push(item);
      }
    }
    visibleByProject.forEach((items: SessionListItem[]) => {
      items.sort(sessionListCompare);
    });
    const visibleProjects: RemoteProject[] = [];
    for (const project of this.projects) {
      if (projectHasVisibleSessions(project, allSessions, this.filterStatus,
        this.filterDeviceId, this.filterRuntime)) {
        visibleProjects.push(project);
      }
    }
    const ordered = sortProjectsByActivity(visibleProjects, allSessions);
    const pinnedProjects: RemoteProject[] = [];
    const regularProjects: RemoteProject[] = [];
    for (const project of ordered) {
      if (project.pinned) {
        pinnedProjects.push(project);
      } else {
        regularProjects.push(project);
      }
    }
    const pinnedSessions: SessionListItem[] = [];
    for (const item of allSessions) {
      if (!item.pinned || item.archived) {
        continue;
      }
      if (this.filterDeviceId.length > 0 && item.connectorId !== this.filterDeviceId) {
        continue;
      }
      if (this.filterRuntime.length > 0 && item.runtime !== this.filterRuntime) {
        continue;
      }
      pinnedSessions.push(item);
    }
    pinnedSessions.sort(sessionListCompare);
    const agents: string[] = [];
    const seenAgents: Set<string> = new Set<string>();
    for (const item of allSessions) {
      if (item.runtime.length > 0 && !seenAgents.has(item.runtime)) {
        seenAgents.add(item.runtime);
        agents.push(item.runtime);
      }
    }
    if (agents.join('|') !== this.filterAgents.join('|')) {
      this.filterAgents = agents;
    }
    const deviceOptions: HomeFilterDeviceOption[] = [];
    for (const device of this.homeDevices) {
      const trimmed = device.name.trim();
      const option: HomeFilterDeviceOption = {
        id: device.id,
        label: trimmed.length > 0 ? trimmed : device.id
      };
      deviceOptions.push(option);
    }
    this.filterDevices = deviceOptions;
    const loadingIds: Set<string> = new Set<string>();
    this.projectSessionLoading.forEach((loadKey: string) => {
      const sep = loadKey.indexOf('|');
      const archived = loadKey.substring(sep + 1) === 'true';
      if (archiveStates.indexOf(archived) >= 0) {
        loadingIds.add(loadKey.substring(0, sep));
      }
    });
    const errorByProject: Map<string, string> = new Map<string, string>();
    this.projectSessionErrors.forEach((message: string, loadKey: string) => {
      const sep = loadKey.indexOf('|');
      const archived = loadKey.substring(sep + 1) === 'true';
      if (archiveStates.indexOf(archived) >= 0 && !errorByProject.has(loadKey.substring(0, sep))) {
        errorByProject.set(loadKey.substring(0, sep), message);
      }
    });
    this.treeHasAnyContent = visibleProjects.length > 0 || pinnedSessions.length > 0;
    const rows: HomeTreeRow[] = [];
    if (pinnedProjects.length > 0 || pinnedSessions.length > 0) {
      const headerRow: HomeTreeRow = {
        kind: 'pinned_header',
        key: `pinned_header|${this.pinnedSectionExpanded}`,
        projectId: '',
        projectName: '',
        workspacePath: '',
        projectPinned: false,
        projectExpanded: this.pinnedSectionExpanded,
        session: null
      };
      rows.push(headerRow);
      if (this.pinnedSectionExpanded) {
        for (const project of pinnedProjects) {
          this.appendProjectRows(rows, project, visibleByProject, loadingIds, errorByProject);
        }
        for (const item of pinnedSessions) {
          const row: HomeTreeRow = {
            kind: 'session',
            key: `session|${this.sessionItemKey(item)}`,
            projectId: item.projectId ?? '',
            projectName: '',
            workspacePath: '',
            projectPinned: false,
            projectExpanded: false,
            session: item
          };
          rows.push(row);
        }
      }
    }
    const projectsHeaderRow: HomeTreeRow = {
      kind: 'projects_header',
      key: `projects_header|${this.projectsSectionExpanded}`,
      projectId: '',
      projectName: '',
      workspacePath: '',
      projectPinned: false,
      projectExpanded: this.projectsSectionExpanded,
      session: null
    };
    rows.push(projectsHeaderRow);
    if (this.projectsSectionExpanded) {
      if (regularProjects.length === 0) {
        const deviceAgent = this.filterDeviceId.length > 0 || this.filterRuntime.length > 0;
        const loadingAny = this.anyProjectLoading();
        const row: HomeTreeRow = {
          kind: 'projects_empty',
          key: `projects_empty|${deviceAgent}|${loadingAny}`,
          projectId: '',
          projectName: '',
          workspacePath: '',
          projectPinned: false,
          projectExpanded: false,
          session: null
        };
        rows.push(row);
      } else {
        for (const project of regularProjects) {
          this.appendProjectRows(rows, project, visibleByProject, loadingIds, errorByProject);
        }
      }
    }
    this.treeRows = rows;
  }

  // Session view mode (Android HomeList + SessionList): a flat list of the
  // active sessions split into collapsible Pinned/Recents sections. The server
  // order is kept as-is, mirroring Android which only filters by pinned flag.
  private rebuildSessionModeRows(): void {
    const pinned: SessionListItem[] = [];
    const recent: SessionListItem[] = [];
    for (const item of this.sessions) {
      if (item.archived) {
        continue;
      }
      if (item.pinned) {
        pinned.push(item);
      } else {
        recent.push(item);
      }
    }
    const rows: HomeTreeRow[] = [];
    const pinnedHeader: HomeTreeRow = {
      kind: 'session_pinned_header',
      key: `session_pinned_header|${this.sessionPinnedExpanded}`,
      projectId: '',
      projectName: '',
      workspacePath: '',
      projectPinned: false,
      projectExpanded: this.sessionPinnedExpanded,
      session: null
    };
    rows.push(pinnedHeader);
    if (this.sessionPinnedExpanded) {
      if (pinned.length === 0) {
        rows.push(this.sectionEmptyRow('pinned_empty'));
      } else {
        for (const item of pinned) {
          rows.push(this.flatSessionRow(item, 'pinned'));
        }
      }
    }
    const recentHeader: HomeTreeRow = {
      kind: 'session_recent_header',
      key: `session_recent_header|${this.sessionRecentExpanded}`,
      projectId: '',
      projectName: '',
      workspacePath: '',
      projectPinned: false,
      projectExpanded: this.sessionRecentExpanded,
      session: null
    };
    rows.push(recentHeader);
    if (this.sessionRecentExpanded) {
      if (recent.length === 0) {
        rows.push(this.sectionEmptyRow('recent_empty'));
      } else {
        for (const item of recent) {
          rows.push(this.flatSessionRow(item, 'recent'));
        }
      }
    }
    this.treeHasAnyContent = pinned.length > 0 || recent.length > 0;
    this.treeRows = rows;
  }

  private sectionEmptyRow(kind: string): HomeTreeRow {
    const row: HomeTreeRow = {
      kind: kind,
      key: kind,
      projectId: '',
      projectName: '',
      workspacePath: '',
      projectPinned: false,
      projectExpanded: false,
      session: null
    };
    return row;
  }

  private flatSessionRow(item: SessionListItem, section: string): HomeTreeRow {
    const row: HomeTreeRow = {
      kind: 'flat_session',
      key: `flat_session|${section}|${this.sessionItemKey(item)}`,
      projectId: item.projectId ?? '',
      projectName: '',
      workspacePath: '',
      projectPinned: false,
      projectExpanded: false,
      session: item
    };
    return row;
  }

  // Android AgentSession.sidebarContextLabel: device name + project name
  // joined by a middle dot (cwd/workspace fallbacks need session fields the
  // harmony client does not keep in SessionListItem, so they are skipped).
  private sessionContextLabel(item: SessionListItem): string {
    const parts: string[] = [];
    for (const device of this.homeDevices) {
      if (device.id === item.connectorId) {
        const name = device.name.trim();
        if (name.length > 0) {
          parts.push(name);
        }
        break;
      }
    }
    const projectId = item.projectId;
    if (projectId !== null && projectId.length > 0) {
      for (const project of this.projects) {
        if (project.id === projectId) {
          const name = project.name.trim();
          if (name.length > 0) {
            parts.push(name);
          }
          break;
        }
      }
    }
    return parts.join(' · ');
  }

  private toggleSessionPinnedSection(): void {
    this.sessionPinnedExpanded = !this.sessionPinnedExpanded;
    this.rebuildProjectTree();
  }

  private toggleSessionRecentSection(): void {
    this.sessionRecentExpanded = !this.sessionRecentExpanded;
    this.rebuildProjectTree();
  }

  private appendProjectRows(rows: HomeTreeRow[], project: RemoteProject,
    visibleByProject: Map<string, SessionListItem[]>, loadingIds: Set<string>,
    errorByProject: Map<string, string>): void {
    const expanded = this.expandedProjectIds.has(project.id);
    const projectRow: HomeTreeRow = {
      kind: 'project',
      key: `project|${project.id}|${project.name}|${expanded}`,
      projectId: project.id,
      projectName: project.name,
      workspacePath: project.workspacePath,
      projectPinned: project.pinned,
      projectExpanded: expanded,
      session: null
    };
    rows.push(projectRow);
    if (!expanded) {
      return;
    }
    const errorMessage = errorByProject.get(project.id);
    if (errorMessage !== undefined) {
      const row: HomeTreeRow = {
        kind: 'project_error',
        key: `project_error|${project.id}|${errorMessage}`,
        projectId: project.id,
        projectName: project.name,
        workspacePath: project.workspacePath,
        projectPinned: project.pinned,
        projectExpanded: expanded,
        session: null
      };
      rows.push(row);
    }
    const sessions = visibleByProject.get(project.id) ?? [];
    if (loadingIds.has(project.id) && sessions.length === 0) {
      const row: HomeTreeRow = {
        kind: 'project_loading',
        key: `project_loading|${project.id}`,
        projectId: project.id,
        projectName: project.name,
        workspacePath: project.workspacePath,
        projectPinned: project.pinned,
        projectExpanded: expanded,
        session: null
      };
      rows.push(row);
    } else if (sessions.length === 0 && errorMessage === undefined) {
      const row: HomeTreeRow = {
        kind: 'project_empty',
        key: `project_empty|${project.id}`,
        projectId: project.id,
        projectName: project.name,
        workspacePath: project.workspacePath,
        projectPinned: project.pinned,
        projectExpanded: expanded,
        session: null
      };
      rows.push(row);
    } else {
      for (const item of sessions) {
        const row: HomeTreeRow = {
          kind: 'session',
          key: `session|${this.sessionItemKey(item)}`,
          projectId: project.id,
          projectName: project.name,
          workspacePath: project.workspacePath,
          projectPinned: project.pinned,
          projectExpanded: expanded,
          session: item
        };
        rows.push(row);
      }
    }
  }

  // ForEach key for a session row. It must cover every field the row renders:
  // ArkUI reuses child components of unchanged keys, so a key of just the id
  // would keep the first-render title/status/unread state forever.
  private sessionItemKey(item: SessionListItem): string {
    return `${item.id}::${item.title}::${item.runtimeLabel}::${item.statusLabel}` +
      `::${item.connectorStatus}::${item.unread}::${item.pinned}`;
  }

  private anyProjectLoading(): boolean {
    const archiveStates = archiveStatesForStatus(this.filterStatus);
    let loading = false;
    this.projectSessionLoading.forEach((loadKey: string) => {
      if (loading) {
        return;
      }
      const sep = loadKey.indexOf('|');
      const archived = loadKey.substring(sep + 1) === 'true';
      if (archiveStates.indexOf(archived) >= 0) {
        loading = true;
      }
    });
    return loading;
  }

  private treeFiltersActive(): boolean {
    return this.filterDeviceId.length > 0 || this.filterRuntime.length > 0 ||
      this.filterStatus !== PROJECT_STATUS_FILTER_ACTIVE;
  }

  private hasProjectsInAllStatuses(): boolean {
    const allSessions = this.collectAllSessions();
    for (const project of this.projects) {
      if (projectHasVisibleSessions(project, allSessions, PROJECT_STATUS_FILTER_ALL, '', '')) {
        return true;
      }
    }
    return false;
  }

  private projectsEmptyMessage(): ResourceStr {
    const deviceAgent = this.filterDeviceId.length > 0 || this.filterRuntime.length > 0;
    if (deviceAgent && this.anyProjectLoading()) {
      return $r('app.string.home_project_filter_loading');
    }
    if (deviceAgent) {
      return $r('app.string.home_project_filter_empty');
    }
    return $r('app.string.home_no_projects');
  }

  private treeEmptyMessage(): ResourceStr {
    const deviceAgent = this.filterDeviceId.length > 0 || this.filterRuntime.length > 0;
    if (deviceAgent && this.anyProjectLoading()) {
      return $r('app.string.home_project_filter_loading');
    }
    if (deviceAgent) {
      return $r('app.string.home_project_filter_empty');
    }
    if (this.filterStatus === PROJECT_STATUS_FILTER_ARCHIVED) {
      return $r('app.string.home_no_archived_projects_yet');
    }
    if (this.filterStatus === PROJECT_STATUS_FILTER_ALL) {
      return $r('app.string.home_no_projects_create');
    }
    return $r('app.string.home_no_active_projects_create');
  }

  // Mirrors Android AgentsAnywhereApp.loadProjectSessions: 30s cache keyed by
  // (projectId, archived), in-flight dedupe and per-key error capture.
  private async loadProjectSessions(projectId: string, status: string): Promise<void> {
    if (projectId.length === 0) {
      return;
    }
    const archiveStates = archiveStatesForStatus(status);
    for (const archived of archiveStates) {
      const loadKey = `${projectId}|${archived}`;
      if (this.projectSessionLoading.has(loadKey)) {
        continue;
      }
      const cached = this.projectSessionCache.get(loadKey);
      if (cached !== undefined && Date.now() - cached.loadedAt < PROJECT_SESSION_CACHE_MS) {
        continue;
      }
      this.projectSessionLoading.add(loadKey);
      this.projectSessionErrors.delete(loadKey);
      await this.loadProjectSessionsPage(projectId, archived, loadKey);
    }
  }

  private async loadProjectSessionsPage(projectId: string, archived: boolean,
    loadKey: string): Promise<void> {
    try {
      const serverUrl = this.serverUrl();
      const accessToken = this.token();
      if (serverUrl.length === 0 || accessToken.length === 0) {
        return;
      }
      const page = await this.sessionsApi.listProjectSessions(serverUrl, accessToken, projectId,
        archived, PROJECT_SESSIONS_LIMIT, null);
      if (!this.pageActive) {
        return;
      }
      // Merge by id: rows fetched under the other archive flag are retained,
      // the fresh page wins on collisions (Android does the same when merging
      // projectSessionsById).
      const byId: Map<string, SessionListItem> = new Map<string, SessionListItem>();
      const otherKey = `${projectId}|${!archived}`;
      const other = this.projectSessionCache.get(otherKey);
      if (other !== undefined) {
        for (const item of other.items) {
          byId.set(item.id, item);
        }
      }
      for (const session of page.sessions) {
        const item = this.toListItem(session);
        byId.set(item.id, item);
      }
      const items: SessionListItem[] = [];
      byId.forEach((item: SessionListItem) => {
        items.push(item);
      });
      this.projectSessionCache.set(loadKey, { loadedAt: Date.now(), items: items });
    } catch (error) {
      hilog.warn(0x0000, LOG_TAG, `project sessions load failed key=%{public}s err=%{public}s`,
        loadKey, errorMessageFrom(error as Object));
      if (this.pageActive) {
        this.projectSessionErrors.set(loadKey, errorMessageFrom(error as Object));
      }
    } finally {
      this.projectSessionLoading.delete(loadKey);
      if (this.pageActive) {
        this.rebuildProjectTree();
      }
    }
  }

  // Mirrors Android HomeScreen's LaunchedEffect prefetch: load sessions for
  // every project visible under the current filter, once per project (the
  // prefetched set keeps failed loads from retrying in a loop).
  private prefetchProjectSessions(): void {
    if (!this.hasLoaded) {
      return;
    }
    const allSessions = this.collectAllSessions();
    const targets: string[] = [];
    for (const project of this.projects) {
      if (projectHasVisibleSessions(project, allSessions, this.filterStatus,
        this.filterDeviceId, this.filterRuntime)) {
        targets.push(project.id);
      }
    }
    const targetSet: Set<string> = new Set<string>(targets);
    const retained: Set<string> = new Set<string>();
    this.prefetchedProjectIds.forEach((id: string) => {
      if (targetSet.has(id)) {
        retained.add(id);
      }
    });
    this.prefetchedProjectIds = retained;
    for (const id of targets) {
      if (this.prefetchedProjectIds.has(id)) {
        continue;
      }
      this.prefetchedProjectIds.add(id);
      this.loadProjectSessions(id, this.filterStatus);
    }
  }

  private retryProjectSessions(projectId: string): void {
    this.loadProjectSessions(projectId, this.filterStatus);
  }

  private invalidateProjectCache(projectId: string): void {
    const next: Map<string, ProjectSessionCacheEntry> = new Map<string, ProjectSessionCacheEntry>();
    this.projectSessionCache.forEach((entry: ProjectSessionCacheEntry, loadKey: string) => {
      if (!loadKey.startsWith(`${projectId}|`)) {
        next.set(loadKey, entry);
      }
    });
    this.projectSessionCache = next;
    this.prefetchedProjectIds.delete(projectId);
  }

  private setSessionStatus(status: string): void {
    if (this.filterStatus === status) {
      return;
    }
    this.filterStatus = status;
    try {
      this.projectPreferenceStore.selectSessionStatus(this.serverUrl(), this.authStore.readUserId(), status);
    } catch (error) {
    }
    this.prefetchedProjectIds = new Set<string>();
    this.rebuildProjectTree();
    this.prefetchProjectSessions();
  }

  private setFilterDevice(deviceId: string): void {
    if (this.filterDeviceId === deviceId) {
      return;
    }
    this.filterDeviceId = deviceId;
    try {
      this.projectPreferenceStore.selectDevice(this.serverUrl(), this.authStore.readUserId(),
        deviceId.length > 0 ? deviceId : null);
    } catch (error) {
    }
    this.rebuildProjectTree();
    this.prefetchProjectSessions();
  }

  private setFilterRuntime(runtime: string): void {
    if (this.filterRuntime === runtime) {
      return;
    }
    this.filterRuntime = runtime;
    try {
      this.projectPreferenceStore.selectAgent(this.serverUrl(), this.authStore.readUserId(),
        runtime.length > 0 ? runtime : null);
    } catch (error) {
    }
    this.rebuildProjectTree();
    this.prefetchProjectSessions();
  }

  private clearProjectFilters(): void {
    this.filterStatus = PROJECT_STATUS_FILTER_ACTIVE;
    this.filterDeviceId = '';
    this.filterRuntime = '';
    try {
      this.projectPreferenceStore.clearFilters(this.serverUrl(), this.authStore.readUserId());
    } catch (error) {
    }
    this.prefetchedProjectIds = new Set<string>();
    this.rebuildProjectTree();
    this.prefetchProjectSessions();
  }

  private toggleProjectExpanded(projectId: string): void {
    const expanded = !this.expandedProjectIds.has(projectId);
    this.setProjectExpanded(projectId, expanded);
    this.vibrateSoft();
    this.rebuildProjectTree();
    if (expanded) {
      this.loadProjectSessions(projectId, this.filterStatus);
    }
  }

  private setProjectExpanded(projectId: string, expanded: boolean): void {
    const next: Set<string> = new Set<string>(this.expandedProjectIds);
    if (expanded) {
      next.add(projectId);
    } else {
      next.delete(projectId);
    }
    this.expandedProjectIds = next;
    try {
      this.projectPreferenceStore.setProjectExpanded(this.serverUrl(), this.authStore.readUserId(),
        projectId, expanded);
    } catch (error) {
    }
  }

  private togglePinnedSection(): void {
    this.pinnedSectionExpanded = !this.pinnedSectionExpanded;
    this.vibrateSoft();
    this.rebuildProjectTree();
  }

  private toggleProjectsSection(): void {
    this.projectsSectionExpanded = !this.projectsSectionExpanded;
    this.vibrateSoft();
    try {
      this.projectPreferenceStore.setProjectsExpanded(this.serverUrl(), this.authStore.readUserId(),
        this.projectsSectionExpanded);
    } catch (error) {
    }
    this.rebuildProjectTree();
  }

  private vibrateSoft(): void {
    try {
      const effect: vibrator.VibratePreset = {
        type: 'preset',
        effectId: 'haptic.effect.soft',
        count: 1
      };
      const attribute: vibrator.VibrateAttribute = {
        id: 0,
        usage: 'touch'
      };
      vibrator.startVibration(effect, attribute).catch((): void => {
      });
    } catch (error) {
    }
  }

  // Anchor bounds are captured at open time relative to the page root via
  // componentUtils, mirroring Android boundsInRoot()/boundsInWindow().
  // getRectangleById returns px while position()/size attributes take vp:
  // convert through UIContext.px2vp before use.
  private anchorFromRect(rect: componentUtils.ComponentInfo,
    rootRect: componentUtils.ComponentInfo): HomeMenuAnchor {
    const uiContext = this.getUIContext();
    const anchor: HomeMenuAnchor = {
      x: uiContext.px2vp(rect.windowOffset.x - rootRect.windowOffset.x),
      y: uiContext.px2vp(rect.windowOffset.y - rootRect.windowOffset.y),
      width: uiContext.px2vp(rect.size.width),
      height: uiContext.px2vp(rect.size.height)
    };
    return anchor;
  }

  private openProjectMenu(projectId: string, anchored: boolean): void {
    const project = this.findProject(projectId);
    if (project === null) {
      return;
    }
    try {
      const utils = this.getUIContext().getComponentUtils();
      const rootRect = utils.getRectangleById('home_anchor_origin');
      const rect = utils.getRectangleById(anchored
        ? `home_project_menu_${projectId}` : `home_project_row_${projectId}`);
      this.projectActionAnchor = this.anchorFromRect(rect, rootRect);
    } catch (error) {
      return;
    }
    this.projectActionMenuAnchored = anchored;
    this.projectActionHighlightExpanded = this.expandedProjectIds.has(projectId);
    this.projectActionMenuId = projectId;
  }

  private closeProjectMenu(): void {
    this.projectActionMenuId = '';
  }

  private openFilterMenu(anchorId: string): void {
    try {
      const utils = this.getUIContext().getComponentUtils();
      const rootRect = utils.getRectangleById('home_anchor_origin');
      const rect = utils.getRectangleById(anchorId);
      this.filterAnchor = this.anchorFromRect(rect, rootRect);
    } catch (error) {
      return;
    }
    this.filterMenuVisible = true;
  }

  // --- Session lookup / mutation --------------------------------------------

  private findSessionInList(items: SessionListItem[], sessionId: string): SessionListItem | null {
    for (const item of items) {
      if (item.id === sessionId) {
        return item;
      }
    }
    return null;
  }

  private findSession(sessionId: string): SessionListItem | null {
    const active = this.findSessionInList(this.sessions, sessionId);
    if (active !== null) {
      return active;
    }
    const archived = this.findSessionInList(this.archivedSessions, sessionId);
    if (archived !== null) {
      return archived;
    }
    const entries: ProjectSessionCacheEntry[] = [];
    this.projectSessionCache.forEach((entry: ProjectSessionCacheEntry) => {
      entries.push(entry);
    });
    for (const entry of entries) {
      const cached = this.findSessionInList(entry.items, sessionId);
      if (cached !== null) {
        return cached;
      }
    }
    return null;
  }

  private replaceInList(items: SessionListItem[], next: SessionListItem): SessionListItem[] {
    const updated: SessionListItem[] = [];
    for (const item of items) {
      if (item.id === next.id) {
        updated.push(next);
      } else {
        updated.push(item);
      }
    }
    return updated;
  }

  private copySession(item: SessionListItem): SessionListItem {
    const copy: SessionListItem = {
      id: item.id,
      connectorId: item.connectorId,
      runtime: item.runtime,
      title: item.title,
      runtimeLabel: item.runtimeLabel,
      statusLabel: item.statusLabel,
      unread: item.unread,
      connectorStatus: item.connectorStatus,
      pinned: item.pinned,
      archived: item.archived,
      projectId: item.projectId,
      sortKey: item.sortKey
    };
    return copy;
  }

  private withUnread(item: SessionListItem, unread: boolean): SessionListItem {
    const next = this.copySession(item);
    next.unread = unread;
    return next;
  }

  private withArchived(item: SessionListItem, archived: boolean): SessionListItem {
    const next = this.copySession(item);
    next.archived = archived;
    return next;
  }

  // Applies a mutated session to every list holding it (active, archived and
  // each per-project cache entry) and rebuilds the tree, mirroring Android's
  // session patching which updates every copy of the row.
  private applySessionUpdate(next: SessionListItem): void {
    this.sessions = this.replaceInList(this.sessions, next);
    this.archivedSessions = this.replaceInList(this.archivedSessions, next);
    const updatedCache: Map<string, ProjectSessionCacheEntry> = new Map<string, ProjectSessionCacheEntry>();
    this.projectSessionCache.forEach((entry: ProjectSessionCacheEntry, loadKey: string) => {
      const updated: ProjectSessionCacheEntry = {
        loadedAt: entry.loadedAt,
        items: this.replaceInList(entry.items, next)
      };
      updatedCache.set(loadKey, updated);
    });
    this.projectSessionCache = updatedCache;
    this.rebuildProjectTree();
  }

  private openActionMenu(item: SessionListItem): void {
    this.actionMenuSessionId = item.id;
  }

  private closeActionMenu(): void {
    this.actionMenuSessionId = '';
  }

  private beginRename(): void {
    const target = this.findSession(this.actionMenuSessionId);
    if (target === null) {
      return;
    }
    this.renameInput = target.title;
    this.renameTargetId = target.id;
    this.closeActionMenu();
  }

  private cancelRename(): void {
    this.renameTargetId = '';
    this.renameInput = '';
  }

  private async confirmRename(value: string): Promise<void> {
    const sessionId = this.renameTargetId;
    const title = value.trim();
    if (sessionId.length === 0) {
      return;
    }
    if (title.length === 0) {
      this.errorMessage = 'A session title is required.';
      return;
    }
    const target = this.findSession(sessionId);
    if (target === null) {
      return;
    }
    this.actionBusy = true;
    try {
      const response = await this.sessionsApi.patchSession(this.serverUrl(), this.token(),
        sessionId, title, null, null);
      this.applySessionUpdate(this.toListItem(response.session));
      this.cancelRename();
      showToast($r('app.string.home_session_renamed'));
    } catch (error) {
      showToast($r('app.string.home_rename_failed'));
    }
    this.actionBusy = false;
  }

  private async toggleArchived(): Promise<void> {
    const target = this.findSession(this.actionMenuSessionId);
    if (target === null) {
      return;
    }
    this.closeActionMenu();
    this.actionBusy = true;
    try {
      if (target.archived) {
        const response = await this.sessionsApi.unarchiveSessions(this.serverUrl(), this.token(),
          [target.id]);
        for (const session of response.sessions) {
          this.applySessionUpdate(this.toListItem(session));
        }
        showToast($r('app.string.home_session_restored'));
      } else {
        await this.sessionsApi.archiveSessions(this.serverUrl(), this.token(), [target.id]);
        this.applySessionUpdate(this.withArchived(target, true));
        showToast($r('app.string.home_session_archived'));
      }
    } catch (error) {
      if (target.archived) {
        showToast($r('app.string.home_restore_failed'));
      } else {
        showToast($r('app.string.home_archive_failed'));
      }
    }
    this.actionBusy = false;
  }

  private async togglePinned(): Promise<void> {
    const target = this.findSession(this.actionMenuSessionId);
    if (target === null) {
      return;
    }
    this.closeActionMenu();
    this.actionBusy = true;
    try {
      const response = await this.sessionsApi.patchSession(this.serverUrl(), this.token(),
        target.id, null, !target.pinned, null);
      this.applySessionUpdate(this.toListItem(response.session));
      if (target.pinned) {
        showToast($r('app.string.home_session_unpinned'));
      } else {
        showToast($r('app.string.home_session_pinned'));
      }
    } catch (error) {
      showToast($r('app.string.home_pin_update_failed'));
    }
    this.actionBusy = false;
  }

  // Marks a single session read when the user opens it; the local patch makes
  // the unread dot disappear immediately.
  private async markReadOnOpen(sessionId: string): Promise<void> {
    const target = this.findSession(sessionId);
    if (target === null || !target.unread) {
      return;
    }
    try {
      await this.sessionsApi.markSessionsRead(this.serverUrl(), this.token(), [sessionId]);
      this.applySessionUpdate(this.withUnread(target, false));
    } catch (error) {
      // Ignore: opening the session matters more than the read receipt.
    }
  }

  private openSession(sessionId: string): void {
    this.markReadOnOpen(sessionId);
    this.pathStack.pushPathByName('session_detail', sessionId);
  }

  // --- Project lookup / mutation --------------------------------------------

  private findProject(projectId: string): RemoteProject | null {
    for (const project of this.projects) {
      if (project.id === projectId) {
        return project;
      }
    }
    return null;
  }

  private findDeviceName(deviceId: string): string {
    for (const device of this.homeDevices) {
      if (device.id === deviceId) {
        const trimmed = device.name.trim();
        return trimmed.length > 0 ? trimmed : device.id;
      }
    }
    return deviceId;
  }

  private applyProjectUpdate(next: RemoteProject): void {
    const updated: RemoteProject[] = [];
    for (const project of this.projects) {
      if (project.id === next.id) {
        updated.push(next);
      } else {
        updated.push(project);
      }
    }
    this.projects = updated;
    this.rebuildProjectTree();
  }

  // --- Project edit sheet -----------------------------------------------------

  private openEditProject(): void {
    const project = this.findProject(this.projectActionMenuId);
    if (project === null) {
      return;
    }
    this.editProjectNameInput = project.name;
    this.editProjectError = '';
    this.editProjectId = project.id;
    this.closeProjectMenu();
  }

  private closeEditProject(): void {
    if (this.editProjectBusy) {
      return;
    }
    this.editProjectId = '';
    this.editProjectError = '';
  }

  private editProjectOriginalName(): string {
    const project = this.findProject(this.editProjectId);
    return project === null ? '' : project.name;
  }

  private editProjectDeviceName(): string {
    const project = this.findProject(this.editProjectId);
    return project === null ? '' : this.findDeviceName(project.connectorId);
  }

  private editProjectWorkspacePath(): string {
    const project = this.findProject(this.editProjectId);
    return project === null ? '' : project.workspacePath;
  }

  private async confirmProjectEdit(): Promise<void> {
    const projectId = this.editProjectId;
    const name = this.editProjectNameInput.trim();
    if (projectId.length === 0 || name.length === 0 || this.editProjectBusy) {
      return;
    }
    this.editProjectBusy = true;
    try {
      const updated = await this.sessionsApi.updateProject(this.serverUrl(), this.token(),
        projectId, name, null);
      this.applyProjectUpdate(updated);
      this.editProjectId = '';
      this.editProjectError = '';
      showToast($r('app.string.home_project_updated'));
    } catch (error) {
      if (error instanceof ApiException && error.errorCode === 'project_name_conflict') {
        // Mirrors Android's 409 handling: refetch the project list (without
        // touching the rendered tree state), prefill an available name and
        // keep the sheet open for confirmation.
        let others: RemoteProject[] = [];
        try {
          const list = await this.sessionsApi.listProjects(this.serverUrl(), this.token());
          for (const project of list.projects) {
            if (project.id !== projectId) {
              others.push(project);
            }
          }
        } catch (listError) {
          for (const project of this.projects) {
            if (project.id !== projectId) {
              others.push(project);
            }
          }
        }
        this.editProjectNameInput = availableProjectName(name, others);
        this.editProjectError = this.localText($r('app.string.project_name_adjusted'));
      } else {
        this.editProjectError = errorMessageFrom(error as Object);
      }
    }
    this.editProjectBusy = false;
  }

  private async toggleProjectPinned(): Promise<void> {
    const project = this.findProject(this.projectActionMenuId);
    if (project === null) {
      return;
    }
    this.closeProjectMenu();
    this.actionBusy = true;
    try {
      const updated = await this.sessionsApi.updateProject(this.serverUrl(), this.token(),
        project.id, null, !project.pinned);
      this.applyProjectUpdate(updated);
      if (project.pinned) {
        showToast($r('app.string.home_project_unpinned'));
      } else {
        showToast($r('app.string.home_project_pinned'));
      }
    } catch (error) {
      showToast($r('app.string.home_project_update_failed'));
    }
    this.actionBusy = false;
  }

  // --- Project archive dialog ---------------------------------------------------

  private openArchiveDialog(): void {
    if (this.projectActionMenuId.length === 0) {
      return;
    }
    this.archiveProjectId = this.projectActionMenuId;
    this.closeProjectMenu();
  }

  private closeArchiveDialog(): void {
    if (this.archiveProjectBusy) {
      return;
    }
    this.archiveProjectId = '';
  }

  private archiveProjectName(): string {
    const project = this.findProject(this.archiveProjectId);
    return project === null ? '' : project.name;
  }

  private async confirmArchiveProject(): Promise<void> {
    const projectId = this.archiveProjectId;
    if (projectId.length === 0 || this.archiveProjectBusy) {
      return;
    }
    this.archiveProjectBusy = true;
    try {
      await this.sessionsApi.archiveAllProjectSessions(this.serverUrl(), this.token(),
        projectId, true, 'all');
      const targets: SessionListItem[] = [];
      for (const item of this.collectAllSessions()) {
        if (item.projectId === projectId && !item.archived) {
          targets.push(item);
        }
      }
      for (const item of targets) {
        this.applySessionUpdate(this.withArchived(item, true));
      }
      this.setProjectExpanded(projectId, false);
      this.rebuildProjectTree();
      this.invalidateProjectCache(projectId);
      showToast($r('app.string.home_project_archived'));
      this.loadSessions();
    } catch (error) {
      showToast($r('app.string.home_project_archive_failed'));
    }
    this.archiveProjectId = '';
    this.archiveProjectBusy = false;
  }

  // --- Row action accessors ---------------------------------------------------

  private projectActionProjectName(): string {
    const project = this.findProject(this.projectActionMenuId);
    return project === null ? '' : project.name;
  }

  private projectActionWorkspacePath(): string {
    const project = this.findProject(this.projectActionMenuId);
    return project === null ? '' : project.workspacePath;
  }

  private projectActionProjectPinned(): boolean {
    const project = this.findProject(this.projectActionMenuId);
    return project !== null && project.pinned;
  }

  private actionMenuTitle(): string {
    const target = this.findSession(this.actionMenuSessionId);
    return target === null ? '' : target.title;
  }

  private actionMenuArchived(): boolean {
    const target = this.findSession(this.actionMenuSessionId);
    return target !== null && target.archived;
  }

  private actionMenuPinned(): boolean {
    const target = this.findSession(this.actionMenuSessionId);
    return target !== null && target.pinned;
  }

  // --- Entry points ------------------------------------------------------------

  // The square-and-pencil action of a project row: opens the new-session sheet
  // pre-targeted at the project's device.
  private onNewSessionInProject(projectId: string): void {
    const project = this.findProject(projectId);
    if (project === null) {
      return;
    }
    this.openNewSession();
    this.newSessionPreferredConnectorId = project.connectorId;
  }

  private openCreateProject(): void {
    if (!this.projectsSectionExpanded) {
      this.toggleProjectsSection();
    }
    this.pathStack.pushPathByName('new_project', '');
  }

  private retryInitialLoad(): void {
    this.errorMessage = '';
    this.loading = true;
    this.loadSessions();
    this.loadAgentGate();
  }

  // The pairing prompt wins over the empty tree once devices are known to be
  // absent (Android HomeScreen's pairDeviceFirst state).
  private pairPromptVisible(): boolean {
    return this.homeDevicesLoaded && this.homeDevices.length === 0;
  }

  // Product decision (diverges from Android, which keeps listing server-side
  // sessions): the home tree is gated on a running Agent. When every device is
  // offline or no Agent is running, show setup guidance instead of the tree.
  private async loadAgentGate(): Promise<void> {
    const seq = ++this.agentGateSeq;
    try {
      const devices = await this.devicesApi.listDevices(this.serverUrl(), this.token());
      if (!this.pageActive || seq !== this.agentGateSeq) {
        return;
      }
      const onlineIds: string[] = [];
      for (const device of devices) {
        if (device.status === 'online') {
          onlineIds.push(device.id);
        }
      }
      this.lastGateOnlineKey = onlineIds.join(',');
      if (devices.length === 0) {
        this.agentGateState = 'no_devices';
        return;
      }
      if (onlineIds.length === 0) {
        this.agentGateState = 'devices_offline';
        return;
      }
      let agentOnline = false;
      for (const deviceId of onlineIds) {
        try {
          const list = await this.devicesApi.listDeviceRuntimes(this.serverUrl(), this.token(), deviceId);
          if (runnableRuntimes(list.runtimes).length > 0) {
            agentOnline = true;
            break;
          }
        } catch (error) {
          // One device's runtime list failing must not fail the whole gate.
        }
      }
      if (!this.pageActive || seq !== this.agentGateSeq) {
        return;
      }
      this.agentGateState = agentOnline ? 'ready' : 'no_agents';
    } catch (error) {
      if (!this.pageActive || seq !== this.agentGateSeq) {
        return;
      }
      // Fail open: a gate check error must not hide the session tree.
      this.agentGateState = 'ready';
    }
  }

  @Builder
  private agentGateContent() {
    Column() {
      if (this.agentGateState === 'devices_offline') {
        Text('🔌')
          .fontSize(40)
        Text($r('app.string.new_session_devices_offline_title'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .lineHeight(21.5)
          .fontColor(getColors().inkSoft)
          .textAlign(TextAlign.Center)
          .maxLines(3)
          .constraintSize({ maxWidth: 294 })
          .margin({ top: 10 })
        Text($r('app.string.new_session_devices_offline_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().faint)
          .textAlign(TextAlign.Center)
          .maxLines(4)
          .constraintSize({ maxWidth: 294 })
          .margin({ top: 6 })
      } else {
        Text('🤖')
          .fontSize(40)
        Text($r('app.string.new_session_setup_agent_title'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .lineHeight(21.5)
          .fontColor(getColors().inkSoft)
          .textAlign(TextAlign.Center)
          .maxLines(3)
          .constraintSize({ maxWidth: 294 })
          .margin({ top: 10 })
        Text($r('app.string.new_session_setup_agent_description'))
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().faint)
          .textAlign(TextAlign.Center)
          .maxLines(4)
          .constraintSize({ maxWidth: 294 })
          .margin({ top: 6 })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }

  private treeHasContent(): boolean {
    return this.treeHasAnyContent;
  }

  private openNewSession(): void {
    this.selectedDeviceId = '';
    this.selectedRuntimeType = '';
    this.selectedRuntimeId = '';
    this.newSessionAttachments = [];
    this.pickingAttachment = false;
    this.runtimes = [];
    this.runtimesLoading = false;
    this.newSessionCwd = '~';
    this.newSessionMessage = '';
    this.newSessionError = '';
    this.newSessionTitleInput = '';
    this.devices = [];
    this.newSessionSetupState = 'checking';
    this.newSessionRuntimeRequestSeq++;
    this.resetNewSessionCatalogState();
    this.resetNewSessionBrowserState();
    this.readNewSessionPreference();
    this.newSessionVisible = true;
    this.loadNewSessionDevices();
  }

  private closeNewSession(): void {
    if (this.creatingSession) {
      return;
    }
    this.newSessionVisible = false;
  }

  private readNewSessionPreference(): void {
    this.newSessionPreferredConnectorId = '';
    this.newSessionPreferredRuntimeId = '';
    try {
      const preference = this.newSessionPreferenceStore.readPreference(this.serverUrl(),
        this.authStore.readUserId());
      if (preference !== null) {
        this.newSessionPreferredConnectorId = preference.connectorId;
        this.newSessionPreferredRuntimeId = preference.runtimeId;
      }
    } catch (error) {
    }
  }

  private newSessionSelectionHint(connectorId: string,
    runtimeId: string): NewSessionStoredSelection | null {
    try {
      const preference = this.newSessionPreferenceStore.readPreference(this.serverUrl(),
        this.authStore.readUserId());
      if (preference === null) {
        return null;
      }
      for (const entry of preference.selections) {
        if (entry.connectorId === connectorId && entry.runtimeId === runtimeId) {
          return entry;
        }
      }
    } catch (error) {
    }
    return null;
  }

  private async loadNewSessionDevices(): Promise<void> {
    this.newSessionSetupState = 'checking';
    // A retry (Check again) must clear the previous selection: autoSelectDevice
    // early-returns while selectedDeviceId is set, which would leave the sheet
    // stuck in the checking state forever.
    this.selectedDeviceId = '';
    this.selectedRuntimeType = '';
    this.selectedRuntimeId = '';
    this.runtimes = [];
    this.runtimesLoading = false;
    this.newSessionRuntimeRequestSeq++;
    try {
      const devices = await this.devicesApi.listDevices(this.serverUrl(), this.token());
      if (!this.newSessionVisible) {
        return;
      }
      this.devices = devices;
      if (devices.length === 0) {
        this.newSessionSetupState = 'no_devices';
        return;
      }
      let hasOnline = false;
      for (const device of devices) {
        if (device.status === 'online') {
          hasOnline = true;
          break;
        }
      }
      if (!hasOnline) {
        this.newSessionSetupState = 'devices_offline';
        return;
      }
      this.autoSelectDevice();
    } catch (error) {
      if (!this.newSessionVisible) {
        return;
      }
      this.newSessionSetupState = 'devices_load_failed';
    }
  }

  // Mirrors Android NewSessionScreen: default to the last used connector (when
  // online) or the first online device so the sheet is ready without taps.
  private autoSelectDevice(): void {
    if (this.creatingSession || this.selectedDeviceId.length > 0) {
      return;
    }
    let target: RemoteDevice | null = null;
    for (const device of this.devices) {
      if (device.status === 'online') {
        if (device.id === this.newSessionPreferredConnectorId) {
          target = device;
          break;
        }
        if (target === null) {
          target = device;
        }
      }
    }
    if (target !== null) {
      this.selectDevice(target.id);
    }
  }

  private async selectDevice(deviceId: string): Promise<void> {
    if (this.creatingSession || this.selectedDeviceId === deviceId) {
      return;
    }
    this.selectedDeviceId = deviceId;
    this.selectedRuntimeType = '';
    this.selectedRuntimeId = '';
    this.runtimes = [];
    this.newSessionError = '';
    this.runtimesLoading = true;
    this.resetNewSessionCatalogState();
    this.resetNewSessionBrowserState();
    try {
      const list = await this.devicesApi.listDeviceRuntimes(this.serverUrl(), this.token(), deviceId);
      if (!this.newSessionVisible || this.selectedDeviceId !== deviceId) {
        return;
      }
      this.runtimes = runnableRuntimes(list.runtimes);
    } catch (error) {
      this.runtimesLoading = false;
      if (!this.newSessionVisible || this.selectedDeviceId !== deviceId) {
        return;
      }
      this.newSessionSetupState = 'runtimes_load_failed';
      return;
    }
    this.runtimesLoading = false;
    this.autoSelectRuntime();
  }

  // Mirrors Android NewSessionRuntimeSelectionState.replaceRuntimeInventory:
  // once a device's runtimes are loaded, default to the last used one.
  private autoSelectRuntime(): void {
    if (this.selectedRuntimeId.length > 0 || this.selectedDeviceId.length === 0) {
      return;
    }
    if (this.runtimes.length === 0) {
      this.newSessionSetupState = 'no_runtimes';
      return;
    }
    let preferred: RemoteDeviceRuntime | null = null;
    for (const runtime of this.runtimes) {
      if (runtime.runtimeId === this.newSessionPreferredRuntimeId) {
        preferred = runtime;
        break;
      }
    }
    this.selectRuntime(preferred === null ? this.runtimes[0] : preferred);
  }

  private selectRuntime(runtime: RemoteDeviceRuntime): void {
    if (this.creatingSession) {
      return;
    }
    if (this.selectedRuntimeId === runtime.runtimeId &&
      this.selectedRuntimeType === runtime.runtimeType) {
      return;
    }
    this.selectedRuntimeType = runtime.runtimeType;
    this.selectedRuntimeId = runtime.runtimeId;
    this.newSessionSetupState = 'ready';
    this.resetNewSessionCatalogState();
    this.resetNewSessionBrowserState();
    this.persistNewSessionTarget();
    this.loadNewSessionRuntimeDetails();
  }

  private resetNewSessionCatalogState(): void {
    this.newSessionCapabilities = [];
    this.newSessionCapabilityError = '';
    this.newSessionCatalogLoading = false;
    this.newSessionModelCatalog = null;
    this.newSessionModelCatalogError = '';
    this.newSessionPermissionCatalog = null;
    this.newSessionPermissionCatalogError = '';
    this.newSessionSelectedModelId = '';
    this.newSessionSelectedEffortId = '';
    this.newSessionSelectedPermissionId = '';
    this.newSessionCatalogView = emptyNewSessionCatalogView();
    this.newSessionStartEnabled = false;
  }

  private resetNewSessionBrowserState(): void {
    this.newSessionBrowserRequestSeq++;
    this.newSessionBrowserVisible = false;
    this.newSessionBrowserLoading = false;
    this.newSessionBrowserError = '';
    this.newSessionBrowserPath = '.';
    this.newSessionBrowserLastRequestPath = '.';
    this.newSessionBrowserRoot = '~';
    this.newSessionBrowserEntries = [];
    this.newSessionBrowserView = emptyNewSessionBrowserView();
  }

  private persistNewSessionTarget(): void {
    try {
      this.newSessionPreferenceStore.saveTarget(this.serverUrl(), this.authStore.readUserId(),
        this.selectedDeviceId, this.selectedRuntimeId);
    } catch (error) {
    }
  }

  private async loadNewSessionRuntimeDetails(): Promise<void> {
    const deviceId = this.selectedDeviceId;
    const runtimeId = this.selectedRuntimeId;
    const runtimeType = this.selectedRuntimeType;
    if (deviceId.length === 0 || runtimeId.length === 0) {
      return;
    }
    this.newSessionRuntimeRequestSeq++;
    const seq = this.newSessionRuntimeRequestSeq;
    this.newSessionCatalogLoading = true;
    this.rebuildNewSessionCatalogView();
    try {
      const capabilities = await this.devicesApi.getDeviceRuntimeCapabilities(this.serverUrl(),
        this.token(), deviceId, runtimeId);
      if (seq !== this.newSessionRuntimeRequestSeq) {
        return;
      }
      this.newSessionCapabilities = capabilities.capabilities;
      this.newSessionCapabilityError = '';
    } catch (error) {
      if (seq !== this.newSessionRuntimeRequestSeq) {
        return;
      }
      this.newSessionCapabilities = [];
      this.newSessionCapabilityError = this.localText($r('app.string.new_session_capabilities_failed'));
      this.newSessionCatalogLoading = false;
      this.rebuildNewSessionCatalogView();
      return;
    }
    const modelCapability = findRuntimeCapability(this.newSessionCapabilities,
      MODEL_CATALOG_CAPABILITY, runtimeId, runtimeType);
    const permissionCapability = findRuntimeCapability(this.newSessionCapabilities,
      PERMISSION_CATALOG_CAPABILITY, runtimeId, runtimeType);
    if (isRuntimeCapabilityUsable(modelCapability)) {
      try {
        const catalog = await this.devicesApi.getDeviceRuntimeModelCatalog(this.serverUrl(),
          this.token(), deviceId, runtimeId);
        if (seq !== this.newSessionRuntimeRequestSeq) {
          return;
        }
        this.newSessionModelCatalog = catalog;
        this.newSessionModelCatalogError = '';
        this.applyModelCatalogDefaults();
      } catch (error) {
        if (seq !== this.newSessionRuntimeRequestSeq) {
          return;
        }
        this.newSessionModelCatalog = null;
        this.newSessionModelCatalogError = this.localText($r('app.string.new_session_model_catalog_failed'));
      }
    } else {
      this.newSessionModelCatalog = null;
      this.newSessionModelCatalogError = '';
    }
    if (isRuntimeCapabilityUsable(permissionCapability)) {
      try {
        const catalog = await this.devicesApi.getDeviceRuntimePermissionCatalog(this.serverUrl(),
          this.token(), deviceId, runtimeId);
        if (seq !== this.newSessionRuntimeRequestSeq) {
          return;
        }
        this.newSessionPermissionCatalog = catalog;
        this.newSessionPermissionCatalogError = '';
        this.applyPermissionCatalogDefaults();
      } catch (error) {
        if (seq !== this.newSessionRuntimeRequestSeq) {
          return;
        }
        this.newSessionPermissionCatalog = null;
        this.newSessionPermissionCatalogError =
          this.localText($r('app.string.new_session_permission_catalog_failed'));
      }
    } else {
      this.newSessionPermissionCatalog = null;
      this.newSessionPermissionCatalogError = '';
    }
    if (seq !== this.newSessionRuntimeRequestSeq) {
      return;
    }
    this.newSessionCatalogLoading = false;
    this.rebuildNewSessionCatalogView();
  }

  private modelHasReasoningSelections(model: RemoteModelItem): boolean {
    for (const effort of model.reasoningItems) {
      if (effort.id.length > 0 && effort.selectionId.length > 0) {
        return true;
      }
    }
    return false;
  }

  private modelHasValidSelection(model: RemoteModelItem): boolean {
    if (this.modelHasReasoningSelections(model)) {
      for (const effort of model.reasoningItems) {
        if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0) {
          return true;
        }
      }
      return false;
    }
    return model.selectionId !== null && model.selectionId.length > 0;
  }

  private findModelBySelectionId(catalog: RemoteModelCatalog,
    selectionId: string): NewSessionModelSelection {
    const result: NewSessionModelSelection = { model: null, effort: null };
    for (const model of catalog.models) {
      if (!model.enabled) {
        continue;
      }
      for (const effort of model.reasoningItems) {
        if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0 &&
          effort.selectionId === selectionId) {
          result.model = model;
          result.effort = effort;
          return result;
        }
      }
      if (!this.modelHasReasoningSelections(model) && model.id.length > 0 &&
        model.selectionId === selectionId) {
        result.model = model;
        return result;
      }
    }
    return result;
  }

  private applyModelCatalogDefaults(): void {
    const catalog = this.newSessionModelCatalog;
    if (catalog === null) {
      return;
    }
    const hintEntry = this.newSessionSelectionHint(this.selectedDeviceId, this.selectedRuntimeId);
    const hint = hintEntry === null ? null : hintEntry.model;
    const selection: NewSessionModelSelection = { model: null, effort: null };
    if (hint !== null && hint.length > 0) {
      const resolved = this.findModelBySelectionId(catalog, hint);
      selection.model = resolved.model;
      selection.effort = resolved.effort;
    }
    if (selection.model === null) {
      for (const model of catalog.models) {
        if (model.enabled && model.id.length > 0 && this.modelHasValidSelection(model) &&
          model.isDefault) {
          selection.model = model;
          break;
        }
      }
    }
    if (selection.model === null) {
      for (const model of catalog.models) {
        if (model.enabled && model.id.length > 0 && this.modelHasValidSelection(model)) {
          selection.model = model;
          break;
        }
      }
    }
    if (selection.model !== null) {
      for (const effort of selection.model.reasoningItems) {
        if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0) {
          if (selection.effort === null) {
            selection.effort = effort;
          }
          if (effort.isDefault) {
            selection.effort = effort;
            break;
          }
        }
      }
    }
    this.newSessionSelectedModelId = selection.model === null ? '' : selection.model.id;
    this.newSessionSelectedEffortId = selection.effort === null ? '' : selection.effort.id;
  }

  private applyPermissionCatalogDefaults(): void {
    const catalog = this.newSessionPermissionCatalog;
    if (catalog === null) {
      return;
    }
    const hintEntry = this.newSessionSelectionHint(this.selectedDeviceId, this.selectedRuntimeId);
    const hint = hintEntry === null ? null : hintEntry.permission;
    let selected: RemotePermissionItem | null = null;
    if (hint !== null && hint.length > 0) {
      for (const permission of catalog.permissions) {
        if (permission.enabled && permission.selectionId.length > 0 &&
          permission.selectionId === hint) {
          selected = permission;
          break;
        }
      }
    }
    if (selected === null) {
      for (const permission of catalog.permissions) {
        if (permission.enabled && permission.id.length > 0 &&
          permission.selectionId.length > 0 && permission.isDefault) {
          selected = permission;
          break;
        }
      }
    }
    if (selected === null) {
      for (const permission of catalog.permissions) {
        if (permission.enabled && permission.id.length > 0 && permission.selectionId.length > 0) {
          selected = permission;
          break;
        }
      }
    }
    this.newSessionSelectedPermissionId = selected === null ? '' : selected.id;
  }

  private selectedModelItem(): RemoteModelItem | null {
    const catalog = this.newSessionModelCatalog;
    if (catalog === null) {
      return null;
    }
    for (const model of catalog.models) {
      if (model.enabled && model.id === this.newSessionSelectedModelId) {
        return model;
      }
    }
    return null;
  }

  private selectedEffortItem(): RemoteReasoningItem | null {
    const model = this.selectedModelItem();
    if (model === null) {
      return null;
    }
    for (const effort of model.reasoningItems) {
      if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0 &&
        effort.id === this.newSessionSelectedEffortId) {
        return effort;
      }
    }
    return null;
  }

  private selectedModelSelectionId(): string | null {
    const model = this.selectedModelItem();
    if (model === null) {
      return null;
    }
    const effort = this.selectedEffortItem();
    if (effort !== null) {
      return effort.selectionId;
    }
    if (this.modelHasReasoningSelections(model)) {
      return null;
    }
    return model.selectionId !== null && model.selectionId.length > 0 ? model.selectionId : null;
  }

  private selectedPermissionSelectionId(): string | null {
    const catalog = this.newSessionPermissionCatalog;
    if (catalog === null) {
      return null;
    }
    for (const permission of catalog.permissions) {
      if (permission.enabled && permission.id === this.newSessionSelectedPermissionId &&
        permission.selectionId.length > 0) {
        return permission.selectionId;
      }
    }
    return null;
  }

  private selectNewSessionModel(modelId: string): void {
    if (this.creatingSession) {
      return;
    }
    const catalog = this.newSessionModelCatalog;
    if (catalog === null) {
      return;
    }
    let target: RemoteModelItem | null = null;
    for (const model of catalog.models) {
      if (model.id === modelId && model.enabled && this.modelHasValidSelection(model)) {
        target = model;
        break;
      }
    }
    if (target === null) {
      return;
    }
    this.newSessionSelectedModelId = target.id;
    let effortId = '';
    for (const effort of target.reasoningItems) {
      if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0) {
        if (effortId.length === 0) {
          effortId = effort.id;
        }
        if (effort.isDefault) {
          effortId = effort.id;
          break;
        }
      }
    }
    this.newSessionSelectedEffortId = effortId;
    this.saveNewSessionModelSelection();
    this.rebuildNewSessionCatalogView();
  }

  private selectNewSessionEffort(effortId: string): void {
    if (this.creatingSession) {
      return;
    }
    const model = this.selectedModelItem();
    if (model === null) {
      return;
    }
    let found = false;
    for (const effort of model.reasoningItems) {
      if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0 &&
        effort.id === effortId) {
        found = true;
        break;
      }
    }
    if (!found) {
      return;
    }
    this.newSessionSelectedEffortId = effortId;
    this.saveNewSessionModelSelection();
    this.rebuildNewSessionCatalogView();
  }

  private selectNewSessionPermission(permissionId: string): void {
    if (this.creatingSession) {
      return;
    }
    const catalog = this.newSessionPermissionCatalog;
    if (catalog === null) {
      return;
    }
    let valid = false;
    for (const permission of catalog.permissions) {
      if (permission.enabled && permission.id === permissionId && permission.selectionId.length > 0) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      return;
    }
    this.newSessionSelectedPermissionId = permissionId;
    try {
      const permissionSelection = this.selectedPermissionSelectionId();
      if (permissionSelection !== null) {
        this.newSessionPreferenceStore.savePermission(this.serverUrl(), this.authStore.readUserId(),
          this.selectedDeviceId, this.selectedRuntimeId, permissionSelection);
      }
    } catch (error) {
    }
    this.rebuildNewSessionCatalogView();
  }

  private saveNewSessionModelSelection(): void {
    try {
      const modelSelection = this.selectedModelSelectionId();
      if (modelSelection !== null) {
        this.newSessionPreferenceStore.saveModel(this.serverUrl(), this.authStore.readUserId(),
          this.selectedDeviceId, this.selectedRuntimeId, modelSelection);
      }
    } catch (error) {
    }
  }

  private computeNewSessionStartEnabled(modelSupported: boolean,
    permissionSupported: boolean): boolean {
    if (this.selectedRuntimeId.length === 0 || this.creatingSession ||
      this.newSessionCatalogLoading || this.newSessionCapabilityError.length > 0) {
      return false;
    }
    if (modelSupported) {
      if (this.newSessionModelCatalogError.length > 0 || this.newSessionModelCatalog === null) {
        return false;
      }
      const catalog = this.newSessionModelCatalog as RemoteModelCatalog;
      if (catalog.models.length > 0 && this.selectedModelSelectionId() === null) {
        return false;
      }
    }
    if (permissionSupported) {
      if (this.newSessionPermissionCatalogError.length > 0 ||
        this.newSessionPermissionCatalog === null) {
        return false;
      }
      const catalog = this.newSessionPermissionCatalog as RemotePermissionCatalog;
      if (catalog.permissions.length > 0 && this.selectedPermissionSelectionId() === null) {
        return false;
      }
    }
    return true;
  }

  private runtimePermissionStrings(): RuntimePermissionStrings {
    const strings: RuntimePermissionStrings = {
      dshReadOnly: this.localText($r('app.string.runtime_permission_dsh_read_only')),
      dshWorkspaceWrite: this.localText($r('app.string.runtime_permission_dsh_workspace_write')),
      dshFullAccess: this.localText($r('app.string.runtime_permission_dsh_full_access')),
      requestApproval: this.localText($r('app.string.runtime_permission_request_approval')),
      autoReview: this.localText($r('app.string.runtime_permission_auto_review')),
      fullAccess: this.localText($r('app.string.runtime_permission_full_access')),
      claudeDefault: this.localText($r('app.string.runtime_permission_claude_default')),
      claudeAcceptEdits: this.localText($r('app.string.runtime_permission_claude_accept_edits')),
      claudePlan: this.localText($r('app.string.runtime_permission_claude_plan')),
      claudeAuto: this.localText($r('app.string.runtime_permission_claude_auto')),
      claudeDontAsk: this.localText($r('app.string.runtime_permission_claude_dont_ask')),
      claudeBypassPermissions: this.localText($r('app.string.runtime_permission_claude_bypass_permissions')),
      descRequestApproval: this.localText($r('app.string.runtime_permission_desc_request_approval')),
      descAutoReview: this.localText($r('app.string.runtime_permission_desc_auto_review')),
      descFullAccess: this.localText($r('app.string.runtime_permission_desc_full_access')),
      descClaudeDefault: this.localText($r('app.string.runtime_permission_desc_claude_default')),
      descClaudeAcceptEdits: this.localText($r('app.string.runtime_permission_desc_claude_accept_edits')),
      descClaudePlan: this.localText($r('app.string.runtime_permission_desc_claude_plan')),
      descClaudeAuto: this.localText($r('app.string.runtime_permission_desc_claude_auto')),
      descClaudeDontAsk: this.localText($r('app.string.runtime_permission_desc_claude_dont_ask')),
      descClaudeBypassPermissions: this.localText($r('app.string.runtime_permission_desc_claude_bypass_permissions'))
    };
    return strings;
  }

  private rebuildNewSessionCatalogView(): void {
    const runtimeId = this.selectedRuntimeId;
    const runtimeType = this.selectedRuntimeType;
    const modelCapability = findRuntimeCapability(this.newSessionCapabilities,
      MODEL_CATALOG_CAPABILITY, runtimeId, runtimeType);
    const permissionCapability = findRuntimeCapability(this.newSessionCapabilities,
      PERMISSION_CATALOG_CAPABILITY, runtimeId, runtimeType);
    const modelSupported = isRuntimeCapabilityUsable(modelCapability);
    const permissionSupported = isRuntimeCapabilityUsable(permissionCapability);
    const view: NewSessionCatalogView = emptyNewSessionCatalogView();
    view.loading = this.newSessionCatalogLoading;
    if (this.newSessionCapabilityError.length > 0) {
      view.errorText = this.newSessionCapabilityError;
    } else if (this.newSessionModelCatalogError.length > 0) {
      view.errorText = this.newSessionModelCatalogError;
    } else if (this.newSessionPermissionCatalogError.length > 0) {
      view.errorText = this.newSessionPermissionCatalogError;
    }
    view.modelUnavailable = !modelSupported;
    view.permissionUnavailable = !permissionSupported;
    const modelCatalog = this.newSessionModelCatalog;
    if (modelCatalog !== null) {
      for (const model of modelCatalog.models) {
        const option: NewSessionCatalogOption = {
          id: model.id,
          label: model.displayName.length > 0 ? model.displayName : model.id,
          description: model.description,
          selected: model.id === this.newSessionSelectedModelId,
          enabled: model.enabled && this.modelHasValidSelection(model)
        };
        view.models.push(option);
      }
      const selectedModel = this.selectedModelItem();
      if (selectedModel !== null) {
        for (const effort of selectedModel.reasoningItems) {
          if (effort.enabled && effort.id.length > 0 && effort.selectionId.length > 0) {
            let label = effort.displayName;
            if (label.length === 0) {
              label = effort.id === 'default'
                ? this.localText($r('app.string.session_runtime_effort_default')) : effort.id;
            }
            const option: NewSessionCatalogOption = {
              id: effort.id,
              label: label,
              description: effort.description,
              selected: effort.id === this.newSessionSelectedEffortId,
              enabled: true
            };
            view.efforts.push(option);
          }
        }
      }
    }
    const permissionCatalog = this.newSessionPermissionCatalog;
    if (permissionCatalog !== null) {
      const strings = this.runtimePermissionStrings();
      for (const permission of permissionCatalog.permissions) {
        const fallbackLabel = permission.displayName.length > 0 ? permission.displayName : permission.id;
        const localized: LocalizedRuntimePermission = localizeRuntimePermission(strings, runtimeType,
          permission.id, fallbackLabel, permission.description, permission.metadata);
        const option: NewSessionCatalogOption = {
          id: permission.id,
          label: localized.label,
          description: localized.description,
          selected: permission.id === this.newSessionSelectedPermissionId,
          enabled: permission.enabled && permission.selectionId.length > 0
        };
        view.permissions.push(option);
      }
    }
    this.newSessionCatalogView = view;
    this.newSessionStartEnabled = this.computeNewSessionStartEnabled(modelSupported,
      permissionSupported);
  }

  private toggleNewSessionBrowser(): void {
    if (this.creatingSession || this.selectedDeviceId.length === 0) {
      return;
    }
    this.newSessionBrowserVisible = !this.newSessionBrowserVisible;
    if (this.newSessionBrowserVisible && this.newSessionBrowserEntries.length === 0 &&
      this.newSessionBrowserError.length === 0 && !this.newSessionBrowserLoading) {
      this.loadNewSessionBrowserDirectory(this.newSessionBrowserStartPath());
    } else {
      this.rebuildNewSessionBrowserView();
    }
  }

  private newSessionBrowserDevice(): RemoteDevice | null {
    for (const device of this.devices) {
      if (device.id === this.selectedDeviceId) {
        return device;
      }
    }
    return null;
  }

  private newSessionBrowserStartPath(): string {
    const device = this.newSessionBrowserDevice();
    return initialRemoteFilePath(device === null ? null : device.deviceOs);
  }

  private async loadNewSessionBrowserDirectory(path: string): Promise<void> {
    const deviceId = this.selectedDeviceId;
    if (deviceId.length === 0 || this.creatingSession) {
      return;
    }
    this.newSessionBrowserRequestSeq++;
    const seq = this.newSessionBrowserRequestSeq;
    this.newSessionBrowserLastRequestPath = path;
    this.newSessionBrowserLoading = true;
    this.newSessionBrowserError = '';
    this.rebuildNewSessionBrowserView();
    let requestPath = path;
    let requestRoot = this.newSessionBrowserRoot;
    if (isWindowsDriveStylePath(requestPath)) {
      if (requestPath.length === 2) {
        requestPath = `${requestPath}\\`;
      }
      requestRoot = windowsDriveRootOf(requestPath);
    }
    try {
      const directory = await this.filesApi.listFiles(this.serverUrl(), this.token(),
        deviceId, requestRoot, requestPath);
      if (seq !== this.newSessionBrowserRequestSeq) {
        return;
      }
      const device = this.newSessionBrowserDevice();
      const windowsDevice = device !== null && isWindowsDeviceOs(device.deviceOs);
      const directories: RemoteDirectoryEntry[] = [];
      for (const entry of directory.entries) {
        if (entry.type === 'directory' && !isHiddenFileEntryName(entry.name, windowsDevice)) {
          directories.push(entry);
        }
      }
      directories.sort((left: RemoteDirectoryEntry, right: RemoteDirectoryEntry): number => {
        return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      });
      this.newSessionBrowserEntries = directories;
      this.newSessionBrowserPath = directory.path;
      if (isWindowsDriveStylePath(this.newSessionBrowserPath)) {
        this.newSessionBrowserRoot = windowsDriveRootOf(this.newSessionBrowserPath);
      }
    } catch (error) {
      if (seq !== this.newSessionBrowserRequestSeq) {
        return;
      }
      this.newSessionBrowserEntries = [];
      this.newSessionBrowserError = this.localText($r('app.string.new_session_load_directory_failed'));
    }
    this.newSessionBrowserLoading = false;
    this.rebuildNewSessionBrowserView();
  }

  private newSessionBrowserParentPath(): string {
    const path = this.newSessionBrowserPath;
    const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (slashIndex < 0) {
      return '.';
    }
    const parent = path.substring(0, slashIndex);
    if (parent.length === 0) {
      return '/';
    }
    return parent;
  }

  private newSessionBrowserCanGoUp(): boolean {
    const path = this.newSessionBrowserPath;
    if (path.length === 0) {
      return false;
    }
    if (isWindowsDriveStylePath(path)) {
      return true;
    }
    return path !== '.' && path !== '/' && path !== '~';
  }

  private goNewSessionBrowserUp(): void {
    if (!this.newSessionBrowserCanGoUp() || this.creatingSession) {
      return;
    }
    const path = this.newSessionBrowserPath;
    if (isWindowsDriveRootPath(path)) {
      this.loadNewSessionBrowserDirectory('');
      return;
    }
    if (isWindowsDriveStylePath(path)) {
      this.loadNewSessionBrowserDirectory(windowsParentPath(path));
      return;
    }
    this.loadNewSessionBrowserDirectory(this.newSessionBrowserParentPath());
  }

  private retryNewSessionBrowser(): void {
    this.loadNewSessionBrowserDirectory(this.newSessionBrowserLastRequestPath);
  }

  private useNewSessionBrowserDirectory(): void {
    const path = this.newSessionBrowserPath;
    if (path.length === 0 || this.creatingSession) {
      return;
    }
    this.newSessionCwd = path;
    this.newSessionBrowserVisible = false;
    this.rebuildNewSessionBrowserView();
  }

  private rebuildNewSessionBrowserView(): void {
    const view: NewSessionBrowserView = emptyNewSessionBrowserView();
    view.visible = this.newSessionBrowserVisible;
    view.loading = this.newSessionBrowserLoading;
    view.errorText = this.newSessionBrowserError;
    view.path = this.newSessionBrowserPath;
    view.canGoUp = this.newSessionBrowserCanGoUp();
    for (const entry of this.newSessionBrowserEntries) {
      const entryView: NewSessionBrowserEntryView = {
        name: entry.name,
        path: entry.path
      };
      view.entries.push(entryView);
    }
    this.newSessionBrowserView = view;
  }

  private deviceOsFor(deviceId: string): string | null {
    for (const device of this.devices) {
      if (device.id === deviceId) {
        return device.deviceOs;
      }
    }
    return null;
  }

  private localText(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  /**
   * Read the bytes behind a picker Uri. Picker Uris are directly accessible
   * via fileIo without any runtime media permission, so no extra permission
   * is added.
   */
  private async readUriBytes(uri: string): Promise<Uint8Array> {
    const file = await fileIo.open(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = await fileIo.stat(file.fd);
      const size = stat.size;
      const arrayBuffer = new ArrayBuffer(size);
      await fileIo.read(file.fd, arrayBuffer);
      return new Uint8Array(arrayBuffer);
    } finally {
      await fileIo.close(file.fd);
    }
  }

  private async addNewSessionAttachments(uris: Array<string>): Promise<void> {
    if (this.pickingAttachment || this.creatingSession || uris.length === 0) {
      return;
    }
    if (this.newSessionAttachments.length + uris.length > MAX_NEW_SESSION_ATTACHMENTS) {
      this.newSessionError = this.localText($r('app.string.new_session_attachment_limit',
        MAX_NEW_SESSION_ATTACHMENTS));
      return;
    }
    this.pickingAttachment = true;
    let failure = '';
    const entries: NewSessionAttachmentEntry[] = this.newSessionAttachments.slice(0);
    try {
      for (const uri of uris) {
        const fileName = uri.substring(uri.lastIndexOf('/') + 1) || 'local-file';
        const bytes = await this.readUriBytes(uri);
        if (bytes.length === 0) {
          failure = this.localText($r('app.string.new_session_attachment_empty', fileName));
          break;
        }
        if (bytes.length > MAX_NEW_SESSION_ATTACHMENT_BYTES) {
          failure = this.localText($r('app.string.new_session_attachment_too_large', fileName));
          break;
        }
        const entry: NewSessionAttachmentEntry = {
          localId: this.nextClientId(),
          name: fileName,
          mediaType: mimeTypeFromName(fileName),
          bytes: bytes
        };
        entries.push(entry);
      }
    } catch (error) {
      failure = this.localText($r('app.string.new_session_attachment_read_failed'));
    }
    if (failure.length === 0) {
      this.newSessionAttachments = entries;
    } else {
      this.newSessionError = failure;
    }
    this.pickingAttachment = false;
  }

  private pickNewSessionPhotos(): void {
    if (this.pickingAttachment || this.creatingSession) {
      return;
    }
    const photoPicker = new picker.PhotoViewPicker();
    photoPicker.select({ MIMEType: picker.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 10 }).then((result: picker.PhotoSelectResult) => {
      this.addNewSessionAttachments(result.photoUris);
    }).catch(() => {
    });
  }

  private pickNewSessionFiles(): void {
    if (this.pickingAttachment || this.creatingSession) {
      return;
    }
    const documentPicker = new picker.DocumentViewPicker();
    documentPicker.select().then((uris: Array<string>) => {
      this.addNewSessionAttachments(uris);
    }).catch(() => {
    });
  }

  private removeNewSessionAttachment(localId: string): void {
    const remaining: NewSessionAttachmentEntry[] = [];
    for (const entry of this.newSessionAttachments) {
      if (entry.localId !== localId) {
        remaining.push(entry);
      }
    }
    this.newSessionAttachments = remaining;
  }

  // Display view of the pending attachments for the sheet (bytes stay here).
  private pendingAttachmentViews(): NewSessionPendingAttachment[] {
    const views: NewSessionPendingAttachment[] = [];
    for (const entry of this.newSessionAttachments) {
      const view: NewSessionPendingAttachment = {
        localId: entry.localId,
        name: entry.name,
        size: entry.bytes.length
      };
      views.push(view);
    }
    return views;
  }

  private async createSession(): Promise<void> {
    const deviceId = this.selectedDeviceId;
    const runtimeType = this.selectedRuntimeType;
    const runtimeId = this.selectedRuntimeId;
    const content = this.newSessionMessage.trim();
    const title = this.newSessionTitleInput.trim();
    if (deviceId.length === 0) {
      this.newSessionError = this.localText($r('app.string.new_session_select_device_first'));
      return;
    }
    if (runtimeType.length === 0) {
      this.newSessionError = this.localText($r('app.string.new_session_select_runtime_first'));
      return;
    }
    if (content.length === 0 && this.newSessionAttachments.length === 0) {
      this.newSessionError = this.localText($r('app.string.new_session_message_or_attachment_required'));
      return;
    }
    this.creatingSession = true;
    this.newSessionError = '';
    try {
      // Inline attachments travel inside the create request (Android
      // toInlineAttachmentRef): no upload round-trip is needed.
      const attachments: RemoteInlineAttachmentRef[] = [];
      for (const entry of this.newSessionAttachments) {
        const ref = await buildRemoteInlineAttachmentRef(entry.name, entry.mediaType, entry.bytes);
        attachments.push(ref);
      }
      let cwd = this.newSessionCwd.trim();
      if (cwd.length === 0) {
        cwd = '~';
      }
      if (cwd.startsWith('~')) {
        const directory = await this.filesApi.listFiles(this.serverUrl(), this.token(),
          deviceId, cwd, '.');
        if (directory.path.length === 0 || directory.path.startsWith('~')) {
          throw new ApiException('Could not resolve the workspace directory.');
        }
        cwd = directory.path;
      }
      const projects = (await this.sessionsApi.listProjects(this.serverUrl(), this.token())).projects;
      let project = workspaceProject(projects, deviceId, cwd, this.deviceOsFor(deviceId));
      if (project === null) {
        project = await this.sessionsApi.createProject(this.serverUrl(), this.token(),
          availableProjectName(workspaceProjectName(cwd), projects), deviceId, cwd, false);
      }
      const modelSelection = this.selectedModelSelectionId();
      const permissionSelection = this.selectedPermissionSelectionId();
      const request: RemoteSessionCreateAndStartRequest = {
        connectorId: deviceId,
        projectId: project.id,
        runtime: runtimeType,
        runtimeId: runtimeId.length > 0 && runtimeId !== runtimeType ? runtimeId : null,
        content: content,
        title: title.length > 0 ? title : null,
        cwd: project.workspacePath,
        selections: { model: modelSelection, permission: permissionSelection },
        attachments: attachments,
        clientMessageId: this.nextClientId()
      };
      const response = await this.sessionsApi.createAndStartSession(this.serverUrl(), this.token(),
        request);
      try {
        this.newSessionPreferenceStore.saveTarget(this.serverUrl(), this.authStore.readUserId(),
          deviceId, runtimeId.length > 0 ? runtimeId : runtimeType);
        if (modelSelection !== null) {
          this.newSessionPreferenceStore.saveModel(this.serverUrl(), this.authStore.readUserId(),
            deviceId, runtimeId.length > 0 ? runtimeId : runtimeType, modelSelection);
        }
        if (permissionSelection !== null) {
          this.newSessionPreferenceStore.savePermission(this.serverUrl(), this.authStore.readUserId(),
            deviceId, runtimeId.length > 0 ? runtimeId : runtimeType, permissionSelection);
        }
      } catch (error) {
      }
      this.newSessionVisible = false;
      this.loadSessions();
      this.pathStack.pushPathByName('session_detail', response.session.id);
    } catch (error) {
      this.newSessionError = errorMessageFrom(error as Object);
    }
    this.creatingSession = false;
  }

  private headerIconColor(): string {
    return this.themeIsDark ? '#FAFAFA' : '#1C1C1E';
  }

  private raisedBorderColor(): string {
    return this.themeIsDark ? '#00000000' : '#E7E6E2';
  }

  private quickEntryIconColor(): string {
    return this.themeIsDark ? '#9A9A9A' : '#8E8E8E';
  }

  @Builder
  homeHeader() {
    Row({ space: 12 }) {
      Button() {
        SymbolGlyph($r('sys.symbol.person'))
          .fontSize(21)
          .fontColor([this.headerIconColor()])
      }
      .width(42)
      .height(42)
      .borderRadius(21)
      .padding(0)
      .backgroundColor(getColors().raisedSurface)
      .border({ width: 1, color: this.raisedBorderColor() })
      .onClick(() => {
        this.profileDrawerVisible = true;
      })
      Text($r('app.string.EntryAbility_label'))
        .fontSize(31)
        .fontWeight(FontWeight.Medium)
        .lineHeight(40)
        .fontFamily('Caveat')
        .fontColor(getColors().ink)
        .textAlign(TextAlign.Center)
        .layoutWeight(1)
      Button() {
        SymbolGlyph($r('sys.symbol.magnifyingglass'))
          .fontSize(24)
          .fontColor([this.headerIconColor()])
      }
      .width(42)
      .height(42)
      .borderRadius(21)
      .padding(0)
      .backgroundColor(Color.Transparent)
      .onClick(() => {
        showToast($r('app.string.home_search_coming_soon'));
      })
    }
    .width('100%')
    .height(46)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  quickEntry(title: ResourceStr, symbol: Resource, action: () => void) {
    Column({ space: 6 }) {
      SymbolGlyph(symbol)
        .fontSize(22)
        .fontColor([this.quickEntryIconColor()])
      Text(title)
        .fontSize(14)
        .fontWeight(FontWeight.Bold)
        .lineHeight(17)
        .fontColor(getColors().ink)
        .maxLines(1)
    }
    .layoutWeight(1)
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 12, right: 12, top: 13, bottom: 13 })
    .borderRadius(18)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: this.raisedBorderColor() })
    .onClick(() => {
      action();
    })
  }

  @Builder
  quickEntries() {
    Row({ space: 10 }) {
      this.quickEntry($r('app.string.home_devices'), $r('sys.symbol.computer'), (): void => {
        this.openDevices();
      })
      this.quickEntry($r('app.string.home_terminal'), $r('sys.symbol.code'), (): void => {
        this.openTerminal();
      })
      this.quickEntry($r('app.string.home_files'), $r('sys.symbol.folder'), (): void => {
        this.openFiles();
      })
    }
    .width('100%')
    .height(76)
  }

  @Builder
  homeFab() {
    // Smart reach (智感握姿): the FAB follows the holding hand. The wrapper is
    // transparent to touches so the list beneath keeps receiving gestures.
    Stack({ alignContent: this.fabOnRight ? Alignment.BottomEnd : Alignment.BottomStart }) {
      if (this.fabOnRight) {
        Button() {
          SymbolGlyph($r('sys.symbol.plus'))
            .fontSize(24)
            .fontColor([getColors().onPrimaryAction])
        }
        .width(54)
        .height(54)
        .borderRadius(27)
        .padding(0)
        .backgroundColor(getColors().primaryAction)
        .margin({ right: 18, bottom: 32 })
        .transition(TransitionEffect.move(TransitionEdge.END)
          .animation({ curve: this.fabHasAppeared
            ? curves.interpolatingSpring(0, 1, 170, 17)
            : curves.interpolatingSpring(0, 1, 200, 17) }))
        .onAppear(() => {
          this.fabHasAppeared = true;
        })
        .accessibilityText($r('app.string.home_new_session'))
        .onClick(() => {
          this.openNewSession();
        })
      } else {
        Button() {
          SymbolGlyph($r('sys.symbol.plus'))
            .fontSize(24)
            .fontColor([getColors().onPrimaryAction])
        }
        .width(54)
        .height(54)
        .borderRadius(27)
        .padding(0)
        .backgroundColor(getColors().primaryAction)
        .margin({ left: 18, bottom: 32 })
        .transition(TransitionEffect.move(TransitionEdge.START)
          .animation({ curve: curves.interpolatingSpring(0, 1, 170, 17) }))
        .accessibilityText($r('app.string.home_new_session'))
        .onClick(() => {
          this.openNewSession();
        })
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(HitTestMode.Transparent)
  }

  // Section header of the pinned/projects sections, mirroring Android
  // HomeListSectionHeader: the label + chevron area toggles the section, the
  // filter chevron and the plus button sit outside that area so their taps do
  // not collapse the section.
  @Builder
  sectionHeader(label: ResourceStr, expanded: boolean, showActions: boolean,
    filterButtonId: string, onToggle: () => void) {
    Row({ space: 10 }) {
      Row({ space: 6 }) {
        Text(label)
          .fontSize(13.2)
          .fontWeight(800)
          .fontColor(getColors().faint)
          .maxLines(1)
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(16)
          .fontColor([getColors().faint])
          .rotate({ angle: expanded ? 0 : -90 })
      }
      .layoutWeight(1)
      .height(44)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        onToggle();
      })
      if (filterButtonId.length > 0) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(19)
            .fontColor([this.treeFiltersActive() ? getColors().inkSoft : getColors().faint])
            .rotate({ angle: this.filterMenuVisible ? -90 : 0 })
            .animation({ duration: 150, curve: Curve.FastOutSlowIn })
        }
        .width(38)
        .height(38)
        .borderRadius(19)
        .padding(0)
        .backgroundColor(Color.Transparent)
        .id(filterButtonId)
        .accessibilityText($r('app.string.home_project_filter_sessions'))
        .onClick(() => {
          this.openFilterMenu(filterButtonId);
        })
      }
      if (showActions) {
        Button() {
          SymbolGlyph($r('sys.symbol.plus'))
            .fontSize(19)
            .fontColor([getColors().faint])
        }
        .width(38)
        .height(38)
        .borderRadius(19)
        .padding(0)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.openCreateProject();
        })
      }
    }
    .width('100%')
    .height(44)
    .alignItems(VerticalAlign.Center)
  }

  // One rendered row of the tree list: dispatches to the matching builder.
  @Builder
  treeRow(row: HomeTreeRow) {
    if (row.kind === 'pinned_header') {
      this.sectionHeader($r('app.string.home_pinned'), row.projectExpanded, false, '', (): void => {
        this.togglePinnedSection();
      })
    } else if (row.kind === 'projects_header') {
      this.sectionHeader($r('app.string.home_projects'), row.projectExpanded, true,
        'home_filter_button', (): void => {
          this.toggleProjectsSection();
        })
    } else if (row.kind === 'project') {
      this.projectRowView(row)
    } else if (row.kind === 'project_error') {
      this.projectErrorRow(row)
    } else if (row.kind === 'project_loading') {
      this.projectLoadingRow()
    } else if (row.kind === 'project_empty') {
      this.projectEmptyRow()
    } else if (row.kind === 'projects_empty') {
      this.projectEmptyBox()
    } else if (row.kind === 'session_pinned_header') {
      this.sectionHeader($r('app.string.home_pinned'), row.projectExpanded, false, '', (): void => {
        this.toggleSessionPinnedSection();
      })
    } else if (row.kind === 'session_recent_header') {
      this.sectionHeader($r('app.string.home_recents'), row.projectExpanded, false, '', (): void => {
        this.toggleSessionRecentSection();
      })
    } else if (row.kind === 'pinned_empty') {
      this.sectionEmptyText($r('app.string.home_no_pinned_sessions'))
    } else if (row.kind === 'recent_empty') {
      this.sectionEmptyText($r('app.string.home_no_recent_sessions'))
    } else if (row.kind === 'flat_session' && row.session !== null) {
      this.flatSessionRowView(row.session)
    } else if (row.kind === 'session' && row.session !== null) {
      this.sessionRowView(row.session)
    }
  }

  @Builder
  projectRowView(row: HomeTreeRow) {
    Row({ space: 10 }) {
      SymbolGlyph(row.projectExpanded ? $r('sys.symbol.folder_fill') : $r('sys.symbol.folder'))
        .fontSize(21)
        .fontColor([getColors().faint])
      Text(row.projectName)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(getColors().inkSoft)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Button() {
        SymbolGlyph($r('sys.symbol.more'))
          .fontSize(19)
          .fontColor([getColors().faint])
      }
      .width(38)
      .height(38)
      .borderRadius(19)
      .padding(0)
      .backgroundColor(Color.Transparent)
      .enabled(!this.actionBusy)
      .id(`home_project_menu_${row.projectId}`)
      .onClick(() => {
        this.openProjectMenu(row.projectId, true);
      })
      Button() {
        SymbolGlyph($r('sys.symbol.square_and_pencil'))
          .fontSize(19)
          .fontColor([getColors().faint])
      }
      .width(38)
      .height(38)
      .borderRadius(19)
      .padding(0)
      .backgroundColor(Color.Transparent)
      .onClick(() => {
        this.onNewSessionInProject(row.projectId);
      })
    }
    .width('100%')
    .height(56)
    .alignItems(VerticalAlign.Center)
    .padding({ top: 4, bottom: 4 })
    .id(`home_project_row_${row.projectId}`)
    .onClick(() => {
      this.toggleProjectExpanded(row.projectId);
    })
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.openProjectMenu(row.projectId, false);
        })
    )
  }

  // Expanded-child error row: the whole row is the retry target.
  @Builder
  projectErrorRow(row: HomeTreeRow) {
    Text($r('app.string.home_project_load_retry'))
      .fontSize(13)
      .fontWeight(FontWeight.Medium)
      .lineHeight(17)
      .fontColor(getColors().errorText)
      .width('100%')
      .padding({ left: 34, top: 10, bottom: 10 })
      .onClick(() => {
        this.retryProjectSessions(row.projectId);
      })
  }

  @Builder
  projectLoadingRow() {
    Row() {
      LoadingProgress()
        .width(18)
        .height(18)
        .color(getColors().muted)
    }
    .width('100%')
    .height(48)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 38 })
  }

  @Builder
  projectEmptyRow() {
    Row() {
      Text($r('app.string.home_project_no_sessions'))
        .fontSize(13)
        .fontWeight(600)
        .fontColor(getColors().faint)
    }
    .width('100%')
    .height(42)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 38 })
  }

  // Placeholder shown inside the projects section when no regular project
  // matches the filters (Android HomeProjectEmptyText).
  @Builder
  projectEmptyBox() {
    Column() {
      Text(this.projectsEmptyMessage())
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().faint)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .height(110)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 18, right: 18 })
  }

  // Android SectionEmptyText: small left-aligned faint label inside an
  // otherwise empty expanded section.
  @Builder
  sectionEmptyText(label: ResourceStr) {
    Row() {
      Text(label)
        .fontSize(13)
        .fontWeight(600)
        .fontColor(getColors().faint)
    }
    .width('100%')
    .height(42)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 38 })
  }

  // Flat session row of the session view mode (Android HomeSessionRow): agent
  // icon, title, device/project context label and the status indicator.
  @Builder
  flatSessionRowView(item: SessionListItem) {
    Row({ space: 10 }) {
      SessionAgentIcon({ runtime: item.runtime })
      Column({ space: 2 }) {
        Text(item.title)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .lineHeight(20)
          .fontColor(getColors().inkSoft)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.sessionContextLabel(item))
          .fontSize(11.2)
          .fontWeight(FontWeight.Medium)
          .fontColor(getColors().faint)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      HomeSessionStatusIndicator({
        indicator: sessionListIndicator(item.statusLabel, item.unread)
      })
    }
    .width('100%')
    .height(66)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 18, right: 10 })
    .onClick(() => {
      this.openSession(item.id);
    })
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.openActionMenu(item);
        })
    )
  }

  @Builder
  sessionRowView(item: SessionListItem) {
    Row({ space: 10 }) {
      SessionAgentIcon({ runtime: item.runtime })
      Text(item.title)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().inkSoft)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      HomeSessionStatusIndicator({
        indicator: sessionListIndicator(item.statusLabel, item.unread)
      })
    }
    .width('100%')
    .height(44)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 18, right: 10 })
    .onClick(() => {
      this.openSession(item.id);
    })
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.openActionMenu(item);
        })
    )
  }

  // Full-empty state of the tree, mirroring Android AppEmptyState: a centered
  // message plus a pill button whose label flips between "clear filters" and
  // "new project", with the filter entry kept reachable at the top-end corner.
  @Builder
  treeEmptyContent() {
    if (this.sidebarViewMode === SIDEBAR_VIEW_SESSION) {
      Column() {
        Text($r('app.string.home_no_sessions'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .lineHeight(21.5)
          .fontColor(getColors().inkSoft)
          .textAlign(TextAlign.Center)
          .constraintSize({ maxWidth: 294 })
        Row({ space: 8 }) {
          SymbolGlyph($r('sys.symbol.plus'))
            .fontSize(17)
            .fontColor([getColors().onPrimaryAction])
          Text($r('app.string.home_new_session'))
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor(getColors().onPrimaryAction)
        }
        .height(44)
        .borderRadius(22)
        .padding({ left: 18, right: 18 })
        .margin({ top: 18 })
        .backgroundColor(getColors().primaryAction)
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.openNewSession();
        })
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .padding({ left: 18, right: 18 })
    } else {
      Stack({ alignContent: Alignment.TopEnd }) {
      Column() {
        Text(this.treeEmptyMessage())
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .lineHeight(21.5)
          .fontColor(getColors().inkSoft)
          .textAlign(TextAlign.Center)
          .constraintSize({ maxWidth: 294 })
        Row({ space: 8 }) {
          SymbolGlyph(this.treeFiltersActive() ? $r('sys.symbol.xmark') : $r('sys.symbol.plus'))
            .fontSize(17)
            .fontColor([getColors().onPrimaryAction])
          Text(this.treeFiltersActive()
            ? $r('app.string.home_project_filter_clear') : $r('app.string.new_session_create_project'))
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor(getColors().onPrimaryAction)
        }
        .height(44)
        .borderRadius(22)
        .padding({ left: 18, right: 18 })
        .margin({ top: 18 })
        .backgroundColor(getColors().primaryAction)
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          if (this.treeFiltersActive()) {
            this.clearProjectFilters();
          } else {
            this.openCreateProject();
          }
        })
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .padding({ left: 18, right: 18, top: 28, bottom: 28 })
      if (this.hasProjectsInAllStatuses() || this.treeFiltersActive()) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(19)
            .fontColor([this.treeFiltersActive() ? getColors().inkSoft : getColors().faint])
            .rotate({ angle: this.filterMenuVisible ? -90 : 0 })
            .animation({ duration: 150, curve: Curve.FastOutSlowIn })
        }
        .width(38)
        .height(38)
        .borderRadius(19)
        .padding(0)
        .backgroundColor(Color.Transparent)
        .accessibilityText($r('app.string.home_project_filter_sessions'))
        .id('home_filter_button_empty')
        .onClick(() => {
          this.openFilterMenu('home_filter_button_empty');
        })
      }
    }
    .width('100%')
    .height('100%')
    }
  }

  build() {
    Stack() {
      // Zero-size origin marker: getRectangleById for page-root-level ids
      // returns a different coordinate basis than for in-page components, so
      // menu anchors are calibrated against this sibling instead of home_root.
      Column()
        .width(0)
        .height(0)
        .position({ x: 0, y: 0 })
        .id('home_anchor_origin')
      Column({ space: 15 }) {
        this.homeHeader()
        this.quickEntries()
        if (this.errorMessage.length > 0 && this.hasLoaded) {
          Text(this.errorMessage)
            .fontSize(13.5)
            .fontWeight(FontWeight.Medium)
            .lineHeight(17)
            .fontColor(getColors().errorText)
            .width('100%')
        }
        Stack({ alignContent: Alignment.BottomEnd }) {
          if ((this.loading || this.agentGateState === 'checking') && !this.hasLoaded) {
            Column() {
              LoadingProgress()
                .width(44)
                .height(44)
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else if (!this.hasLoaded && this.errorMessage.length > 0) {
            Column() {
              ErrorState({
                message: this.errorMessage,
                onRetry: (): void => {
                  this.retryInitialLoad();
                }
              })
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else if (this.agentGateState === 'devices_offline' || this.agentGateState === 'no_agents') {
            Refresh({ refreshing: $$this.refreshing }) {
              Column() {
                this.agentGateContent()
              }
              .width('100%')
              .height('100%')
              .justifyContent(FlexAlign.Center)
            }
            .onRefreshing(() => {
              this.loadSessions();
              this.loadAgentGate();
              this.dashboardRetries = 0;
              this.connectDashboard();
            })
            .width('100%')
            .height('100%')
          } else if (this.pairPromptVisible()) {
            Column() {
              EmptyState({
                glyph: '📡',
                message: $r('app.string.home_pair_device_first'),
                actionLabel: $r('app.string.home_pair_new_device'),
                onAction: (): void => {
                  this.openPairing();
                }
              })
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else if (!this.treeHasContent()) {
            this.treeEmptyContent()
          } else {
            Refresh({ refreshing: $$this.refreshing }) {
              List() {
                ForEach(this.treeRows, (row: HomeTreeRow) => {
                  ListItem() {
                    this.treeRow(row)
                  }
                }, (row: HomeTreeRow) => row.key)
                ListItem() {
                  Column()
                    .height(96)
                }
              }
              .width('100%')
              .height('100%')
              .padding({ top: 4 })
            }
            .onRefreshing(() => {
              this.loadSessions();
              this.loadAgentGate();
              this.dashboardRetries = 0;
              this.connectDashboard();
            })
            .width('100%')
            .height('100%')
          }
          this.homeFab()
        }
        .width('100%')
        .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
      .padding({ left: 18, right: 18, top: 6 })
      if (this.filterMenuVisible) {
        HomeProjectFilterOverlay({
          anchor: this.filterAnchor,
          selectedStatus: this.filterStatus,
          selectedDeviceId: this.filterDeviceId,
          selectedRuntime: this.filterRuntime,
          devices: this.filterDevices,
          devicesLoading: false,
          agents: this.filterAgents,
          onSelectStatus: (status: string): void => {
            this.setSessionStatus(status);
          },
          onSelectDevice: (deviceId: string): void => {
            this.setFilterDevice(deviceId);
          },
          onSelectAgent: (runtime: string): void => {
            this.setFilterRuntime(runtime);
          },
          onClear: (): void => {
            this.clearProjectFilters();
          },
          onDismiss: (): void => {
            this.filterMenuVisible = false;
          }
        })
      }
      if (this.projectActionMenuId.length > 0) {
        HomeProjectActionMenuOverlay({
          anchored: this.projectActionMenuAnchored,
          anchor: this.projectActionAnchor,
          projectName: this.projectActionProjectName(),
          workspacePath: this.projectActionWorkspacePath(),
          projectPinned: this.projectActionProjectPinned(),
          highlightExpanded: this.projectActionHighlightExpanded,
          onEdit: (): void => {
            this.openEditProject();
          },
          onTogglePinned: (): void => {
            this.toggleProjectPinned();
          },
          onArchive: (): void => {
            this.openArchiveDialog();
          },
          onDismiss: (): void => {
            this.closeProjectMenu();
          }
        })
      }
      if (this.editProjectId.length > 0) {
        HomeProjectEditSheetOverlay({
          originalName: this.editProjectOriginalName(),
          deviceName: this.editProjectDeviceName(),
          workspacePath: this.editProjectWorkspacePath(),
          nameInput: this.editProjectNameInput,
          busy: this.editProjectBusy,
          errorMessage: this.editProjectError,
          onNameChange: (value: string): void => {
            this.editProjectNameInput = value;
          },
          onSave: (): void => {
            this.confirmProjectEdit();
          },
          onDismiss: (): void => {
            this.closeEditProject();
          }
        })
      }
      if (this.archiveProjectId.length > 0) {
        HomeProjectArchiveDialog({
          projectName: this.archiveProjectName(),
          busy: this.archiveProjectBusy,
          onConfirm: (): void => {
            this.confirmArchiveProject();
          },
          onDismiss: (): void => {
            this.closeArchiveDialog();
          }
        })
      }
      if (this.newSessionVisible) {
        NewSessionSheetOverlay({
          devices: this.devices,
          runtimes: this.runtimes,
          runtimesLoading: this.runtimesLoading,
          selectedDeviceId: this.selectedDeviceId,
          selectedRuntimeId: this.selectedRuntimeId,
          setupState: this.newSessionSetupState,
          titleInput: this.newSessionTitleInput,
          cwdInput: this.newSessionCwd,
          messageInput: this.newSessionMessage,
          catalog: this.newSessionCatalogView,
          browser: this.newSessionBrowserView,
          startEnabled: this.newSessionStartEnabled,
          creating: this.creatingSession,
          errorText: this.newSessionError,
          attachments: this.pendingAttachmentViews(),
          pickingAttachment: this.pickingAttachment,
          onTitleChange: (value: string): void => {
            this.newSessionTitleInput = value;
          },
          onDeviceSelected: (deviceId: string): void => {
            this.selectDevice(deviceId);
          },
          onRuntimeSelected: (runtime: RemoteDeviceRuntime): void => {
            this.selectRuntime(runtime);
          },
          onModelSelected: (modelId: string): void => {
            this.selectNewSessionModel(modelId);
          },
          onEffortSelected: (effortId: string): void => {
            this.selectNewSessionEffort(effortId);
          },
          onPermissionSelected: (permissionId: string): void => {
            this.selectNewSessionPermission(permissionId);
          },
          onRetryRuntimeDetails: (): void => {
            this.loadNewSessionRuntimeDetails();
          },
          onCwdChange: (value: string): void => {
            this.newSessionCwd = value;
          },
          onMessageChange: (value: string): void => {
            this.newSessionMessage = value;
          },
          onChooseDirectory: (): void => {
            this.toggleNewSessionBrowser();
          },
          onBrowserUp: (): void => {
            this.goNewSessionBrowserUp();
          },
          onBrowserEntrySelected: (path: string): void => {
            this.loadNewSessionBrowserDirectory(path);
          },
          onBrowserRetry: (): void => {
            this.retryNewSessionBrowser();
          },
          onUseDirectory: (): void => {
            this.useNewSessionBrowserDirectory();
          },
          onPickPhotos: (): void => {
            this.pickNewSessionPhotos();
          },
          onPickFiles: (): void => {
            this.pickNewSessionFiles();
          },
          onRemoveAttachment: (localId: string): void => {
            this.removeNewSessionAttachment(localId);
          },
          onRetrySetup: (): void => {
            this.loadNewSessionDevices();
          },
          onViewDevices: (): void => {
            this.closeNewSession();
            this.openDevices();
          },
          onCreate: (): void => {
            this.createSession();
          },
          onClose: (): void => {
            this.closeNewSession();
          }
        })
      }
      if (this.actionMenuSessionId.length > 0) {
        SessionActionMenuOverlay({
          sessionTitle: this.actionMenuTitle(),
          archived: this.actionMenuArchived(),
          pinned: this.actionMenuPinned(),
          onRename: (): void => {
            this.beginRename();
          },
          onToggleArchived: (): void => {
            this.toggleArchived();
          },
          onTogglePinned: (): void => {
            this.togglePinned();
          },
          onClose: (): void => {
            this.closeActionMenu();
          }
        })
      }
      if (this.renameTargetId.length > 0) {
        StringInputDialog({
          title: $r('app.string.home_rename_session'),
          initial: this.renameInput,
          placeholder: $r('app.string.home_session_title_placeholder'),
          saveLabel: $r('app.string.profile_save'),
          busy: this.actionBusy,
          onSave: (value: string): void => {
            this.confirmRename(value);
          },
          onCancel: (): void => {
            this.cancelRename();
          }
        })
      }
      if (this.profileDrawerVisible) {
        ProfileDrawerOverlay({
          onOpenArchivedSessions: (): void => {
            this.profileDrawerVisible = false;
            this.pathStack.pushPathByName('archived_sessions', '');
          },
          onClose: (): void => {
            this.profileDrawerVisible = false;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .id('home_root')
    .backgroundColor(getColors().canvas)
  }
}
