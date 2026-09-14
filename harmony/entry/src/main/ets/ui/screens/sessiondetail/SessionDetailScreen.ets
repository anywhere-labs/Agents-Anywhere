import { RemoteSession } from '../../../api/SessionsDtos';
import { RemoteRuntimeNotice, RuntimeStatus } from '../../../api/RuntimeDtos';
import { SelectionScope } from '../../../api/RuntimeCatalogDtos';
import { TimelineFileChange } from '../../../api/TimelineDtos';
import { AgentSession } from '../../../model/AgentSession';
import { SessionDetailState } from '../../../feature/sessiondetail/SessionDetailState';
import { RuntimeSettingsState } from '../../../feature/sessiondetail/RuntimeSettingsState';
import {
  MessageAuthor, TimelineMessage, TimelineMessageKind, TimelineRenderItem, TimelineRenderKind,
  agentCallGroupSummary, reconnectSummary, toolActivitySummary, toolRunSummary,
} from '../../../feature/sessiondetail/SessionTimelineProjection';
import {
  AgentReplyAction, buildAgentReplyActions,
} from '../../../feature/sessiondetail/AgentReplyActions';
import { SessionReplyActions } from './SessionReplyActions';
import { RuntimeCommandSuggestions } from './RuntimeCommandSuggestions';
import {
  RuntimeCommand, RuntimeCommands, commandArgs, commandName, commandQuery, findCommand,
} from '../../../feature/sessiondetail/RuntimeCommandsState';
import { capabilityUsable, findRuntimeCapability } from '../../../api/RuntimeDtos';
import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AAHeight, AARadius } from '../../designsystem/AAMetrics';
import { BlockingRuntimeNoticeStack, RuntimeNoticeCard } from './SessionRuntimeControls';
import { AgentMarkdownText } from './AgentMarkdownText';
import { SessionRuntimeSettingsSheet } from './SessionRuntimeSettingsSheet';
import { noticeTargetIds } from '../../../feature/sessiondetail/SessionDetailController';
import { shouldAutoFollowRealtime } from '../../../feature/sessiondetail/SessionScrollFollow';
import {
  AttachmentUploadState, PendingAttachment, attachmentsReady,
} from '../../../feature/sessiondetail/PendingAttachment';
import { SessionCapability, isCapabilityUsable } from '../../../api/RuntimeDtos';
import {
  AttachSourceMenu, PendingAttachmentStrip,
} from './ComposerAttachments';
import { AttachmentPreviewViewer, LocalImageViewer, MessageAttachmentStrip } from './AttachmentViews';
import { TimelineAttachment } from '../../../feature/sessiondetail/SessionTimelineProjection';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { AALog } from '../../../common/AAAppLog';
import {
  DiffLine, DiffLineTone, DiffPreview, diffPreview, diffToneBackground,
} from '../../../feature/sessiondetail/DiffPreview';
import { resolveString } from '../../../common/AAResources';

/** Rows from the oldest end at which the previous page is loaded, as Android. */
const LOAD_OLDER_VISIBLE_THRESHOLD: number = 3;
/** Rows kept when animating back to the newest message from far away. */
const RETURN_TO_LATEST_ANIMATION_WINDOW: number = 12;
/** How long a scroll this component started counts as its own. */
const PROGRAMMATIC_SCROLL_WINDOW_MS: number = 400;

/**
 * Session detail: the conversation page.
 *
 * Port of page 0 of `ui/screens/sessiondetail/SessionDetailScreen.kt`.
 *
 * What is faithful here: the row taxonomy and its chrome (user bubbles aligned
 * right at 78% width, agent text with no bubble, tool activity as collapsed
 * one-line rows with a chevron), the grouped runs, the composer's placeholder
 * precedence, the takeover gate, and the runtime settings sheet reached from the
 * header.
 *
 * What is not in yet, and is tracked rather than approximated: code-block syntax
 * highlighting, tapping a file reference to open the workspace browser,
 * attachments, the turn-end share footer, slash commands, and the second pager
 * page for files and terminal. Those land in the following passes.
 *
 * One deliberate difference from Android's header: it keeps an explicit back
 * button beside the settings button, because HarmonyOS's system back exits the
 * app rather than popping this page, and the header would otherwise have no way
 * back to the session list.
 */
