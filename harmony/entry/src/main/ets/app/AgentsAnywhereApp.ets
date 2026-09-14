import { AAColors, resolveAAColors, withAlpha } from '../ui/designsystem/AAColors';
import { curves } from '@kit.ArkUI';
import { AppDestination, canNavigateBackFrom } from '../navigation/AppDestination';
import { LoginMethodsScreen } from '../ui/screens/auth/LoginMethodsScreen';
import { ServerSetupScreen } from '../ui/screens/auth/ServerSetupScreen';
import { QrLoginScreen, QrWaitingScreen } from '../ui/screens/auth/QrAuthScreens';
import { HomeScreen } from '../ui/screens/home/HomeScreen';
import { ArchivedSessionsScreen } from '../ui/screens/home/ArchivedSessionsScreen';
import { SessionDetailScreen } from '../ui/screens/sessiondetail/SessionDetailScreen';
import { DevicesScreen } from '../ui/screens/devices/DevicesScreen';
import { DeviceDetailScreen } from '../ui/screens/devices/DeviceDetailScreen';
import { SessionDetailState } from '../feature/sessiondetail/SessionDetailState';
import { RuntimeSettingsState } from '../feature/sessiondetail/RuntimeSettingsState';
import { MessageAction } from '../feature/sessiondetail/SessionDetailController';
import { noticeTargetIds } from '../feature/sessiondetail/SessionDetailController';
import {
  applyRealtimeEvents,
} from '../feature/sessiondetail/SessionDetailReducer';
import {
  latestTimelineItemChanged, noticesChanged,
} from '../feature/sessiondetail/SessionScrollFollow';
import {
  AttachmentUploadState, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES, PendingAttachment,
  localDraftAttachment, pendingAttachment, updateAttachment, uploadedAttachmentIds,
} from '../feature/sessiondetail/PendingAttachment';
import { AttachmentPicker, PickedAttachment, readAttachmentBytes } from '../feature/sessiondetail/AttachmentPicker';
import {
  SessionShareDialog, SHARE_SCOPE_REPLY, SHARE_SCOPE_SESSION,
} from '../ui/screens/sessiondetail/SessionShareDialog';
import { systemShare } from '@kit.ShareKit';
import { copyTextToClipboard } from '../common/AAClipboard';
import { RemoteSessionShareResponse } from '../api/SessionsApi';
import { RuntimeCommand } from '../feature/sessiondetail/RuntimeCommandsState';
import { ComposerDraft, ComposerDraftStore } from '../feature/sessiondetail/ComposerDraftStore';
import {
  attachmentErrorMessage, isValidAttachmentMediaType,
} from '../feature/sessiondetail/SessionAttachmentTransfer';
import { UploadFilePart } from '../api/HttpTransport';
import { TimelineAttachment } from '../feature/sessiondetail/SessionTimelineProjection';
import { ProfileSettingsDrawer } from '../ui/screens/profile/ProfileSettingsDrawer';
import { avatarDataUrl } from '../ui/screens/profile/ProfileSettingsSupport';
import { ParsedAuthConfig, ParsedAuthMe, ParsedEmailCode } from '../api/AuthDtos';
import { AndroidAppRelease } from '../api/AppUpdatesApi';
import { AppUpdateState } from '../feature/update/AppUpdateController';
import { AppUpdatePromptDialog } from '../ui/screens/update/AppUpdatePromptDialog';
import { i18n } from '@kit.LocalizationKit';
import { isImageAttachment } from '../feature/sessiondetail/PendingAttachment';
import { randomUuid } from '../common/AAEncoding';
import {
  eventCursorSequence, laterEventCursor, RemoteSessionEvent,
} from '../api/SessionEventDtos';
import { RemoteRuntimeNotice } from '../api/RuntimeDtos';
import { MobileLoginQrPayload } from '../feature/auth/WebLoginModels';
import { SessionsState } from '../feature/sessions/SessionsState';
import {
  DeviceAgentPreviews, onlineAgentCountForList,
} from '../feature/devices/DeviceAgentPreviews';
import { DeviceDetailState, deviceDetailState } from '../feature/devices/DeviceDetailState';
import {
  DeviceConfirmAction, DeviceConfirmKind,
} from '../ui/screens/devices/DeviceConfirmDialog';
import { AddDeviceScreen } from '../ui/screens/devices/AddDeviceScreen';
import { FilesScreen } from '../ui/screens/files/FilesScreen';
import { TerminalScreen } from '../ui/screens/terminal/TerminalScreen';
import { NewSessionScreen } from '../ui/screens/home/NewSessionScreen';
import {
  DevicePairingStep, DeviceSetupCredential, isCompletePairCode, previousPairingStep,
} from '../feature/devices/DevicePairingFlow';
import {
  DevicePairingMonitor, DevicePairingStatus, isTerminalPairingStatus, pairingDeviceOnline,
  pairingPollDelayMs,
} from '../feature/devices/DevicePairingMonitor';
import { AAApiError } from '../api/ApiError';
import { DeviceCredential } from '../api/DevicesApi';
import { DeviceArchiveAllResult } from '../feature/sessions/SessionsController';
import {
  NewSessionDirectory, NewSessionPathEntry,
} from '../feature/sessions/NewSessionState';
import { NewSessionDraft, firstMessageRequest } from '../feature/sessions/NewSessionDraft';
import { NewSessionAttachmentPart, NewSessionCreateOutcome } from '../feature/sessions/NewSessionState';
import { RemoteDirectory } from '../api/FilesDtos';
import { RuntimeModelCatalog, RuntimePermissionCatalog } from '../api/RuntimeCatalogDtos';
import { RemoteRuntimeCapabilitySet } from '../api/RuntimeDtos';
import { RemoteDeviceRuntimeList } from '../api/DevicesDtos';
import { RemoteDeviceRuntime } from '../api/DevicesDtos';
import { DeviceRuntimeManagementState } from '../feature/devices/DeviceRuntimeState';
import {
  archiveStatesFor, projectSessionKey, ProjectSessionsState, ProjectSessionStatusFilter,
} from '../feature/sessions/ProjectSessionsState';
import { AgentDevice, AgentProject, AgentSession } from '../model/AgentSession';
import { DashboardSnapshot } from '../api/RealtimeDtos';
import { AALog } from '../common/AAAppLog';
import { AppConfig } from '../config/AppConfig';
import { common, Want } from '@kit.AbilityKit';
import { AppServices } from './AppServices';
import { ProjectSidebarPreferences } from '../storage/ProjectSidebarPreferences';
import { resolveString, resolveStringWith } from '../common/AAResources';
import { iosHairline } from '../ui/designsystem/AAIosChrome';

/**
 * The window width at which the shell splits into two columns.
 *
 * iOS resolves its chat shell from the system horizontal size class
 * (`ChatSidebarState.Layout.resolve(hasRegularWidth:)`) and never from a device
 * model or a measured window; ArkUI's equivalent is the `lg` breakpoint of 840vp,
 * which no phone reaches and a tablet or 2in1 in landscape does.
 */
const SPLIT_BREAKPOINT: number = 840;

/** The leading column's fixed width, matching iOS's sidebar. */
const SIDEBAR_WIDTH: number = 320;

/**
 * How much of the window the compact layout's drawer reveals.
 *
 * iOS's `SidebarDrawerConfiguration.revealFraction`; the wide layout's column
 * is the fixed `SIDEBAR_WIDTH` above instead.
 */
const DRAWER_REVEAL: number = 0.75;

/**
 * How far in from the leading edge a drag may start to open the closed drawer.
 *
 * iOS's `SidebarDrawerConfiguration.edgeActivationWidth`: a pan that begins on
 * the edge opens the sidebar, one that begins on the card closes it.
 */
const DRAWER_EDGE_WIDTH: number = 44;

/** iOS's `sidebarClosedScale`: the sidebar grows to its full size as it opens. */
const DRAWER_CLOSED_SCALE: number = 0.95;

/** iOS's card corner radius while the drawer is open (`ConcentricRectangle`). */
const DRAWER_CARD_RADIUS: number = 10;

/**
 * Composition root.
 *
 * Port of the destination switching in
 * `android/app/src/main/java/com/agentsanywhere/app/app/AgentsAnywhereApp.kt`
 * and `AgentsAnywhereNavHost.kt`.
 *
 * Android has no back stack: it holds one `currentDestination` and renders a
 * whole screen per value inside a single `AnimatedContent`, and each screen owns
 * its own back handling. This component keeps that shape, so the port stays
 * reviewable against the original.
 *
 * Auth gating is likewise startup-only: the initial destination is chosen once
 * from `hasAuthSession()`, and there is no per-route guard. The only other way
 * back to the sign-in screen is a confirmed 401.
 */
@Component
export struct AgentsAnywhereApp {
  @State private destination: AppDestination = AppDestination.LoginMethods;
  @State private appearanceMode: string = 'system';
  /** Language the drawer selected; `system` follows the device. */
  @State private languageMode: string = 'system';
  /** Sidebar layout the drawer selected; the sessions list reads it. */
  @State private sidebarViewMode: string = 'project';
  /** True while the settings drawer covers the shell. */
  @State private profileOpen: boolean = false;
  /**
   * The signed-in account, for the sidebar's bottom avatar.
   *
   * iOS reads `appState.me`; this port has no such store, so the one request
   * the settings drawer makes anyway is issued at sign-in as well.
   */
  @State private account: ParsedAuthMe | null = null;
  /** Window width in vp, published by the root and read by the split test. */
  @State @Watch('onWindowWidthChanged') private windowWidth: number = 0;
  /**
   * Whether the split layout's sidebar is on screen.
   *
   * iOS's `ChatSidebarState.isOpen`: open whenever the layout is a regular-width
   * split, closed in the drawer layout, and afterwards whatever the user's last
   * toggle left it as.
   */
  @State private sidebarOpen: boolean = false;
  /** The layout `sidebarOpen` was last seeded for; see `onWindowWidthChanged`. */
  private lastSplitLayout: boolean = false;
  /**
   * How far the compact drawer has been dragged, 0 closed … 1 open.
   *
   * iOS's `SidebarDrawerInteractive.progress`: the card follows the finger while
   * a pan is in flight and springs to 0 or 1 when it ends, so this is separate
   * from the committed `sidebarOpen`.
   */
  @State private drawerProgress: number = 0;
  /** Whether the pan in flight is driving the drawer at all. */
  private drawerDragActive: boolean = false;
  /** The progress the pan started from, added to its translation. */
  private drawerDragStart: number = 0;
  /** The update check's state; drives the prompt and the drawer's version card. */
  @State private appUpdate: AppUpdateState = AppUpdateState.empty();
  @State private pendingQr: MobileLoginQrPayload | null = null;
  @State private sessionsState: SessionsState = SessionsState.empty();
  /** Lazily loaded per-project session lists; see `ProjectSessionLoader`. */
  @State private projectSessions: ProjectSessionsState = ProjectSessionsState.empty();
  /** Which archived states the project tree shows; changed from the filter menu. */
  @State private projectStatusFilter: ProjectSessionStatusFilter = ProjectSessionStatusFilter.Active;
  /** Sidebar state restored from preferences and written back on change. */
  @State private expandedProjectIds: string[] = [];
  @State private projectsSectionExpanded: boolean = true;
  /** Session currently open in the detail screen. */
  @State private selectedSessionId: string = '';
  @State private detailState: SessionDetailState = SessionDetailState.empty();
  /** Live model and permission catalogs for the session's settings sheet. */
  @State private runtimeSettings: RuntimeSettingsState = RuntimeSettingsState.empty();
  /** Bumped when a send should return the conversation to the newest message. */
  @State private forceLatestRequest: number = 0;
  /** Bumped when realtime events changed the newest item or the notices. */
  @State private streamLatestRequest: number = 0;
  /** Attachments picked for the composer, with their upload state. */
  @State private composerAttachments: PendingAttachment[] = [];
  /** Composer-level notice (attachment limits, upload failures) for the toast. */
  @State private composerNotice: ResourceStr = '';
  @State private composerNoticeRequest: number = 0;
  /** The copy confirmation, which Android shows as a plain snackbar. */
  @State private infoNotice: ResourceStr = '';
  @State private infoNoticeRequest: number = 0;
  /** Share dialog state: the ids the reply share covers, and the in-flight flag. */
  @State private shareScope: string = SHARE_SCOPE_REPLY;
  @State private shareBusy: boolean = false;
  private shareItemIds: string[] | null = null;
  /** Per-account composer drafts; rebuilt whenever the account changes. */
  private composerDrafts: ComposerDraftStore | null = null;
  /** The composer's text as the screen last reported it. */
  private composerDraftText: string = '';
  /** Image the full-screen viewer is showing; null when it is closed. */
  @State private previewAttachment: TimelineAttachment | null = null;
  /** Composer attachment being previewed, which has no file id yet. */
  @State private previewPending: PendingAttachment | null = null;
  /** Per-device agent counts for the devices page. */
  @State private deviceAgentPreviews: DeviceAgentPreviews = DeviceAgentPreviews.empty();
  /** Device the detail page is showing; empty when none was opened. */
  @State private selectedDeviceId: string = '';
  /** Runtime inventory of the open device. */
  @State private deviceRuntimes: DeviceRuntimeManagementState = DeviceRuntimeManagementState.empty();
  /** True while a bulk session operation on the device page is in flight. */
  @State private deviceBulkBusy: boolean = false;
  /** Device-page notices, surfaced in that screen's toast. */
  @State private deviceNotice: ResourceStr = '';
  @State private deviceNoticeRequest: number = 0;
  /** Devices actions sheet and its confirmation dialog. */
  @State private deviceActionsOpen: boolean = false;
  @State private deviceActionBusy: boolean = false;
  @State private deviceActionError: string = '';
  @State private deviceConfirmAction: DeviceConfirmAction | undefined = undefined;
  /** Pairing wizard state: step, credential and the two busy flags. */
  @State private pairingStep: DevicePairingStep = DevicePairingStep.ConnectionMethod;
  @State private pairingCredential: DeviceSetupCredential | undefined = undefined;
  @State private pairingBusy: boolean = false;
  @State private pairingCreatedThisFlow: boolean = false;
  @State private pairingWaitingOnline: boolean = false;
  @State private pairingExitConfirm: boolean = false;
  /** Wizard notices, surfaced in that screen's toast. */
  @State private pairingNotice: ResourceStr = '';
  @State private pairingNoticeRequest: number = 0;
  /** Devices the app is polling for, with their pairing status. */
  @State private pairingMonitor: DevicePairingMonitor = new DevicePairingMonitor();
  /** Files page: which device it opens on, and where its back button returns. */
  @State private filesDeviceId: string = '';
  /**
   * The session the files page belongs to, or `null` for the device browser.
   *
   * Android reaches the same screen two ways — the Files destination and the
   * session detail's files/terminal pager — and only the second one carries a
   * session, which is what turns the page into the pager.
   */
  @State private filesSession: AgentSession | null = null;
  private filesReturn: AppDestination = AppDestination.Sessions;
  /**
   * The draft the new-session page prepared.
   *
   * Android hands it straight to the conversation screen, which creates the
   * Server session on the first send; the port keeps it here until that
   * handoff is ported.
   */
  private preparedDraft: NewSessionDraft | null = null;
  /** Text the app hands back to the composer after a failed create. */
  @State private composerRestoreText: string = '';
  @State private composerRestoreRequest: number = 0;
  /** Device ids the current preview refresh is waiting on. */
  private previewRefreshGeneration: number = 0;
  /** True once the preview refresh has run, so an empty set still runs once. */
  private previewKeySeen: boolean = false;
  private lastPreviewKey: string = '';
  @State private previewToast: ResourceStr = '';
  @State private previewToastRequest: number = 0;
  @State private noticeBusy: boolean = false;
  @State private noticeError: string = '';
  /** Session id of the running realtime channel, empty when closed. */
  private realtimeSessionId: string = '';
  /** Guards against overlapping older-page requests from scroll callbacks. */
  private loadingOlderInFlight: boolean = false;
  /**
   * Bumped by every project write and every project list read, so a slow answer
   * cannot replace a newer list — Android's `projectsRequestVersion`.
   */
  private projectsRequestVersion: number = 0;
  @StorageProp('systemDarkMode') private systemDark: boolean = false;
  /** Status-bar height published by `EntryAbility`, applied once for every screen. */
  @StorageProp('statusBarHeight') private statusBarHeight: number = 0;
  /** Bumped by `EntryAbility` when the system back gesture is consumed. */
  @StorageProp('backRequest') @Watch('onBackRequested') private backRequest: number = 0;
  /** Where the pairing wizard returns to; Android tracks the same value. */
  private deviceSetupReturn: AppDestination = AppDestination.Devices;
  /** Device the standalone terminal opens on, when a page chose one. */
  @State private terminalDeviceId: string = '';
  /** Where the terminal returns to; its entry point is the device page now. */
  private terminalReturn: AppDestination = AppDestination.Sessions;

