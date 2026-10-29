import { ApiClient, UploadFilePart } from 'network';
import { RealtimeApi } from 'network';
import { RealtimeSocketListener, RealtimeWebSocket } from 'network';
import { SharedApiClient } from '../api/SharedApiClient';
import {
  RemoteCommandResult,
  RemoteNoticeAction,
  RemoteDownloadedAttachment,
  RemoteRuntimeCommand,
  RemoteRuntimeNotice,
  RemoteRuntimeCapabilitySet,
  RemoteSession,
  RemoteSessionEventEnvelope,
  RemoteTimelineAttachment,
  RemoteTimelineItem,
  RemoteUploadedAttachment,
  hasCapability
} from 'network';
import { SessionsApi } from 'network';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { errorMessageFrom } from 'common';
import { MdBlock, parseMarkdownBlocks } from 'common';
import { NetworkMonitor } from 'common';
import { ComposerDraftStore } from '../feature/ComposerDraftStore';
import {
  OPTIMISTIC_PREFIX, OptimisticMessageStore
} from '../common/OptimisticMessageStore';
import {
  TimelineToolGroupModel,
  TimelineToolRowModel,
  TimelineToolStrings,
  isTimelineToolRunItem,
  timelineToolGroupModelOf,
  timelineToolRowModelOf
} from '../common/TimelineSummaries';
import { AgentMarkdownView } from '../components/AgentMarkdownView';
import { AttachmentImageView } from '../components/AttachmentImageView';
import { AttachmentPreviewOverlay } from '../components/AttachmentPreviewOverlay';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiffCodeView } from '../components/DiffCodeView';
import { TimelineToolEntry } from '../components/session/TimelineToolEntry';
import { TimelineToolGroupEntry } from '../components/session/TimelineToolGroupEntry';
import { fileIo } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { common, OpenLinkOptions } from '@kit.AbilityKit';
import { camera, cameraPicker } from '@kit.CameraKit';
import { util } from '@kit.ArkTS';
import { display } from '@kit.ArkUI';
import { showToast } from 'common';
import {
  NoticeAnswerDraft,
  NoticeInputField,
  NoticeInputRequestForm,
  NoticeInputRequestOption,
  NoticeInputRequestQuestion,
  buildNoticeFormPayload,
  coerceNoticeInput,
  isNoticeFormComplete,
  noticeInputFields,
  noticeInputRequestForm
} from '../feature/NoticeInputForm';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { RadiusTokens } from 'common';

interface TimelineEntry {
  item: RemoteTimelineItem;
  blocks: MdBlock[];
  attachments: RemoteTimelineAttachment[];
}

// One rendered row of the session timeline. Tool-like items are condensed
// into weak rows ('tool') or collapsed runs of them ('group'); everything
// else stays a classic entry ('entry').
interface SessionSection {
  kind: string;
  entry: TimelineEntry | null;
  entryKey: string;
  toolRow: TimelineToolRowModel | null;
  group: TimelineToolGroupModel | null;
}

// Result of applying one realtime event: whether the rendered entry list must
// be rebuilt and whether runtime notices need a refetch.
interface EventApplyOutcome {
  itemsChanged: boolean;
  noticesStale: boolean;
}

interface SlashIntent {
  command: string;
  suffix: string;
  raw: string;
  multiline: boolean;
  commandLike: boolean;
}

const BUSY_STATUSES: string[] = ['waiting', 'pending', 'running', 'stopping', 'waiting_approval', 'blocked'];
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
const MAX_PROCESSED_EVENT_IDS = 1000;
const RETAINED_PROCESSED_EVENT_IDS = 500;
const MAX_SUGGESTIONS = 6;
const MAX_PENDING_ATTACHMENTS = 10;
// Capability ids mirrored from Android SessionRuntimeState.kt.
const SESSION_SEND_MESSAGE_CAPABILITY = 'session.send_message';
const SESSION_INTERRUPT_CAPABILITY = 'session.interrupt';
const SESSION_NOTICE_RESPONSE_CAPABILITY = 'session.interaction.approval';
const SESSION_COMMANDS_CAPABILITY = 'session.commands';
const SESSION_COMMAND_EXECUTE_CAPABILITY = 'session.command.execute';
const SESSION_ATTACHMENT_CAPABILITY = 'runtime.attachment';
// Realtime events are aggregated into short batches before being applied so a
// burst of events triggers a single UI refresh (Android batches too).
const EVENT_BATCH_WINDOW_MS = 100;
const MAX_PENDING_REALTIME_EVENTS = 128;

function isBusyStatus(status: string): boolean {
  return BUSY_STATUSES.indexOf(status) >= 0;
}

function isCommandLikeToken(token: string): boolean {
  return /^[a-z0-9][a-z0-9_:.\\-]*$/.test(token);
}

function parseSlashIntent(raw: string): SlashIntent | null {
  let trimmed = raw;
  let lead = 0;
  while (lead < trimmed.length && (trimmed.charAt(lead) === ' ' || trimmed.charAt(lead) === '\t')) {
    lead++;
  }
  trimmed = trimmed.substring(lead);
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const body = trimmed.substring(1);
  let tokenEnd = 0;
  while (tokenEnd < body.length && body.charAt(tokenEnd) !== ' ' && body.charAt(tokenEnd) !== '\t' &&
    body.charAt(tokenEnd) !== '\n' && body.charAt(tokenEnd) !== '\r') {
    tokenEnd++;
  }
  const token = body.substring(0, tokenEnd);
  const intent: SlashIntent = {
    command: token.toLowerCase(),
    suffix: body.substring(tokenEnd),
    raw: raw,
    multiline: raw.indexOf('\n') >= 0 || raw.indexOf('\r') >= 0,
    commandLike: token.length === 0 || isCommandLikeToken(token)
  };
  return intent;
}