@Component
export struct SessionDetailScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  @Prop state: SessionDetailState;
  @Prop runtimeSettings: RuntimeSettingsState;
  /**
   * Counters the app bumps when the conversation should follow the newest item.
   *
   * Android keeps the same two counters: `forceLatest` on a send, `streamLatest`
   * when realtime events changed the newest item or the notices.
   */
  @Prop @Watch('onForceLatestChanged') forceLatestRequest: number;
  @Prop @Watch('onStreamLatestChanged') streamLatestRequest: number;
  /** Watched so the list jumps to the newest page once a snapshot lands. */
  @Prop @Watch('onInitializedChanged') initialized: boolean;
  /** Watched to keep the reading position across an older-page prepend. */
  @Prop @Watch('onLoadingOlderChanged') loadingOlder: boolean;
  /** Row passed from the list, used for the title before the snapshot lands. */
  session: AgentSession | null = null;
  deviceOnline: boolean = true;
  onBack: () => void = () => {};
  onLoadOlder: () => void = () => {};
  onSend: (content: string) => void = () => {};
  onInterrupt: () => void = () => {};
  onToggleTakeover: (enabled: boolean) => void = () => {};
  onRetry: () => void = () => {};
  /** Opens the runtime settings surface, loading its catalogs when needed. */
  onOpenRuntimeSettings: () => void = () => {};
  onRetryRuntimeCatalogs: () => void = () => {};
  onSelectRuntime: (scope: string, selectionId: string) => void = () => {};
  /** Android's right header button switches to the files/terminal page. */
  onOpenAgentFiles: () => void = () => {};
  /** Notices that block this session until answered, shown above the composer. */
  blockingNotices: RemoteRuntimeNotice[] = [];
  /** Notices with no timeline target, rendered inline in the conversation. */
  detachedNotices: RemoteRuntimeNotice[] = [];
  /** Notices attached to a timeline item, rendered inside that row when expanded. */
  attachedNotices: RemoteRuntimeNotice[] = [];
  noticeBusy: boolean = false;
  noticeError: string = '';
  onRespondNotice: (noticeId: string, actionId: string, input: Object | null) => void = () => {};
  /** Composer attachments, owned by the app because an upload outlives a render. */
  attachments: PendingAttachment[] = [];
  onRemoveAttachment: (attachment: PendingAttachment) => void = () => {};
  onRetryAttachment: (attachment: PendingAttachment) => void = () => {};
  /** Opens the viewer for a composer attachment that has not been sent yet. */
  onPreviewComposerAttachment: (attachment: PendingAttachment) => void = () => {};
  onPickPhoto: () => void = () => {};
  onOpenCamera: () => void = () => {};
  onPickFile: () => void = () => {};
  /** Attachment-level notices, surfaced as the screen's toast. */
  composerNotice: ResourceStr = '';
  @Prop @Watch('onComposerNoticeChanged') composerNoticeRequest: number;
  /** A non-error toast (the copy confirmation); same request-counter shape. */
  infoNotice: ResourceStr = '';
  @Prop @Watch('onInfoNoticeChanged') infoNoticeRequest: number = 0;
  /** Copies a completed turn's reply text. */
  onCopyReply: (text: string) => void = () => {};
  /** Opens the share dialog for a completed turn's message ids. */
  onShareReply: (itemIds: string[]) => void = () => {};
  /** Reports the composer text so the app can keep the session's draft. */
  onDraftChange: (text: string) => void = () => {};
  /** Loads the session's slash-command catalog; rejects on failure. */
  onLoadCommands: () => Promise<RuntimeCommand[]> = () =>
    Promise.reject(new Error('Command listing is not connected.'));
  /** Runs a slash command; rejects with the Server's message on failure. */
  onExecuteCommand: (commandId: string, args: string[], raw: string) => Promise<void> = () =>
    Promise.reject(new Error('Command execution is not connected.'));
  /**
   * True while the page is showing a prepared draft, before the Server session
   * exists. Android's `preparedSession != null`.
   */
  draftMode: boolean = false;
  /** Whether the draft's runtime accepts attachments (Android's draft flag). */
  draftAttachmentsEnabled: boolean = true;
  /** Bumped when the app puts text back in the composer after a failed create. */
  @Prop @Watch('onComposerRestoreChanged') composerRestoreRequest: number = 0;
  /** The text to restore; Android's `draft = message` after a create failure. */
  composerRestoreText: string = '';
  /** Every image in the conversation, so the viewer can page between them. */
  sessionImages: TimelineAttachment[] = [];
  /** The image the viewer is showing; `null` when it is closed. */
  @Prop @Watch('onPreviewChanged') previewAttachment: TimelineAttachment | null;
  /** A composer attachment being previewed, which has no file id yet. */
  @Prop @Watch('onPreviewChanged') previewPending: PendingAttachment | null;
  /** Result of a save, shown inside the viewer's own toast. */
  previewToast: ResourceStr = '';
  @Prop previewToastRequest: number;
  /** Opens the viewer for an image that is already part of the conversation. */
  onPreviewMessageAttachment: (attachment: TimelineAttachment) => void = () => {};
  onClosePreview: () => void = () => {};
  onDownloadAttachment: (attachment: TimelineAttachment) => void = () => {};
  onOpenAttachment: (attachment: TimelineAttachment) => void = () => {};
  loadAttachment: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);
  /** Height of the status bar, used to inset the viewer's controls. */
  @Prop statusBarHeight: number;

  @State private draft: string = '';
  @State private showRuntimeSettings: boolean = false;
  @State private showScrollToBottom: boolean = false;
  @State private showAttachMenu: boolean = false;
  @State private showPreview: boolean = false;
  private toast: AAToastState = new AAToastState();
  /** Memo for the turn-end actions; see `replyActions()`. */
  private replyActionKey: string = '';
  private replyActionCache: Map<string, AgentReplyAction> = new Map<string, AgentReplyAction>();
  /**
   * The slash-command catalog, and whether one is running.
   *
   * Android keeps both in the screen's own `state`; nothing outside this page
   * reads them, so they stay local here rather than travelling through the app.
   */
  @State private commands: RuntimeCommands = RuntimeCommands.empty();
  @State private commandExecuting: boolean = false;
  /** The session the catalog belongs to; a switch drops it (Android keys it too). */
  private commandsSessionId: string = '';

  onPreviewChanged(): void {
    this.showPreview = this.previewAttachment !== null || this.previewPending !== null;
  }

  /** Android routes these through the screen's snackbar host. */
  onComposerNoticeChanged(): void {
    if (this.composerNoticeRequest > 0) {
      this.toast.show(this.composerNotice, true);
    }
  }

  /** The copy confirmation, which Android shows as a plain snackbar. */
  onInfoNoticeChanged(): void {
    if (this.infoNoticeRequest > 0) {
      this.toast.show(this.infoNotice, false);
    }
  }

  /**
   * Android's `turnInProgress`: whether the newest turn is still streaming.
   *
   * The port has no optimistic messages, so the "a message is still running" half
   * of Android's test has nothing to match; the runtime status and the two
   * in-flight flags carry the same meaning.
   */
  private turnInProgress(): boolean {
    if (this.state.sending || this.state.interrupting) {
      return true;
    }
    const status: string = this.state.runtimeStatus;
    return status === RuntimeStatus.RUNNING
      || status === RuntimeStatus.WAITING
      || status === RuntimeStatus.PENDING
      || status === RuntimeStatus.STOPPING
      || status === RuntimeStatus.WAITING_APPROVAL
      || status === RuntimeStatus.BLOCKED;
  }

  /** Android's `buildAgentActionsByTurnEnd`, keyed by the row it sits under. */
  private replyActions(): Map<string, AgentReplyAction> {
    const items: TimelineRenderItem[] = this.state.renderItems;
    const inProgress: boolean = this.turnInProgress();
    // Every row asks for this map twice, so it is memoized: the key covers the
    // list size, the newest row and the streaming text growing inside it, which
    // is everything the grouping can change on.
    const last: TimelineRenderItem | null = items.length > 0 ? items[items.length - 1] : null;
    let lastText: number = 0;
    if (last !== null && last.messages.length > 0) {
      lastText = last.messages[last.messages.length - 1].text.length;
    }
    const key: string = `${items.length}:${last === null ? '' : last.key}:${lastText}:${inProgress}`;
    if (key === this.replyActionKey) {
      return this.replyActionCache;
    }
    this.replyActionKey = key;
    this.replyActionCache = buildAgentReplyActions(items, inProgress);
    return this.replyActionCache;
  }

  /**
   * The app handed text back after a failed create, or restored a saved draft.
   *
   * Android restores the composer inline (`draft = message`); the port's composer
   * state lives here, so the app signals it through this request counter. The
   * counter is also read once when the page is created, because a `@Watch` does
   * not fire for the value a component is born with — and a restored draft is
   * always set before the page is shown.
   */
  onComposerRestoreChanged(): void {
    if (this.composerRestoreRequest > 0) {
      this.draft = this.composerRestoreText;
    }
  }

  aboutToAppear(): void {
    this.onComposerRestoreChanged();
  }

  // ------------------------------------------------------- reading position
  //
  // Android's conversation list is reversed, so index 0 *is* the newest message
  // and "following" is just a scroll to 0. ArkUI's `List` has no reverse layout,
  // so the list runs oldest-to-newest and the same behaviour is expressed
  // against its end. Some consequences of that difference are handled here and
  // noted in the port plan: the initial snapshot jumps to the end, and an
  // older-page prepend re-anchors the first visible row.

  private timelineScroller: Scroller = new Scroller();
  private autoFollowLatest: boolean = true;
  private userPausedAutoFollow: boolean = false;
  private scrollingNow: boolean = false;
  /**
   * Deadline for scrolls this component started itself.
   *
   * A plain latch would be wrong: a jump that lands where the list already is
   * fires no `onScrollStop`, so the latch would never clear and every later
   * gesture would be mistaken for our own. A short window expires by itself.
   */
  private programmaticUntil: number = 0;
  /** False until the first snapshot has been scrolled to its newest message. */
  private initialJumpDone: boolean = false;
  /** Index of the oldest visible row, tracked for the prepend anchor. */
  private firstVisibleIndex: number = 0;
  private prependAnchor: number = -1;
  private prependCount: number = 0;

  private beganProgrammaticScroll(): void {
    this.programmaticUntil = Date.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
  }

  private isProgrammaticScroll(): boolean {
    return Date.now() < this.programmaticUntil;
  }

  /** Android's `releaseReadLock`. */
  private releaseReadLock(): void {
    this.userPausedAutoFollow = false;
    this.autoFollowLatest = true;
  }

  /** Android's `pauseAutoFollowWithSnapshot`. */
  private pauseAutoFollow(): void {
    this.userPausedAutoFollow = true;
    this.autoFollowLatest = false;
  }

  private atLatest(): boolean {
    return this.timelineScroller.isAtEnd();
  }

  /**
   * Jumps to the newest row, after the frame that produced it has been laid out.
   *
   * Android runs this from a `LaunchedEffect`, which is also after composition,
   * so the deferral keeps the two equivalent.
   */
  private jumpToLatest(): void {
    this.beganProgrammaticScroll();
    setTimeout(() => {
      this.timelineScroller.scrollEdge(Edge.Bottom);
    }, 0);
  }

  onForceLatestChanged(): void {
    if (this.forceLatestRequest <= 0) {
      return;
    }
    this.releaseReadLock();
    this.jumpToLatest();
  }

  onStreamLatestChanged(): void {
    const follow: boolean = shouldAutoFollowRealtime(
      this.streamLatestRequest > 0, this.autoFollowLatest, this.userPausedAutoFollow,
      this.scrollingNow,
    );
    if (follow) {
      this.jumpToLatest();
    }
  }

  onInitializedChanged(): void {
    if (this.initialized) {
      this.releaseReadLock();
      // Older pages are only fetched once the list sits where Android's starts:
      // at the newest end.
      this.initialJumpDone = true;
      this.jumpToLatest();
    }
  }

  /**
   * Re-anchors the viewport after older messages are inserted above it.
   *
   * A reversed list does not move when items are prepended; a forward one shifts
   * everything down, so the row the reader was on is put back under the finger.
   */
  onLoadingOlderChanged(): void {
    if (this.loadingOlder) {
      this.prependAnchor = this.firstVisibleIndex;
      this.prependCount = this.state.renderItems.length;
      return;
    }
    if (this.prependAnchor < 0) {
      return;
    }
    const added: number = this.state.renderItems.length - this.prependCount;
    const anchor: number = this.prependAnchor;
    this.prependAnchor = -1;
    if (added <= 0) {
      return;
    }
    this.beganProgrammaticScroll();
    setTimeout(() => {
      this.timelineScroller.scrollToIndex(anchor + added, false, ScrollAlign.START);
    }, 0);
  }

  private wireSession(): RemoteSession | null {
    return this.state.session;
  }

  /** Notices whose target is any item inside this render row. */
  private noticesForItem(item: TimelineRenderItem): RemoteRuntimeNotice[] {
    if (this.attachedNotices.length === 0) {
      return [];
    }
    const ids: string[] = [];
    for (const message of item.messages) {
      ids.push(message.id);
    }
    const matched: RemoteRuntimeNotice[] = [];
    for (const notice of this.attachedNotices) {
      const targets: string[] = noticeTargetIds(notice);
      for (const target of targets) {
        if (ids.includes(target)) {
          matched.push(notice);
          break;
        }
      }
    }
    return matched;
  }

  private title(): string {
    const wire: RemoteSession | null = this.wireSession();
    if (wire !== null && wire.title !== null && wire.title.length > 0) {
      return wire.title;
    }
    return this.session === null ? 'Session' : this.session.title;
  }

  /** Runtime label shown in the composer placeholder and the takeover dialog. */
  private runtimeLabel(): string {
    if (this.session !== null && this.session.runtimeLabel.length > 0) {
      return this.session.runtimeLabel;
    }
    const wire: RemoteSession | null = this.wireSession();
    return wire === null ? 'Agent' : wire.runtimeName;
  }

  private takeoverEnabled(): boolean {
    if (this.draftMode) {
      // A prepared draft has no Server session yet, and Android treats it as
      // takeover-enabled so the composer is usable.
      return true;
    }
    const wire: RemoteSession | null = this.wireSession();
    return wire !== null && wire.takeover;
  }

  private canInterrupt(): boolean {
    if (!this.deviceOnline) {
      return false;
    }
    const status: string = this.state.runtimeStatus;
    return status === RuntimeStatus.RUNNING
      || status === RuntimeStatus.WAITING
      || status === RuntimeStatus.PENDING
      || status === RuntimeStatus.STOPPING
      || status === RuntimeStatus.WAITING_APPROVAL
      || status === RuntimeStatus.BLOCKED;
  }

  /**
   * Composer placeholder, in Android's precedence order.
   *
   * Takeover and connectivity come first because neither can be fixed by
   * retrying, then the blocking states, then the runtime's own condition.
   */
  private placeholder(): ResourceStr {
    if (!this.takeoverEnabled()) {
      return $r('app.string.session_read_only_placeholder');
    }
    if (!this.deviceOnline) {
      return $r('app.string.session_device_offline_placeholder');
    }
    if (this.state.openNotices().length > 0) {
      return $r('app.string.session_waiting_approval_placeholder');
    }
    const status: string = this.state.runtimeStatus;
    if (status === RuntimeStatus.UNKNOWN) {
      return $r('app.string.session_runtime_state_error');
    }
    if (status === RuntimeStatus.WAITING || status === RuntimeStatus.PENDING) {
      return $r('app.string.session_pending_placeholder');
    }
    if (status === RuntimeStatus.RUNNING || status === RuntimeStatus.STOPPING) {
      return $r('app.string.session_busy_placeholder');
    }
    if (status === RuntimeStatus.WAITING_APPROVAL || status === RuntimeStatus.BLOCKED) {
      return $r('app.string.session_waiting_approval_placeholder');
    }
    if (status === RuntimeStatus.ERROR) {
      return $r('app.string.session_error_placeholder');
    }
    return $r('app.string.session_send_unavailable');
  }

  /** True when the composer should accept text and offer the send button. */
  private inputEnabled(): boolean {
    if (this.draftMode) {
      // Android's `inputEnabled` for a prepared session is simply true.
      return this.deviceOnline && !this.state.sending;
    }
    return this.takeoverEnabled() && this.deviceOnline && !this.state.sending;
  }

  /**
   * True when the runtime accepts attachments.
   *
   * Android asks the capability set for `runtime.attachment` through its
   * four-level lookup; the same helper is used here, with the runtime id and type
   * taken from the loaded session.
   */
  private attachmentsEnabled(): boolean {
    if (this.draftMode) {
      // Android asks the *draft* for this, because a prepared session has no
      // capability set yet.
      return this.draftAttachmentsEnabled;
    }
    const wire: RemoteSession | null = this.wireSession();
    if (wire === null) {
      return false;
    }
    return isCapabilityUsable(
      this.state.capabilities, SessionCapability.ATTACHMENT, wire.runtimeId, wire.runtimeType,
    );
  }

  /**
   * The send button's gate.
   *
   * Android's `canSend`, minus the pieces this port has no feature for yet: the
   * composer must be writable, no notice may be blocking, nothing may be in
   * flight, every attachment must have finished uploading, and the message must
   * carry either text or an attachment. In command mode the command capability
   * and a loaded catalog replace the send/steer requirement.
   */
  private canSubmit(): boolean {
    if (!this.inputEnabled() || this.state.sending || this.commandExecuting) {
      return false;
    }
    if (this.blockingNotices.length > 0) {
      return false;
    }
    if (!attachmentsReady(this.attachments)) {
      return false;
    }
    if (this.attachments.length > 0 && !this.attachmentsEnabled()) {
      return false;
    }
    if (this.draft.trim().length === 0 && this.attachments.length === 0) {
      return false;
    }
    if (this.commandMode()) {
      return this.canUseCommands() && this.commandCatalogReady();
    }
    return true;
  }

  // -------------------------------------------------------- slash commands

  /**
   * Android's `commandRequested`/`commandMode`.
   *
   * A leading slash turns the composer into a command line: takeover has to be on,
   * the composer writable, and nothing attached. A prepared draft is excluded —
   * Android's send path skips the command branch for one, so offering the panel
   * there would only lead to a message that cannot be sent.
   */
  private commandMode(): boolean {
    if (this.draftMode || !this.takeoverEnabled() || !this.inputEnabled()) {
      return false;
    }
    if (this.attachments.length > 0) {
      return false;
    }
    return this.draft.trimStart().startsWith('/');
  }

  private commandQuery(): string {
    return commandQuery(this.draft);
  }

  /**
   * The catalog, but only while it belongs to the session on screen.
   *
   * Android keys its whole state on the session id, so another session's commands
   * can never be offered; the screen instance outlives a session switch here, so
   * the owning id is checked instead.
   */
  private activeCommands(): RuntimeCommand[] {
    return this.commandsSessionId === this.state.sessionId() ? this.commands.commands : [];
  }

  private commandCatalogReady(): boolean {
    return this.commands.isLoaded && this.commandsSessionId === this.state.sessionId();
  }

  /** Android's `canUseCommands`: either command capability is enough. */
  private canUseCommands(): boolean {
    const wire: RemoteSession | null = this.wireSession();
    if (wire === null) {
      return false;
    }
    return isCapabilityUsable(
      this.state.capabilities, SessionCapability.COMMANDS, wire.runtimeId, wire.runtimeType,
    ) || isCapabilityUsable(
      this.state.capabilities, SessionCapability.COMMAND_EXECUTE, wire.runtimeId, wire.runtimeType,
    );
  }

  /**
   * Why the panel cannot list commands, or an empty string.
   *
   * Android shows the first unusable capability's own reason, falling back to the
   * load error the state carries.
   */
  private commandUnavailableReason(): string {
    if (this.commands.errorMessage !== null) {
      return this.commands.errorMessage;
    }
    const wire: RemoteSession | null = this.wireSession();
    if (wire === null) {
      return '';
    }
    let capability = findRuntimeCapability(
      this.state.capabilities, SessionCapability.COMMANDS, wire.runtimeId, wire.runtimeType,
    );
    if (capability === null) {
      capability = findRuntimeCapability(
        this.state.capabilities, SessionCapability.COMMAND_EXECUTE, wire.runtimeId, wire.runtimeType,
      );
    }
    if (capability === null || capabilityUsable(capability)) {
      return '';
    }
    return capability.unavailableReason === null ? '' : capability.unavailableReason;
  }

  /**
   * Android's `loadCommands`: fetch once per session, with a forced retry.
   *
   * The request key drops an answer that belongs to a session the user has left,
   * and a catalog already loaded is not re-fetched unless the caller forces it.
   */
  private loadCommands(force: boolean): void {
    const sessionId: string = this.state.sessionId();
    if (sessionId.length === 0) {
      return;
    }
    if (this.commandsSessionId !== sessionId) {
      // Another session's catalog is not a starting point.
      this.commandsSessionId = sessionId;
      this.commands = RuntimeCommands.empty();
    }
    if (this.commands.isLoading) {
      return;
    }
    if (!force && this.commands.isLoaded && !this.commands.stale) {
      return;
    }
    this.commands = this.commands.begin(sessionId);
    const key: string = this.commands.requestKey;
    if (key.length === 0) {
      return;
    }
    void this.onLoadCommands().then((loaded: RuntimeCommand[]) => {
      if (this.state.sessionId() !== sessionId || this.commands.requestKey !== key) {
        return;
      }
      this.commands = this.commands.apply(key, loaded);
    }).catch((error: Object) => {
      if (this.state.sessionId() !== sessionId || this.commands.requestKey !== key) {
        return;
      }
      this.commands = this.commands.fail(
        key,
        error instanceof Error && error.message.length > 0
          ? error.message : resolveString($r('app.string.session_commands_load_failed')),
      );
    });
  }

  /** Android's `onSelect`: a disabled command explains itself instead. */
  private selectCommand(command: RuntimeCommand): void {
    if (!command.enabled) {
      const reason: string | null = command.disabledReason;
      this.toast.show(
        reason === null || reason.length === 0 ? $r('app.string.session_command_failed') : reason,
        true,
      );
      return;
    }
    this.draft = `/${command.id}${command.acceptsArgs ? ' ' : ''}`;
    // A programmatic change is a draft change too, as Android's setComposerDraft.
    this.onDraftChange(this.draft);
  }

  /**
   * The send button.
   *
   * Android's `sendDraft`: a leading slash runs a command instead of sending a
   * message, and the composer only clears when the command is accepted.
   */
  private submitComposer(): void {
    const text: string = this.draft.trim();
    if (!this.canSubmit()) {
      return;
    }
    if (this.commandMode()) {
      void this.executeTypedCommand(text);
      return;
    }
    this.draft = '';
    this.onDraftChange('');
    this.onSend(text);
  }

  private async executeTypedCommand(text: string): Promise<void> {
    if (this.state.sessionId().length === 0 || this.commandExecuting) {
      return;
    }
    const raw: string = text.startsWith('/') ? text.substring(1).trim() : text;
    const command: RuntimeCommand | null = findCommand(this.activeCommands(), commandName(raw));
    if (command === null) {
      this.toast.show($r('app.string.session_command_unknown'), true);
      return;
    }
    if (!command.enabled) {
      const reason: string | null = command.disabledReason;
      this.toast.show(
        reason === null || reason.length === 0 ? $r('app.string.session_command_failed') : reason,
        true,
      );
      return;
    }
    this.commandExecuting = true;
    try {
      await this.onExecuteCommand(command.id, commandArgs(raw), text);
      this.draft = '';
      this.onDraftChange('');
    } catch (error) {
      this.toast.show(
        error instanceof Error && error.message.length > 0
          ? error.message : $r('app.string.session_command_failed'),
        true,
      );
    } finally {
      this.commandExecuting = false;
    }
  }

  private workingLabel(): ResourceStr {
    const label: string = this.runtimeLabel();
    if (this.state.interrupting) {
      return $r('app.string.session_agent_interrupting', label);
    }
    return $r('app.string.session_agent_working', label);
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      this.Conversation()
      // The toast floats above the page, as Android's snackbar host does.
      AAToastHost({
        colors: this.colors,
        message: this.toast.message,
        isError: this.toast.isError,
        actionLabel: this.toast.actionLabel,
        visible: this.toast.visible,
        onAction: () => this.toast.hide(),
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .bindSheet($$this.showRuntimeSettings, this.RuntimeSettingsSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: false,
      showClose: false,
      // The surface is drawn by the sheet itself so its 28dp top radius matches
      // Android's, rather than the platform's default sheet radius.
      backgroundColor: '#00000000',
      maskColor: withAlpha('#000000', this.colors.isDark ? 0.56 : 0.28),
      shouldDismiss: (sheetDismiss: SheetDismiss) => {
        if (this.runtimeSettings.busy) {
          return;
        }
        this.showRuntimeSettings = false;
        sheetDismiss.dismiss();
      },
      onDisappear: () => {
        this.showRuntimeSettings = false;
      },
    })
    .bindContentCover($$this.showPreview, this.PreviewCover(), {
      modalTransition: ModalTransition.DEFAULT,
      onDisappear: () => {
        this.showPreview = false;
        this.onClosePreview();
      },
    })
  }

  @Builder
  PreviewCover() {
    if (this.previewPending !== null) {
      LocalImageViewer({
        colors: this.colors,
        attachment: this.previewPending,
        statusBarHeight: this.statusBarHeight,
        onClose: () => {
          this.showPreview = false;
          this.onClosePreview();
        },
      })
    } else {
      AttachmentPreviewViewer({
        colors: this.colors,
        images: this.sessionImages,
        initialFileId: this.previewAttachment === null ? '' : this.previewAttachment.fileId,
        statusBarHeight: this.statusBarHeight,
        load: this.loadAttachment,
        previewToast: this.previewToast,
        previewToastRequest: this.previewToastRequest,
        onDownload: (attachment: TimelineAttachment) => {
          this.onDownloadAttachment(attachment);
        },
        onClose: () => {
          this.showPreview = false;
          this.onClosePreview();
        },
      })
    }
  }

  @Builder
  Conversation() {
    Column() {
      // iOS's `ChatPageToolbar` puts the title in a native inline navigation bar
      // above the timeline — "no header view sits in the timeline" — so the bar
      // is a sibling of the list and Android's floating header and 88dp veil are
      // gone with it.
      this.Header()

      Column() {
        // Timeline or the loading / error / empty state.
        if (this.state.loading && !this.state.initialized) {
          Column() {
            LoadingProgress().width(24).height(24).color(this.colors.ink)
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
        } else if (this.state.errorMessage !== null && !this.state.initialized) {
          Column({ space: 14 }) {
            Text(this.state.errorMessage)
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.colors.errorText)
              .textAlign(TextAlign.Center)
            Text($r('app.string.archived_retry'))
              .fontSize(AAFontSize.LABEL)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.colors.onPrimaryAction)
              .height(44)
              .padding({ left: 20, right: 20 })
              .borderRadius(AARadius.PILL)
              .backgroundColor(this.colors.primaryAction)
              .onClick(() => this.onRetry())
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .padding(32)
        } else {
          Stack({ alignContent: Alignment.Bottom }) {
            List({ space: 16, scroller: this.timelineScroller }) {
              // Older messages are loaded automatically, as Android does when
              // the oldest rows come into view; the spinner sits at the oldest
              // end.
              if (this.loadingOlder) {
                  ListItem() {
                    this.OlderMessagesLoadingIndicator()
                  }
                }
                ForEach(this.state.renderItems, (item: TimelineRenderItem) => {
                  ListItem() {
                    Column({ space: 7 }) {
                      SessionTimelineRow({
                        colors: this.colors,
                        item: item,
                        notices: this.noticesForItem(item),
                        noticeBusy: this.noticeBusy,
                        noticeError: this.noticeError,
                        onRespondNotice: (noticeId: string, actionId: string, input: Object | null) => {
                          this.onRespondNotice(noticeId, actionId, input);
                        },
                        onPreviewAttachment: (attachment: TimelineAttachment) => {
                          this.onPreviewMessageAttachment(attachment);
                        },
                        onOpenAttachment: (attachment: TimelineAttachment) => {
                          this.onOpenAttachment(attachment);
                        },
                        loadAttachment: this.loadAttachment,
                      })

                      // Android hangs the copy/share pair off the last row of a
                      // completed turn.
                      if (this.replyActions().has(item.key)) {
                        SessionReplyActions({
                          colors: this.colors,
                          onCopy: () => {
                            const action = this.replyActions().get(item.key);
                            if (action !== undefined) {
                              this.onCopyReply(action.copyText);
                            }
                          },
                          onShare: () => {
                            const action = this.replyActions().get(item.key);
                            if (action !== undefined) {
                              this.onShareReply(action.itemIds);
                            }
                          },
                        })
                      }
                    }
                    .width('100%')
                    .alignItems(HorizontalAlign.Start)
                  }
                }, (item: TimelineRenderItem) => item.key)
                // A notice with no timeline target is its own row at the end of
                // the conversation, which is where Android draws it.
                ForEach(this.detachedNotices, (notice: RemoteRuntimeNotice) => {
                  ListItem() {
                    RuntimeNoticeCard({
                      colors: this.colors,
                      notice: notice,
                      busy: this.noticeBusy,
                      errorMessage: this.noticeError,
                      notificationOnly: notice.type === 'notification',
                      onRespond: (actionId: string, input: Object | null) => {
                        this.onRespondNotice(notice.noticeId, actionId, input);
                      },
                    })
                  }
                }, (notice: RemoteRuntimeNotice) => `notice-${notice.noticeId}`)
                ListItem() {
                  Column().height(24)
                }
              }
              .width('100%')
              .height('100%')
              .scrollBar(BarState.Off)
              .padding({ left: 20, right: 20 })
              .onScrollIndex((start: number, end: number) => {
                this.firstVisibleIndex = start;
                if (this.initialJumpDone && start <= LOAD_OLDER_VISIBLE_THRESHOLD
                  && this.state.hasMore && !this.loadingOlder) {
                  this.onLoadOlder();
                }
              })
              .onDidScroll((offset: number, scrollState: ScrollState) => {
                if (this.isProgrammaticScroll()) {
                  return;
                }
                if (scrollState !== ScrollState.Idle) {
                  this.scrollingNow = true;
                  this.pauseAutoFollow();
                }
                this.showScrollToBottom = !this.atLatest();
              })
              .onScrollStop(() => {
                this.scrollingNow = false;
                const atEnd: boolean = this.atLatest();
                this.showScrollToBottom = !atEnd;
                if (atEnd) {
                  this.releaseReadLock();
                }
              })

              if (this.showScrollToBottom) {
                this.ScrollToBottomButton()
              }
            }
            .width('100%')
            .height('100%')
          }
        }
      .width('100%')
      .layoutWeight(1)
      // Blocking notices sit between the timeline and the composer, so answering
      // one never requires scrolling.
      if (this.blockingNotices.length > 0) {
        BlockingRuntimeNoticeStack({
          colors: this.colors,
          notices: this.blockingNotices,
          busy: this.noticeBusy,
          onRespond: (noticeId: string, actionId: string, input: Object | null) => {
            this.onRespondNotice(noticeId, actionId, input);
          },
        })
      }

      // Working indicator, above the composer.
      if (this.state.isTurnActive()) {
        Row({ space: 8 }) {
          LoadingProgress().width(16).height(16).color(this.colors.muted)
          Text(this.workingLabel())
            .fontSize(13)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.muted)
        }
        .width('100%')
        .padding({ left: 22, bottom: 6 })
        .alignItems(VerticalAlign.Center)
      }

      // The slash-command panel replaces nothing: Android stacks it between the
      // blocking notices and the composer.
      if (this.commandMode()) {
        RuntimeCommandSuggestions({
          colors: this.colors,
          commands: this.activeCommands(),
          query: this.commandQuery(),
          loading: this.commands.isLoading,
          errorMessage: this.commandUnavailableReason(),
          onRetry: () => this.loadCommands(true),
          onSelect: (command: RuntimeCommand) => this.selectCommand(command),
        })
          .padding({ left: 14, right: 14, bottom: 6 })
      }

      this.Composer()
    }
    .width('100%')
    .height('100%')
  }

  /**
   * The inline navigation bar.
   *
   * iOS's `ChatPageToolbar` sets `.navigationBarTitleDisplayMode(.inline)` and
   * puts the title at `.headline` with a `.caption` subtitle line carrying the
   * status — "no header view sits in the timeline". Android's floating pill,
   * circular buttons and 88dp veil are replaced by that: a 44dp bar on the
   * canvas, the back glyph on the leading edge, the title and its status line in
   * the middle, and this app's two entry points (runtime settings, agent files)
   * as bare 44dp glyphs on the trailing side.
   */
  @Builder
  Header() {
    Row({ space: 10 }) {
      this.HeaderGlyphButton(AA_ICONS.CHEVRON_LEFT, $r('app.string.common_back'), () => this.onBack())

      Column({ space: 1 }) {
        Text(this.title())
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Row({ space: 4 }) {
          if (this.state.isTurnActive()) {
            LoadingProgress().width(12).height(12).color(this.colors.muted)
          }
          Text(this.statusLine())
            .fontSize(12)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      this.HeaderGlyphButton(AA_ICONS.SLIDERS_HORIZONTAL, $r('app.string.session_runtime_settings_title'),
        () => {
          this.showRuntimeSettings = true;
          this.onOpenRuntimeSettings();
        })
      this.HeaderGlyphButton(AA_ICONS.TERMINAL, $r('app.string.common_files'), () => this.onOpenAgentFiles())
    }
    .width('100%')
    .height(44)
    .padding({ left: 6, right: 6 })
    .alignItems(VerticalAlign.Center)
  }

  /** The bar's title line: the runtime label, then the workspace. */
  private statusLine(): string {
    const session: AgentSession | null = this.session;
    const workspace: string = session === null ? '' : session.workspaceLabel;
    return [this.runtimeLabel(), workspace]
      .filter((part: string) => part.length > 0)
      .join(' · ');
  }

  /** One 44dp square of the navigation bar, with no surface of its own. */
  @Builder
  HeaderGlyphButton(commands: string, label: Resource, onTap: () => void) {
    Column() {
      AAIcon({ commands: commands, iconSize: 20, color: this.colors.ink })
    }
    .width(44)
    .height(44)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(label)
    .onClick(() => onTap())
  }

  /**
   * The "return to the newest message" affordance.
   *
   * Android draws a 48dp circle on the raised surface with a 1dp border, a 10dp
   * shadow and a 16dp down arrow, pinned to the bottom centre of the list. Here
   * it sits 16dp above the list's bottom edge, because this port's composer is a
   * sibling of the list rather than floating over it, so Android's 168dp
   * composer inset does not apply.
   */
  @Builder
  ScrollToBottomButton() {
    Column() {
      AAIcon({ commands: AA_ICONS.ARROW_DOWN, iconSize: 16, color: this.colors.ink })
    }
    .width(48)
    .height(48)
    .justifyContent(FlexAlign.Center)
    .borderRadius(24)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    .shadow({ radius: 10, color: this.colors.appShadow, offsetX: 0, offsetY: 0 })
    .margin({ bottom: 16 })
    .onClick(() => {
      this.animateToLatest();
    })
  }

  /**
   * Animates to the newest row.
   *
   * Android jumps to within `RETURN_TO_LATEST_ANIMATION_WINDOW` items first so a
   * long conversation does not animate through hundreds of rows; the same window
   * is used here.
   */
  private animateToLatest(): void {
    const last: number = this.lastRowIndex();
    const current: number = this.firstVisibleIndex;
    this.beganProgrammaticScroll();
    // A long conversation is jumped close to the end first, so the animation
    // covers a bounded number of rows, exactly as Android does.
    if (last - current > RETURN_TO_LATEST_ANIMATION_WINDOW) {
      this.timelineScroller.scrollToIndex(last - RETURN_TO_LATEST_ANIMATION_WINDOW,
        false, ScrollAlign.START);
    }
    this.timelineScroller.scrollToIndex(last > 0 ? last : 0, true, ScrollAlign.END);
    this.releaseReadLock();
  }

  /**
   * Index of the last rendered row.
   *
   * It mirrors the order the list is built in — optional spinner, conversation
   * rows, detached notices, bottom spacer — so the two must change together.
   */
  private lastRowIndex(): number {
    const loading: number = this.loadingOlder ? 1 : 0;
    return loading + this.state.renderItems.length + this.detachedNotices.length;
  }

  /** The oldest-page spinner: 22dp, 8dp vertical padding, centred. */
  @Builder
  OlderMessagesLoadingIndicator() {
    Column() {
      LoadingProgress().width(22).height(22).color(this.colors.ink)
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  RuntimeSettingsSheet() {
    SessionRuntimeSettingsSheet({
      colors: this.colors,
      settings: this.runtimeSettings,
      runtimeLabel: this.runtimeLabel(),
      onDismiss: () => {
        this.showRuntimeSettings = false;
      },
      onRetryModels: () => this.onRetryRuntimeCatalogs(),
      onRetryPermissions: () => this.onRetryRuntimeCatalogs(),
      onSelectModel: (selectionId: string) => {
        this.onSelectRuntime(SelectionScope.MODEL, selectionId);
      },
      onSelectPermission: (selectionId: string) => {
        this.onSelectRuntime(SelectionScope.PERMISSION, selectionId);
      },
    })
  }

  @Builder
  Composer() {
    // iOS's `ChatComposer`: one glass rounded container — hairline, no drop shadow
    // — with 12dp side insets and a 10dp bottom inset, the editor at 17sp and the
    // 40dp send circle at the trailing edge.
    Column({ space: 10 }) {
      if (this.attachments.length > 0) {
        PendingAttachmentStrip({
          colors: this.colors,
          attachments: this.attachments,
          onRemove: (attachment: PendingAttachment) => this.onRemoveAttachment(attachment),
          onRetry: (attachment: PendingAttachment) => this.onRetryAttachment(attachment),
          onPreview: (attachment: PendingAttachment) => this.onPreviewComposerAttachment(attachment),
        })
      }

      TextInput({ text: this.draft, placeholder: this.placeholder() })
        .placeholderColor(this.colors.muted)
        .placeholderFont({ size: 17 })
        .fontSize(17)
        .fontColor(this.colors.ink)
        .backgroundColor('#00000000')
        .borderRadius(0)
        .padding(0)
        .height(40)
        .enabled(this.inputEnabled())
        .onChange((next: string) => {
          const wasCommand: boolean = this.draft.trimStart().startsWith('/');
          this.draft = next;
          this.onDraftChange(next);
          // Android's effect on `commandMode`: entering command mode loads the
          // catalog once, and a retry is only offered from the panel.
          if (!wasCommand && next.trimStart().startsWith('/') && this.canUseCommands()) {
            this.loadCommands(false);
          }
        })

      Row() {
        // Attach entry point, then the takeover toggle, exactly as Android
        // orders them: a 30dp "+" circle followed by the 30x18 switch.
        Row({ space: 9 }) {
          this.AttachButton()

          // iOS's `.toggleStyle(.switch)`: a 51x31 track, green when on, with a
          // 27dp white knob; Android's 30x18 switch is gone.
          Row({ space: 8 }) {
            Stack({ alignContent: this.takeoverEnabled() ? Alignment.End : Alignment.Start }) {
              Column()
                .width(51)
                .height(31)
                .borderRadius(15.5)
                .backgroundColor(this.takeoverEnabled()
                  ? '#34C759'
                  : (this.colors.isDark ? '#39393D' : '#E9E9EA'))
              Column()
                .width(27)
                .height(27)
                .borderRadius(13.5)
                .backgroundColor('#FFFFFF')
                .shadow({ radius: 3, color: '#1F000000', offsetX: 0, offsetY: 1 })
                .margin({ left: 2, right: 2 })
            }
            .width(51)
            .height(31)
            Text($r('app.string.session_takeover'))
              .fontSize(13)
              .fontColor(this.takeoverEnabled() ? this.colors.ink : this.colors.muted)
          }
          .alignItems(VerticalAlign.Center)
          .opacity(this.state.takeoverBusy || !this.deviceOnline ? 0.5 : 1)
          .onClick(() => {
            if (!this.state.takeoverBusy && this.deviceOnline) {
              this.onToggleTakeover(!this.takeoverEnabled());
            }
          })
        }
        .alignItems(VerticalAlign.Center)

        Blank().layoutWeight(1)

        // Interrupt replaces send while a turn is active; iOS swaps the glyph on
        // the same circle rather than switching to a red one.
        if (this.canInterrupt()) {
          Column() {
            if (this.state.interrupting) {
              LoadingProgress().width(17).height(17).color(this.colors.onPrimaryAction)
            } else {
              Column()
                .width(10)
                .height(10)
                .borderRadius(2)
                .backgroundColor(this.colors.onPrimaryAction)
            }
          }
          .width(40)
          .height(40)
          .justifyContent(FlexAlign.Center)
          .borderRadius(20)
          .backgroundColor(this.colors.primaryAction)
          .onClick(() => this.onInterrupt())
        } else {
          Column() {
            if (this.state.sending) {
              LoadingProgress().width(17).height(17).color(this.colors.onPrimaryAction)
            } else {
              AAIcon({
                commands: AA_ICONS.ARROW_UP,
                iconSize: 18,
                color: this.colors.onPrimaryAction,
              })
            }
          }
          .width(40)
          .height(40)
          .justifyContent(FlexAlign.Center)
          .borderRadius(20)
          .backgroundColor(this.canSubmit()
            ? this.colors.primaryAction
            : this.colors.sessionStatusNeutralSurface)
          .opacity(this.canSubmit() ? 1 : 0.42)
          .onClick(() => this.submitComposer())
        }
      }
      .width('100%')
      .height(44)
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 12 })
    .margin({ left: 12, right: 12, bottom: 10 })
    .borderRadius(26)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.isDark ? this.colors.border : '#3C3C43' })
    .opacity(1)
  }

  /** The 44dp "+" target that opens the attach menu; iOS draws a 24dp glyph. */
  @Builder
  AttachButton() {
    Column() {
      AAIcon({
        commands: AA_ICONS.PLUS,
        iconSize: 24,
        color: this.colors.ink,
      })
    }
    .width(44)
    .height(44)
    .justifyContent(FlexAlign.Center)
    .opacity(this.attachmentsEnabled() && !this.commandMode() ? 1 : 0.45)
    .onClick(() => {
      if (this.attachmentsEnabled() && !this.commandMode()) {
        this.showAttachMenu = true;
      }
    })
    // A menu rather than a popup: `bindPopup` would report its dismissal through
    // `PopupStateChangeParam`, whose field is gated to a newer SDK than this
    // project targets, while `MenuOptions.onDisappear` is available since 11.
    .bindMenu(this.showAttachMenu, this.AttachMenu(), {
      placement: Placement.BottomLeft,
      // Android offsets the menu by (14, -34) from the composer's bottom-left,
      // which lifts it clear of the 34dp action row.
      offset: { x: 14, y: -34 },
      enableArrow: false,
      onDisappear: () => {
        this.showAttachMenu = false;
      },
    })
  }

  @Builder
  AttachMenu() {
    AttachSourceMenu({
      colors: this.colors,
      onCamera: () => {
        this.showAttachMenu = false;
        this.onOpenCamera();
      },
      onPhoto: () => {
        this.showAttachMenu = false;
        this.onPickPhoto();
      },
      onFile: () => {
        this.showAttachMenu = false;
        this.onPickFile();
      },
    })
  }
}