  private services: AppServices | null = null;
  /** Per-account project sidebar state; rebuilt whenever the account changes. */
  private sidebarPreferences: ProjectSidebarPreferences | null = null;

  aboutToAppear(): void {
    this.registerBrandFonts();
    const services: AppServices = new AppServices((token: string) => this.handleUnauthorized(token));
    this.services = services;
    this.appearanceMode = services.uiPreferences.appearanceMode();
    this.languageMode = services.uiPreferences.languageMode();
    this.sidebarViewMode = services.uiPreferences.sidebarViewMode();
    // Touch the realtime client id once so the store exists from first launch,
    // matching Android where it is created on the first socket connect.
    services.realtimeClientId.clientId();
    this.loadSidebarPreferences();
    if (services.hasAuthSession()) {
      this.destination = AppDestination.Sessions;
      this.startSignedInSession();
    } else {
      this.destination = AppDestination.LoginMethods;
    }
  }

  /** Reads the persisted project-tree state for the signed-in account. */
  private loadSidebarPreferences(): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    this.sidebarPreferences = new ProjectSidebarPreferences(
      services.serverUrl(), services.sessionStore.readUserId(),
    );
    // Composer drafts are per account too, in a store named after the user id
    // exactly as Android names its preferences file.
    this.composerDrafts = new ComposerDraftStore(services.sessionStore.readUserId());
    this.projectStatusFilter = this.sidebarPreferences.statusFilter();
    this.expandedProjectIds = this.sidebarPreferences.expandedProjectIds();
    this.projectsSectionExpanded = this.sidebarPreferences.projectsSectionExpanded();
  }

  aboutToDisappear(): void {
    this.services?.disposeConnections();
  }

  /**
   * Loads the first page and opens the dashboard socket.
   *
   * The socket is the primary list transport; the HTTP load is what makes the
   * screen useful before the first snapshot arrives, and it is also the fallback
   * when the socket cannot deliver one.
   */
  private startSignedInSession(): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    void this.loadShellAccount();
    void this.loadSessions();
    services.dashboardRealtime.start(
      (snapshot: DashboardSnapshot) => this.applyDashboardSnapshot(snapshot),
      (connected: boolean, attempt: number) => {
        AALog.debug(`Dashboard connection ${connected ? 'up' : 'down'} (attempt ${attempt})`);
      },
      () => {
        // No snapshot in time: refresh over HTTP when nothing has loaded yet.
        if (!this.sessionsState.hasLoaded) {
          void this.loadSessions();
        }
      },
    );
  }

  private async loadSessions(): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    const next: SessionsState = await services.sessionsController.loadInitial(this.sessionsState);
    this.sessionsState = next;
    this.syncDevicePreviews();
  }

  /**
   * Refreshes the per-device agent counts.
   *
   * Android's `rememberDeviceAgentPreviews`: every online device is asked once
   * per refresh, in parallel, and the generation guard in `DeviceAgentPreviews`
   * drops a reply that belongs to a superseded refresh. A device that already
   * reported a count keeps showing it while the new request is in flight.
   */
  private syncDevicePreviews(): void {
    const services: AppServices | null = this.services;
    const online: string[] = [];
    for (const device of this.sessionsState.devices) {
      if (device.online) {
        online.push(device.id);
      }
    }
    // Android keys its effect on the sorted online-device id list, so an
    // unchanged set does not re-ask every device; the first pass always runs.
    const key: string = online.slice().sort().join('|');
    if (this.previewKeySeen && key === this.lastPreviewKey) {
      return;
    }
    this.previewKeySeen = true;
    this.lastPreviewKey = key;

    const started: DeviceAgentPreviews = this.deviceAgentPreviews.beginRefresh(online);
    this.deviceAgentPreviews = started;
    const generation: number = started.generation;
    if (services === null || this.sessionsState.isLoading || online.length === 0) {
      return;
    }
    for (const deviceId of online) {
      void services.devicesController.listDeviceRuntimes(deviceId)
        .then((inventory: RemoteDeviceRuntimeList) => {
          this.deviceAgentPreviews = this.deviceAgentPreviews.loaded(
            generation, deviceId, onlineAgentCountForList(inventory),
          );
        })
        .catch((error: Object) => {
          AALog.debug(`Runtime preview failed for ${deviceId}: `
            + `${error instanceof Error ? error.message : 'unknown'}`);
          this.deviceAgentPreviews = this.deviceAgentPreviews.failed(generation, deviceId);
        });
    }
  }

  /** Loads the next page of whichever list the active view mode is showing. */
  private async loadMoreSessions(): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    this.sessionsState = await services.sessionsController.loadMoreActive(this.sessionsState);
  }

  /**
   * Ensures a project's sessions are loaded for every archived state the current
   * filter expands to. Skipped when fresh or already in flight.
   */
  private loadProjectSessions(projectId: string): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    const filter: ProjectSessionStatusFilter = this.projectStatusFilter;
    const devices: AgentDevice[] = this.sessionsState.devices;
    for (const archived of archiveStatesFor(filter)) {
      this.projectSessions = this.projectSessions.withLoading(
        projectSessionKey(projectId, archived),
      );
      void services.projectSessionLoader.ensureLoaded(
        projectId,
        archived,
        devices,
        () => this.sessionsState.projects.some((project) => project.id === projectId),
        (loadedProjectId: string, loadedArchived: boolean, sessions: AgentSession[]) => {
          this.projectSessions = this.projectSessions
            .withLoaded(loadedProjectId, loadedArchived, sessions)
            .withLoadingCleared(projectSessionKey(loadedProjectId, loadedArchived));
        },
        (failedProjectId: string, failedArchived: boolean, message: string) => {
          this.projectSessions = this.projectSessions
            .withError(projectSessionKey(failedProjectId, failedArchived), message)
            .withLoadingCleared(projectSessionKey(failedProjectId, failedArchived));
        },
      );
    }
  }

  // --------------------------------------------------------- session detail

  /** Opens a session: mark it read, load its snapshot, and show the page. */
  private openSession(session: AgentSession): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    this.selectedSessionId = session.id;
    this.detailState = SessionDetailState.empty();
    // The settings catalogs are per session, so they are dropped with the old
    // state and reloaded the first time the settings sheet opens.
    this.runtimeSettings = RuntimeSettingsState.empty();
    // Both follow counters are per session too; the first snapshot is what
    // brings the new conversation to its newest message.
    this.forceLatestRequest = 0;
    this.streamLatestRequest = 0;
    // The composer is per session as well: Android keys its draft and its
    // attachments on the session id, so a pending upload never leaks across.
    this.composerAttachments = [];
    this.restoreComposerDraft(session.id);
    this.destination = AppDestination.SessionDetail;
    void this.loadSessionDetail(session.id);
    // Reading, not sending: a failure here only leaves the unread dot in place.
    void services.sessionDetailController.markRead(session.id);
  }

  /**
   * Opens the conversation for a prepared draft.
   *
   * Port of the handoff Android does from the new-session page: nothing exists on
   * the Server yet, so the page shows the draft's preview session over an empty
   * timeline, and the first message the user sends is what creates the session
   * (`sendDraftFirstMessage`).
   */
  private openPreparedDraft(draft: NewSessionDraft): void {
    this.preparedDraft = draft;
    this.selectedSessionId = draft.localSessionId;
    // An empty state that is already "initialized": there is nothing to load, and
    // a loading state would leave the page on its skeleton forever.
    this.detailState = SessionDetailState.empty().copy({ initialized: true });
    this.runtimeSettings = RuntimeSettingsState.empty();
    this.forceLatestRequest = 0;
    this.streamLatestRequest = 0;
    this.composerAttachments = [];
    this.restoreComposerDraft(draft.localSessionId);
    this.stopSessionRealtime();
    this.navigate(AppDestination.SessionDetail);
  }

  // ---------------------------------------------------- composer drafts

  /**
   * Puts a session's saved composer state back.
   *
   * Android restores the draft and its attachments when the screen is created for
   * a session; the screen here outlives a destination change, so the app pushes
   * the restored text through the same "restore" channel it uses after a failed
   * create, and republishes the attachments the composer draws.
   */
  private restoreComposerDraft(sessionId: string): void {
    const store: ComposerDraftStore | null = this.composerDrafts;
    if (store === null || sessionId.length === 0) {
      return;
    }
    const draft: ComposerDraft = store.restore(
      sessionId, $r('app.string.session_attachment_upload_failed'),
    );
    this.composerAttachments = draft.attachments;
    this.composerRestoreText = draft.text;
    this.composerRestoreRequest += 1;
  }

  /** Mirrors the composer into the store; Android calls this on every change. */
  private persistComposerDraft(text: string): void {
    this.composerDraftText = text;
    const store: ComposerDraftStore | null = this.composerDrafts;
    if (store === null || this.selectedSessionId.length === 0) {
      return;
    }
    store.save(this.selectedSessionId, text, this.composerAttachments);
  }

  /** Forgets a session's draft, which is what a successful send does. */
  private clearComposerDraft(sessionId: string): void {
    this.composerDraftText = '';
    this.composerDrafts?.clear(sessionId);
  }

  /** The session the detail page shows: the draft's preview, or the real one. */
  private detailSession(): AgentSession | null {
    const draft: NewSessionDraft | null = this.preparedDraft;
    if (draft !== null && draft.localSessionId === this.selectedSessionId) {
      return draft.previewSession();
    }
    return this.findSession(this.selectedSessionId);
  }

  /** Drops the draft when the user leaves its conversation. */
  private leavePreparedDraft(): void {
    this.preparedDraft = null;
  }

  /**
   * Sends the first message of a draft, which is what creates the session.
   *
   * Android's `sendText` for a prepared session: the draft's own selections and
   * attachments go with the request, and the outcome decides what happens next —
   * a created session replaces the draft and loads normally, while a failure puts
   * the text back in the composer and shows the Server's message so the same
   * message can be retried with the same client message id.
   */
  private async sendDraftFirstMessage(content: string): Promise<void> {
    const draft: NewSessionDraft | null = this.preparedDraft;
    const services: AppServices | null = this.services;
    if (draft === null || services === null) {
      return;
    }
    const pendingAttachments: PendingAttachment[] = this.composerAttachments;
    if (content.trim().length === 0 && pendingAttachments.length === 0) {
      return;
    }
    // Android reads every part through `uploadPart` at send time and converts it
    // to an inline attachment, so the first message carries the bytes and needs
    // no upload step. The read is synchronous, so a failure here happens before
    // anything is marked as sending and the composer keeps its attachments.
    const inlineAttachments: NewSessionAttachmentPart[] = [];
    try {
      for (const attachment of pendingAttachments) {
        const bytes: ArrayBuffer = readAttachmentBytes(attachment.uri, attachment.name);
        if (!isValidAttachmentMediaType(attachment.mediaType)) {
          throw new Error(resolveStringWith($r('app.string.session_attachment_media_type_invalid'), [attachment.name]));
        }
        inlineAttachments.push(new NewSessionAttachmentPart(
          attachment.name, attachment.mediaType, new Uint8Array(bytes),
        ));
      }
    } catch (error) {
      this.showComposerNotice(error instanceof Error && error.message.length > 0
        ? error.message : $r('app.string.session_attachment_read_failed'));
      return;
    }
    const clientMessageId: string = services.sessionDetailController.newClientMessageId();
    this.composerAttachments = [];
    this.clearComposerDraft(draft.localSessionId);
    this.detailState = this.detailState.copy({ sending: true });
    this.forceLatestRequest += 1;
    try {
      const outcome: NewSessionCreateOutcome = await services.sessionsController.createAndStartSession(
        firstMessageRequest(draft, content, draft.selections, inlineAttachments, clientMessageId),
        this.sessionsState.devices,
        this.sessionsState.projects,
      );
      if (outcome.succeeded() && outcome.session !== null) {
        const created: AgentSession = outcome.session;
        this.preparedDraft = null;
        this.selectedSessionId = created.id;
        // The dashboard list owns the session now, so it is refreshed before the
        // conversation loads; otherwise a back navigation would show a list that
        // does not know about the new session yet.
        await this.loadSessions();
        await this.loadSessionDetail(created.id);
        return;
      }
      this.detailState = this.detailState.copy({ sending: false });
      // Android puts the attachment list and the text back so the same message
      // can be retried, keeping the client message id for the retry.
      this.composerAttachments = pendingAttachments;
      this.composerRestoreText = content;
      this.composerRestoreRequest += 1;
      this.persistComposerDraft(content);
      this.showComposerNotice(outcome.errorMessage.length > 0
        ? outcome.errorMessage : $r('app.string.new_session_create_failed'));
    } catch (error) {
      AALog.warn(`Creating the session failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.detailState = this.detailState.copy({ sending: false });
      this.composerAttachments = pendingAttachments;
      this.composerRestoreText = content;
      this.composerRestoreRequest += 1;
      this.persistComposerDraft(content);
      this.showComposerNotice(error instanceof Error && error.message.length > 0
        ? error.message : $r('app.string.new_session_create_failed'));
    }
  }

  private async loadSessionDetail(sessionId: string): Promise<void> {    const services: AppServices | null = this.services;
    if (services === null || sessionId.length === 0) {
      return;
    }
    const next: SessionDetailState = await services.sessionDetailController.load(
      this.sessionsState.devices, sessionId,
    );
    if (this.selectedSessionId !== sessionId) {
      return;
    }
    this.detailState = next;
    // The realtime channel only starts once a snapshot has landed, so recovery
    // has a cursor to resume from.
    if (next.initialized) {
      this.startSessionRealtime(sessionId);
    }
  }

  /**
   * Opens the session socket, unless it is already open for this session.
   *
   * A refetch triggered by the socket itself must not restart it, so the session
   * id of the running channel is tracked separately from the selected one.
   */
  private startSessionRealtime(sessionId: string): void {
    const services: AppServices | null = this.services;
    if (services === null || this.realtimeSessionId === sessionId) {
      return;
    }
    this.realtimeSessionId = sessionId;
    services.sessionRealtime.start(
      sessionId,
      () => this.detailState.eventCursor,
      (events: RemoteSessionEvent[]) => {
        const before: SessionDetailState = this.detailState;
        const next: SessionDetailState = applyRealtimeEvents(before, events);
        this.detailState = next;
        // The conversation follows the newest item, but only when a realtime
        // event actually moved it: a cursor-only event must not scroll.
        if (latestTimelineItemChanged(before.timeline, next.timeline)
          || noticesChanged(before.notices, next.notices)) {
          this.streamLatestRequest += 1;
        }
      },
      (cursor: string) => {
        this.detailState = this.detailState.copy({
          eventCursor: laterEventCursor(this.detailState.eventCursor, cursor),
        });
      },
      (reason: string) => {
        AALog.debug(`Snapshot required: ${reason}`);
        void this.loadSessionDetail(sessionId);
      },
      (connectionGeneration: number, refreshGeneration: number) => {
        // The runtime live domains are refreshed by re-reading the snapshot,
        // which carries state, notices and capabilities in one round trip.
        AALog.debug(`Runtime refresh ${connectionGeneration}/${refreshGeneration}`);
        void this.loadSessionDetail(sessionId);
      },
      (connected: boolean, recovering: boolean, attempt: number, error: string | null) => {
        AALog.debug(`Session socket ${connected ? 'up' : 'down'} recovering=${recovering}`
          + ` attempt=${attempt}${error === null ? '' : ` error=${error}`}`);
      },
    );
  }

  /** Closes the session channel when the detail page is left. */
  private stopSessionRealtime(): void {
    if (this.realtimeSessionId.length === 0) {
      return;
    }
    this.services?.sessionRealtime.stop();
    this.realtimeSessionId = '';
  }

  private async sendDetailMessage(content: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    if (this.preparedDraft !== null) {
      await this.sendDraftFirstMessage(content);
      return;
    }
    const clientMessageId: string = services.sessionDetailController.newClientMessageId();
    const attachmentIds: string[] = uploadedAttachmentIds(this.composerAttachments);
    // The composer is cleared before the request, so a slow round trip cannot
    // let the same attachment be sent twice. The draft goes with it: a failed
    // send restores the text through the notice channel, not through the store.
    this.composerAttachments = [];
    this.clearComposerDraft(this.selectedSessionId);
    // A send always returns to the newest message, which is where the reply
    // will appear, regardless of where the reader had scrolled to.
    this.forceLatestRequest += 1;
    try {
      this.detailState = await services.sessionDetailController.submitMessage(
        this.detailState, content, clientMessageId, attachmentIds,
      );
      // The Server writes the user row, so the timeline is refetched rather than
      // guessed: an optimistic bubble without a reconciling read would drift.
      await this.loadSessionDetail(this.selectedSessionId);
    } catch (error) {
      AALog.warn(`Send failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async interruptDetailTurn(): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    try {
      this.detailState = await services.sessionDetailController.interrupt(this.detailState);
    } catch (error) {
      AALog.warn(`Interrupt failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async toggleDetailTakeover(enabled: boolean): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    try {
      this.detailState = await services.sessionDetailController.setTakeover(this.detailState, enabled);
    } catch (error) {
      AALog.warn(`Takeover failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  // --------------------------------------------------- composer attachments

  /** Shows an attachment notice in the detail screen's toast. */
  private showComposerNotice(message: ResourceStr): void {
    this.composerNotice = message;
    this.composerNoticeRequest += 1;
  }

  // ------------------------------------------------------------ commands

  /** The session's slash-command catalog, which the panel loads on demand. */
  private async loadSessionCommands(): Promise<RuntimeCommand[]> {
    const services: AppServices = this.requireServices('Sign in again to load commands.');
    return await services.sessionDetailController.loadCommands(this.selectedSessionId);
  }

  /**
   * Runs one slash command.
   *
   * A rejection carries the Server's own message, which is what the screen shows;
   * the composer only clears when this resolves.
   */
  private async executeSessionCommand(
    commandId: string,
    args: string[],
    raw: string,
  ): Promise<void> {
    const services: AppServices = this.requireServices('Sign in again to run this command.');
    await services.sessionDetailController.executeCommand(
      this.selectedSessionId, commandId, args, raw,
    );
  }

  // ------------------------------------------------------------ sharing
  /**
   * Android's `requestShare`: opens the dialog for a reply.
   *
   * The scope always starts at "this reply" — the only caller passes the ids of
   * the turn the user tapped — and the ids are held until the create answers.
   */
  private requestShare(itemIds: string[]): void {
    if (this.selectedSessionId.length === 0 || itemIds.length === 0) {
      return;
    }
    if (this.preparedDraft !== null) {
      // Android returns early while `sessionId == null`: a prepared session has no
      // Server session to share yet.
      return;
    }
    this.shareScope = SHARE_SCOPE_REPLY;
    this.shareItemIds = itemIds;
  }

  /**
   * Android's `createShare`.
   *
   * The link is minted on the Server and then handed to the system share sheet;
   * a session-scoped share sends no item ids at all, which is what the endpoint
   * expects.
   */
  private async createShare(): Promise<void> {
    const services: AppServices | null = this.services;
    const itemIds: string[] | null = this.shareItemIds;
    if (services === null || itemIds === null || this.shareBusy) {
      return;
    }
    this.shareBusy = true;
    try {
      const response: RemoteSessionShareResponse = await services.sessionDetailController.createShare(
        this.selectedSessionId,
        this.shareScope,
        this.shareScope === SHARE_SCOPE_REPLY ? itemIds : [],
      );
      this.shareItemIds = null;
      this.shareBusy = false;
      await this.openShareSheet(response.shareUrl);
    } catch (error) {
      this.shareItemIds = null;
      this.shareBusy = false;
      AALog.warn(`Creating a share failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showComposerNotice($r('app.string.session_share_failed'));
    }
  }

  /**
   * Hands the link to the system share sheet.
   *
   * Android fires `ACTION_SEND` through a chooser; the equivalent here is
   * ShareKit's panel, with the link as a plain-text record.
   */
  private async openShareSheet(shareUrl: string): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext();
      const data = new systemShare.SharedData({
        utd: 'general.plain-text',
        content: shareUrl,
        title: resolveString($r('app.string.session_share_chooser_title')),
      });
      const controller = new systemShare.ShareController(data);
      await controller.show(context as common.UIAbilityContext, {
        selectionMode: systemShare.SelectionMode.SINGLE,
        previewMode: systemShare.SharePreviewMode.DEFAULT,
      });
    } catch (error) {
      AALog.warn(`Opening the share sheet failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showComposerNotice($r('app.string.session_share_open_failed'));
    }
  }

  /**
   * Android's `copyMessageText`: the reply text without its trailing line breaks.
   *
   * Android shows `common_copied` through the screen's snackbar, which is the
   * non-error notice channel here.
   */
  private copyReplyText(text: string): void {
    let end: number = text.length;
    while (end > 0 && (text.charAt(end - 1) === '\r' || text.charAt(end - 1) === '\n')) {
      end -= 1;
    }
    const copyText: string = end === text.length ? text : text.substring(0, end);
    if (copyText.trim().length === 0) {
      return;
    }
    void copyTextToClipboard(copyText).then((copied: boolean) => {
      if (copied) {
        this.infoNotice = $r('app.string.common_copied');
        this.infoNoticeRequest += 1;
      }
    });
  }

  /**
   * Accepts picked files into the composer.
   *
   * Android's `attachPending`: the per-message slot count and the per-file size
   * are checked before anything is read, the accepted files enter the list in the
   * uploading state, and each one is uploaded immediately so it is ready by the
   * time the user finishes typing. The two notifications are deliberate — the
   * overflow notice fires even when some files are still accepted, which is what
   * Android does.
   */
  /**
   * Whether the composer may attach while a draft is open.
   *
   * Port of the `preparedSession?.attachmentsEnabled == true` half of Android's
   * `attachmentsEnabled`: a prepared session has no capability set yet, so the
   * answer travels with the draft from the new-session page.
   */
  private draftAttachmentsEnabled(): boolean {
    const draft: NewSessionDraft | null = this.preparedDraft;
    return draft === null ? true : draft.attachmentsEnabled;
  }

  private attachPicked(picked: PickedAttachment[]): void {
    if (picked.length === 0) {
      return;
    }
    const remaining: number = MAX_ATTACHMENT_FILES - this.composerAttachments.length;
    if (remaining <= 0) {
      this.showComposerNotice($r('app.string.session_attachment_limit', MAX_ATTACHMENT_FILES));
      return;
    }
    if (picked.length > remaining) {
      this.showComposerNotice($r('app.string.session_attachment_limit', MAX_ATTACHMENT_FILES));
    }
    const accepted: PendingAttachment[] = [];
    for (const file of picked) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        this.showComposerNotice($r('app.string.session_attachment_file_too_large', file.name));
        continue;
      }
      if (accepted.length >= remaining) {
        break;
      }
      accepted.push(pendingAttachment(
        `att_${randomUuid()}`, file.name, file.mediaType, file.size, file.uri,
      ));
    }
    if (accepted.length === 0) {
      return;
    }
    this.composerAttachments = this.composerAttachments.concat(accepted);
    for (const attachment of accepted) {
      void this.uploadAttachment(attachment);
    }
    // Android's `setComposerAttachments` saves the draft alongside the text.
    this.persistComposerDraft(this.composerDraftText);
  }

  private updateAttachmentState(
    id: string,
    uploadState: AttachmentUploadState,
    remote: TimelineAttachment | null,
    errorMessage: ResourceStr | null,
  ): void {
    this.composerAttachments = updateAttachment(this.composerAttachments, id, (current: PendingAttachment) => {
      return {
        id: current.id,
        name: current.name,
        mediaType: current.mediaType,
        size: current.size,
        uri: current.uri,
        uploadState: uploadState,
        remote: remote,
        errorMessage: errorMessage,
      };
    });
    // An upload finishing (or failing) is part of the draft's state.
    this.persistComposerDraft(this.composerDraftText);
  }

  /**
   * Reads and uploads one attachment.
   *
   * The bytes are read here rather than at pick time so the picker's grant is
   * used once, and the part is dropped as soon as the Server has confirmed it.
   */
  private async uploadAttachment(attachment: PendingAttachment): Promise<void> {
    const services: AppServices | null = this.services;
    const sessionId: string = this.selectedSessionId;
    if (services === null || sessionId.length === 0) {
      return;
    }
    const draft: NewSessionDraft | null = this.preparedDraft;
    if (draft !== null && draft.localSessionId === sessionId) {
      // Android's prepared-session branch of `uploadPendingAttachment`: there is
      // no Server session yet, so nothing is uploaded and the bytes wait for the
      // first message.
      await this.prepareDraftAttachment(attachment);
      return;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = readAttachmentBytes(attachment.uri, attachment.name);
    } catch (error) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        error instanceof Error ? error.message : $r('app.string.session_attachment_read_failed'));
      return;
    }
    if (!isValidAttachmentMediaType(attachment.mediaType)) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        $r('app.string.session_attachment_media_type_invalid', attachment.name));
      return;
    }
    const part: UploadFilePart = {
      name: attachment.name,
      mediaType: attachment.mediaType,
      bytes: bytes,
    };
    try {
      const verified: TimelineAttachment[] = await services.sessionDetailController
        .uploadAttachments(sessionId, [part]);
      const remote: TimelineAttachment | null = verified.length > 0 ? verified[0] : null;
      if (remote === null) {
        this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
          $r('app.string.session_attachment_upload_empty'));
        return;
      }
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Uploaded, remote, null);
    } catch (error) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        attachmentErrorMessage(error as Object, $r('app.string.session_attachment_upload_failed')));
    }
  }

  /**
   * Reads one draft attachment locally.
   *
   * Port of Android's `id == null && preparedSession != null` branch of
   * `uploadPendingAttachment`: the same read-and-validate an upload does, but the
   * timeline row comes from the local bytes, so the strip shows a ready thumbnail
   * with no round trip and nothing is stored on the Server until the message is
   * sent.
   */
  private async prepareDraftAttachment(attachment: PendingAttachment): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      bytes = readAttachmentBytes(attachment.uri, attachment.name);
    } catch (error) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        error instanceof Error ? error.message : $r('app.string.session_attachment_read_failed'));
      return;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        $r('app.string.session_attachment_file_too_large', attachment.name));
      return;
    }
    if (!isValidAttachmentMediaType(attachment.mediaType)) {
      this.updateAttachmentState(attachment.id, AttachmentUploadState.Failed, null,
        $r('app.string.session_attachment_media_type_invalid', attachment.name));
      return;
    }
    const local: TimelineAttachment = await localDraftAttachment(
      attachment.name, attachment.mediaType, bytes.byteLength, bytes,
    );
    this.updateAttachmentState(attachment.id, AttachmentUploadState.Uploaded, local, null);
  }

  private removeComposerAttachment(attachment: PendingAttachment): void {
    this.composerAttachments = this.composerAttachments.filter(
      (candidate: PendingAttachment) => candidate.id !== attachment.id,
    );
    this.persistComposerDraft(this.composerDraftText);
  }

  private retryComposerAttachment(attachment: PendingAttachment): void {
    this.updateAttachmentState(attachment.id, AttachmentUploadState.Uploading, null, null);
    void this.uploadAttachment(attachment);
  }

  private pickComposerPhotos(): void {
    const context = this.getUIContext().getHostContext();
    const pickerApi: AttachmentPicker = new AttachmentPicker(context);
    void pickerApi.pickImages(MAX_ATTACHMENT_FILES, false)
      .then((picked: PickedAttachment[]) => this.attachPicked(picked))
      .catch((error: Object) => {
        AALog.warn(`Photo picker failed: ${error instanceof Error ? error.message : 'unknown'}`);
        this.showComposerNotice($r('app.string.session_photo_access_required'));
      });
  }

  /**
   * The camera entry.
   *
   * Android opens its own capture screen; the system photo picker can offer a
   * capture entry instead, which is what `isPhotoTakingSupported` asks for. The
   * substitution is recorded in the port plan.
   */
  private openComposerCamera(): void {
    const context = this.getUIContext().getHostContext();
    const pickerApi: AttachmentPicker = new AttachmentPicker(context);
    void pickerApi.pickImages(1, true)
      .then((picked: PickedAttachment[]) => this.attachPicked(picked))
      .catch((error: Object) => {
        AALog.warn(`Camera failed: ${error instanceof Error ? error.message : 'unknown'}`);
        this.showComposerNotice($r('app.string.session_camera_permission_required'));
      });
  }

  private pickComposerFiles(): void {
    const context = this.getUIContext().getHostContext();
    const pickerApi: AttachmentPicker = new AttachmentPicker(context);
    void pickerApi.pickFiles(MAX_ATTACHMENT_FILES)
      .then((picked: PickedAttachment[]) => this.attachPicked(picked))
      .catch((error: Object) => {
        AALog.warn(`File picker failed: ${error instanceof Error ? error.message : 'unknown'}`);
        this.showComposerNotice($r('app.string.session_file_picker_failed'));
      });
  }

  // ------------------------------------------------------ message attachments

  /** Images across the loaded conversation, which the viewer pages through. */
  private conversationImages(): TimelineAttachment[] {
    const images: TimelineAttachment[] = [];
    for (const message of this.detailState.timeline) {
      for (const attachment of message.attachments) {
        if (isImageAttachment(attachment.mediaType)) {
          images.push(attachment);
        }
      }
    }
    return images;
  }

  /**
   * Downloads one attachment's bytes.
   *
   * Android caches these in Coil and in its own download directory; here the
   * bytes are fetched on demand and handed to the caller, which decodes them for
   * display or writes them out for a save.
   */
  private async loadAttachmentBytes(attachment: TimelineAttachment): Promise<ArrayBuffer | null> {
    const services: AppServices | null = this.services;
    const sessionId: string = this.selectedSessionId;
    if (services === null || sessionId.length === 0) {
      return null;
    }
    try {
      return await services.sessionDetailController.loadAttachmentBytes(sessionId, attachment.fileId);
    } catch (error) {
      AALog.warn(`Attachment download failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Saves an attachment through the system save dialog.
   *
   * Android writes to the gallery through MediaStore; HarmonyOS's equivalent
   * user-visible destination is the document picker's save mode, so the user
   * chooses where the file lands. That substitution is recorded in the port plan.
   */
  private async saveAttachment(attachment: TimelineAttachment): Promise<void> {
    const bytes: ArrayBuffer | null = await this.loadAttachmentBytes(attachment);
    if (bytes === null) {
      this.previewToast = $r('app.string.session_attachment_download_failed');
      this.previewToastRequest += 1;
      return;
    }
    const context = this.getUIContext().getHostContext();
    const pickerApi: AttachmentPicker = new AttachmentPicker(context);
    const saved: boolean = await pickerApi.saveFileAs(attachment.name, bytes);
    this.previewToast = saved
      ? $r('app.string.session_attachment_saved')
      : $r('app.string.session_attachment_save_failed');
    this.previewToastRequest += 1;
  }

  /** The file card's action: save the same way the viewer's button does. */
  private openMessageAttachment(attachment: TimelineAttachment): void {
    if (isImageAttachment(attachment.mediaType)) {
      this.previewAttachment = attachment;
      return;
    }
    void this.saveAttachment(attachment);
  }

  // ------------------------------------------------------------ device detail

  /** iOS's device page opens the device's workspace files from here. */
  private openDeviceFiles(): void {
    this.filesSession = null;
    this.filesDeviceId = this.selectedDeviceId;
    this.filesReturn = AppDestination.DeviceDetail;
    this.navigate(AppDestination.Files);
  }

  /** The same page opens the standalone terminal, which only Android has. */
  private openDeviceTerminal(): void {
    this.terminalDeviceId = this.selectedDeviceId;
    this.terminalReturn = AppDestination.DeviceDetail;
    this.navigate(AppDestination.Terminal);
  }

  /** Opens a device: show the page, then load its runtime inventory. */
  private openDevice(device: AgentDevice): void {
    this.selectedDeviceId = device.id;
    this.deviceRuntimes = DeviceRuntimeManagementState.loadingFor(device.id);
    this.navigate(AppDestination.DeviceDetail);
    void this.loadDeviceRuntimes(device.id);
  }

  /**
   * Loads the runtime inventory.
   *
   * Android runs this from a `LaunchedEffect` keyed on the device id and treats a
   * failure as a message on the section, keeping whatever was already loaded.
   */
  private async loadDeviceRuntimes(deviceId: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || deviceId.length === 0) {
      return;
    }
    try {
      const inventory: RemoteDeviceRuntimeList =
        await services.devicesController.listDeviceRuntimes(deviceId);
      if (this.selectedDeviceId !== deviceId) {
        return;
      }
      this.deviceRuntimes = this.deviceRuntimes.replaceWithList(inventory);
    } catch (error) {
      if (this.selectedDeviceId !== deviceId) {
        return;
      }
      AALog.warn(`Runtime inventory failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.deviceRuntimes = this.deviceRuntimes.copy({
        loading: false,
        errorMessage: 'Could not load runtimes for this device.',
      });
    }
  }

  /**
   * Starts or stops one runtime.
   *
   * Android marks the row pending, applies the Server's runtime on success, and
   * on failure re-reads the inventory so the switch snaps back to the truth.
   */
  private async setDeviceRuntimeActive(runtime: RemoteDeviceRuntime, active: boolean): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || this.deviceRuntimes.pendingRuntimeId !== null) {
      return;
    }
    this.deviceRuntimes = this.deviceRuntimes.copy({
      pendingRuntimeId: runtime.id,
      errorMessage: null,
    });
    try {
      const updated: RemoteDeviceRuntime = await services.devicesController.setRuntimeActive(
        runtime.connectorId, runtime.id, active,
      );
      if (this.selectedDeviceId !== updated.connectorId
        && this.selectedDeviceId !== runtime.connectorId) {
        return;
      }
      this.deviceRuntimes = this.deviceRuntimes.replaceRuntime(updated);
    } catch (error) {
      AALog.warn(`Runtime activation failed: ${error instanceof Error ? error.message : 'unknown'}`);
      const message: string = 'Could not update the runtime.';
      this.deviceRuntimes = this.deviceRuntimes.copy({
        pendingRuntimeId: null,
        errorMessage: message,
      });
      // Re-read so the switch reflects what the Server actually has.
      await this.loadDeviceRuntimes(runtime.connectorId);
      this.deviceRuntimes = this.deviceRuntimes.copy({ errorMessage: message });
    }
  }

  /**
   * Bulk archive or unarchive from the device page.
   *
   * Android reports how many sessions moved and how many the Server no longer
   * knows about, both as toasts over the page.
   */
  private async bulkSetDeviceSessionsArchived(
    sessionIds: string[],
    archived: boolean,
  ): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || sessionIds.length === 0 || this.deviceBulkBusy) {
      return;
    }
    this.deviceBulkBusy = true;
    try {
      const next: SessionsState = await services.sessionsController.setArchivedBulk(
        this.sessionsState, sessionIds, archived,
      );
      this.sessionsState = next;
      const known: Set<string> = new Set<string>();
      for (const session of next.sessions) {
        known.add(session.id);
      }
      for (const session of next.archivedSessions) {
        known.add(session.id);
      }
      let updated: number = 0;
      let missing: number = 0;
      for (const id of sessionIds) {
        if (known.has(id)) {
          updated++;
        } else {
          missing++;
        }
      }
      if (missing > 0) {
        this.showDeviceNotice($r('app.string.device_detail_sessions_not_found', missing));
      }
      this.showDeviceNotice(archived
        ? $r('app.string.device_detail_archived_sessions_toast', updated)
        : $r('app.string.device_detail_unarchived_sessions_toast', updated));
    } catch (error) {
      AALog.warn(`Bulk archive failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showDeviceNotice($r('app.string.device_detail_update_sessions_failed'));
    } finally {
      this.deviceBulkBusy = false;
    }
  }

  private showDeviceNotice(message: ResourceStr): void {
    this.deviceNotice = message;
    this.deviceNoticeRequest += 1;
  }

  // ------------------------------------------------------- device actions

  private deviceName(): string {
    const detail: DeviceDetailState = deviceDetailState(this.sessionsState, this.selectedDeviceId);
    return detail.device === null ? '' : detail.device.name;
  }

  /**
   * Runs the confirmed device action.
   *
   * Android's `confirmCurrentAction`: the dialog stays open with its error on
   * failure, and only a success clears it. The revoke path is the exception — it
   * prepares a fresh setup credential, which needs the pairing sheet to be shown,
   * so it stays unreachable until that screen lands.
   */
  private async confirmDeviceAction(): Promise<void> {
    const services: AppServices | null = this.services;
    const action: DeviceConfirmAction | undefined = this.deviceConfirmAction;
    if (services === null || action === undefined || this.deviceActionBusy) {
      return;
    }
    const deviceId: string = this.selectedDeviceId;
    if (deviceId.length === 0) {
      return;
    }
    this.deviceActionBusy = true;
    this.deviceActionError = '';
    try {
      if (action.kind === DeviceConfirmKind.DeleteDevice) {
        await services.sessionsController.deleteDevice(this.sessionsState, deviceId);
        this.sessionsState = await services.sessionsController.loadInitial(this.sessionsState);
        this.deviceConfirmAction = undefined;
        this.deviceActionsOpen = false;
        this.syncDevicePreviews();
        this.navigate(AppDestination.Devices);
      } else if (action.kind === DeviceConfirmKind.DeleteRuntimeConfig) {
        const updated: RemoteDeviceRuntime = await services.devicesController.deleteRuntimeConfig(
          deviceId, action.runtimeId,
        );
        this.deviceRuntimes = this.deviceRuntimes.replaceRuntime(updated);
        this.deviceConfirmAction = undefined;
      } else if (action.kind === DeviceConfirmKind.ArchiveAllSessions) {
        const result: DeviceArchiveAllResult = await services.sessionsController.archiveAllForDevice(
          this.sessionsState, deviceId, action.archived, action.scope,
        );
        this.sessionsState = result.state;
        this.deviceConfirmAction = undefined;
        this.showDeviceNotice(action.archived
          ? $r('app.string.device_detail_archived_sessions_toast', result.updated)
          : $r('app.string.device_detail_unarchived_sessions_toast', result.updated));
      }
    } catch (error) {
      AALog.warn(`Device action failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.deviceActionError = error instanceof Error
        ? error.message
        : 'The action could not be completed.';
      // A failed runtime deletion still needs the Server's truth on screen.
      if (action.kind === DeviceConfirmKind.DeleteRuntimeConfig) {
        await this.loadDeviceRuntimes(deviceId);
      }
    } finally {
      this.deviceActionBusy = false;
    }
  }

  /** Renames the open device from the actions sheet. */
  private async renameOpenDevice(name: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || this.selectedDeviceId.length === 0 || this.deviceActionBusy) {
      return;
    }
    this.deviceActionBusy = true;
    this.deviceActionError = '';
    try {
      await services.sessionsController.renameDevice(this.sessionsState, this.selectedDeviceId, name);
      this.sessionsState = await services.sessionsController.loadInitial(this.sessionsState);
      this.deviceActionsOpen = false;
    } catch (error) {
      AALog.warn(`Rename failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.deviceActionError = error instanceof Error
        ? error.message
        : 'Could not rename device.';
    } finally {
      this.deviceActionBusy = false;
    }
  }

  // ------------------------------------------------------- pairing wizard

  /**
   * Moves to a pairing step.
   *
   * Android's `showStep`: the token and code steps need a credential and fall
   * back to the name step without one, and the token step is what starts the
   * online wait.
   */
  private showPairingStep(step: DevicePairingStep): void {
    if (this.pairingBusy) {
      return;
    }
    this.pairingWaitingOnline = false;
    if (step === DevicePairingStep.Command || step === DevicePairingStep.PairCode) {
      const credential: DeviceSetupCredential | undefined = this.pairingCredential;
      if (credential === undefined) {
        this.pairingStep = DevicePairingStep.Name;
        return;
      }
      if (step === DevicePairingStep.Command) {
        this.startPairingWait(credential.device.id);
        this.pairingWaitingOnline = true;
      }
    }
    this.pairingStep = step;
  }

  /** The header's back button: one step back, or out of the wizard. */
  private goBackPairingStep(): void {
    if (this.pairingBusy) {
      return;
    }
    if (this.pairingStep === DevicePairingStep.ConnectionMethod) {
      this.leavePairing();
      return;
    }
    this.pairingWaitingOnline = false;
    this.pairingStep = previousPairingStep(this.pairingStep);
  }

  /**
   * Leaving the wizard.
   *
   * Android asks first when a connector was created in this pass, because
   * abandoning it leaves an unpaired device behind.
   */
  private leavePairing(): void {
    if (this.pairingBusy) {
      return;
    }
    if (this.pairingCredential !== undefined && this.pairingCreatedThisFlow) {
      this.pairingExitConfirm = true;
      return;
    }
    this.navigate(this.deviceSetupReturn);
  }

  /** Opens the desktop download page in the browser. */
  private async openDesktopDownload(): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext();
      if (context === undefined) {
        return;
      }
      const want: Want = {
        action: 'ohos.want.action.viewData',
        uri: AppConfig.DESKTOP_DOWNLOAD_URL,
      };
      await (context as common.UIAbilityContext).startAbility(want);
    } catch (error) {
      AALog.warn(`Download page failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showPairingError($r('app.string.device_pairing_open_download_failed'));
    }
  }

  /** Opens the wizard from the top, as the "Add a new device" row does. */
  private openPairingWizard(returnTo: AppDestination): void {    this.deviceSetupReturn = returnTo;
    this.pairingStep = DevicePairingStep.ConnectionMethod;
    this.pairingCredential = undefined;
    this.pairingCreatedThisFlow = false;
    this.pairingWaitingOnline = false;
    this.pairingExitConfirm = false;
    this.navigate(AppDestination.DeviceSetup);
  }

  /**
   * Opens the wizard on the token step with a freshly rotated credential.
   *
   * Android's Revoke action revokes the token and shows the setup sheet with the
   * replacement, which is the only safe way to drop the old one.
   */
  private async revokeDeviceForSetup(deviceId: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || deviceId.length === 0) {
      return;
    }
    this.deviceActionBusy = true;
    this.deviceActionError = '';
    try {
      const credential: DeviceCredential = await services.devicesController.revoke(deviceId);
      this.pairingCredential = {
        device: credential.device,
        serverUrl: this.services === null ? '' : this.services.serverUrl(),
        connectorToken: credential.connectorToken,
      };
      this.pairingStep = DevicePairingStep.CliMethod;
      this.pairingCreatedThisFlow = false;
      this.pairingWaitingOnline = false;
      this.pairingExitConfirm = false;
      this.deviceConfirmAction = undefined;
      this.deviceActionsOpen = false;
      this.deviceSetupReturn = AppDestination.DeviceDetail;
      this.navigate(AppDestination.DeviceSetup);
    } catch (error) {
      AALog.warn(`Revoke failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.deviceActionError = error instanceof Error ? error.message : 'Could not revoke device token.';
    } finally {
      this.deviceActionBusy = false;
    }
  }

  /** Creates (or renames) the connector the wizard is about to pair. */
  private async createPairingCredential(name: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || this.pairingBusy) {
      return;
    }
    const cleanName: string = name.trim();
    if (cleanName.length === 0) {
      return;
    }
    const previous: DeviceSetupCredential | undefined = this.pairingCredential;
    this.pairingBusy = true;
    try {
      if (previous === undefined) {
        this.pairingCredential = await services.devicesController.createCredential(cleanName);
        this.pairingCreatedThisFlow = true;
      } else if (previous.device.name !== cleanName) {
        const patched: SessionsState = await services.sessionsController.renameDevice(
          this.sessionsState, previous.device.id, cleanName,
        );
        this.sessionsState = patched;
        const device: AgentDevice | null = findDevice(patched, previous.device.id);
        if (device !== null) {
          this.pairingCredential = {
            device: device,
            serverUrl: previous.serverUrl,
            connectorToken: previous.connectorToken,
          };
        }
      }
      this.pairingStep = DevicePairingStep.CliMethod;
    } catch (error) {
      AALog.warn(`Pairing credential failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showPairingError($r('app.string.device_pairing_errors_create_failed'));
    } finally {
      this.pairingBusy = false;
    }
  }

  private showPairingError(message: ResourceStr): void {
    this.pairingNotice = message;
    this.pairingNoticeRequest += 1;
  }

  /**
   * Waits for a freshly started connector to come online.
   *
   * Android's `DevicePairingMonitor.observe`: an initial 1.5s delay, then a poll
   * every 2s (3s after a failure) until the device reports online, or until the
   * Server answers with a status that will not change — a 404 for a device that
   * no longer exists.
   */
  private startPairingWait(deviceId: string): void {
    this.pairingMonitor = this.pairingMonitor.waitForDevice(deviceId);
    void this.pollPairingDevice(deviceId, true);
  }

  private async pollPairingDevice(deviceId: string, first: boolean): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    const generation: string = `${deviceId}`;
    let failed: boolean = false;
    try {
      await delayMillis(pairingPollDelayMs(failed, first));
      if (!this.pairingMonitor.isTracked(generation)) {
        return;
      }
      const device: AgentDevice = await services.devicesController.get(deviceId);
      if (device.online) {
        this.pairingMonitor = this.pairingMonitor.markOnline(deviceId);
        this.sessionsState = await services.sessionsController.loadInitial(this.sessionsState);
        this.syncDevicePreviews();
        if (this.destination === AppDestination.DeviceSetup) {
          this.pairingMonitor = this.pairingMonitor.clear(deviceId);
          this.navigate(this.deviceSetupReturn);
        }
        return;
      }
    } catch (error) {
      failed = true;
      const status: number = error instanceof AAApiError ? (error.statusCode ?? 0) : 0;
      if (isTerminalPairingStatus(status)) {
        AALog.debug(`Pairing wait stopped for ${deviceId} (status ${status})`);
        this.pairingMonitor = this.pairingMonitor.clear(deviceId);
        return;
      }
    }
    if (this.pairingMonitor.isTracked(deviceId)) {
      void this.pollPairingDevice(deviceId, false);
    }
  }

  /** Claims a pair code shown by the connector CLI. */
  private async claimPairingCode(code: string): Promise<void> {
    const services: AppServices | null = this.services;
    const credential: DeviceSetupCredential | undefined = this.pairingCredential;
    if (services === null || credential === undefined || this.pairingBusy || !isCompletePairCode(code)) {
      return;
    }
    this.pairingBusy = true;
    try {
      await services.devicesController.claimPairing(
        credential, code, credential.device.name,
      );
      this.pairingMonitor = this.pairingMonitor.clear(credential.device.id);
      this.sessionsState = await services.sessionsController.loadInitial(this.sessionsState);
      this.syncDevicePreviews();
      this.pairingBusy = false;
      this.navigate(this.deviceSetupReturn);
      return;
    } catch (error) {
      AALog.warn(`Pair code claim failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.showPairingError($r('app.string.device_pairing_errors_claim_failed'));
    } finally {
      this.pairingBusy = false;
    }
  }

  private async loadOlderDetail(): Promise<void> {    const services: AppServices | null = this.services;
    if (services === null || this.loadingOlderInFlight) {
      return;
    }
    // The list asks for the previous page from inside a scroll callback, so two
    // callbacks can arrive before the state's own `loadingOlder` flag is read
    // back; this latch keeps it to one request.
    this.loadingOlderInFlight = true;
    try {
      this.detailState = await services.sessionDetailController.loadOlder(this.detailState);
    } finally {
      this.loadingOlderInFlight = false;
    }
  }

  // ------------------------------------------------------ runtime settings

  /** Runtime id of the open session, used as the catalog lookup fallback. */
  private detailRuntimeId(): string | null {
    const wire = this.detailState.session;
    return wire === null ? null : wire.runtimeId;
  }

  /**
   * Loads the live catalogs behind the settings sheet.
   *
   * Android loads each catalog only when it is missing and not already in
   * flight, which keeps reopening the sheet free; the two are fetched in one
   * round trip here because the controller loads them together.
   */
  private loadRuntimeCatalogs(): void {
    const services: AppServices | null = this.services;
    if (services === null || this.selectedSessionId.length === 0) {
      return;
    }
    const settings: RuntimeSettingsState = this.runtimeSettings;
    if (settings.modelLoading || settings.permissionLoading) {
      return;
    }
    const complete: boolean = settings.modelCatalog !== null && settings.permissionCatalog !== null;
    // A failure is always retried; a complete pair is not re-fetched.
    const failed: boolean = settings.modelError !== null || settings.permissionError !== null;
    if (complete && !failed) {
      return;
    }
    const sessionId: string = this.selectedSessionId;
    void services.sessionDetailController
      .loadCatalogs(settings, sessionId, this.detailRuntimeId())
      .then((next: RuntimeSettingsState) => {
        if (this.selectedSessionId === sessionId) {
          this.runtimeSettings = next;
        }
      })
      .catch((error: Object) => {
        AALog.warn(`Runtime catalogs failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
  }

  /**
   * Applies a model or permission change.
   *
   * There is no optimistic write: the row reflects the Server's echo, so the
   * sheet cannot show a selection the runtime rejected.
   */
  private async selectRuntimeOption(scope: string, selectionId: string): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || this.selectedSessionId.length === 0) {
      return;
    }
    try {
      this.runtimeSettings = await services.sessionDetailController.patchSelection(
        this.runtimeSettings, this.selectedSessionId, scope, selectionId, this.detailRuntimeId(),
      );
    } catch (error) {
      AALog.warn(`Runtime selection failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** Open notices that name a timeline item, so a row can render them inline. */
  private attachedDetailNotices(): RemoteRuntimeNotice[] {
    const attached: RemoteRuntimeNotice[] = [];
    for (const notice of this.detailState.openNotices()) {
      if (noticeTargetIds(notice).length > 0) {
        attached.push(notice);
      }
    }
    return attached;
  }

  /**
   * Answers an approval or input request.
   *
   * A failure keeps the card in place and surfaces the message, because the
   * session stays blocked until the answer actually lands.
   */
  private async respondToDetailNotice(
    noticeId: string,
    actionId: string,
    input: Object | null,
  ): Promise<void> {
    const services: AppServices | null = this.services;
    if (services === null || this.noticeBusy) {
      return;
    }
    this.noticeBusy = true;
    this.noticeError = '';
    try {
      this.detailState = await services.sessionDetailController.respondToNotice(
        this.detailState, noticeId, actionId, input,
      );
    } catch (error) {
      this.noticeError = error instanceof Error
        ? error.message
        : 'Could not send the runtime response.';
    } finally {
      this.noticeBusy = false;
    }
  }

  private applyDashboardSnapshot(snapshot: DashboardSnapshot): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    this.sessionsState = services.sessionsController.applyDashboard(this.sessionsState, snapshot);
    // A snapshot can bring a device online, which is exactly when its agent
    // count needs asking for; the key guard skips the unchanged case.
    this.syncDevicePreviews();
  }

  /**
   * A signature of the device list for the new-session page.
   *
   * Android re-runs its device/inventory effects whenever the list or an online
   * flag changes; ArkUI has no `LaunchedEffect`, so the page watches this string
   * instead — it changes exactly when Android's keys would.
   */
  private devicesSignature(): string {
    const parts: string[] = [];
    for (const device of this.sessionsState.devices) {
      parts.push(`${device.id}:${device.online ? '1' : '0'}`);
    }
    parts.sort();
    return parts.join('|');
  }

  private accountUserId(): string {
    return this.services?.sessionStore.readUserId() ?? '';
  }

  /** The new-session page's runtime listing: the device's inventory. */
  private async listNewSessionRuntimes(deviceId: string): Promise<RemoteDeviceRuntimeList> {
    const services: AppServices | null = this.services;
    if (services === null) {
      throw new Error('Sign in again to start a session.');
    }
    return await services.devicesController.listDeviceRuntimes(deviceId);
  }

  private requireServices(message: string): AppServices {
    const services: AppServices | null = this.services;
    if (services === null) {
      throw new Error(message);
    }
    return services;
  }

  /** The runtime capability set the new-session page gates its selectors on. */
  private async loadNewSessionCapabilities(
    deviceId: string,
    runtimeId: string,
  ): Promise<RemoteRuntimeCapabilitySet> {
    return await this.requireServices('Sign in again to load runtime capabilities.')
      .devicesController.runtimeCapabilities(deviceId, runtimeId);
  }

  private async loadNewSessionModelCatalog(
    deviceId: string,
    runtimeId: string,
  ): Promise<RuntimeModelCatalog> {
    return await this.requireServices('Sign in again to load the model catalog.')
      .devicesController.runtimeModelCatalog(deviceId, runtimeId);
  }

  private async loadNewSessionPermissionCatalog(
    deviceId: string,
    runtimeId: string,
  ): Promise<RuntimePermissionCatalog> {
    return await this.requireServices('Sign in again to load the permission catalog.')
      .devicesController.runtimePermissionCatalog(deviceId, runtimeId);
  }

  /**
   * The new-session page's directory listing.
   *
   * Android's `SessionsController.listNewSessionDirectory`: it rejects a target
   * that is a file, keeps only directories, and sorts them by lower-cased name.
   * The port reads the same endpoint through `FilesApi`, because the files
   * browser's own controller drops the `targetType` this check needs.
   */
  private async listNewSessionDirectory(
    deviceId: string,
    root: string,
    path: string,
  ): Promise<NewSessionDirectory> {
    const services: AppServices = this.requireServices('Sign in again to browse directories.');
    const serverUrl: string = services.sessionStore.readServerUrl();
    const token: string = services.sessionStore.readAccessToken();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to browse directories.');
    }
    const directory: RemoteDirectory =
      await services.filesApi.listFiles(serverUrl, token, deviceId, root, path);
    if (directory.targetType === 'file') {
      throw new Error('Choose a directory, not a file.');
    }
    const entries: NewSessionPathEntry[] = [];
    for (const entry of directory.entries) {
      if (entry.type !== 'directory') {
        continue;
      }
      entries.push(new NewSessionPathEntry(entry.name, entry.path, true, entry.size));
    }
    entries.sort((left: NewSessionPathEntry, right: NewSessionPathEntry) => {
      return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
    });
    return new NewSessionDirectory(directory.path, entries);
  }

  /**
   * Android's `reloadProjects`: re-reads the project list and stores it, unless a
   * newer request has already done so.
   */
  private async reloadProjects(): Promise<AgentProject[]> {
    const services: AppServices = this.requireServices('Sign in again to load projects.');
    const version: number = this.projectsRequestVersion + 1;
    this.projectsRequestVersion = version;
    const projects: AgentProject[] = await services.sessionsController.loadProjects();
    if (version === this.projectsRequestVersion) {
      this.sessionsState = this.sessionsState.copy({ projects: projects });
    }
    return projects;
  }

  /**
   * Android's `onCreateProject`: creates the project and folds the authoritative
   * row into the session state, bumping the request version so a list already in
   * flight cannot overwrite it with a stale answer.
   */
  private async createProject(
    name: string,
    connectorId: string,
    workspacePath: string,
  ): Promise<AgentProject> {
    const services: AppServices = this.requireServices('Sign in again to create a project.');
    const project: AgentProject =
      await services.sessionsController.createProject(name, connectorId, workspacePath);
    this.projectsRequestVersion += 1;
    this.sessionsState = this.sessionsState.withPatchedProject(project);
    return project;
  }

  /** Looks up a session in either list so the detail header has a title up front. */
  private findSession(sessionId: string): AgentSession | null {
    for (const session of this.sessionsState.sessions) {
      if (session.id === sessionId) {
        return session;
      }
    }
    for (const session of this.sessionsState.archivedSessions) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return null;
  }

  /** Connectivity of the device that hosts a session, which gates the composer. */
  private sessionDeviceOnline(sessionId: string): boolean {
    const session: AgentSession | null = this.findSession(sessionId);
    if (session === null) {
      return true;
    }
    for (const device of this.sessionsState.devices) {
      if (device.id === session.connectorId) {
        return device.online;
      }
    }
    return true;
  }

  /**
   * Registers the bundled brand fonts.
   *
   * This is the current API (`UIContext.getFont().registerFont`) rather than the
   * deprecated ability-level `font.registerFont`, which needs a UI context. A
   * failure only costs the wordmark and the welcome line their typeface, so it is
   * logged and ignored.
   */
  private registerBrandFonts(): void {
    try {
      const fontApi = this.getUIContext().getFont();
      fontApi.registerFont({ familyName: 'AACaveat', familySrc: $rawfile('fonts/caveat_wght.ttf') });
      fontApi.registerFont({
        familyName: 'AANewsreader',
        familySrc: $rawfile('fonts/newsreader_opsz_wght.ttf'),
      });
    } catch (error) {
      AALog.warn(`Brand font registration failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /**
   * A 401 clears the credential only when the rejected token is still the stored
   * one: a response that raced a re-login must not sign out the new session.
   */
  private handleUnauthorized(token: string): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    if (services.authController.signOutIfTokenMatches(token)) {
      AALog.info('Signed out after an unauthorized response');
      this.returnToLogin();
    }
  }

  /** Clears every signed-in-only piece of state, matching Android's teardown. */
  private returnToLogin(): void {
    this.services?.disposeConnections();
    this.sessionsState = SessionsState.empty();
    this.projectSessions = ProjectSessionsState.empty();
    this.pendingQr = null;
    this.destination = AppDestination.LoginMethods;
  }

  /** Runs after a successful sign-in: load the shell and open the socket. */
  private onSignedIn(): void {
    this.destination = AppDestination.Sessions;
    // The account changed, so the project-tree preferences belong to it now.
    this.loadSidebarPreferences();
    this.startSignedInSession();
    // Android checks for a new build once a session exists, and offers it.
    const services: AppServices | null = this.services;
    if (services !== null) {
      services.appUpdates.onStateChange = (state: AppUpdateState) => {
        this.appUpdate = state;
      };
      services.appUpdates.syncSession(true);
    }
  }

  /** Android's `showUpdatePrompt`: shows the known release, or checks first. */
  private showUpdatePrompt(): void {
    const services: AppServices | null = this.services;
    if (services === null) {
      return;
    }
    this.profileOpen = false;
    services.appUpdates.showUpdatePrompt();
  }

  /**
   * Opens the release's download address.
   *
   * Android downloads the HAP and hands it to the package installer; this port
   * opens the address instead, and reports the placeholder address as
   * unavailable rather than opening a link that leads nowhere.
   */
  private openUpdateDownload(): void {
    const services: AppServices | null = this.services;
    const release: AndroidAppRelease | null =
      services === null ? null : services.appUpdates.state().release;
    if (services === null || release === null) {
      return;
    }
    services.appUpdates.markPromptHandled();
    if (!isConfiguredDownloadUrl(release.downloadUrl)) {
      services.appUpdates.reportDownloadUnavailable();
      return;
    }
    void this.openExternalUrl(release.downloadUrl);
  }

  /** Opens a URL in whatever the system uses for it. */
  private async openExternalUrl(url: string): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext();
      if (context === undefined) {
        return;
      }
      const want: Want = { action: 'ohos.want.action.viewData', uri: url };
      await (context as common.UIAbilityContext).startAbility(want);
    } catch (error) {
      AALog.warn(`Opening the update page failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private colors(): AAColors {
    return resolveAAColors(this.appearanceMode, this.systemDark);
  }

  /**
   * The account behind the sidebar's avatar.
   *
   * A failure is not worth a message: the control falls back to the label's
   * first letter, which is what iOS shows without a picture too.
   */
  private async loadShellAccount(): Promise<void> {
    try {
      this.account = await this.loadAccount();
    } catch (error) {
      AALog.debug(`Sidebar account load failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** The signed-in account, for the drawer's identity card. */
  private async loadAccount(): Promise<ParsedAuthMe> {
    const services: AppServices = this.requireServices('Sign in again to load the account.');
    return await services.authController.me(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(),
    );
  }

  // ------------------------------------------------------------ account edits

  private async updateDisplayName(displayName: string): Promise<ParsedAuthMe> {
    const services: AppServices = this.requireServices('Sign in again to rename the account.');
    return await services.authApi.updateDisplayName(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(), displayName,
    );
  }

  private async changePassword(password: string): Promise<void> {
    const services: AppServices = this.requireServices('Sign in again to change the password.');
    await services.authApi.changePassword(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(), password,
    );
  }

  private async loadAuthConfig(): Promise<ParsedAuthConfig> {
    const services: AppServices = this.requireServices('Sign in again to load the auth policy.');
    return await services.authApi.config(services.sessionStore.readServerUrl());
  }

  private async sendEmailCode(email: string): Promise<ParsedEmailCode> {
    const services: AppServices = this.requireServices('Sign in again to send a code.');
    return await services.authApi.sendEmailCode(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(), email,
    );
  }

  private async bindEmail(email: string, code: string | null): Promise<ParsedAuthMe> {
    const services: AppServices = this.requireServices('Sign in again to bind an email.');
    return await services.authApi.bindEmail(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(), email, code,
    );
  }

  private async updateAvatar(dataUrl: string): Promise<ParsedAuthMe> {
    const services: AppServices = this.requireServices('Sign in again to change the avatar.');
    return await services.authApi.updateAvatar(
      services.sessionStore.readServerUrl(), services.sessionStore.readAccessToken(), dataUrl,
    );
  }

  /**
   * Picks one picture and scales it to the 256px data URL the Server stores.
   *
   * Android decodes, scales and PNG-encodes before sending; the port does the
   * same through `avatarDataUrl`, which also reports a picture it cannot read.
   */
  private async pickAvatarDataUrl(): Promise<string | null> {
    const context = this.getUIContext().getHostContext();
    const pickerApi: AttachmentPicker = new AttachmentPicker(context);
    let picked: PickedAttachment[];
    try {
      picked = await pickerApi.pickImages(1, false);
    } catch (error) {
      AALog.warn(`Avatar picker failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
    if (picked.length === 0) {
      return null;
    }
    const dataUrl: string | null = await avatarDataUrl(picked[0].uri);
    if (dataUrl === null) {
      throw new Error(resolveString($r('app.string.profile_avatar_read_failed')));
    }
    return dataUrl;
  }

  /**
   * Applies the chosen language to the app's resources.   *
   * Android switches the process locale; HarmonyOS exposes the same idea as a
   * preferred language for the app, which the resource manager picks up for UI
   * created afterwards. `system` clears the preference again.
   */
  private applyLanguageMode(mode: string): void {
    try {
      if (mode === 'system') {
        i18n.System.setAppPreferredLanguage('default');
        return;
      }
      i18n.System.setAppPreferredLanguage(mode === 'zh-Hans' ? 'zh-Hans' : 'en');
    } catch (error) {
      AALog.warn(`Applying the language failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private navigate(destination: AppDestination): void {
    AALog.debug(`navigate -> ${destination}`);
    if (destination !== AppDestination.SessionDetail) {
      // The share dialog belongs to the conversation; Android hosts it inside the
      // screen, so leaving the screen takes it away.
      this.shareItemIds = null;
      this.shareBusy = false;
    }
    if (!this.isSplitLayout()) {
      // iOS's `selectDestination`: picking content closes the drawer, while a
      // regular-width split keeps its sidebar.
      this.settleDrawer(false);
    }
    this.destination = destination;
    // The ability reads this to decide whether the system back gesture belongs
    // to the app or to the platform.
    this.publishBackGesture();
  }

  /**
   * The system back gesture, mirroring each screen's own `onBack`.
   *
   * Android lets the platform event fall through on a root screen so the app
   * goes to the background; the same happens here by leaving the destination
   * untouched and returning `false` from the ability.
   */
  onBackRequested(): void {
    if (this.drawerVisible()) {
      // Android closes an open drawer with back before anything else; the drawer
      // is the compact layout's session list, so this is its dismissal.
      this.settleDrawer(false);
      return;
    }
    if (this.destination === AppDestination.ServerSetup
      || this.destination === AppDestination.QrLogin) {
      this.navigate(AppDestination.LoginMethods);
      return;
    }
    if (this.destination === AppDestination.QrWaiting) {
      this.navigate(AppDestination.QrLogin);
      return;
    }
    if (this.destination === AppDestination.SessionDetail) {
      this.stopSessionRealtime();
      this.leavePreparedDraft();
      this.navigate(AppDestination.Sessions);
      return;
    }
    if (this.destination === AppDestination.DeviceSetup) {
      this.navigate(this.deviceSetupReturn);
      return;
    }
    if (canNavigateBackFrom(this.destination)) {
      this.navigate(AppDestination.Sessions);
    }
  }

  /**
   * Whether the window is wide enough for the two-column shell.
   *
   * A port of iOS's `horizontalSizeClass == .regular` test. The width comes from
   * the root's `onAreaChange`, so a rotation or a window resize re-evaluates it.
   */
  isSplitLayout(): boolean {
    return this.windowWidth >= SPLIT_BREAKPOINT;
  }

  /**
   * Whether the session list sits beside the content instead of being a page.
   *
   * iOS keeps its sidebar beside the detail on every surface of the signed-in
   * shell; the sign-in pages are the exception, because there is no session list
   * to show before an account exists.
   */
  showsSidebar(): boolean {
    if (!this.isSplitLayout() || !this.sidebarOpen) {
      return false;
    }
    return this.hasSidebarContent();
  }

  /** Whether this destination has a session list to show at all. */
  private hasSidebarContent(): boolean {
    return this.destination !== AppDestination.LoginMethods
      && this.destination !== AppDestination.ServerSetup
      && this.destination !== AppDestination.QrLogin
      && this.destination !== AppDestination.QrWaiting;
  }

  /**
   * Whether the compact layout's drawer exists here.
   *
   * iOS's drawer presentation is the compact counterpart of the split's sidebar;
   * the settings page replaces the shell, so it takes the drawer with it.
   */
  private compactDrawerAvailable(): boolean {
    return !this.isSplitLayout() && !this.profileOpen && this.hasSidebarContent();
  }

  /**
   * Whether the drawer is committed open, which is what `back` dismisses.
   *
   * iOS's `ChatSidebarState.obscuresDetail`.
   */
  drawerVisible(): boolean {
    return this.compactDrawerAvailable() && this.sidebarOpen;
  }

  /** Whether the drawer's layer has to be drawn: open, or on its way there. */
  private drawerLayerVisible(): boolean {
    return this.compactDrawerAvailable() && (this.sidebarOpen || this.drawerProgress > 0.001);
  }

  /**
   * Re-seeds the sidebar's open state, the way `ChatSidebarState.setLayout` does.
   *
   * Only a change of layout moves the sidebar: `setLayout` returns early while
   * the layout is the same, so a drag to 900vp and back to 880vp does not
   * overwrite what the user toggled.
   */
  onWindowWidthChanged(): void {
    const split: boolean = this.isSplitLayout();
    if (split === this.lastSplitLayout) {
      return;
    }
    this.lastSplitLayout = split;
    this.sidebarOpen = split;
    // The drawer belongs to one layout only, so a rotation never leaves it half open.
    this.drawerProgress = 0;
  }

  /** iOS's `toggleSidebar`: the leading button of the detail pages flips this. */
  private toggleSidebar(): void {
    const open: boolean = !this.sidebarOpen;
    this.sidebarOpen = open;
    if (!this.isSplitLayout()) {
      this.animateDrawerProgress(open ? 1 : 0);
    }
    this.publishBackGesture();
  }

  /** iOS's `settle`: commit the drawer and spring the progress to match. */
  private settleDrawer(open: boolean): void {
    this.sidebarOpen = open;
    this.animateDrawerProgress(open ? 1 : 0);
    this.publishBackGesture();
  }

  /**
   * iOS's `.interpolatingSpring(response: 0.34, dampingRatio: 0.9)` — the spring
   * every drawer settle runs on, whether it came from a button, a tap or a pan.
   */
  private animateDrawerProgress(target: number): void {
    this.getUIContext().animateTo({
      curve: curves.springMotion(0.34, 0.9),
    }, () => {
      this.drawerProgress = target;
    });
  }

  /**
   * Starts the pan that drives the drawer.
   *
   * The handlers below are wired to the two nodes that carry the gesture — the
   * leading edge strip and the card's veil — and both use
   * `PanDirection.Horizontal`, so a vertical drag is never recognised and lists
   * and terminals keep scrolling.
   */
  private beginDrawerDrag(): void {
    // The commit waits for the release: the layer appears as soon as progress
    // moves, and the edge strip that owns the gesture has to stay mounted for as
    // long as the finger is down.
    this.drawerDragActive = true;
    this.drawerDragStart = this.drawerProgress;
  }

  private updateDrawerDrag(event: GestureEvent): void {
    if (!this.drawerDragActive) {
      return;
    }
    const width: number = this.drawerWidth();
    if (width <= 0) {
      return;
    }
    const next: number = this.drawerDragStart + event.offsetX / width;
    this.drawerProgress = next < 0 ? 0 : (next > 1 ? 1 : next);
  }

  private endDrawerDrag(event: GestureEvent): void {
    if (!this.drawerDragActive) {
      return;
    }
    this.drawerDragActive = false;
    const width: number = this.drawerWidth();
    // iOS projects the fling: translation plus a fifth of the release velocity.
    const projected: number = this.drawerProgress
      + (width > 0 ? (event.velocityX * 0.2) / width : 0);
    this.settleDrawer(projected >= 0.5);
  }

  /**
   * Publishes whether the system back gesture belongs to the app.
   *
   * An open drawer counts as a step back — Android closes it with back — so the
   * gesture stays with the app even on a root destination while it is showing.
   */
  private publishBackGesture(): void {
    AppStorage.setOrCreate('canNavigateBack',
      this.drawerVisible() || canNavigateBackFrom(this.destination));
  }

  /**
   * What the empty selection shows until the first load lands.
   *
   * The new-session page reads its device, project and workspace choices out of
   * the sessions state, and a state that arrived after it mounted left it on its
   * "checking devices" rows for good — so it is only mounted once there is a state
   * to read. A failed first load mounts it too: it has the failure explanations,
   * and a spinner that never ends would be worse.
   */
  @Builder
  LandingLoading() {
    Column() {
      LoadingProgress()
        .width(24)
        .height(24)
        .color(this.colors().muted)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.colors().canvas)
  }

  /** Whether the empty selection has a sessions state to render its page from. */
  private landingReady(): boolean {
    return this.sessionsState.hasLoaded || this.sessionsState.errorMessage !== null;
  }

  /**
   * The empty selection's content, and the new-session destination's.
   *
   * iOS resolves the chat shell's `ChatShellSelection.newSession` to
   * `NewSessionView` in the detail column, which is what both of those states
   * are here; its leading glyph is the sidebar toggle in either layout.
   */
  @Builder
  NewSessionContent() {
    NewSessionScreen({
      colors: this.colors(),
      state: this.sessionsState,
      devicesSignature: this.devicesSignature(),
      serverUrl: this.services?.serverUrl() ?? '',
      userId: this.accountUserId(),
      devicesRefreshing: this.sessionsState.isLoading,
      // Android opens the same screen in project-only mode for NewProject.
      projectOnly: this.destination === AppDestination.NewProject,
      sidebarViewMode: this.sidebarViewMode,
      onBack: () => this.navigate(AppDestination.Sessions),
      // iOS's `NewSessionView` carries the sidebar toggle, in both layouts.
      sidebarToggle: true,
      onToggleSidebar: () => this.toggleSidebar(),
      onOpenDevices: () => this.navigate(AppDestination.Devices),
      onRefreshDevices: () => this.loadSessions(),
      onCreateProject: (name: string, connectorId: string, path: string) =>
        this.createProject(name, connectorId, path),
      onLoadProjects: () => this.reloadProjects(),
      onListRuntimes: (deviceId: string) => this.listNewSessionRuntimes(deviceId),
      onListDirectory: (deviceId: string, root: string, path: string) =>
        this.listNewSessionDirectory(deviceId, root, path),
      onLoadRuntimeCapabilities: (deviceId: string, runtimeId: string) =>
        this.loadNewSessionCapabilities(deviceId, runtimeId),
      onLoadModelCatalog: (deviceId: string, runtimeId: string) =>
        this.loadNewSessionModelCatalog(deviceId, runtimeId),
      onLoadPermissionCatalog: (deviceId: string, runtimeId: string) =>
        this.loadNewSessionPermissionCatalog(deviceId, runtimeId),
      onPrepareSession: (draft: NewSessionDraft) => {
        // Android hands the draft to the conversation screen, which creates
        // the Server session on the first send.
        this.openPreparedDraft(draft);
      },
    })
  }

  /**
   * The session list, shared by the wide layout's column and the compact drawer.
   *
   * Both columns draw the same component with the same callbacks, so a selection
   * behaves identically at either width.
   */
  @Builder
  SessionsList() {
    HomeScreen({
      colors: this.colors(),
      state: this.sessionsState,
      controller: this.services?.sessionsController ?? null,
      projectSessions: this.projectSessions,
      projectStatusFilter: this.projectStatusFilter,
      onLoadProjectSessions: (projectId: string) => this.loadProjectSessions(projectId),
      onProjectFilterChange: (filter: ProjectSessionStatusFilter) => {
        this.projectStatusFilter = filter;
        const preferences: ProjectSidebarPreferences | null = this.sidebarPreferences;
        if (preferences !== null) {
          preferences.setStatusFilter(filter);
        }
      },
      initialExpandedProjectIds: this.expandedProjectIds,
      initialProjectsSectionExpanded: this.projectsSectionExpanded,
      onSidebarStateChange: (ids: string[], sectionExpanded: boolean) => {
        this.expandedProjectIds = ids;
        this.projectsSectionExpanded = sectionExpanded;
        const preferences: ProjectSidebarPreferences | null = this.sidebarPreferences;
        if (preferences !== null) {
          preferences.setExpandedProjectIds(ids);
          preferences.setProjectsSectionExpanded(sectionExpanded);
        }
      },
      sidebarViewMode: this.sidebarViewMode,
      account: this.account,
      onStateChange: (next: SessionsState) => {
        this.sessionsState = next;
      },
      onOpenSession: (session: AgentSession) => this.openSession(session),
      onNewSession: () => this.navigate(AppDestination.NewSession),
      onNewProject: () => this.navigate(AppDestination.NewProject),
      onOpenDevice: (device: AgentDevice) => this.openDevice(device),
      onOpenProfile: () => {
        // The account page replaces the shell, so the drawer gets out of its way.
        this.sidebarOpen = false;
        this.profileOpen = true;
      },
      onPairDevice: () => this.openPairingWizard(AppDestination.Sessions),
      onRefresh: () => this.loadSessions(),
      onLoadMore: () => {
        void this.loadMoreSessions();
      },
    })
  }

  /** The split layout's leading column: the session list at a fixed width. */
  @Builder
  SidebarColumn() {
    Column() {
      this.SessionsList()
    }
    .width(SIDEBAR_WIDTH)
    .height('100%')
    .border({ width: { right: 1 }, color: iosHairline(this.colors()) })
  }

  /**
   * The compact layout's sidebar, behind the content card.
   *
   * iOS's `SidebarDrawerSidebar`: it sits at the leading edge at 75% of the
   * window, grows from `sidebarClosedScale` to its full size as the drawer opens,
   * and loses its `systemBackground` veil — which is what keeps it from looking
   * finished while the card still covers it.
   */
  @Builder
  SidebarDrawerLayer() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        this.SessionsList()
      }
      .width(this.drawerWidth())
      .height('100%')
      .padding({ top: this.statusBarHeight })
      .backgroundColor(this.colors().canvas)

      if (this.drawerProgress < 0.999) {
        Column()
          .width(this.drawerWidth())
          .height('100%')
          .backgroundColor(withAlpha(this.colors().canvas, 0.5 * (1 - this.drawerProgress)))
      }
    }
    .width(this.drawerWidth())
    .height('100%')
    .scale({
      x: DRAWER_CLOSED_SCALE + (1 - DRAWER_CLOSED_SCALE) * this.drawerProgress,
      y: DRAWER_CLOSED_SCALE + (1 - DRAWER_CLOSED_SCALE) * this.drawerProgress,
      centerX: 0,
      centerY: '50%',
    })
  }

  /** iOS sizes the drawer from the window: `revealFraction` of its width. */
  private drawerWidth(): number {
    return Math.round(this.windowWidth * DRAWER_REVEAL);
  }

  /** How far the content card has slid to reveal the drawer. */
  private cardOffsetX(): number {
    return this.drawerWidth() * this.drawerProgress;
  }

  build() {
    Stack() {
      // The compact layout draws the sidebar behind this card, as iOS does; in
      // the wide layout the same builder is the fixed column in the row below.
      // The leading row matters: a bare child of this stack is centred, which
      // pushed the whole sidebar right by half the unrevealed width.
      if (this.drawerLayerVisible()) {
        Row() {
          this.SidebarDrawerLayer()
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
      }

      // iOS's `SidebarDrawerMainCard`: the content slides right by the revealed
      // width, rounds its leading corners, veils itself white, takes a hairline
      // and casts a shadow while the drawer is open. The veil is also the tap
      // target that closes the drawer and the surface that drags it shut.
      Stack() {
        Column() {
        if (this.profileOpen) {
          // Android slides the drawer over the current screen; this port's shell
          // swaps the page instead, which is the same choice the session pager
          // makes, and the drawer fades in so the change is not a hard cut.
          ProfileSettingsDrawer({
            colors: this.colors(),
            userId: this.accountUserId(),
            role: this.services?.sessionStore.readRole() ?? '',
            serverUrl: this.services?.serverUrl() ?? '',
            appearanceMode: this.appearanceMode,
            languageMode: this.languageMode,
            sidebarViewMode: this.sidebarViewMode,
            appVersion: AppConfig.CLIENT_VERSION_NAME,
            onAppearanceModeChange: (mode: string) => {
              this.appearanceMode = mode;
              this.services?.uiPreferences.setAppearanceMode(mode);
            },
            onLanguageModeChange: (mode: string) => {
              this.languageMode = mode;
              this.services?.uiPreferences.setLanguageMode(mode);
              this.applyLanguageMode(mode);
            },
            onSidebarViewModeChange: (mode: string) => {
              this.sidebarViewMode = mode;
              this.services?.uiPreferences.setSidebarViewMode(mode);
            },
            onOpenArchivedSessions: () => {
              this.profileOpen = false;
              this.navigate(AppDestination.ArchivedSessions);
            },
            onSignOut: () => {
              this.profileOpen = false;
              this.services?.authController.signOut();
              this.returnToLogin();
            },
            onClose: () => {
              this.profileOpen = false;
              // The drawer may have renamed the account or changed its picture.
              void this.loadShellAccount();
            },
            onLoadAccount: () => this.loadAccount(),
            onUpdateDisplayName: (displayName: string) => this.updateDisplayName(displayName),
            onChangePassword: (password: string) => this.changePassword(password),
            onLoadAuthConfig: () => this.loadAuthConfig(),
            onSendEmailCode: (email: string) => this.sendEmailCode(email),
            onBindEmail: (email: string, code: string | null) => this.bindEmail(email, code),
            onPickAvatar: () => this.pickAvatarDataUrl(),
            onUpdateAvatar: (dataUrl: string) => this.updateAvatar(dataUrl),
            appUpdate: this.appUpdate,
            onUpdateNow: () => this.showUpdatePrompt(),
            onCheckForUpdates: () => {
              void this.services?.appUpdates.checkForUpdate(false, false);
            },
          })
            .transition(TransitionEffect.OPACITY.animation({ duration: 180, curve: Curve.EaseOut }))
        } else {
          // iOS's `NavigationSplitView`: on a regular-width window the session
          // list keeps its place beside the content instead of being a page of
          // its own, and every other destination renders in the detail column.
          Row() {
            if (this.showsSidebar()) {
              this.SidebarColumn()
            }

            Column() {
              if (this.destination === AppDestination.LoginMethods) {
                LoginMethodsScreen({
                  colors: this.colors(),
                  onOpenQrLogin: () => this.navigate(AppDestination.QrLogin),
                  onOpenServerSetup: () => this.navigate(AppDestination.ServerSetup),
                })
              } else if (this.destination === AppDestination.ServerSetup) {
                ServerSetupScreen({
                  colors: this.colors(),
                  controller: this.services?.authController ?? null,
                  onBack: () => this.navigate(AppDestination.LoginMethods),
                  onSignedIn: () => this.onSignedIn(),
                })
              } else if (this.destination === AppDestination.QrLogin) {
                QrLoginScreen({
                  colors: this.colors(),
                  controller: this.services?.authController ?? null,
                  onBack: () => this.navigate(AppDestination.LoginMethods),
                  onScanned: (payload: MobileLoginQrPayload) => {
                    this.pendingQr = payload;
                    this.navigate(AppDestination.QrWaiting);
                  },
                })
              } else if (this.destination === AppDestination.QrWaiting) {
                QrWaitingScreen({
                  colors: this.colors(),
                  controller: this.services?.authController ?? null,
                  payload: this.pendingQr,
                  onBack: () => this.navigate(AppDestination.QrLogin),
                  onSignedIn: () => this.onSignedIn(),
                })
              } else if (this.destination === AppDestination.Sessions) {
                // Nothing selected: iOS shows the new-session page here, in both
                // layouts, and leaves the session list to the sidebar. It waits
                // for the first session load; see `LandingLoading`.
                if (this.landingReady()) {
                  this.NewSessionContent()
                } else {
                  this.LandingLoading()
                }
              } else if (this.destination === AppDestination.SessionDetail) {
                SessionDetailScreen({
                  colors: this.colors(),
                  state: this.detailState,
                  runtimeSettings: this.runtimeSettings,
                  forceLatestRequest: this.forceLatestRequest,
                  streamLatestRequest: this.streamLatestRequest,
                  initialized: this.detailState.initialized,
                  loadingOlder: this.detailState.loadingOlder,
                  session: this.detailSession(),
                  deviceOnline: this.sessionDeviceOnline(this.selectedSessionId),
                  draftMode: this.preparedDraft !== null,
                  // Android asks the draft whether its runtime accepts attachments
                  // (`preparedSession.attachmentsEnabled`); outside a draft the screen
                  // reads the loaded capability set instead.
                  draftAttachmentsEnabled: this.draftAttachmentsEnabled(),
                  composerRestoreText: this.composerRestoreText,
                  composerRestoreRequest: this.composerRestoreRequest,
                  onBack: () => {
                    this.stopSessionRealtime();
                    this.leavePreparedDraft();
                    this.navigate(AppDestination.Sessions);
                  },
                  // iOS's `SidebarMenuIcon`: the conversation's leading glyph opens
                  // the session list — the drawer on a phone, the column when split.
                  sidebarToggle: true,
                  onToggleSidebar: () => this.toggleSidebar(),
                  onLoadOlder: () => {
                    void this.loadOlderDetail();
                  },
                  onSend: (content: string) => {
                    void this.sendDetailMessage(content);
                  },
                  onInterrupt: () => {
                    void this.interruptDetailTurn();
                  },
                  onToggleTakeover: (enabled: boolean) => {
                    void this.toggleDetailTakeover(enabled);
                  },
                  onRetry: () => {
                    void this.loadSessionDetail(this.selectedSessionId);
                  },
                  onOpenRuntimeSettings: () => this.loadRuntimeCatalogs(),
                  onRetryRuntimeCatalogs: () => this.loadRuntimeCatalogs(),
                  onSelectRuntime: (scope: string, selectionId: string) => {
                    void this.selectRuntimeOption(scope, selectionId);
                  },
                  onOpenAgentFiles: () => {
                    // Android swaps to the session's files/terminal pager page; the port
                    // opens the same page, with the session that turns on the pager header
                    // and the workspace-rooted browser.
                    const session: AgentSession | null = this.findSession(this.selectedSessionId);
                    this.filesSession = session;
                    this.filesDeviceId = session === null ? '' : session.connectorId;
                    this.filesReturn = AppDestination.SessionDetail;
                    this.navigate(AppDestination.Files);
                  },
                  blockingNotices: this.services?.sessionDetailController.blockingNotices(this.detailState)
                    ?? [],
                  detachedNotices: this.services?.sessionDetailController.detachedNotices(this.detailState)
                    ?? [],
                  attachedNotices: this.attachedDetailNotices(),
                  noticeBusy: this.noticeBusy,
                  noticeError: this.noticeError,
                  onRespondNotice: (noticeId: string, actionId: string, input: Object | null) => {
                    void this.respondToDetailNotice(noticeId, actionId, input);
                  },
                  attachments: this.composerAttachments,
                  composerNotice: this.composerNotice,
                  composerNoticeRequest: this.composerNoticeRequest,
                  infoNotice: this.infoNotice,
                  infoNoticeRequest: this.infoNoticeRequest,
                  onCopyReply: (text: string) => this.copyReplyText(text),
                  onShareReply: (itemIds: string[]) => this.requestShare(itemIds),
                  onDraftChange: (text: string) => this.persistComposerDraft(text),
                  onLoadCommands: () => this.loadSessionCommands(),
                  onExecuteCommand: (commandId: string, args: string[], raw: string) =>
                    this.executeSessionCommand(commandId, args, raw),
                  sessionImages: this.conversationImages(),
                  previewAttachment: this.previewAttachment,
                  previewPending: this.previewPending,
                  previewToast: this.previewToast,
                  previewToastRequest: this.previewToastRequest,
                  statusBarHeight: this.statusBarHeight,
                  loadAttachment: (attachment: TimelineAttachment) => this.loadAttachmentBytes(attachment),
                  onPreviewMessageAttachment: (attachment: TimelineAttachment) => {
                    this.previewAttachment = attachment;
                  },
                  onClosePreview: () => {
                    this.previewAttachment = null;
                    this.previewPending = null;
                  },
                  onDownloadAttachment: (attachment: TimelineAttachment) => {
                    void this.saveAttachment(attachment);
                  },
                  onOpenAttachment: (attachment: TimelineAttachment) => {
                    this.openMessageAttachment(attachment);
                  },
                  onPickPhoto: () => this.pickComposerPhotos(),
                  onOpenCamera: () => this.openComposerCamera(),
                  onPickFile: () => this.pickComposerFiles(),
                  onRemoveAttachment: (attachment: PendingAttachment) => {
                    this.removeComposerAttachment(attachment);
                  },
                  onRetryAttachment: (attachment: PendingAttachment) => {
                    this.retryComposerAttachment(attachment);
                  },
                  onPreviewComposerAttachment: (attachment: PendingAttachment) => {
                    // A local image opens in its own surface: it has no file id yet, so
                    // the conversation pager cannot hold it.
                    if (isImageAttachment(attachment.mediaType)) {
                      this.previewPending = attachment;
                    }
                  },
                })
              } else if (this.destination === AppDestination.Devices) {
                DevicesScreen({
                  colors: this.colors(),
                  state: this.sessionsState,
                  isRefreshing: this.sessionsState.isLoading,
                  agentPreviews: this.deviceAgentPreviews,
                  onRefresh: () => this.loadSessions(),
                  onOpenDevice: (device: AgentDevice) => {
                    this.openDevice(device);
                  },
                  onBack: () => this.navigate(AppDestination.Sessions),
                  onAddDevice: () => {
                    this.openPairingWizard(AppDestination.Devices);
                  },
                })
              } else if (this.destination === AppDestination.DeviceDetail) {
                DeviceDetailScreen({
                  colors: this.colors(),
                  state: this.sessionsState,
                  deviceId: this.selectedDeviceId,
                  runtimes: this.deviceRuntimes,
                  bulkBusy: this.deviceBulkBusy,
                  deviceNotice: this.deviceNotice,
                  deviceNoticeRequest: this.deviceNoticeRequest,
                  // iOS reaches a device's files from the device page
                  // (`WorkspaceFilesSheet`); the terminal is this app's own page.
                  onOpenFiles: () => this.openDeviceFiles(),
                  onOpenTerminal: () => this.openDeviceTerminal(),
                  onBack: () => this.navigate(AppDestination.Devices),
                  // A device row in the sidebar opens this page, so its leading
                  // glyph is the sidebar toggle (iOS's `DeviceManagementView(onMenu:)`).
                  sidebarToggle: true,
                  onToggleSidebar: () => this.toggleSidebar(),
                  onOpenSession: (session: AgentSession) => {
                    this.openSession(session);
                  },
                  onRetryRuntimes: () => {
                    void this.loadDeviceRuntimes(this.selectedDeviceId);
                  },
                  onSetRuntimeActive: (runtime: RemoteDeviceRuntime, active: boolean) => {
                    void this.setDeviceRuntimeActive(runtime, active);
                  },
                  onDeleteRuntimeConfig: (runtime: RemoteDeviceRuntime) => {
                    this.deviceActionError = '';
                    this.deviceConfirmAction = DeviceConfirmAction.deleteRuntimeConfig(runtime);
                  },
                  onBulkSetArchived: (sessionIds: string[], archived: boolean) => {
                    void this.bulkSetDeviceSessionsArchived(sessionIds, archived);
                  },
                  onArchiveAll: (archived: boolean, scope: string, scopeLabel: string) => {
                    this.deviceActionError = '';
                    this.deviceConfirmAction = DeviceConfirmAction.archiveAllSessions(
                      this.deviceName(), archived, scope, scopeLabel,
                    );
                  },
                  actionsOpen: this.deviceActionsOpen,
                  actionBusy: this.deviceActionBusy,
                  actionError: this.deviceActionError,
                  onOpenActions: () => {
                    this.deviceActionError = '';
                    this.deviceActionsOpen = true;
                  },
                  onCloseActions: () => {
                    this.deviceActionsOpen = false;
                    this.deviceActionError = '';
                  },
                  onRenameDevice: (name: string) => {
                    void this.renameOpenDevice(name);
                  },
                  onDeleteDevice: () => {
                    this.deviceActionsOpen = false;
                    this.deviceActionError = '';
                    this.deviceConfirmAction = DeviceConfirmAction.deleteDevice();
                  },
                  onPrepareDeviceSetup: () => {
                    // Android's Revoke row rotates the token and shows the replacement;
                    // the wizard's token step is that sheet.
                    void this.revokeDeviceForSetup(this.selectedDeviceId);
                  },
                  confirmAction: this.deviceConfirmAction,
                  onDismissConfirm: () => {
                    if (!this.deviceActionBusy) {
                      this.deviceConfirmAction = undefined;
                      this.deviceActionError = '';
                    }
                  },
                  onConfirmAction: () => {
                    void this.confirmDeviceAction();
                  },
                })
              } else if (this.destination === AppDestination.DeviceSetup) {
                AddDeviceScreen({
                  colors: this.colors(),
                  step: this.pairingStep,
                  credential: this.pairingCredential,
                  createdThisFlow: this.pairingCreatedThisFlow,
                  busy: this.pairingBusy,
                  waitingOnline: this.pairingWaitingOnline,
                  deviceOnline: this.pairingCredential === undefined
                    ? false
                    : pairingDeviceOnline(
                      this.pairingMonitor, this.sessionsState.devices, this.pairingCredential.device.id,
                    ),
                  exitConfirmation: this.pairingExitConfirm,
                  pairingNotice: this.pairingNotice,
                  pairingNoticeRequest: this.pairingNoticeRequest,
                  onBack: () => this.goBackPairingStep(),
                  onLeave: () => this.leavePairing(),
                  onStep: (step: DevicePairingStep) => this.showPairingStep(step),
                  onCreateCredential: (name: string) => {
                    void this.createPairingCredential(name);
                  },
                  onClaimCode: (code: string) => {
                    void this.claimPairingCode(code);
                  },
                  onCopyError: () => this.showPairingError($r('app.string.device_pairing_errors_copy_failed')),
                  onOpenDownload: () => {
                    void this.openDesktopDownload();
                  },
                  onDismissExit: () => {
                    this.pairingExitConfirm = false;
                  },
                  onConfirmExit: () => {
                    this.pairingExitConfirm = false;
                    this.navigate(this.deviceSetupReturn);
                  },
                })
              } else if (this.destination === AppDestination.Files) {
                FilesScreen({
                  colors: this.colors(),
                  state: this.sessionsState,
                  controller: this.services?.filesController ?? null,
                  initialDeviceId: this.filesDeviceId,
                  session: this.filesSession,
                  pool: this.services?.terminalPool ?? null,
                  onBack: () => this.navigate(this.filesReturn),
                  onPairDevice: () => this.openPairingWizard(AppDestination.Files),
                })
              } else if (this.destination === AppDestination.Terminal) {
                TerminalScreen({
                  colors: this.colors(),
                  state: this.sessionsState,
                  pool: this.services?.terminalPool ?? null,
                  onBack: () => this.navigate(this.terminalReturn),
                  initialDeviceId: this.terminalDeviceId,
                  onPairDevice: () => this.openPairingWizard(AppDestination.Terminal),
                })
              } else if (this.destination === AppDestination.NewSession
                || this.destination === AppDestination.NewProject) {
                this.NewSessionContent()
              } else if (this.destination === AppDestination.ArchivedSessions) {
                ArchivedSessionsScreen({
                  colors: this.colors(),
                  state: this.sessionsState,
                  controller: this.services?.sessionsController ?? null,
                  onStateChange: (next: SessionsState) => {
                    this.sessionsState = next;
                  },
                  onBack: () => this.navigate(AppDestination.Sessions),
                  onOpenSession: (session: AgentSession) => {
                    AALog.debug(`Open archived session ${session.id}`);
                  },
                })
              } else {
                PhasePlaceholder({ colors: this.colors(), destination: this.destination })
              }
            }
            .layoutWeight(1)
            .height('100%')
          }
          .width('100%')
          .height('100%')
        }
        }
        .width('100%')
        .height('100%')
        // Android's `ScreenScaffold` applies `WindowInsets.statusBars` as padding,
        // which shrinks the box its screens lay out in; the inset is applied once
        // here so no screen has to know about window metrics. A spacer child would
        // instead push a `100%`-tall screen down and clip its bottom by the inset.
        .padding({ top: this.statusBarHeight })
        .backgroundColor(this.colors().canvas)

        if (!this.isSplitLayout() && this.drawerProgress > 0.001) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor(withAlpha('#FFFFFF', 0.14 * this.drawerProgress))
            .border({
              width: 1,
              color: withAlpha(this.colors().isDark ? '#FFFFFF' : '#000000',
                0.2 * this.drawerProgress),
            })
            .onClick(() => this.settleDrawer(false))
            .gesture(
              PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
                .onActionStart(() => this.beginDrawerDrag())
                .onActionUpdate((event: GestureEvent) => this.updateDrawerDrag(event))
                .onActionEnd((event: GestureEvent) => this.endDrawerDrag(event)),
            )
        }
      }
      .width('100%')
      .height('100%')
      .translate({ x: this.cardOffsetX() })
      .borderRadius(DRAWER_CARD_RADIUS * this.drawerProgress)
      .clip(true)
      .shadow({
        radius: 18 * this.drawerProgress,
        color: withAlpha('#000000', 0.28 * this.drawerProgress),
        offsetX: -3 * this.drawerProgress,
        offsetY: 0,
      })


      // The closed drawer's activation edge: iOS reserves `edgeActivationWidth`
      // for the pan that opens it. `Transparent` lets taps through to the page
      // underneath — only a horizontal pan starting here is claimed.
      if (this.compactDrawerAvailable() && !this.sidebarOpen) {
        Row() {
          Column()
            .width(DRAWER_EDGE_WIDTH)
            .height('100%')
            .hitTestBehavior(HitTestMode.Transparent)
            .gesture(
              PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
                .onActionStart(() => this.beginDrawerDrag())
                .onActionUpdate((event: GestureEvent) => this.updateDrawerDrag(event))
                .onActionEnd((event: GestureEvent) => this.endDrawerDrag(event)),
            )
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
        .hitTestBehavior(HitTestMode.Transparent)
      }

      // The update prompt floats above whichever screen is showing, as Android's
      // dialog does; it is the only overlay that can appear on any destination.
      AppUpdatePromptDialog({
        colors: this.colors(),
        state: this.appUpdate,
        onUpdate: () => this.openUpdateDownload(),
        onIgnore: () => this.services?.appUpdates.ignoreVersion(),
      })

      // The share dialog belongs to the conversation, but the link has to outlive
      // a re-render, so the app owns it the way it owns the update prompt.
      if (this.shareItemIds !== null) {
        SessionShareDialog({
          colors: this.colors(),
          scope: this.shareScope,
          busy: this.shareBusy,
          onSelectScope: (scope: string) => {
            this.shareScope = scope;
          },
          onDismiss: () => {
            if (!this.shareBusy) {
              this.shareItemIds = null;
            }
          },
          onConfirm: () => {
            void this.createShare();
          },
        })
      }
    }
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      // The split layout follows the window rather than the device: iOS resolves
      // its sidebar from the horizontal size class, so a rotation has to
      // re-evaluate the breakpoint here too.
      this.windowWidth = Number(newValue.width);
    })
    .width('100%')
    .height('100%')
    // The drawer scales to 95% while it is closed, so the shell paints the canvas
    // behind both of them; otherwise that sliver would show the window's default.
    .backgroundColor(this.colors().canvas)
    .clip(true)
  }
}

/**
 * Waits for a given number of milliseconds.
 *
 * ArkTS has no coroutine scheduler, so the pairing poll chain is driven by
 * `setTimeout` through this helper.
 */
function delayMillis(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => resolve(), milliseconds);
  });
}