function sortItems(items: RemoteTimelineItem[]): RemoteTimelineItem[] {
  const sorted = items.slice(0);
  sorted.sort((left: RemoteTimelineItem, right: RemoteTimelineItem): number => {
    if (left.orderSeq !== right.orderSeq) {
      return left.orderSeq - right.orderSeq;
    }
    if (left.updatedSeq !== right.updatedSeq) {
      return left.updatedSeq - right.updatedSeq;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  return sorted;
}

function shouldReplaceItem(current: RemoteTimelineItem, incoming: RemoteTimelineItem): boolean {
  if (incoming.revision !== current.revision) {
    return incoming.revision > current.revision;
  }
  return incoming.updatedSeq >= current.updatedSeq;
}

function isRenderableItem(item: RemoteTimelineItem): boolean {
  if (item.type === 'message') {
    if (item.text.trim().length > 0) {
      return true;
    }
    return item.attachments.length > 0;
  }
  // Non-message items render as weak tool rows whenever they carry any
  // human-visible payload: text, a command, output or file changes.
  if (item.text.length > 0) {
    return true;
  }
  if (item.command !== null && item.command.length > 0) {
    return true;
  }
  if (item.output !== null && item.output.length > 0) {
    return true;
  }
  return item.changes.length > 0;
}

function eventCursorSequenceOrNull(cursor: string): number | null {
  const withoutPrefix = cursor.startsWith('seq:') ? cursor.substring(4) : cursor;
  if (withoutPrefix.length === 0) {
    return null;
  }
  const parsed = Number(withoutPrefix);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function eventCursorSequence(cursor: string): number {
  return eventCursorSequenceOrNull(cursor) ?? 0;
}

function laterEventCursor(current: string, incoming: string): string {
  const currentSequence = eventCursorSequence(current);
  const incomingSequence = eventCursorSequenceOrNull(incoming);
  if (incomingSequence === null) {
    return current;
  }
  return incomingSequence >= currentSequence ? incoming : current;
}

// Mirrors Android RealtimeRetry.reconnectDelayMillis: exponential backoff with
// a 30s cap and ±25% jitter, no retry limit.
function reconnectDelayMs(attempt: number): number {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  const exponent = safeAttempt > 5 ? 5 : safeAttempt;
  const base = Math.min(RETRY_BASE_DELAY_MS * (1 << exponent), RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(base * 0.25 * Math.random());
  return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
}

@Component
export struct SessionDetailPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State errorMessage: string = '';
  @State title: string = 'Session';
  @State runtimeLabel: string = '';
  @State statusLabel: string = 'idle';
  @State sections: SessionSection[] = [];
  @State notices: RemoteRuntimeNotice[] = [];
  @State composerInput: string = '';
  @State commandSuggestions: RemoteRuntimeCommand[] = [];
  @State attachmentPanelOpen: boolean = false;
  @State attachmentUrlMode: boolean = false;
  @State attachmentUrlInput: string = '';
  @State uploadingAttachment: boolean = false;
  @State pickingLocalFile: boolean = false;
  @State savingAttachmentId: string = '';
  @State pendingAttachments: RemoteUploadedAttachment[] = [];
  @State sending: boolean = false;
  @State interrupting: boolean = false;
  @State executingCommand: boolean = false;
  @State respondingNoticeId: string = '';
  @State noticeFieldDrafts: Map<string, Map<string, string>> = new Map();
  @State noticeAnswerDrafts: Map<string, Map<string, NoticeAnswerDraft>> = new Map();
  @State noticeValidationErrors: Map<string, string> = new Map();
  @State noticeSelectedAction: Map<string, string> = new Map();
  @State realtimeConnected: boolean = false;
  @State hasMoreHistory: boolean = false;
  @State loadingHistory: boolean = false;
  @State canInterrupt: boolean = false;
  @State capabilities: RemoteRuntimeCapabilitySet | null = null;
  @State takeoverOn: boolean = false;
  @State takeoverBusy: boolean = false;
  @State attachmentPreviewOpen: boolean = false;
  @State attachmentPreviewAttachments: RemoteTimelineAttachment[] = [];
  @State attachmentPreviewIndex: number = 0;
  @State sharing: boolean = false;
  @State shareBusy: boolean = false;
  private sessionId: string = '';
  private session: RemoteSession | null = null;
  private items: RemoteTimelineItem[] = [];
  private commands: RemoteRuntimeCommand[] = [];
  private eventCursor: string = '';
  private timelineEventCursor: string = 'seq:0';
  private processedEventIds: string[] = [];
  private processedEventIdSet: Set<string> = new Set();
  private pendingRealtimeEvents: RemoteSessionEventEnvelope[] = [];
  private realtimeBatchTimer: number = -1;
  private pageActive: boolean = false;
  private realtimeRetries: number = 0;
  private retryTimer: number = -1;
  private optCounter: number = 0;
  private navPathStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private initialBottomScrollDone: boolean = false;
  private socket: RealtimeWebSocket = new RealtimeWebSocket();
  private networkMonitor: NetworkMonitor = new NetworkMonitor();
  private draftStore: ComposerDraftStore = ComposerDraftStore.getInstance();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private sessionsApi: SessionsApi = new SessionsApi(this.client);
  private realtimeApi: RealtimeApi = new RealtimeApi(this.client);
  private optimisticStore: OptimisticMessageStore = OptimisticMessageStore.getInstance();
  private pendingTakeoverValue: boolean = false;
  private readOnlyComposerTapCount: number = 0;
  // Absolute width caps (vp) for message bubbles and their content. Percentages
  // inside constraintSize pollute descendant percentage resolution, so bubble
  // content is capped with absolute vp values computed from the display width.
  private windowWidthVp: number = 0;
  private userBubbleMaxVp: number = 0;
  private userContentMaxVp: number = 0;
  private assistantBubbleMaxVp: number = 0;
  private assistantContentMaxVp: number = 0;
  private confirmTakeoverDialog: CustomDialogController = new CustomDialogController({
    builder: ConfirmDialog({
      title: this.takeoverDialogTitle(),
      message: this.takeoverDialogMessage(),
      confirmText: this.takeoverDialogConfirmLabel(),
      cancelText: $r('app.string.profile_cancel'),
      confirmIsDanger: false,
      onConfirm: (): void => {
        this.confirmTakeoverDialog.close();
        this.setTakeover(this.pendingTakeoverValue);
      },
      onCancel: (): void => {
        this.confirmTakeoverDialog.close();
      }
    }),
    autoCancel: true,
    alignment: DialogAlignment.Center
  });
  private confirmDeviceOfflineDialog: CustomDialogController = new CustomDialogController({
    builder: ConfirmDialog({
      title: $r('app.string.session_device_offline_title'),
      message: $r('app.string.session_device_offline_body'),
      confirmText: $r('app.string.common_ok'),
      showCancel: false,
      onConfirm: (): void => {
        this.confirmDeviceOfflineDialog.close();
      },
      onCancel: (): void => {
        this.confirmDeviceOfflineDialog.close();
      }
    }),
    autoCancel: true,
    alignment: DialogAlignment.Center
  });

  aboutToAppear(): void {
    const displayInfo = display.getDefaultDisplaySync();
    const density = displayInfo.densityPixels > 0 ? displayInfo.densityPixels : 3.5;
    this.windowWidthVp = displayInfo.width / density;
    // List content = window - 40vp side padding. Android caps the user bubble
    // at 78% of the list content width and lets assistant markdown fill it.
    const listContentVp = this.windowWidthVp - 40;
    this.userBubbleMaxVp = Math.floor(listContentVp * 0.78);
    this.userContentMaxVp = this.userBubbleMaxVp - 34;
    this.assistantBubbleMaxVp = Math.floor(listContentVp);
    this.assistantContentMaxVp = this.assistantBubbleMaxVp - 8;
    // Reconnect the realtime socket the moment connectivity returns instead of
    // waiting out the current exponential-backoff delay.
    this.networkMonitor.start({
      onNetworkAvailable: (): void => {
        this.onNetworkRestored();
      }
    });
  }

  aboutToDisappear(): void {
    this.pageActive = false;
    this.networkMonitor.stop();
    if (this.retryTimer >= 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
    if (this.realtimeBatchTimer >= 0) {
      clearTimeout(this.realtimeBatchTimer);
      this.realtimeBatchTimer = -1;
    }
    this.pendingRealtimeEvents = [];
    this.socket.destroy();
  }

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private clientId(): string {
    this.optCounter++;
    return `hmos_${Date.now().toString(36)}_${this.optCounter}`;
  }

  private localText(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  private sessionCwd(): string {
    const session = this.session;
    if (session !== null && session.cwd !== null) {
      return session.cwd;
    }
    return '';
  }

  private toolStrings(): TimelineToolStrings {
    const strings: TimelineToolStrings = {
      ran: this.localText($r('app.string.session_tool_ran')),
      commandFallback: this.localText($r('app.string.session_tool_command_fallback')),
      createdFile: this.localText($r('app.string.session_tool_created_file')),
      changedFile: this.localText($r('app.string.session_tool_changed_file')),
      createdFiles: this.localText($r('app.string.session_tool_created_files')),
      changedFiles: this.localText($r('app.string.session_tool_changed_files')),
      searched: this.localText($r('app.string.session_tool_searched')),
      webFallback: this.localText($r('app.string.session_tool_web_fallback')),
      reasoning: this.localText($r('app.string.session_tool_reasoning')),
      groupReasoning: this.localText($r('app.string.session_tool_group_reasoning')),
      groupTools: this.localText($r('app.string.session_tool_group_tools')),
      groupItems: this.localText($r('app.string.session_tool_group_items'))
    };
    return strings;
  }

  private entrySectionOf(item: RemoteTimelineItem): SessionSection {
    const entry: TimelineEntry = {
      item: item,
      blocks: parseMarkdownBlocks(item.text),
      attachments: item.attachments
    };
    const section: SessionSection = {
      kind: 'entry',
      entry: entry,
      entryKey: `${item.id}_${item.revision}_${item.updatedSeq}`,
      toolRow: null,
      group: null
    };
    return section;
  }

  // Flushes a run of consecutive tool-like rows: two or more collapse into a
  // group section, a lone row becomes a single weak tool section.
  private flushToolRows(sections: SessionSection[], rows: TimelineToolRowModel[],
    strings: TimelineToolStrings): void {
    if (rows.length === 0) {
      return;
    }
    if (rows.length >= 2) {
      const group = timelineToolGroupModelOf(rows, strings);
      const section: SessionSection = {
        kind: 'group',
        entry: null,
        entryKey: group.groupKey,
        toolRow: null,
        group: group
      };
      sections.push(section);
      return;
    }
    for (const row of rows) {
      const section: SessionSection = {
        kind: 'tool',
        entry: null,
        entryKey: row.rowKey,
        toolRow: row,
        group: null
      };
      sections.push(section);
    }
  }

  private rebuildEntries(): void {
    const sections: SessionSection[] = [];
    const strings = this.toolStrings();
    const cwdRaw = this.sessionCwd();
    const cwd = cwdRaw.length > 0 ? cwdRaw : null;
    let pendingRows: TimelineToolRowModel[] = [];
    for (const item of this.items) {
      if (!isRenderableItem(item)) {
        continue;
      }
      if (isTimelineToolRunItem(item)) {
        pendingRows.push(timelineToolRowModelOf(item, cwd, strings));
        continue;
      }
      this.flushToolRows(sections, pendingRows, strings);
      pendingRows = [];
      sections.push(this.entrySectionOf(item));
    }
    this.flushToolRows(sections, pendingRows, strings);
    this.sections = sections;
  }

  private syncSessionMeta(session: RemoteSession): void {
    this.session = session;
    this.takeoverOn = session.takeover;
    const title = session.title === null || session.title.length === 0 ? 'Session' : session.title;
    this.title = title;
    this.runtimeLabel = session.runtimeName;
    this.statusLabel = session.status;
    this.canInterrupt = isBusyStatus(session.status);
  }

  private syncStatus(status: string): void {
    this.statusLabel = status;
    this.canInterrupt = isBusyStatus(status);
  }

  // Capability-driven gating (Android parity): a missing capability entry
  // disables the feature, but while capabilities are not loaded at all
  // (null) the UI must not be gated.
  private capabilityAllowed(capabilityId: string): boolean {
    if (this.capabilities === null) {
      return true;
    }
    return hasCapability(this.capabilities, capabilityId);
  }

  // Android parity (sessionComposerEnabled): composer input requires the
  // session to be in takeover mode AND fresh capability facts; a missing
  // capability entry disables the feature. Other read-only surfaces keep the
  // null-tolerant behavior of capabilityAllowed() above.
  private sendInputAllowed(): boolean {
    if (!this.takeoverOn || this.capabilities === null) {
      return false;
    }
    return hasCapability(this.capabilities, SESSION_SEND_MESSAGE_CAPABILITY) ||
      hasCapability(this.capabilities, SESSION_COMMANDS_CAPABILITY) ||
      hasCapability(this.capabilities, SESSION_COMMAND_EXECUTE_CAPABILITY);
  }

  private commandsAllowed(): boolean {
    return this.capabilityAllowed(SESSION_COMMANDS_CAPABILITY) ||
      this.capabilityAllowed(SESSION_COMMAND_EXECUTE_CAPABILITY);
  }

  private mergeItems(incoming: RemoteTimelineItem[], rebuild: boolean = true): void {
    if (incoming.length === 0) {
      return;
    }
    const map: Map<string, RemoteTimelineItem> = new Map();
    for (const existing of this.items) {
      map.set(existing.id, existing);
    }
    for (const item of incoming) {
      const current = map.get(item.id);
      if (current === undefined || shouldReplaceItem(current, item)) {
        map.set(item.id, item);
      }
      if (item.clientMessageId !== null) {
        for (const existing of map.keys()) {
          if (existing.startsWith(OPTIMISTIC_PREFIX)) {
            const optimistic = map.get(existing);
            if (optimistic !== undefined && optimistic.clientMessageId === item.clientMessageId) {
              map.delete(existing);
            }
          }
        }
      }
    }
    const merged: RemoteTimelineItem[] = [];
    map.forEach((value: RemoteTimelineItem) => {
      merged.push(value);
    });
    this.items = sortItems(merged);
    this.syncOptimisticStore();
    if (rebuild) {
      this.rebuildEntries();
    }
  }

  private replaceItems(items: RemoteTimelineItem[], rebuild: boolean = true): void {
    // Preserve in-flight optimistic messages across a full snapshot replace:
    // re-attach those whose clientMessageId is not confirmed by the new list.
    const pendingOptimistic: RemoteTimelineItem[] = [];
    for (const item of this.items) {
      if (item.id.startsWith(OPTIMISTIC_PREFIX)) {
        pendingOptimistic.push(item);
      }
    }
    const confirmedClientMessageIds: Set<string> = new Set();
    for (const item of items) {
      if (item.clientMessageId !== null) {
        confirmedClientMessageIds.add(item.clientMessageId);
      }
    }
    const merged: RemoteTimelineItem[] = items.slice(0);
    for (const item of pendingOptimistic) {
      if (item.clientMessageId !== null && confirmedClientMessageIds.has(item.clientMessageId)) {
        continue;
      }
      merged.push(item);
    }
    this.items = sortItems(merged);
    this.syncOptimisticStore();
    if (rebuild) {
      this.rebuildEntries();
    }
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const snapshot = await this.sessionsApi.getSessionSnapshot(this.serverUrl(), this.token(),
        this.sessionId, 100);
      this.syncSessionMeta(snapshot.session);
      this.replaceItems(snapshot.timelineItems);
      this.eventCursor = snapshot.eventCursor;
      this.timelineEventCursor = snapshot.eventCursor;
      this.hasMoreHistory = snapshot.timelineHasMore;
      this.errorMessage = '';
      this.refreshNotices();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loading = false;
  }

  private async loadRuntimeState(): Promise<void> {
    try {
      const response = await this.sessionsApi.getSessionRuntimeState(this.serverUrl(), this.token(),
        this.sessionId);
      this.syncStatus(response.state.status);
      try {
        this.capabilities = await this.sessionsApi.getSessionRuntimeCapabilities(this.serverUrl(),
          this.token(), this.sessionId);
        this.takeoverOn = this.session !== null && this.session.takeover;
      } catch (error) {
        this.capabilities = null;
      }
    } catch (error) {
      return;
    }
  }

  private takeoverDialogTitle(): ResourceStr {
    return this.pendingTakeoverValue ? $r('app.string.session_enable_takeover_title')
      : $r('app.string.session_disable_takeover_title');
  }

  private takeoverDialogConfirmLabel(): ResourceStr {
    return this.pendingTakeoverValue ? $r('app.string.common_enable')
      : $r('app.string.common_disable');
  }

  private takeoverDialogMessage(): ResourceStr {
    const agentLabel = this.session !== null && this.session.runtimeName.length > 0
      ? this.session.runtimeName : 'Agent';
    if (this.session !== null && this.session.runtimeType === 'dsh') {
      return this.pendingTakeoverValue ? $r('app.string.session_enable_takeover_dsh_body')
        : $r('app.string.session_disable_takeover_dsh_body');
    }
    return this.pendingTakeoverValue ? $r('app.string.session_enable_takeover_body', agentLabel)
      : $r('app.string.session_disable_takeover_body', agentLabel);
  }

  private handleReadOnlyComposerClick(): void {
    if (this.sendInputAllowed() || this.takeoverBusy) {
      return;
    }
    this.readOnlyComposerTapCount += 1;
    if (this.readOnlyComposerTapCount >= 2) {
      this.readOnlyComposerTapCount = 0;
      if (this.session === null || this.session.connectorStatus !== 'online') {
        this.confirmDeviceOfflineDialog.open();
      } else if (!this.takeoverOn) {
        this.requestTakeoverChange(true);
      }
    }
  }

  private requestTakeoverChange(desired: boolean): void {
    if (this.takeoverBusy) {
      return;
    }
    this.pendingTakeoverValue = desired;
    this.confirmTakeoverDialog.open();
  }

  private async setTakeover(value: boolean): Promise<void> {
    if (this.takeoverBusy) {
      return;
    }
    this.takeoverBusy = true;
    this.takeoverOn = value;
    try {
      const session = value
        ? await this.sessionsApi.enableTakeover(this.serverUrl(), this.token(), this.sessionId)
        : await this.sessionsApi.disableTakeover(this.serverUrl(), this.token(), this.sessionId);
      this.syncSessionMeta(session);
      this.takeoverOn = session.takeover;
      this.loadRuntimeState();
      showToast(value ? $r('app.string.session_takeover_on_toast')
        : $r('app.string.session_takeover_off_toast'));
    } catch (error) {
      this.takeoverOn = !value;
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.takeoverBusy = false;
  }

  private async shareSession(): Promise<void> {
    if (this.shareBusy) {
      return;
    }
    this.shareBusy = true;
    try {
      const response = await this.sessionsApi.createSessionShare(this.serverUrl(), this.token(),
        this.sessionId, 'session', []);
      const url = response.shareUrl;
      if (url.length > 0) {
        const options: OpenLinkOptions = { appLinkingOnly: false };
        const context = getContext(this) as common.UIAbilityContext;
        context.openLink(url, options).catch(() => {
          showToast('Could not open share link.');
        });
      } else {
        showToast('Could not create share link.');
      }
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.shareBusy = false;
  }

  private async loadRuntimeCommands(): Promise<void> {
    try {
      const list = await this.sessionsApi.listRuntimeCommands(this.serverUrl(), this.token(),
        this.sessionId);
      const enabled: RemoteRuntimeCommand[] = [];
      for (const command of list.commands) {
        if (command.enabled) {
          enabled.push(command);
        }
      }
      this.commands = enabled;
    } catch (error) {
      this.commands = [];
    }
  }

  private async loadHistory(): Promise<void> {
    if (this.items.length === 0 || this.loadingHistory) {
      return;
    }
    let beforeOrderSeq = this.items[0].orderSeq;
    for (const item of this.items) {
      if (item.orderSeq < beforeOrderSeq) {
        beforeOrderSeq = item.orderSeq;
      }
    }
    this.loadingHistory = true;
    try {
      const page = await this.sessionsApi.getSessionTimelineHistory(this.serverUrl(), this.token(),
        this.sessionId, beforeOrderSeq, 50);
      this.mergeItems(page.items);
      this.hasMoreHistory = page.hasMore;
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.loadingHistory = false;
  }

  private async refreshNotices(): Promise<void> {
    try {
      const list = await this.sessionsApi.listRuntimeNotices(this.serverUrl(), this.token(),
        this.sessionId);
      const open: RemoteRuntimeNotice[] = [];
      for (const notice of list.notices) {
        if (notice.status === 'open' || notice.status === 'responding') {
          open.push(notice);
        }
      }
      this.notices = open;
    } catch (error) {
      return;
    }
  }

  private async respondNotice(notice: RemoteRuntimeNotice, actionId: string,
    input: Record<string, Object> | null): Promise<void> {
    this.respondingNoticeId = notice.noticeId;
    this.noticeValidationErrors.delete(notice.noticeId);
    try {
      const rpc = await this.sessionsApi.respondToRuntimeNotice(this.serverUrl(), this.token(),
        this.sessionId, notice.noticeId, actionId, input);
      if (!rpc.ok) {
        this.errorMessage = rpc.errorMessage === null ? 'Could not respond to the request.' : rpc.errorMessage;
      }
      await this.refreshNotices();
      await this.loadRuntimeState();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.respondingNoticeId = '';
  }

  private noticeInputFormOf(notice: RemoteRuntimeNotice): NoticeInputRequestForm | null {
    return noticeInputRequestForm(notice);
  }

  private noticeSchemaFieldsOf(notice: RemoteRuntimeNotice, actionId: string): NoticeInputField[] {
    for (const action of notice.actions) {
      if (action.actionId === actionId) {
        return noticeInputFields(action);
      }
    }
    return [];
  }

  private noticeFieldDraft(noticeId: string, key: string): string {
    const inner = this.noticeFieldDrafts.get(noticeId);
    if (inner === undefined) {
      return '';
    }
    const value = inner.get(key);
    return value === undefined ? '' : value;
  }

  private setNoticeFieldDraft(noticeId: string, key: string, value: string): void {
    const draft = this.noticeFieldDrafts;
    const current: Map<string, string> | undefined = draft.get(noticeId);
    if (current === undefined) {
      const next: Map<string, string> = new Map();
      next.set(key, value);
      draft.set(noticeId, next);
      return;
    }
    current.set(key, value);
  }

  private toggleNoticeOption(noticeId: string, questionId: string, optionId: string,
    multiple: boolean): void {
    const outer = this.noticeAnswerDrafts;
    let answers = outer.get(noticeId);
    if (answers === undefined) {
      answers = new Map<string, NoticeAnswerDraft>();
      outer.set(noticeId, answers);
    }
    let draft = answers.get(questionId);
    if (draft === undefined) {
      const newDraft: NoticeAnswerDraft = { optionIds: [], customText: '', useCustom: false };
      draft = newDraft;
      answers.set(questionId, draft);
    }
    const index = draft.optionIds.indexOf(optionId);
    if (index >= 0) {
      draft.optionIds.splice(index, 1);
      draft.useCustom = false;
      draft.customText = '';
    } else if (multiple) {
      draft.optionIds.push(optionId);
    } else {
      draft.optionIds = [optionId];
    }
  }

  private setNoticeCustomText(noticeId: string, questionId: string, text: string): void {
    const outer = this.noticeAnswerDrafts;
    let answers = outer.get(noticeId);
    if (answers === undefined) {
      answers = new Map<string, NoticeAnswerDraft>();
      outer.set(noticeId, answers);
    }
    let draft = answers.get(questionId);
    if (draft === undefined) {
      const newDraft: NoticeAnswerDraft = { optionIds: [], customText: '', useCustom: false };
      draft = newDraft;
      answers.set(questionId, draft);
    }
    draft.customText = text;
    draft.useCustom = text.trim().length > 0;
  }

  private isQuestionDrafted(noticeId: string, questionId: string): boolean {
    const answers = this.noticeAnswerDrafts.get(noticeId);
    if (answers === undefined) {
      return false;
    }
    const draft = answers.get(questionId);
    if (draft === undefined) {
      return false;
    }
    return draft.optionIds.length > 0 || (draft.useCustom && draft.customText.trim().length > 0);
  }

  private noticeSelectedActionId(noticeId: string): string {
    const map = this.noticeSelectedAction;
    const value = map.get(noticeId);
    return value !== undefined ? value : '';
  }

  private setNoticeSelectedAction(noticeId: string, actionId: string): void {
    this.noticeSelectedAction.set(noticeId, actionId);
  }

  // Build the input payload for a notice action: schema-driven text fields, or
  // the uiSchema question form when the notice is an input_request.
  private buildNoticeInput(notice: RemoteRuntimeNotice, actionId: string): Record<string, Object> | null {
    const form = this.noticeInputFormOf(notice);
    if (form !== null && form.action.actionId === actionId) {
      const drafts = this.noticeAnswerDrafts.get(notice.noticeId);
      if (drafts === undefined) {
        return null;
      }
      if (!isNoticeFormComplete(form, drafts)) {
        return null;
      }
      return buildNoticeFormPayload(form, drafts);
    }
    const fields = this.noticeSchemaFieldsOf(notice, actionId);
    if (fields.length === 0) {
      return null;
    }
    const rawValues = new Map<string, string>();
    for (const field of fields) {
      rawValues.set(field.key, this.noticeFieldDraft(notice.noticeId, field.key));
    }
    try {
      const action = this.findNoticeAction(notice, actionId);
      if (action === null) {
        return null;
      }
      return coerceNoticeInput(action, rawValues);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid input value.';
      this.noticeValidationErrors.set(notice.noticeId, message);
      throw new Error(message);
    }
  }

  private findNoticeAction(notice: RemoteRuntimeNotice, actionId: string): RemoteNoticeAction | null {
    for (const action of notice.actions) {
      if (action.actionId === actionId) {
        return action;
      }
    }
    return null;
  }

  private canSubmitNoticeAction(notice: RemoteRuntimeNotice, actionId: string): boolean {
    if (this.respondingNoticeId === notice.noticeId) {
      return false;
    }
    const form = this.noticeInputFormOf(notice);
    if (form !== null && form.action.actionId === actionId) {
      const drafts = this.noticeAnswerDrafts.get(notice.noticeId);
      return drafts !== undefined && isNoticeFormComplete(form, drafts);
    }
    const fields = this.noticeSchemaFieldsOf(notice, actionId);
    for (const field of fields) {
      if (field.required && this.noticeFieldDraft(notice.noticeId, field.key).trim().length === 0) {
        return false;
      }
    }
    return true;
  }

  private triggerNoticeAction(notice: RemoteRuntimeNotice, action: RemoteNoticeAction): void {
    if (this.respondingNoticeId === notice.noticeId) {
      return;
    }
    this.setNoticeSelectedAction(notice.noticeId, action.actionId);
    const form = this.noticeInputFormOf(notice);
    try {
      if (form !== null && form.action.actionId === action.actionId) {
        if (!isNoticeFormComplete(form, this.noticeAnswerDrafts.get(notice.noticeId) ?? new Map())) {
          return;
        }
        this.respondNotice(notice, action.actionId, buildNoticeFormPayload(
          form, this.noticeAnswerDrafts.get(notice.noticeId) ?? new Map()));
        return;
      }
      const fields = this.noticeSchemaFieldsOf(notice, action.actionId);
      if (fields.length > 0) {
        const input = this.buildNoticeInput(notice, action.actionId);
        this.respondNotice(notice, action.actionId, input);
        return;
      }
      this.respondNotice(notice, action.actionId, null);
    } catch (error) {
      // Validation failure: the error is shown in the notice card via
      // noticeValidationErrors, set by buildNoticeInput.
    }
  }

  private addOptimisticMessage(content: string, clientMessageId: string,
    attachments: RemoteTimelineAttachment[]): void {
    let maxOrderSeq = 0;
    for (const item of this.items) {
      if (item.orderSeq > maxOrderSeq) {
        maxOrderSeq = item.orderSeq;
      }
    }
    const optimistic: RemoteTimelineItem = {
      id: `${OPTIMISTIC_PREFIX}${clientMessageId}`,
      sessionId: this.sessionId,
      type: 'message',
      status: 'pending',
      role: 'user',
      text: content,
      kind: null,
      command: null,
      output: null,
      toolName: null,
      targetPath: null,
      query: null,
      description: null,
      action: null,
      changes: [],
      clientMessageId: clientMessageId,
      orderSeq: maxOrderSeq + 1,
      revision: 1,
      updatedSeq: 0,
      createdAt: new Date().toISOString(),
      contentHash: '',
      attachments: attachments
    };
    this.mergeItems([optimistic]);
  }

  private removeOptimisticMessage(clientMessageId: string): void {
    const remaining: RemoteTimelineItem[] = [];
    for (const item of this.items) {
      if (item.id.startsWith(OPTIMISTIC_PREFIX) && item.clientMessageId === clientMessageId) {
        continue;
      }
      remaining.push(item);
    }
    this.items = remaining;
    this.syncOptimisticStore();
    this.rebuildEntries();
  }

  // Keeps the cross-page optimistic store in step with this page's item list:
  // after every merge/replace the store retains only the optimistic items that
  // are still awaiting server confirmation (mirrors Android's
  // optimisticStore.replace calls after each state reduction).
  private syncOptimisticStore(): void {
    if (this.sessionId.length === 0) {
      return;
    }
    this.optimisticStore.sync(this.sessionId, this.items);
  }

  // Re-entry restore: pending optimistic messages written by a previous page
  // instance are re-attached before the snapshot loads so the "sending"
  // bubbles survive navigation. loadSnapshot()/replaceItems() then reconciles
  // them: items confirmed by the server (matching clientMessageId) are dropped,
  // the rest stay visible.
  private restoreOptimisticMessages(): void {
    const stored = this.optimisticStore.read(this.sessionId);
    if (stored.length === 0) {
      return;
    }
    this.items = stored;
    this.rebuildEntries();
  }

  private commandMatchesPrefix(command: RemoteRuntimeCommand, prefix: string): boolean {
    if (prefix.length === 0) {
      return true;
    }
    if (command.id.toLowerCase().startsWith(prefix)) {
      return true;
    }
    if (command.title.toLowerCase().startsWith(prefix)) {
      return true;
    }
    for (const alias of command.aliases) {
      if (alias.toLowerCase().startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private updateCommandSuggestions(): void {
    const suggestions: RemoteRuntimeCommand[] = [];
    if (!this.commandsAllowed()) {
      this.commandSuggestions = suggestions;
      return;
    }
    const intent = parseSlashIntent(this.composerInput);
    if (intent !== null && !intent.multiline && intent.commandLike &&
      intent.suffix.length === 0 && this.commands.length > 0) {
      for (const command of this.commands) {
        if (this.commandMatchesPrefix(command, intent.command)) {
          suggestions.push(command);
          if (suggestions.length >= MAX_SUGGESTIONS) {
            break;
          }
        }
      }
    }
    this.commandSuggestions = suggestions;
  }

  private exactCommand(intent: SlashIntent): RemoteRuntimeCommand | null {
    if (intent.command.length === 0) {
      return null;
    }
    for (const command of this.commands) {
      if (command.id.toLowerCase() === intent.command) {
        return command;
      }
      for (const alias of command.aliases) {
        if (alias.toLowerCase() === intent.command) {
          return command;
        }
      }
    }
    return null;
  }

  private commandResultText(result: RemoteCommandResult): string {
    const stateLabel = result.executionState === 'completed' ? 'Completed'
      : (result.executionState === 'accepted' ? 'Accepted' : 'Unknown');
    if (!result.ok) {
      const code = result.code.length > 0 ? ` (${result.code})` : '';
      return `${stateLabel}${code}: ${result.message}`;
    }
    return result.message.length > 0 ? result.message : stateLabel;
  }

  private showCommandResult(command: RemoteRuntimeCommand, result: RemoteCommandResult): void {
    showToast(`/${command.id}: ${this.commandResultText(result)}`);
  }

  private async runCommand(command: RemoteRuntimeCommand, intent: SlashIntent): Promise<void> {
    const suffix = intent.suffix.trim();
    if (suffix.length > 0 && !command.acceptsArgs) {
      this.errorMessage = `/${command.id} does not accept arguments.`;
      return;
    }
    const args: string[] = [];
    if (suffix.length > 0) {
      if (command.argsSchemaType === 'string') {
        const first = intent.suffix.charAt(0);
        const value = first === ' ' || first === '\t' ? intent.suffix.substring(1) : intent.suffix;
        args.push(value);
      } else {
        const words = suffix.split(/\s+/);
        for (const word of words) {
          if (word.length > 0) {
            args.push(word);
          }
        }
      }
    }
    this.executingCommand = true;
    try {
      const result = await this.sessionsApi.executeRuntimeCommand(this.serverUrl(), this.token(),
        this.sessionId, command.id, args, intent.raw);
      this.composerInput = '';
      this.commandSuggestions = [];
      this.draftStore.clear(this.sessionId);
      this.showCommandResult(command, result);
      await this.loadRuntimeState();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.executingCommand = false;
  }

  private restorePendingAttachments(attachments: RemoteTimelineAttachment[]): void {
    const restored: RemoteUploadedAttachment[] = [];
    for (const attachment of attachments) {
      const uploaded: RemoteUploadedAttachment = {
        fileId: attachment.fileId,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sha256: attachment.sha256 === null ? '' : attachment.sha256
      };
      restored.push(uploaded);
    }
    this.pendingAttachments = restored;
  }

  private async sendMessage(): Promise<void> {
    const content = this.composerInput.trim();
    if ((content.length === 0 && this.pendingAttachments.length === 0) ||
      this.sending || this.executingCommand) {
      return;
    }
    if (content.startsWith('/')) {
      const intent = parseSlashIntent(content);
      if (intent !== null && !intent.multiline && intent.commandLike && this.commandsAllowed()) {
        const command = this.exactCommand(intent);
        if (command !== null) {
          await this.runCommand(command, intent);
          return;
        }
      }
    }
    const clientMessageId = this.clientId();
    this.sending = true;
    this.composerInput = '';
    this.commandSuggestions = [];
    const attachmentFileIds: string[] = [];
    const optimisticAttachments: RemoteTimelineAttachment[] = [];
    for (const attachment of this.pendingAttachments) {
      attachmentFileIds.push(attachment.fileId);
      const timelineAttachment: RemoteTimelineAttachment = {
        fileId: attachment.fileId,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sha256: attachment.sha256
      };
      optimisticAttachments.push(timelineAttachment);
    }
    this.pendingAttachments = [];
    this.addOptimisticMessage(content, clientMessageId, optimisticAttachments);
    this.scrollToBottom();
    try {
      const rpc = await this.sessionsApi.sendSessionMessage(this.serverUrl(), this.token(),
        this.sessionId, content, clientMessageId, attachmentFileIds);
      if (!rpc.ok) {
        throw new Error(rpc.errorMessage === null ? 'Could not send the message.' : rpc.errorMessage);
      }
      this.errorMessage = '';
      this.draftStore.clear(this.sessionId);
    } catch (error) {
      this.composerInput = content;
      this.restorePendingAttachments(optimisticAttachments);
      this.saveComposerDraft();
      this.removeOptimisticMessage(clientMessageId);
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.sending = false;
  }

  private async addAttachmentFromUrl(): Promise<void> {
    const url = this.attachmentUrlInput.trim();
    if (this.uploadingAttachment || url.length === 0) {
      return;
    }
    if (this.pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
      this.errorMessage = `A message can carry at most ${MAX_PENDING_ATTACHMENTS} attachments.`;
      return;
    }
    this.uploadingAttachment = true;
    try {
      const response = await this.sessionsApi.uploadExternalFileAsAttachment(this.serverUrl(), this.token(),
        this.sessionId, url);
      if (response.attachments.length === 0) {
        throw new Error('The server did not accept the file.');
      }
      const updated = this.pendingAttachments.slice(0);
      updated.push(response.attachments[0]);
      this.pendingAttachments = updated;
      this.saveComposerDraft();
      this.attachmentUrlInput = '';
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.uploadingAttachment = false;
  }

  private removePendingAttachment(fileId: string): void {
    const remaining: RemoteUploadedAttachment[] = [];
    for (const attachment of this.pendingAttachments) {
      if (attachment.fileId !== fileId) {
        remaining.push(attachment);
      }
    }
    this.pendingAttachments = remaining;
    this.saveComposerDraft();
  }

  /**
   * Picker URIs percent-encode non-ASCII file names (e.g. Chinese names turn
   * into %E6%AC%A2...). Decode for display; fall back to the raw segment if
   * the encoding is malformed.
   */
  private decodePickerFileName(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  private mimeTypeFromName(name: string): string {
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

  /**
   * Read the bytes behind a picker Uri. Picker Uris are directly accessible via
   * fileIo without any runtime media permission, so no extra permission is added.
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

  private async uploadLocalUris(uris: Array<string>): Promise<void> {
    if (this.pickingLocalFile) {
      return;
    }
    if (this.pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
      this.errorMessage = `A message can carry at most ${MAX_PENDING_ATTACHMENTS} attachments.`;
      return;
    }
    this.pickingLocalFile = true;
    try {
      const parts: UploadFilePart[] = [];
      for (const uri of uris) {
        const rawName = uri.substring(uri.lastIndexOf('/') + 1) || 'local-file';
        const fileName = this.decodePickerFileName(rawName);
        const bytes = await this.readUriBytes(uri);
        const part: UploadFilePart = {
          fileName: fileName,
          mediaType: this.mimeTypeFromName(fileName),
          bytes: bytes
        };
        parts.push(part);
      }
      if (parts.length === 0) {
        return;
      }
      const response = await this.sessionsApi.uploadSessionAttachments(this.serverUrl(), this.token(),
        this.sessionId, parts);
      const updated = this.pendingAttachments.slice(0);
      for (const attachment of response.attachments) {
        updated.push(attachment);
      }
      this.pendingAttachments = updated;
      this.saveComposerDraft();
      this.attachmentPanelOpen = false;
      this.errorMessage = '';
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.pickingLocalFile = false;
  }

  private pickLocalFiles(): void {
    const documentPicker = new picker.DocumentViewPicker();
    documentPicker.select().then((uris: Array<string>) => {
      this.uploadLocalUris(uris);
    }).catch(() => {
    });
  }

  private pickLocalImages(): void {
    const photoPicker = new picker.PhotoViewPicker();
    photoPicker.select({ MIMEType: picker.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 10 }).then((result: picker.PhotoSelectResult) => {
      this.uploadLocalUris(result.photoUris);
    }).catch(() => {
    });
  }

  /**
   * Launch the system camera (CameraPicker) to take a photo. CameraPicker
   * needs no camera permission; closing the camera without shooting is
   * silently ignored.
   */
  private capturePhoto(): void {
    const pickerProfile: cameraPicker.PickerProfile = {
      cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
    };
    // On camera-less devices (e.g. emulators) the syscap stub returns
    // undefined instead of a Promise; without the guard the .then below
    // crashes the page ("Cannot read property then of undefined").
    const picked: Promise<cameraPicker.PickerResult> | undefined =
      cameraPicker.pick(getContext(this), [cameraPicker.PickerMediaType.PHOTO], pickerProfile);
    if (picked === undefined) {
      return;
    }
    picked.then((result: cameraPicker.PickerResult) => {
      if (result.resultCode !== 0 || result.resultUri.length === 0) {
        return;
      }
      // The captured photo reuses the exact same upload path as gallery
      // picks, so no upload logic is duplicated here.
      this.uploadLocalUris([result.resultUri]);
    })
      .catch(() => {
        // User closed the camera or no camera is available — stay silent.
      });
  }

  private isSavingAttachment(attachment: RemoteTimelineAttachment): boolean {
    return this.savingAttachmentId === attachment.fileId;
  }

  /**
   * Download a non-image attachment with authentication and let the user pick
   * where to save it via the system save picker (no storage permission
   * needed). Image attachments keep their existing preview behaviour.
   */
  private async saveTimelineAttachment(attachment: RemoteTimelineAttachment): Promise<void> {
    if (this.savingAttachmentId.length > 0) {
      return;
    }
    this.savingAttachmentId = attachment.fileId;
    try {
      const downloaded: RemoteDownloadedAttachment = await this.sessionsApi.downloadSessionAttachment(
        this.serverUrl(), this.token(), this.sessionId, attachment.fileId);
      const bytes = new util.Base64Helper().decodeSync(downloaded.contentBase64);
      if (bytes.byteLength === 0) {
        throw new Error('The attachment did not download completely.');
      }
      const targetUri = await this.pickSaveLocation(attachment.name);
      if (targetUri === null) {
        this.savingAttachmentId = '';
        return;
      }
      const file = await fileIo.open(targetUri, fileIo.OpenMode.READ_WRITE);
      try {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        await fileIo.write(file.fd, buffer);
      } finally {
        await fileIo.close(file.fd);
      }
      showToast($r('app.string.session_attachment_saved'));
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
    this.savingAttachmentId = '';
  }

  /**
   * Open the system save picker so the user chooses where the file is
   * written. Returns null when the user cancels the picker.
   */
  private async pickSaveLocation(fileName: string): Promise<string | null> {
    const saveOptions: picker.DocumentSaveOptions = { newFileNames: [fileName] };
    const savePicker = new picker.DocumentViewPicker();
    try {
      const uris = await savePicker.save(saveOptions);
      if (uris.length === 0) {
        return null;
      }
      return uris[0];
    } catch (error) {
      // The save sheet rejects when the user cancels; treat any picker exit
      // as a cancel and stay silent.
      return null;
    }
  }

  private isDiffBlock(block: MdBlock): boolean {
    if (block.kind !== 'code') {
      return false;
    }
    if (block.language === 'diff') {
      return true;
    }
    const text = block.codeText;
    if (text.length === 0) {
      return false;
    }
    const lines = text.split('\n');
    let checked = 0;
    for (const rawLine of lines) {
      const line = rawLine;
      if (line.length === 0) {
        continue;
      }
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') ||
        line.startsWith('+') || line.startsWith('-') || line.startsWith('diff ')) {
        return true;
      }
      checked++;
      if (checked >= 4) {
        break;
      }
    }
    return false;
  }

  private async interruptRuntime(): Promise<void> {
    if (this.interrupting) {
      return;
    }
    this.interrupting = true;
    try {
      const rpc = await this.sessionsApi.interruptSession(this.serverUrl(), this.token(), this.sessionId);
      if (!rpc.ok) {
        this.errorMessage = rpc.errorMessage === null ? 'Could not interrupt.' : rpc.errorMessage;
      }
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.interrupting = false;
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      this.scroller.scrollEdge(Edge.Bottom);
    }, 120);
  }

  private initialTimelineIndex(): number {
    if (this.sections.length === 0) {
      return 0;
    }
    const headerItems = this.hasMoreHistory ? 1 : 0;
    return headerItems + this.sections.length - 1;
  }

  private rememberProcessedEvent(eventId: string): boolean {
    if (this.processedEventIdSet.has(eventId)) {
      return false;
    }
    this.processedEventIdSet.add(eventId);
    this.processedEventIds.push(eventId);
    if (this.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
      const evicted = this.processedEventIds.splice(0,
        this.processedEventIds.length - RETAINED_PROCESSED_EVENT_IDS);
      for (const id of evicted) {
        this.processedEventIdSet.delete(id);
      }
    }
    return true;
  }

  private applyEvent(envelope: RemoteSessionEventEnvelope): EventApplyOutcome {
    const unchanged: EventApplyOutcome = { itemsChanged: false, noticesStale: false };
    if (envelope.protocolVersion !== '1.0' || envelope.sessionId !== this.sessionId) {
      return unchanged;
    }
    if (!this.rememberProcessedEvent(envelope.eventId)) {
      return unchanged;
    }
    let itemsChanged = false;
    const payload = envelope.payload;
    if (payload.session !== null) {
      this.syncSessionMeta(payload.session);
    }
    if (envelope.type === 'timeline.snapshot') {
      // A snapshot may only clobber the timeline when it is at least as new as
      // what we already hold (mirrors Android's sequence guard).
      const currentTimelineSequence = eventCursorSequence(this.timelineEventCursor);
      if (envelope.sequence >= currentTimelineSequence) {
        this.replaceItems(payload.items, false);
        this.timelineEventCursor = laterEventCursor(this.timelineEventCursor, envelope.cursor);
        itemsChanged = true;
      }
    } else if (payload.items.length > 0) {
      this.mergeItems(payload.items, false);
      this.timelineEventCursor = laterEventCursor(this.timelineEventCursor, envelope.cursor);
      itemsChanged = true;
    } else if (payload.item !== null) {
      this.mergeItems([payload.item], false);
      this.timelineEventCursor = laterEventCursor(this.timelineEventCursor, envelope.cursor);
      itemsChanged = true;
    }
    if (payload.state !== null) {
      this.syncStatus(payload.state.status);
    }
    const noticesStale = envelope.type.indexOf('runtime.notice') === 0;
    const cursor = payload.eventCursor;
    if (cursor !== null && cursor.length > 0) {
      this.eventCursor = cursor;
    } else if (envelope.cursor.length > 0) {
      this.eventCursor = envelope.cursor;
    }
    const outcome: EventApplyOutcome = { itemsChanged: itemsChanged, noticesStale: noticesStale };
    return outcome;
  }

  // Aggregate realtime events for EVENT_BATCH_WINDOW_MS (up to
  // MAX_PENDING_REALTIME_EVENTS) and apply them in one pass so a burst only
  // refreshes the UI once (mirrors Android's event batch window).
  private enqueueRealtimeEvent(envelope: RemoteSessionEventEnvelope): void {
    this.pendingRealtimeEvents.push(envelope);
    if (this.pendingRealtimeEvents.length >= MAX_PENDING_REALTIME_EVENTS) {
      this.flushRealtimeEvents();
      return;
    }
    if (this.realtimeBatchTimer < 0) {
      this.realtimeBatchTimer = setTimeout(() => {
        this.realtimeBatchTimer = -1;
        this.flushRealtimeEvents();
      }, EVENT_BATCH_WINDOW_MS);
    }
  }

  private flushRealtimeEvents(): void {
    if (this.realtimeBatchTimer >= 0) {
      clearTimeout(this.realtimeBatchTimer);
      this.realtimeBatchTimer = -1;
    }
    if (this.pendingRealtimeEvents.length === 0) {
      return;
    }
    const batch = this.pendingRealtimeEvents;
    this.pendingRealtimeEvents = [];
    let itemsChanged = false;
    let noticesStale = false;
    let sessionRefetchRequired = false;
    let runtimeRefetchRequired = false;
    for (const envelope of batch) {
      if (envelope.type === 'session.refetch_required') {
        sessionRefetchRequired = true;
      } else if (envelope.type === 'runtime.refetch_required') {
        runtimeRefetchRequired = true;
      }
      const outcome = this.applyEvent(envelope);
      if (outcome.itemsChanged) {
        itemsChanged = true;
      }
      if (outcome.noticesStale) {
        noticesStale = true;
      }
    }
    if (itemsChanged) {
      this.rebuildEntries();
      this.scrollToBottom();
    }
    if (noticesStale) {
      this.refreshNotices();
    }
    if (sessionRefetchRequired) {
      this.loadSnapshot();
    }
    if (runtimeRefetchRequired) {
      this.loadRuntimeState();
    }
  }

  private async recoverMissedEvents(): Promise<void> {
    if (this.eventCursor.length === 0) {
      return;
    }
    try {
      const recovery = await this.realtimeApi.recoverSessionEvents(this.serverUrl(), this.token(),
        this.sessionId, this.eventCursor);
      let itemsChanged = false;
      let noticesStale = false;
      for (const event of recovery.events) {
        const outcome = this.applyEvent(event);
        if (outcome.itemsChanged) {
          itemsChanged = true;
        }
        if (outcome.noticesStale) {
          noticesStale = true;
        }
      }
      if (itemsChanged) {
        this.rebuildEntries();
        this.scrollToBottom();
      }
      if (noticesStale) {
        this.refreshNotices();
      }
      if (recovery.snapshotRequired) {
        await this.loadSnapshot();
      }
    } catch (error) {
      return;
    }
  }

  private async connectRealtime(): Promise<void> {
    if (!this.pageActive || this.sessionId.length === 0) {
      return;
    }
    try {
      const ticket = await this.realtimeApi.createSessionTicket(this.serverUrl(), this.token(),
        this.clientId(), this.sessionId);
      // The ticket round-trip may outlive the page: never create a socket
      // (and leak its listeners) after aboutToDisappear has run.
      if (!this.pageActive) {
        return;
      }
      const url = this.realtimeApi.sessionWebSocketUrl(this.serverUrl(), this.sessionId, ticket.ticket);
      this.socket.connect(url, this.createSocketListener());
    } catch (error) {
      this.scheduleRealtimeRetry();
    }
  }

  private createSocketListener(): RealtimeSocketListener {
    const listener: RealtimeSocketListener = {
      onOpen: (): void => {
        this.realtimeConnected = true;
        this.realtimeRetries = 0;
        this.recoverMissedEvents();
      },
      onMessage: (text: string): void => {
        const envelope = this.realtimeApi.parseSessionMessage(text);
        if (envelope !== null) {
          this.enqueueRealtimeEvent(envelope);
        }
      },
      onClose: (code: number, reason: string): void => {
        this.realtimeConnected = false;
        this.scheduleRealtimeRetry();
      },
      onError: (message: string): void => {
        this.realtimeConnected = false;
        this.scheduleRealtimeRetry();
      }
    };
    return listener;
  }

  private scheduleRealtimeRetry(): void {
    if (!this.pageActive) {
      return;
    }
    if (this.retryTimer >= 0) {
      return;
    }
    const attempt = this.realtimeRetries;
    this.realtimeRetries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = -1;
      this.connectRealtime();
    }, reconnectDelayMs(attempt));
  }

  /**
   * Connectivity just returned: if the socket is down and a backoff retry is
   * pending, cancel it and reconnect immediately.
   */
  private onNetworkRestored(): void {
    if (!this.pageActive || this.realtimeConnected || this.retryTimer < 0) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = -1;
    this.realtimeRetries = 0;
    this.connectRealtime();
  }

  private saveComposerDraft(): void {
    this.draftStore.save(this.sessionId, this.composerInput, this.pendingAttachments);
  }

  private async restoreComposerDraft(): Promise<void> {
    const draft = await this.draftStore.load(this.sessionId);
    if (!this.pageActive) {
      return;
    }
    this.composerInput = draft.text;
    this.pendingAttachments = draft.attachments;
  }

  private statusColor(): string {
    if (this.statusLabel === 'running' || this.statusLabel === 'pending' || this.statusLabel === 'waiting') {
      return getColors().primaryAction;
    }
    if (this.statusLabel === 'waiting_approval' || this.statusLabel === 'blocked') {
      return getColors().noticeWarning;
    }
    if (this.statusLabel === 'error' || this.statusLabel === 'failed') {
      return getColors().errorText;
    }
    return getColors().noticeSuccess;
  }

  private itemLabelColor(status: string): string {
    if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
      return getColors().errorText;
    }
    if (status === 'running' || status === 'pending') {
      return getColors().primaryAction;
    }
    return getColors().faint;
  }

  private itemRunning(status: string): boolean {
    return status === 'running' || status === 'pending';
  }

  private noticeSeverityColor(severity: string): string {
    if (severity === 'error') {
      return getColors().errorText;
    }
    if (severity === 'warning') {
      return getColors().noticeWarning;
    }
    if (severity === 'success') {
      return getColors().noticeSuccess;
    }
    return getColors().primaryAction;
  }

  private noticeSurfaceColor(severity: string): string {
    if (severity === 'error') {
      return getColors().errorSurface;
    }
    if (severity === 'success') {
      return getColors().successSurface;
    }
    return getColors().warningSurface;
  }

  private noticeBorderColor(severity: string): string {
    if (severity === 'error') {
      return getColors().errorBorder;
    }
    if (severity === 'success') {
      return getColors().successBorder;
    }
    return getColors().warningBorder;
  }

  // Composer palette mirrored from Android SessionComposer.kt (MessageComposer/ComposerActions).
  private composerCardSurface(): string {
    return this.themeIsDark ? getColors().raisedSurface : '#F2FFFFFF';
  }

  private composerCardBorder(): string {
    return this.themeIsDark ? getColors().border : '#EFEDE9';
  }

  private composerInputColor(): string {
    if (!this.sendInputAllowed()) {
      return this.themeIsDark ? '#A1A1AA' : '#8A8984';
    }
    return this.themeIsDark ? '#EDEDEF' : '#252622';
  }

  private composerPlusColor(): string {
    return this.themeIsDark ? '#A1A1AA' : '#2D2E2B';
  }

  private takeoverTrackColor(): string {
    if (this.takeoverOn) {
      return this.themeIsDark ? '#52525B' : '#2F302D';
    }
    return this.themeIsDark ? '#303033' : '#D8D6D1';
  }

  private takeoverKnobColor(): string {
    if (this.themeIsDark || this.takeoverOn) {
      return '#FFFFFF';
    }
    return '#FDFCFB';
  }

  private takeoverLabelColor(): string {
    if (this.takeoverOn) {
      return this.themeIsDark ? '#EDEDEF' : '#2F302D';
    }
    return this.themeIsDark ? '#A1A1AA' : '#3A3935';
  }

  private canSendDraft(): boolean {
    return this.composerInput.trim().length > 0 && this.sendInputAllowed();
  }

  private sendButtonSurface(): string {
    if (this.canSendDraft()) {
      return this.themeIsDark ? '#FAFAFA' : '#2B2B2B';
    }
    return this.themeIsDark ? '#3F3F46' : '#E2E0DC';
  }

  private sendButtonIconColor(): string {
    if (this.canSendDraft()) {
      return this.themeIsDark ? '#09090B' : '#FFFFFF';
    }
    return this.themeIsDark ? '#71717A' : '#A7A5A0';
  }

  private actionStyleColor(style: string): string {
    if (style === 'primary') {
      return getColors().primaryAction;
    }
    if (style === 'danger') {
      return getColors().errorText;
    }
    return getColors().muted;
  }

  private actionStyleBackground(style: string): string {
    if (style === 'primary') {
      return getColors().accentSurface;
    }
    if (style === 'danger') {
      return getColors().errorSurface;
    }
    return getColors().sessionCodeSurface;
  }

  private realtimeDotColor(): string {
    return this.realtimeConnected ? getColors().runtimeRunning : getColors().runtimeInactive;
  }

  private realtimeStatusLabel(): string {
    return this.realtimeConnected ? 'live' : 'offline';
  }

  private historyButtonLabel(): string {
    return this.loadingHistory ? 'Loading…' : 'Load earlier messages';
  }

  private interruptButtonLabel(): string {
    return this.interrupting ? '…' : '■';
  }

  private sendButtonLabel(): string {
    return this.sending ? '…' : '➤';
  }

  private attachmentUploadLabel(): string {
    return this.uploadingAttachment ? '…' : 'Add';
  }

  private localFileButtonLabel(): string {
    return this.pickingLocalFile ? '…' : 'Choose file';
  }

  private localImageButtonLabel(): string {
    return this.pickingLocalFile ? '…' : 'Choose image';
  }

  private cameraButtonLabel(): ResourceStr {
    return this.pickingLocalFile ? '…' : $r('app.string.session_attachment_camera');
  }

  private noticeTypeLabel(notice: RemoteRuntimeNotice): string {
    if (notice.interactionType === null || notice.interactionType.length === 0) {
      return notice.type;
    }
    return notice.interactionType;
  }

  private isImageAttachment(attachment: RemoteTimelineAttachment): boolean {
    return attachment.mediaType.startsWith('image/');
  }

  private openAttachmentPreview(entry: TimelineEntry, attachment: RemoteTimelineAttachment): void {
    const images: RemoteTimelineAttachment[] = [];
    let initialIndex = 0;
    for (const item of entry.attachments) {
      if (!this.isImageAttachment(item)) {
        continue;
      }
      if (item.fileId === attachment.fileId) {
        initialIndex = images.length;
      }
      images.push(item);
    }
    if (images.length === 0) {
      return;
    }
    this.attachmentPreviewAttachments = images;
    this.attachmentPreviewIndex = initialIndex;
    this.attachmentPreviewOpen = true;
  }

  private attachmentSizeLabel(size: number): string {
    if (size >= 1048576) {
      const mb = Math.round(size / 104857.6) / 10;
      return `${mb} MB`;
    }
    if (size >= 1024) {
      const kb = Math.round(size / 102.4) / 10;
      return `${kb} KB`;
    }
    return `${size} B`;
  }

  @Builder
  attachmentView(entry: TimelineEntry, attachment: RemoteTimelineAttachment) {
    if (this.isImageAttachment(attachment)) {
      Column() {
        AttachmentImageView({
          sessionId: this.sessionId,
          fileId: attachment.fileId
        })
      }
      .width('100%')
      .onClick(() => {
        this.openAttachmentPreview(entry, attachment);
      })
    } else {
      Row({ space: 6 }) {
        Text($r('app.string.session_file'))
          .fontSize(9)
          .fontColor(getColors().muted)
          .padding({ left: 4, right: 4, top: 1, bottom: 1 })
          .borderRadius(3)
          .backgroundColor(getColors().subtle)
        Column({ space: 2 }) {
          Text(attachment.name)
            .fontSize(13)
            .fontColor(getColors().ink)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
          Text(this.attachmentSizeLabel(attachment.size))
            .fontSize(11)
            .fontColor(getColors().muted)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.isSavingAttachment(attachment)) {
          LoadingProgress()
            .width(16)
            .height(16)
        } else {
          Text('⇩')
            .fontSize(15)
            .width(28)
            .height(28)
            .borderRadius(14)
            .textAlign(TextAlign.Center)
            .backgroundColor(getColors().secondaryActionSurface)
            .fontColor(getColors().inkSoft)
            .onClick(() => {
              this.saveTimelineAttachment(attachment);
            })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding(8)
      .borderRadius(8)
      .backgroundColor(getColors().subtleSurface)
      .onClick(() => {
        this.saveTimelineAttachment(attachment);
      })
    }
  }

  @Builder
  userContentView(entry: TimelineEntry) {
    Column({ space: 6 }) {
      ForEach(entry.attachments, (attachment: RemoteTimelineAttachment) => {
        this.attachmentView(entry, attachment)
      }, (attachment: RemoteTimelineAttachment) => attachment.fileId)
      if (entry.blocks.length > 0) {
        this.blocksView(entry.blocks, getColors().sessionMessageText, getColors().mdLinkOnPrimary,
          getColors().mdInlineOnSurface, getColors().mdCodeOnSurface, getColors().mdCodePanelText, 16.5,
          this.userContentMaxVp)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .constraintSize({ maxWidth: this.userBubbleMaxVp })
    .padding({ left: 17, right: 17, top: 13, bottom: 13 })
    .borderRadius(22)
    .backgroundColor(getColors().sessionMessageBubble)
  }

  @Builder
  assistantContentView(entry: TimelineEntry) {
    Column({ space: 8 }) {
      ForEach(entry.attachments, (attachment: RemoteTimelineAttachment) => {
        this.attachmentView(entry, attachment)
      }, (attachment: RemoteTimelineAttachment) => attachment.fileId)
      if (entry.blocks.length > 0) {
        this.blocksView(entry.blocks, getColors().sessionMessageText, getColors().mdLinkOnPrimary,
          getColors().mdInlineOnSurface, getColors().mdCodeOnSurface, getColors().mdCodePanelText, 17,
          this.assistantContentMaxVp)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .constraintSize({ maxWidth: this.assistantBubbleMaxVp })
    .padding({ left: 4, right: 4 })
  }

  /**
   * Renders markdown blocks, routing diff code blocks to DiffCodeView while
   * delegating everything else to AgentMarkdownView (which is not modified here).
   */
  @Builder
  blocksView(blocks: MdBlock[], textColor: string, linkColor: string, inlineCodeColor: string,
    codePanelColor: string, codePanelTextColor: string, fontSize: number, contentMaxWidthVp: number) {
    ForEach(blocks, (block: MdBlock, index: number) => {
      if (this.isDiffBlock(block)) {
        DiffCodeView({
          codeText: block.codeText,
          contentMaxWidthVp: contentMaxWidthVp
        })
      } else {
        AgentMarkdownView({
          blocks: [block],
          textColor: textColor,
          linkColor: linkColor,
          inlineCodeColor: inlineCodeColor,
          codePanelColor: codePanelColor,
          codePanelTextColor: codePanelTextColor,
          fontSize: fontSize,
          contentMaxWidthVp: contentMaxWidthVp
        })
      }
    }, (block: MdBlock, index: number) => `${index}_${block.kind}_${block.language}_${block.codeText.length}`)
  }

  @Builder
  entryView(entry: TimelineEntry) {
    if (entry.item.type === 'message') {
      if (entry.item.role === 'user') {
        Row() {
          this.userContentView(entry)
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
        .padding({ top: 2, bottom: 2 })
      } else if (entry.item.role === 'assistant') {
        Row() {
          this.assistantContentView(entry)
        }
        .width('100%')
        .justifyContent(FlexAlign.Start)
        .padding({ top: 2, bottom: 2 })
      } else {
        Text(entry.item.text)
          .fontSize(12)
          .fontColor(getColors().faint)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 4, bottom: 4 })
          .copyOption(CopyOptions.LocalDevice)
      }
    } else {
      if (this.isSystemLikeItem(entry.item.type)) {
        Row({ space: 8 }) {
          SymbolGlyph(this.itemDestructive(entry.item) ? $r('sys.symbol.exclamationmark_circle') : $r('sys.symbol.clock'))
            .fontSize(16)
            .width(16)
            .height(16)
            .fontColor([this.systemItemAccentColor(entry.item)])
          Text(this.systemItemDisplayText(entry.item))
            .fontSize(13)
            .fontWeight(700)
            .fontColor(this.systemItemAccentColor(entry.item))
            .layoutWeight(1)
            .copyOption(CopyOptions.LocalDevice)
          if (this.systemItemShowsPill(entry.item.type)) {
            Text(entry.item.status)
              .fontSize(11)
              .lineHeight(11)
              .fontWeight(700)
              .fontColor(this.itemDestructive(entry.item) ? getColors().errorText : getColors().sessionStatusNeutralText)
              .constraintSize({ minWidth: 40 })
              .height(20)
              .textAlign(TextAlign.Center)
              .borderRadius(10)
              .backgroundColor(this.itemDestructive(entry.item) ? getColors().errorSurface : getColors().sessionStatusNeutralSurface)
              .padding({ left: 8, right: 8 })
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding({ left: 4, right: 4, top: 4, bottom: 4 })
      } else {
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Row({ space: 6 }) {
              Text(entry.item.type)
                .fontSize(10)
                .fontColor(this.itemLabelColor(entry.item.status))
                .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                .borderRadius(4)
                .backgroundColor(getColors().sessionCodeSurface)
              if (this.itemRunning(entry.item.status)) {
                LoadingProgress()
                  .width(12)
                  .height(12)
              }
            }
            Text(entry.item.text)
              .fontSize(13)
              .fontColor(getColors().muted)
              .maxLines(8)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)
        .padding(10)
        .borderRadius(10)
        .backgroundColor(getColors().subtle)
        .border({ width: 1, color: getColors().border })
      }
    }
  }

  private isSystemLikeItem(type: string): boolean {
    return type === 'system' || type === 'marker' || type === 'error' || type === 'diagnostic';
  }

  private itemDestructive(item: RemoteTimelineItem): boolean {
    return item.type === 'error' || item.status === 'failed' || item.status === 'cancelled' ||
      item.status === 'interrupted';
  }

  private systemItemDisplayText(item: RemoteTimelineItem): string {
    return item.text.length > 0 ? item.text : item.type;
  }

  private systemItemAccentColor(item: RemoteTimelineItem): string {
    return this.itemDestructive(item) ? getColors().errorIcon : getColors().muted;
  }

  private systemItemShowsPill(type: string): boolean {
    return type === 'marker' || type === 'error' || type === 'system';
  }

  private noticeSchemaFieldsFor(notice: RemoteRuntimeNotice, actionId: string): NoticeInputField[] {
    return this.noticeSchemaFieldsOf(notice, actionId);
  }

  private noticeFormFor(notice: RemoteRuntimeNotice): NoticeInputRequestForm | null {
    return this.noticeInputFormOf(notice);
  }

  private noticeSchemaFieldsSelectedAction(notice: RemoteRuntimeNotice): string {
    const selected = this.noticeSelectedActionId(notice.noticeId);
    return this.noticeFormFor(notice) === null && selected.length > 0 ? selected : '';
  }

  private questionDraft(noticeId: string, questionId: string): NoticeAnswerDraft {
    const answers = this.noticeAnswerDrafts.get(noticeId);
    if (answers !== undefined) {
      const draft = answers.get(questionId);
      if (draft !== undefined) {
        return draft;
      }
    }
    const empty: NoticeAnswerDraft = { optionIds: [], customText: '', useCustom: false };
    return empty;
  }

  private optionSelected(noticeId: string, questionId: string, optionId: string): boolean {
    const draft = this.questionDraft(noticeId, questionId);
    return draft.optionIds.indexOf(optionId) >= 0;
  }

  private formQuestionLabel(question: NoticeInputRequestQuestion): string {
    return question.header.length > 0 ? question.header : question.prompt;
  }

  @Builder
  noticeInputFormBuilder(notice: RemoteRuntimeNotice) {
    if (this.noticeFormFor(notice) !== null) {
      this.noticeFormQuestions(notice, this.noticeFormFor(notice) as NoticeInputRequestForm)
    }
  }

  @Builder
  noticeFormQuestions(notice: RemoteRuntimeNotice, form: NoticeInputRequestForm) {
    Column({ space: 12 }) {
      ForEach(form.questions, (question: NoticeInputRequestQuestion) => {
        Column({ space: 6 }) {
          Text(this.formQuestionLabel(question))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor(getColors().inkSoft)
            .width('100%')
          if (question.options.length > 0) {
            this.noticeQuestionOptions(notice, question)
          }
          if (question.allowCustom) {
            TextInput({
              placeholder: $r('app.string.session_own_answer_placeholder'),
              text: this.questionDraft(notice.noticeId, question.id).customText
            })
              .fontSize(13)
              .height(38)
              .width('100%')
              .backgroundColor(getColors().matchedAccountSurface)
              .borderRadius(8)
              .onChange((value: string) => {
                this.setNoticeCustomText(notice.noticeId, question.id, value);
              })
          }
        }
        .width('100%')
      }, (question: NoticeInputRequestQuestion) => question.id)
    }
    .width('100%')
    .padding({ left: 2, right: 2, top: 4 })
  }

  @Builder
  noticeQuestionOptions(notice: RemoteRuntimeNotice, question: NoticeInputRequestQuestion) {
    ForEach(question.options, (option: NoticeInputRequestOption) => {
      Row({ space: 8 }) {
        Radio({ value: option.id, group: notice.noticeId + ':' + question.id })
          .checked(this.optionSelected(notice.noticeId, question.id, option.id))
          .onChange((isChecked: boolean) => {
            this.toggleNoticeOption(notice.noticeId, question.id, option.id, question.multiple);
          })
        Column({ space: 2 }) {
          Text(option.label)
            .fontSize(13)
            .fontColor(getColors().ink)
          if (option.description.length > 0) {
            Text(option.description)
              .fontSize(12)
              .fontColor(getColors().muted)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
    }, (option: NoticeInputRequestOption) => option.id)
  }

  @Builder
  noticeSchemaFieldsSelected(notice: RemoteRuntimeNotice) {
    if (this.noticeSchemaFieldsSelectedAction(notice).length > 0) {
      this.noticeSchemaFieldsBuilder(notice, this.noticeSchemaFieldsSelectedAction(notice))
    }
  }

  @Builder
  noticeSchemaFieldsBuilder(notice: RemoteRuntimeNotice, actionId: string) {
    if (this.noticeSchemaFieldsFor(notice, actionId).length > 0) {
      this.noticeSchemaFieldRows(notice, actionId, this.noticeSchemaFieldsFor(notice, actionId))
    }
  }

  @Builder
  noticeSchemaFieldRows(notice: RemoteRuntimeNotice, actionId: string, fields: NoticeInputField[]) {
    Column({ space: 8 }) {
      ForEach(fields, (field: NoticeInputField) => {
        Column({ space: 4 }) {
          Text(field.label)
            .fontSize(12)
            .fontColor(getColors().muted)
          TextInput({
            placeholder: field.label,
            text: this.noticeFieldDraft(notice.noticeId, field.key)
          })
            .fontSize(13)
            .height(38)
            .width('100%')
            .backgroundColor(getColors().matchedAccountSurface)
            .borderRadius(8)
            .type(field.type === 'integer' || field.type === 'number' ? InputType.Number : InputType.Normal)
            .onChange((value: string) => {
              this.setNoticeFieldDraft(notice.noticeId, field.key, value);
            })
        }
        .width('100%')
      }, (field: NoticeInputField) => field.key)
    }
    .width('100%')
    .padding({ left: 2, right: 2, top: 4 })
  }

  @Builder
  noticeView(notice: RemoteRuntimeNotice) {
    Column({ space: 11 }) {
      Row({ space: 6 }) {
        Circle()
          .width(8)
          .height(8)
          .fill(this.noticeSeverityColor(notice.severity))
        Text(notice.title)
          .fontSize(14)
          .fontWeight(600)
          .fontColor(getColors().ink)
          .layoutWeight(1)
        Text(this.noticeTypeLabel(notice))
          .fontSize(11)
          .fontColor(this.noticeSeverityColor(notice.severity))
      }
      .width('100%')
      if (notice.message !== null && notice.message.length > 0) {
        Text(notice.message)
          .fontSize(13)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
      }
      this.noticeInputFormBuilder(notice)
      this.noticeSchemaFieldsSelected(notice)
      if (this.noticeValidationErrors.has(notice.noticeId)) {
        Text(this.noticeValidationErrors.get(notice.noticeId))
          .fontSize(12)
          .fontColor(getColors().errorText)
          .width('100%')
      }
      if (this.capabilityAllowed(SESSION_NOTICE_RESPONSE_CAPABILITY)) {
        Row({ space: 8 }) {
          ForEach(notice.actions, (action: RemoteNoticeAction) => {
            Button(action.label)
              .fontSize(12)
              .fontWeight(600)
              .height(34)
              .padding({ left: 14, right: 14 })
              .fontColor(this.actionStyleColor(action.style))
              .backgroundColor(this.actionStyleBackground(action.style))
              .enabled(this.canSubmitNoticeAction(notice, action.actionId))
              .onClick(() => {
                this.triggerNoticeAction(notice, action);
              })
          }, (action: RemoteNoticeAction) => action.actionId)
          if (this.respondingNoticeId === notice.noticeId) {
            LoadingProgress()
              .width(18)
              .height(18)
          }
        }
        .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .borderRadius(RadiusTokens.noticeCard)
    .backgroundColor(this.noticeSurfaceColor(notice.severity))
    .border({ width: 1, color: this.noticeBorderColor(notice.severity) })
  }

  @Builder
  headerMenusBuilder() {
    Row({ space: 2 }) {
      Row() {
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(19)
          .fontColor([getColors().ink])
      }
      .width(38)
      .height(38)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.navPathStack.pushPathByName('session_agent_files', this.sessionId);
      })
      Row() {
        SymbolGlyph($r('sys.symbol.share'))
          .fontSize(19)
          .fontColor([getColors().ink])
      }
      .width(38)
      .height(38)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .enabled(!this.shareBusy)
      .onClick(() => {
        this.shareSession();
      })
    }
    .alignItems(VerticalAlign.Center)
  }

  build() {
    NavDestination() {
      Stack() {
        Column() {
        Row({ space: 8 }) {
          Text(`${this.runtimeLabel} · ${this.statusLabel}`)
            .fontSize(12)
            .fontColor(this.statusColor())
            .layoutWeight(1)
          Circle()
            .width(8)
            .height(8)
            .fill(this.realtimeDotColor())
          Text(this.realtimeStatusLabel())
            .fontSize(11)
            .fontColor(getColors().faint)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 4 })
        if (this.errorMessage.length > 0) {
          Text(this.errorMessage)
            .fontSize(12)
            .fontColor(getColors().errorText)
            .width('100%')
            .padding({ left: 16, right: 16 })
        }
        if (this.loading) {
          Column() {
            LoadingProgress()
              .width(44)
              .height(44)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          List({ space: 16, scroller: this.scroller, initialIndex: this.initialTimelineIndex() }) {
            if (this.hasMoreHistory) {
              ListItem() {
                Button(this.historyButtonLabel())
                  .fontSize(12)
                  .height(30)
                  .backgroundColor(getColors().sessionCodeSurface)
                  .fontColor(getColors().inkSoft)
                  .enabled(!this.loadingHistory)
                  .onClick(() => {
                    this.loadHistory();
                  })
              }
              .width('100%')
            }
            if (this.sections.length === 0) {
              ListItem() {
                Text($r('app.string.session_no_messages'))
                  .fontSize(14)
                  .fontColor(getColors().faint)
                  .width('100%')
                  .textAlign(TextAlign.Center)
                  .padding({ top: 24, bottom: 24 })
              }
            }
            ForEach(this.sections, (section: SessionSection) => {
              ListItem() {
                if (section.kind === 'entry' && section.entry !== null) {
                  this.entryView(section.entry)
                } else if (section.kind === 'tool' && section.toolRow !== null) {
                  TimelineToolEntry({
                    model: section.toolRow,
                    workingDir: this.sessionCwd(),
                    contentMaxWidthVp: this.assistantContentMaxVp
                  })
                } else if (section.kind === 'group' && section.group !== null) {
                  TimelineToolGroupEntry({
                    group: section.group,
                    workingDir: this.sessionCwd(),
                    contentMaxWidthVp: this.assistantContentMaxVp
                  })
                }
              }
            }, (section: SessionSection) => `${section.kind}_${section.entryKey}`)
            if (this.canInterrupt) {
              ListItem() {
                Row({ space: 8 }) {
                  LoadingProgress()
                    .width(14)
                    .height(14)
                  Text($r('app.string.session_tool_running'))
                    .fontSize(13)
                    .fontColor(getColors().muted)
                }
                .width('100%')
                .alignItems(VerticalAlign.Center)
              }
              .width('100%')
            }
          }
          .width('100%')
          .layoutWeight(1)
          .padding({ left: 20, right: 20, top: 4 })
          .onAppear(() => {
            if (this.initialBottomScrollDone) {
              return;
            }
            this.initialBottomScrollDone = true;
            this.scroller.scrollEdge(Edge.Bottom);
          })
        }
        if (this.commandSuggestions.length > 0) {
          Column() {
            ForEach(this.commandSuggestions, (command: RemoteRuntimeCommand) => {
              Row({ space: 8 }) {
                Text(`/${command.id}`)
                  .fontSize(13)
                  .fontColor(getColors().ink)
                  .fontFamily('monospace')
                Text(command.title)
                  .fontSize(12)
                  .fontColor(getColors().muted)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 8, bottom: 8 })
              .onClick(() => {
                this.applySuggestion(command);
              })
            }, (command: RemoteRuntimeCommand) => command.id)
          }
          .width('100%')
          .padding({ left: 12, right: 12 })
          .borderRadius(10)
          .backgroundColor(getColors().canvas)
          .border({ width: 1, color: getColors().border })
          .shadow({ radius: 16, color: this.themeIsDark ? '#66000000' : '#1F000000' })
        }
        if (this.attachmentPanelOpen && this.capabilityAllowed(SESSION_ATTACHMENT_CAPABILITY)) {
          Column({ space: 6 }) {
            Row({ space: 14 }) {
              Row() {
                SymbolGlyph($r('sys.symbol.camera'))
                  .fontSize(20)
                  .fontColor([this.themeIsDark ? '#F4F4F5' : '#2F302D'])
              }
              .width(42)
              .height(42)
              .borderRadius(21)
              .backgroundColor(this.themeIsDark ? '#3A3A3D' : '#F1F1EF')
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              Text($r('app.string.session_attachment_camera'))
                .fontSize(16)
                .fontWeight(600)
                .fontColor(this.themeIsDark ? '#F4F4F5' : '#2F302D')
                .maxLines(1)
                .layoutWeight(1)
            }
            .width('100%')
            .height(50)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.attachmentPanelOpen = false;
              this.capturePhoto();
            })
            Row({ space: 14 }) {
              Row() {
                SymbolGlyph($r('sys.symbol.picture'))
                  .fontSize(20)
                  .fontColor([this.themeIsDark ? '#F4F4F5' : '#2F302D'])
              }
              .width(42)
              .height(42)
              .borderRadius(21)
              .backgroundColor(this.themeIsDark ? '#3A3A3D' : '#F1F1EF')
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              Text($r('app.string.session_attachment_photos'))
                .fontSize(16)
                .fontWeight(600)
                .fontColor(this.themeIsDark ? '#F4F4F5' : '#2F302D')
                .maxLines(1)
                .layoutWeight(1)
            }
            .width('100%')
            .height(50)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.attachmentPanelOpen = false;
              this.pickLocalImages();
            })
            Row({ space: 14 }) {
              Row() {
                SymbolGlyph($r('sys.symbol.doc'))
                  .fontSize(20)
                  .fontColor([this.themeIsDark ? '#F4F4F5' : '#2F302D'])
              }
              .width(42)
              .height(42)
              .borderRadius(21)
              .backgroundColor(this.themeIsDark ? '#3A3A3D' : '#F1F1EF')
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              Text($r('app.string.session_attachment_file'))
                .fontSize(16)
                .fontWeight(600)
                .fontColor(this.themeIsDark ? '#F4F4F5' : '#2F302D')
                .maxLines(1)
                .layoutWeight(1)
            }
            .width('100%')
            .height(50)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.attachmentPanelOpen = false;
              this.pickLocalFiles();
            })
            Row({ space: 14 }) {
              Row() {
                SymbolGlyph($r('sys.symbol.link'))
                  .fontSize(20)
                  .fontColor([this.themeIsDark ? '#F4F4F5' : '#2F302D'])
              }
              .width(42)
              .height(42)
              .borderRadius(21)
              .backgroundColor(this.themeIsDark ? '#3A3A3D' : '#F1F1EF')
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              Text($r('app.string.session_attachment_url'))
                .fontSize(16)
                .fontWeight(600)
                .fontColor(this.themeIsDark ? '#F4F4F5' : '#2F302D')
                .maxLines(1)
                .layoutWeight(1)
            }
            .width('100%')
            .height(50)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.attachmentPanelOpen = false;
              this.attachmentUrlMode = true;
            })
          }
          .width(270)
          .padding({ left: 18, right: 18, top: 10, bottom: 10 })
          .borderRadius(24)
          .backgroundColor(this.themeIsDark ? '#202023' : '#FFFFFF')
          .border({ width: 1, color: this.themeIsDark ? '#38383C' : '#EFEDE9' })
          .alignSelf(ItemAlign.Start)
          .margin({ left: 14, bottom: 10 })
          .shadow({ radius: 20, color: this.themeIsDark ? '#80000000' : '#29000000' })
        }
        if (this.notices.length > 0) {
          Column({ space: 8 }) {
            this.noticeView(this.notices[0])
            if (this.notices.length > 1) {
              Text(this.localText($r('app.string.session_tool_more_notices'))
                .replace('%1$d', `${this.notices.length - 1}`))
                .fontSize(12)
                .fontColor(getColors().muted)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .borderRadius(12)
                .backgroundColor(getColors().subtle)
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 14, right: 14 })
        }
        Column({ space: 10 }) {
          if (this.pendingAttachments.length > 0) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.pendingAttachments, (attachment: RemoteUploadedAttachment) => {
                Row({ space: 4 }) {
                  Text(attachment.name)
                    .fontSize(11)
                    .fontColor(getColors().ink)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .constraintSize({ maxWidth: 140 })
                    .copyOption(CopyOptions.LocalDevice)
                  Text('✕')
                    .fontSize(11)
                    .fontColor(getColors().muted)
                    .padding({ left: 2, right: 2 })
                    .onClick(() => {
                      this.removePendingAttachment(attachment.fileId);
                    })
                }
                .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                .borderRadius(12)
                .backgroundColor(getColors().subtle)
                .margin({ right: 6, bottom: 4 })
              }, (attachment: RemoteUploadedAttachment) => attachment.fileId)
            }
            .width('100%')
          }
          if (this.attachmentUrlMode) {
            Row({ space: 8 }) {
              TextInput({ text: this.attachmentUrlInput, placeholder: $r('app.string.session_attachment_url_placeholder') })
                .fontSize(13)
                .height(36)
                .layoutWeight(1)
                .backgroundColor(getColors().matchedAccountSurface)
                .borderRadius(18)
                .padding({ left: 12, right: 12 })
                .enabled(!this.uploadingAttachment)
                .onChange((value: string) => {
                  this.attachmentUrlInput = value;
                })
              Button(this.attachmentUploadLabel())
                .fontSize(13)
                .height(36)
                .padding({ left: 14, right: 14 })
                .backgroundColor(getColors().primaryAction)
                .fontColor(getColors().onPrimaryAction)
                .enabled(!this.uploadingAttachment)
                .onClick(() => {
                  this.addAttachmentFromUrl();
                })
              Text('✕')
                .fontSize(14)
                .fontColor(getColors().muted)
                .width(28)
                .height(28)
                .textAlign(TextAlign.Center)
                .onClick(() => {
                  this.attachmentUrlMode = false;
                })
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
          }
          TextArea({ text: this.composerInput, placeholder: $r('app.string.session_message_placeholder') })
            .fontSize(16)
            .fontWeight(500)
            .fontColor(this.composerInputColor())
            .constraintSize({ minHeight: 28, maxHeight: 92 })
            .backgroundColor(Color.Transparent)
            .padding(0)
            .placeholderColor(getColors().muted)
            .enabled(this.sendInputAllowed())
            .onChange((value: string) => {
              this.composerInput = value;
              this.saveComposerDraft();
              this.updateCommandSuggestions();
            })
          Row() {
            Row({ space: 9 }) {
              if (this.capabilityAllowed(SESSION_ATTACHMENT_CAPABILITY)) {
                Row() {
                  SymbolGlyph($r('sys.symbol.plus'))
                    .fontSize(15)
                    .fontColor([this.composerPlusColor()])
                }
                .width(30)
                .height(30)
                .borderRadius(15)
                .backgroundColor(this.themeIsDark ? '#00000000' : '#FFFFFF')
                .justifyContent(FlexAlign.Center)
                .alignItems(VerticalAlign.Center)
                .onClick(() => {
                  this.attachmentPanelOpen = !this.attachmentPanelOpen;
                })
              }
              if (this.capabilities !== null) {
                Row({ space: 5 }) {
                  Row() {
                    Circle()
                      .width(12)
                      .height(12)
                      .fill(this.takeoverKnobColor())
                  }
                  .width(30)
                  .height(18)
                  .borderRadius(9)
                  .backgroundColor(this.takeoverTrackColor())
                  .justifyContent(this.takeoverOn ? FlexAlign.End : FlexAlign.Start)
                  .alignItems(VerticalAlign.Center)
                  .padding({ left: 3, right: 3 })
                  Text($r('app.string.session_takeover_label'))
                    .fontSize(12)
                    .fontWeight(600)
                    .fontColor(this.takeoverLabelColor())
                    .maxLines(1)
                }
                .height(28)
                .padding({ left: 4, right: 9 })
                .borderRadius(14)
                .backgroundColor(this.themeIsDark ? '#00000000' : '#FFFFFF')
                .alignItems(VerticalAlign.Center)
                .onClick(() => {
                  if (!this.takeoverBusy) {
                    this.requestTakeoverChange(!this.takeoverOn);
                  }
                })
              }
            }
            .alignItems(VerticalAlign.Center)
            if (this.canInterrupt && this.capabilityAllowed(SESSION_INTERRUPT_CAPABILITY)) {
              Row() {
                if (this.interrupting) {
                  LoadingProgress()
                    .width(17)
                    .height(17)
                    .color('#FFFFFF')
                } else {
                  Column()
                    .width(10)
                    .height(10)
                    .borderRadius(2)
                    .backgroundColor('#FFFFFF')
                }
              }
              .width(34)
              .height(34)
              .borderRadius(12)
              .backgroundColor('#EF4444')
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .onClick(() => {
                if (!this.interrupting) {
                  this.interruptRuntime();
                }
              })
            } else {
              Row() {
                if (this.sending || this.executingCommand) {
                  LoadingProgress()
                    .width(17)
                    .height(17)
                    .color(this.sendButtonIconColor())
                } else {
                  SymbolGlyph($r('sys.symbol.arrow_up'))
                    .fontSize(17)
                    .fontColor([this.sendButtonIconColor()])
                }
              }
              .width(34)
              .height(34)
              .borderRadius(17)
              .backgroundColor(this.sendButtonSurface())
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .onClick(() => {
                if (!this.sending && !this.executingCommand && this.sendInputAllowed()) {
                  this.sendMessage();
                }
              })
            }
          }
          .width('100%')
          .height(34)
          .justifyContent(FlexAlign.SpaceBetween)
          .alignItems(VerticalAlign.Center)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 16, bottom: 12 })
        .borderRadius(22)
        .backgroundColor(this.composerCardSurface())
        .border({ width: 1, color: this.composerCardBorder() })
        .margin({ left: 14, right: 14, bottom: 20 })
        .onClick(() => {
          this.handleReadOnlyComposerClick();
        })
      }
      .width('100%')
      .height('100%')

        if (this.attachmentPreviewOpen) {
          AttachmentPreviewOverlay({
            sessionId: this.sessionId,
            attachments: this.attachmentPreviewAttachments,
            initialIndex: this.attachmentPreviewIndex,
            onSave: (attachment: RemoteTimelineAttachment): void => {
              this.saveTimelineAttachment(attachment);
            },
            onClose: (): void => {
              this.attachmentPreviewOpen = false;
            }
          })
        }
      }
      .width('100%')
      .height('100%')
    }
    .title(this.title)
    .menus(this.headerMenusBuilder)
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      const raw = ctx.pathInfo.param as string;
      if (typeof raw === 'string' && raw.length > 0) {
        this.sessionId = raw;
      }
      if (this.sessionId.length > 0) {
        this.pageActive = true;
        this.restoreOptimisticMessages();
        this.restoreComposerDraft();
        this.loadSnapshot();
        this.loadRuntimeState();
        this.loadRuntimeCommands();
        this.connectRealtime();
      } else {
        this.errorMessage = 'Missing session.';
        this.loading = false;
      }
    })
  }

  private applySuggestion(command: RemoteRuntimeCommand): void {
    const separator = command.acceptsArgs ? ' ' : '';
    this.composerInput = `/${command.id}${separator}`;
    this.commandSuggestions = [];
  }
}

@Builder
export function SessionDetailPageBuilder() {
  SessionDetailPage()
}