/**
 * One timeline row.
 *
 * The layout rules come straight from Android: user text is a right-aligned
 * bubble capped at 78% of the width, agent text is full width with no
 * background, and tool activity collapses into a single 34dp chevron row whose
 * summary is 13sp monospace.
 */
@Component
export struct SessionTimelineRow {
  colors: AAColors = AA_LIGHT_COLORS;
  item: TimelineRenderItem = { key: '', messages: [], kind: TimelineRenderKind.Single, parentItemId: null };
  /** Notices attached to this row, shown once the row is expanded. */
  notices: RemoteRuntimeNotice[] = [];
  noticeBusy: boolean = false;
  noticeError: string = '';
  onRespondNotice: (noticeId: string, actionId: string, input: Object | null) => void = () => {};
  /** Attachment callbacks, forwarded from the screen. */
  onPreviewAttachment: (attachment: TimelineAttachment) => void = () => {};
  onOpenAttachment: (attachment: TimelineAttachment) => void = () => {};
  loadAttachment: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);
  @State private expanded: boolean = false;

  private first(): TimelineMessage | null {
    return this.item.messages.length > 0 ? this.item.messages[0] : null;
  }

  private summary(): string {
    if (this.item.kind === TimelineRenderKind.ToolRun) {
      return toolRunSummary(this.item.messages);
    }
    if (this.item.kind === TimelineRenderKind.Reconnect) {
      return reconnectSummary(this.item.messages);
    }
    if (this.item.kind === TimelineRenderKind.AgentCalls) {
      return agentCallGroupSummary(this.item.messages);
    }
    const message: TimelineMessage | null = this.first();
    return message === null ? '' : toolActivitySummary(message);
  }

  build() {
    if (this.item.kind === TimelineRenderKind.Single) {
      this.SingleRow()
    } else {
      this.ActivityHeader()
    }
  }

  @Builder
  SingleRow() {
    if (this.first() !== null && this.first()!.author === MessageAuthor.User) {
      // User bubble: attachments above the bubble, right aligned, capped width.
      Column({ space: 7 }) {
        MessageAttachmentStrip({
          colors: this.colors,
          attachments: this.first()!.attachments,
          alignEnd: true,
          onPreview: this.onPreviewAttachment,
          onOpen: this.onOpenAttachment,
          load: this.loadAttachment,
        })
        if (this.userText().length > 0) {
          // iOS's `UserMessageBubble`: a content-sized bubble right-aligned behind a
          // 48dp spacer, 17sp body text, 17x12 padding and a 24dp radius — not
          // Android's fixed 78%-wide bubble.
          Row() {
            Blank().width(48)
            Column({ space: 7 }) {
              Text(this.userText())
                .fontSize(17)
                .fontColor(this.colors.sessionMessageText)
                .lineHeight(22)
              if (this.first()!.status === 'failed') {
                Text($r('app.string.session_status_failed'))
                  .fontSize(11)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.colors.errorIcon)
              }
            }
            .alignItems(HorizontalAlign.Start)
            .padding({ left: 17, right: 17, top: 12, bottom: 12 })
            .borderRadius(24)
            .backgroundColor(this.colors.sessionMessageBubble)
          }
          .width('100%')
          .justifyContent(FlexAlign.End)
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.End)
    } else if (this.first() !== null && this.first()!.author === MessageAuthor.Agent
      && this.first()!.kind === TimelineMessageKind.Text) {
      // Agent text is Markdown, matching Android's commonmark rendering, with any
      // attachments the platform attached to the same message below it.
      Column({ space: 8 }) {
        if (this.first()!.text.length > 0) {
          AgentMarkdownText({
            colors: this.colors,
            text: this.first()!.text,
          })
        }
        MessageAttachmentStrip({
          colors: this.colors,
          attachments: this.first()!.attachments,
          alignEnd: false,
          onPreview: this.onPreviewAttachment,
          onOpen: this.onOpenAttachment,
          load: this.loadAttachment,
        })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    } else if (this.first() !== null && this.first()!.kind === TimelineMessageKind.Reasoning) {
      AgentMarkdownText({
        colors: this.colors,
        text: this.first()!.reasoningSegments.length > 0
          ? this.first()!.reasoningSegments.join('\n\n')
          : this.first()!.text,
        compact: true,
      })
    } else {
      this.ActivityHeader()
    }
  }

  /**
   * The bubble's text.
   *
   * Android drops the placeholder body when the message carries attachments, so
   * a photo sent with no caption does not show `(No text content.)`.
   */
  private userText(): string {
    const message: TimelineMessage | null = this.first();
    if (message === null) {
      return '';
    }
    const text: string = message.text.replace(/[\r\n]+$/, '');
    if (text === '(No text content.)' && message.attachments.length > 0) {
      return '';
    }
    return text;
  }

  @Builder
  ActivityHeader() {
    // iOS's `TimelineMarkerRow`: a 10dp reveal chevron, a 15dp symbol in an 18dp
    // box and the summary at 15sp monospace — `subheadline` monospaced — on a 44dp
    // row with no surface of its own. Android's 13sp/34dp row with a grouped
    // background is gone.
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Row() {
          AAIcon({
            commands: this.expanded ? AA_ICONS.CHEVRON_DOWN : AA_ICONS.CHEVRON_RIGHT,
            iconSize: 10,
            color: this.colors.muted,
          })
        }
        .width(10)
        .justifyContent(FlexAlign.Center)

        Row() {
          AAIcon({
            commands: this.activityIcon(),
            iconSize: 15,
            color: this.isFailed() ? this.colors.errorIcon : this.colors.muted,
          })
        }
        .width(18)
        .justifyContent(FlexAlign.Center)

        Text(this.summary())
          .fontSize(15)
          .fontFamily('monospace')
          .fontColor(this.isFailed() ? this.colors.errorIcon : this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .constraintSize({ minHeight: 44 })
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.expanded = !this.expanded;
      })

      if (this.expanded) {
        this.ActivityDetail()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  ActivityDetail() {
    Column({ space: 8 }) {
      ForEach(this.item.messages, (message: TimelineMessage) => {
        Column({ space: 4 }) {
          if (message.detail.length > 0) {
            Text(message.detail)
              .fontSize(12)
              .fontFamily('monospace')
              .fontColor(this.colors.inkSoft)
              .width('100%')
          }
          if (message.text.length > 0 && message.text !== message.detail) {
            Text(message.text)
              .fontSize(12)
              .fontFamily('monospace')
              .fontColor(this.colors.muted)
              .width('100%')
          }
          if (message.rawContent.length > 0) {
            Text(message.rawContent)
              .fontSize(11.5)
              .fontFamily('monospace')
              .fontColor(this.colors.muted)
              .width('100%')
              .padding(8)
              .borderRadius(8)
              .backgroundColor(this.colors.sessionCodeSurface)
          }
          // File changes carry a unified diff, which is drawn with the same
          // added/deleted line tones the Android client uses.
          if (message.fileChanges.length > 0) {
            ForEach(message.fileChanges, (change: TimelineFileChange) => {
              this.DiffBlock(change)
            }, (change: TimelineFileChange) => `diff-${message.id}-${change.path}`)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }, (message: TimelineMessage) => `detail-${message.id}`)

      // Approvals attached to this item render here, which is where Android puts
      // them: the request sits next to the command it is about.
      ForEach(this.notices, (notice: RemoteRuntimeNotice) => {
        RuntimeNoticeCard({
          colors: this.colors,
          notice: notice,
          busy: this.noticeBusy,
          errorMessage: this.noticeError,
          notificationOnly: notice.type === 'notification',
          onRespond: (actionId: string, input: Object | null) => {
            this.onRespondNotice(notice.noticeId, actionId, input);
          },
        })
      }, (notice: RemoteRuntimeNotice) => `attached-${notice.noticeId}`)
    }
    .width('100%')
    .padding({ left: 30, top: 4, bottom: 4 })
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * One file change's diff.
   *
   * Android finds the preview empty for a change with no body and shows the
   * placeholder, so the same fallback is applied here.
   */
  @Builder
  DiffBlock(change: TimelineFileChange) {
    Column({ space: 4 }) {
      // iOS's `TimelineFileChangeView`: a document glyph, the action in a small
      // quaternary chip and the path at 12sp monospace with middle truncation, on a
      // 44dp row.
      Row({ space: 8 }) {
        AAIcon({ commands: AA_ICONS.FILE_TEXT, iconSize: 15, color: this.colors.muted })

        if (change.action.length > 0) {
          Text(change.action)
            .fontSize(11)
            .fontColor(this.colors.muted)
            .padding(5)
            .borderRadius(5)
            .backgroundColor(this.colors.subtle)
        }

        Text(change.path)
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor(this.colors.muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .constraintSize({ minHeight: 44 })
      .padding({ left: 12, right: 12 })
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.colors.subtle)
      .borderRadius(12)
      Scroll() {
        Column() {
          ForEach(diffPreview(change.diff).lines, (line: DiffLine, index: number) => {
            Text(line.text.length > 0 ? line.text : ' ')
              .fontSize(11.5)
              .fontFamily('monospace')
              .fontColor(this.colors.inkSoft)
              .width('100%')
              .padding({ left: 8, right: 8 })
              .backgroundColor(diffToneBackground(line.tone, this.colors.isDark))
          }, (line: DiffLine, index: number) => `diffline-${index}`)
        }
        .alignItems(HorizontalAlign.Start)
        .padding({ top: 6, bottom: 6 })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .borderRadius(8)
      .backgroundColor(this.colors.sessionCodeSurface)
      .border({ width: 1, color: this.colors.border })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  private activityIcon(): string {
    const message: TimelineMessage | null = this.first();
    if (message === null) {
      return AA_ICONS.HAMMER;
    }
    if (message.kind === TimelineMessageKind.Command) {
      return AA_ICONS.TERMINAL;
    }
    if (message.kind === TimelineMessageKind.AgentCall) {
      return AA_ICONS.USER_ROUND;
    }
    if (message.kind === TimelineMessageKind.FileChange || message.kind === TimelineMessageKind.Artifact) {
      return AA_ICONS.PENCIL;
    }
    return AA_ICONS.HAMMER;
  }

  private isFailed(): boolean {
    const message: TimelineMessage | null = this.first();
    return message !== null && (message.toolError || message.status === 'failed');
  }
}

/** Header height constant kept close to the row that uses it. */
export const SESSION_HEADER_HEIGHT: number = AAHeight.HEADER;