/**
 * Whether the update address is a real download rather than the placeholder.
 *
 * Android refuses anything that is not HTTPS, carries credentials, or still sits
 * under a `.invalid` host — the same test, so a build that has not been given a
 * real package address reports "download unavailable" instead of opening a dead
 * link.
 */
function isConfiguredDownloadUrl(downloadUrl: string): boolean {
  if (!downloadUrl.startsWith('https://')) {
    return false;
  }
  if (downloadUrl.includes('@')) {
    return false;
  }
  const host: string = downloadUrl.substring('https://'.length).split('/')[0];
  return !host.endsWith('.invalid');
}

/** The device with this id, or `null`; used after a rename. */
function findDevice(state: SessionsState, deviceId: string): AgentDevice | null {
  for (const device of state.devices) {
    if (device.id === deviceId) {
      return device;
    }
  }
  return null;
}

/**
 * Temporary stand-in for destinations that have not been ported yet.
 *
 * It is deliberately loud and names the owning phase rather than rendering an
 * empty screen, so an incomplete build can never be mistaken for a working one.
 */
@Component
struct PhasePlaceholder {
  colors: AAColors = resolveAAColors('system', false);
  destination: AppDestination = AppDestination.Sessions;

  build() {
    Column({ space: 12 }) {
      Text('Not ported yet')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.ink)
      Text(`Destination: ${this.destination}`)
        .fontSize(14)
        .fontColor(this.colors.muted)
      Text('The signed-in shell arrives in Phase 2.')
        .fontSize(14)
        .fontColor(this.colors.muted)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(32)
  }
}
