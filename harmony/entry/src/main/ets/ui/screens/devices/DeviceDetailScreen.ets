import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { AALog } from '../../../common/AAAppLog';
import { AgentDevice, AgentSession } from '../../../model/AgentSession';
import { RuntimeInstanceLabels, runtimeInstanceLabels } from '../../../model/RuntimeIdentity';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import {
  DeviceDetailState, deviceDetailState,
} from '../../../feature/devices/DeviceDetailState';
import {
  DeviceRuntimeManagementState, runtimeCanActivate,
} from '../../../feature/devices/DeviceRuntimeState';
import { DeviceRuntimeStatus, RemoteDeviceRuntime } from '../../../api/DevicesDtos';
import { DeviceActionsSheet } from './DeviceActionsSheet';
import { DeviceConfirmAction, DeviceActionConfirmDialog } from './DeviceConfirmDialog';

/**
 * Device detail page.
 *
 * Port of `ui/screens/devices/DeviceDetailScreen.kt`.
 *
 * Two sections under a 64dp header:
 *
 *  - **AGENTS** — the configured runtimes in Codex/Claude/DSH order, each a 72dp
 *    row with a 14dp status dot (a spinner while an operation is pending), the
 *    runtime's primary and secondary labels at 16.5sp bold and 11.5sp medium, a
 *    32x20 switch and a 32dp delete button; a 12.5sp hint row follows, and a
 *    retry button appears when the inventory could not be read.
 *  - **SESSIONS** — the Active/Archived/All pill row (34dp pills, 14dp bold or
 *    semi-bold), a Select / Archive-all action pair in the section header, an
 *    optional bulk bar (44dp, 8dp radius, a 20dp selection circle, the selected
 *    count in 11.5sp monospace and a 30dp pill action), then 52dp session rows
 *    with a 14dp list glyph, the title at 16sp bold and the 10.8sp monospace time.
 *
 * Geometry and type sizes are Android's; the fonts use numeric weights, so
 * Android's SemiBold is 600 and ExtraBold is 800.
 *
 * Not in this pass, and tracked: the device actions sheet (rename, revoke,
 * delete, reconnect) with its confirm dialogs, and the runtime configuration
 * sheet. Their buttons are rendered and disabled rather than omitted.
 */
@Component
export struct DeviceDetailScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  state: SessionsState = SessionsState.empty();
  deviceId: string | null = null;
  runtimes: DeviceRuntimeManagementState = DeviceRuntimeManagementState.empty();
  /** Bulk-operation latch, mirroring Android's `sessionBulkBusy`. */
  bulkBusy: boolean = false;
  /** Bulk-operation feedback, surfaced as this screen's toast. */
  deviceNotice: ResourceStr = '';
  @Prop @Watch('onDeviceNoticeChanged') deviceNoticeRequest: number;
  onBack: () => void = () => {};
  /**
   * Split layout: the leading glyph folds the shell's sidebar, because this page
   * is what a device row in the sidebar opens (iOS's `DeviceManagementView`).
   */
  sidebarToggle: boolean = false;
  onToggleSidebar: () => void = () => {};
  /** The device's workspace files, which iOS opens from this page. */
  onOpenFiles: () => void = () => {};
  /** The standalone terminal, which only this app has. */
  onOpenTerminal: () => void = () => {};
  onOpenSession: (session: AgentSession) => void = () => {};
  onRetryRuntimes: () => void = () => {};
  onSetRuntimeActive: (runtime: RemoteDeviceRuntime, active: boolean) => void = () => {};
  onDeleteRuntimeConfig: (runtime: RemoteDeviceRuntime) => void = () => {};
  onBulkSetArchived: (sessionIds: string[], archived: boolean) => void = () => {};
  /** Archive-all for the current filter scope, after its confirmation. */
  onArchiveAll: (archived: boolean, scope: string, scopeLabel: string) => void = () => {};
  /** Device actions sheet: rename, token action and delete. */
  onRenameDevice: (name: string) => void = () => {};
  onDeleteDevice: () => void = () => {};
  onPrepareDeviceSetup: () => void = () => {};
  /** Actions-sheet state, owned by the app so a rename failure survives a redraw. */
  actionsOpen: boolean = false;
  actionBusy: boolean = false;
  actionError: string = '';
  onCloseActions: () => void = () => {};
  onOpenActions: () => void = () => {};
  /** Confirmation dialog, or `undefined` when none is open. */
  confirmAction: DeviceConfirmAction | undefined = undefined;
  onDismissConfirm: () => void = () => {};
  onConfirmAction: () => void = () => {};

  @State private filter: DeviceSessionsFilter = DeviceSessionsFilter.Active;
  @State private selectMode: boolean = false;
  @State private selectedIds: string[] = [];
  private toast: AAToastState = new AAToastState();
  @State private toastRevision: number = 0;

  /** Android routes bulk results through the screen's snackbar host. */
  onDeviceNoticeChanged(): void {
    if (this.deviceNoticeRequest > 0) {
      this.toast.show(this.deviceNotice, false);
      this.toastRevision += 1;
    }
  }

  private detail(): DeviceDetailState {
    return deviceDetailState(this.state, this.deviceId);
  }

  /** The rows the current filter shows, in Android's order. */
  private visibleSessions(): AgentSession[] {
    const detail: DeviceDetailState = this.detail();
    if (this.filter === DeviceSessionsFilter.Active) {
      return detail.activeSessions;
    }
    if (this.filter === DeviceSessionsFilter.Archived) {
      return detail.archivedSessions;
    }
    const all: AgentSession[] = detail.activeSessions.concat(detail.archivedSessions);
    all.sort((left: AgentSession, right: AgentSession) => {
      if (left.sortKey === right.sortKey) {
        return 0;
      }
      return left.sortKey < right.sortKey ? 1 : -1;
    });
    return all;
  }

  private selectedCount(): number {
    let count: number = 0;
    for (const session of this.visibleSessions()) {
      if (this.selectedIds.includes(session.id)) {
        count++;
      }
    }
    return count;
  }

  private allSelected(): boolean {
    const sessions: AgentSession[] = this.visibleSessions();
    if (sessions.length === 0) {
      return false;
    }
    for (const session of sessions) {
      if (!this.selectedIds.includes(session.id)) {
        return false;
      }
    }
    return true;
  }

  /** Android's `targetArchivedForSelection`. */
  private targetArchived(): boolean {
    if (this.filter === DeviceSessionsFilter.Archived) {
      return false;
    }
    if (this.filter === DeviceSessionsFilter.Active) {
      return true;
    }
    for (const session of this.visibleSessions()) {
      if (this.selectedIds.includes(session.id) && !session.archived) {
        return true;
      }
    }
    return false;
  }

  private showToast(message: ResourceStr, isError: boolean): void {
    this.toast.show(message, isError);
    this.toastRevision += 1;
  }

  /**
   * The scope label as text.
   *
   * The dialog builds its title with `$r(..., scopeLabel)`, and `$r` parameters
   * must be plain strings, so the label is resolved here through the resource
   * manager's id overload — the one overload of `getStringSync` that is not
   * deprecated.
   */
  private scopeLabelText(): string {
    const resource: Resource = archiveScopeLabel(this.filter);
    try {
      const context = this.getUIContext().getHostContext();
      if (context === undefined) {
        return '';
      }
      return context.resourceManager.getStringSync(resource.id);
    } catch (error) {
      AALog.debug('Scope label could not be resolved');
      return '';
    }
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        this.Header()

        List({ space: 18 }) {
          if (this.detail().device === null) {
            ListItem() {
              this.MissingDevice()
            }
          } else {
            ListItem() {
              this.AgentsSection()
            }
            ListItem() {
              this.WorkspaceSection()
            }
            ListItem() {
              this.SessionsSection()
            }
          }
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .padding({ left: 24, right: 24, bottom: 28 })
      }
      .width('100%')
      .height('100%')

      AAToastHost({
        colors: this.colors,
        message: this.toast.message,
        isError: this.toast.isError,
        actionLabel: this.toast.actionLabel,
        visible: this.toast.visible,
        onAction: () => this.toast.hide(),
      })

      // Android hosts the confirmation in a modal Dialog; the same card is drawn
      // here in a scrim so the busy rule stays identical without a controller.
      if (this.confirmAction !== undefined) {
        DeviceActionConfirmDialog({
          colors: this.colors,
          action: this.confirmAction,
          busy: this.actionBusy,
          errorMessage: this.actionError,
          onDismiss: () => this.onDismissConfirm(),
          onConfirm: () => this.onConfirmAction(),
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .bindSheet($$this.actionsOpen, this.ActionsSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: false,
      showClose: false,
      backgroundColor: '#00000000',
      maskColor: withAlpha('#000000', this.colors.isDark ? 0.56 : 0.28),
      shouldDismiss: (sheetDismiss: SheetDismiss) => {
        if (this.actionBusy) {
          return;
        }
        this.onCloseActions();
        sheetDismiss.dismiss();
      },
    })
  }

  @Builder
  ActionsSheet() {
    DeviceActionsSheet({
      colors: this.colors,
      deviceName: this.detail().device === null ? '' : (this.detail().device as AgentDevice).name,
      deviceOnline: this.detail().device !== null && (this.detail().device as AgentDevice).online,
      busy: this.actionBusy,
      errorMessage: this.actionError,
      onDismiss: () => this.onCloseActions(),
      onRename: (name: string) => this.onRenameDevice(name),
      onPrepareSetup: () => this.onPrepareDeviceSetup(),
      onDelete: () => this.onDeleteDevice(),
    })
  }

  /**
   * Header: a 38dp round back button, the device name at 25sp/29sp extra-bold
   * beside the 13sp status label, and a 38dp round actions button.
   */
  @Builder
  Header() {
    // iOS's `DeviceAgentSection` sets the device name as an inline navigation
    // title; the online state becomes its `navigationSubtitle` line, and the
    // actions menu stays a bare trailing glyph. Android's 25sp/800 name and two
    // bordered circles are gone.
    AAIosInlineBar({
      colors: this.colors,
      title: this.detail().device === null ? '' : (this.detail().device as AgentDevice).name,
      subtitle: this.deviceStatusText(),
      onBack: () => this.onBack(),
      sidebarToggle: this.sidebarToggle,
      onToggleSidebar: () => this.onToggleSidebar(),
      trailingSlots: 1,
    }) {
      this.HeaderGlyphButton(AA_ICONS.ELLIPSIS, $r('app.string.device_detail_device_actions'),
        () => this.onOpenActions())
    }
  }

  /** The bar's subtitle: iOS's `Connected` / `Offline` line. */
  private deviceStatusText(): ResourceStr {
    const device: AgentDevice | null = this.detail().device;
    if (device === null) {
      return '';
    }
    return device.online
      ? $r('app.string.devices_online')
      : $r('app.string.devices_offline');
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

  @Builder
  MissingDevice() {
    Column() {
      Text($r('app.string.device_detail_not_found'))
        .fontSize(24)
        .fontWeight(800)
        .fontColor(this.colors.ink)
      Column().height(8)
      Text($r('app.string.device_detail_refresh_try_again'))
        .fontSize(14)
        .fontWeight(500)
        .fontColor(this.colors.muted)
    }
    .width('100%')
    .padding({ top: 120 })
    .alignItems(HorizontalAlign.Center)
  }

  // ------------------------------------------------------------------ agents

  @Builder
  AgentsSection() {
    Column({ space: 4 }) {
      this.SectionTitle($r('app.string.device_detail_agents_section'))

      if (this.runtimes.loading && this.runtimes.runtimes.length === 0) {
        Row({ space: 10 }) {
          LoadingProgress().width(18).height(18).color(this.colors.ink)
          this.EmptyText($r('app.string.device_runtime_loading'))
        }
        .width('100%')
        .height(56)
        .alignItems(VerticalAlign.Center)
      } else {
        if (this.runtimes.errorMessage !== null) {
          Text(this.runtimes.errorMessage)
            .fontSize(12.5)
            .lineHeight(17)
            .fontWeight(600)
            .fontColor(this.colors.errorText)
            .padding({ bottom: 8 })
            .width('100%')
        }

        if (this.runtimes.configuredRuntimes().length === 0) {
          this.EmptyText($r('app.string.device_runtime_no_configured'))
        } else {
          ForEach(this.runtimes.configuredRuntimes(), (runtime: RemoteDeviceRuntime, index: number) => {
            Column() {
              ConfiguredAgentRow({
                colors: this.colors,
                runtime: runtime,
                pending: this.runtimes.pendingRuntimeId === runtime.id,
                operationsEnabled: this.runtimes.operationsEnabled(),
                onSetActive: (active: boolean) => this.onSetRuntimeActive(runtime, active),
                onDeleteConfig: () => this.onDeleteRuntimeConfig(runtime),
              })
              if (index !== this.runtimes.configuredRuntimes().length - 1) {
                Column()
                  .width('100%')
                  .height(1)
                  .backgroundColor(this.colors.border)
              }
            }
            .width('100%')
          }, (runtime: RemoteDeviceRuntime) => `runtime-${runtime.id}`)
        }

        Row({ space: 8 }) {
          AAIcon({ commands: AA_ICONS.CIRCLE_ALERT, iconSize: 15, color: this.colors.muted })
          Text($r('app.string.device_runtime_desktop_configuration_hint'))
            .fontSize(12.5)
            .lineHeight(17)
            .fontWeight(500)
            .fontColor(this.colors.muted)
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ top: 14, bottom: 2 })
        .alignItems(VerticalAlign.Center)

        if (this.runtimes.errorMessage !== null) {
          SmallActionButton({
            colors: this.colors,
            commands: AA_ICONS.REFRESH,
            label: $r('app.string.common_retry'),
            danger: false,
            rowEnabled: !this.runtimes.loading && !this.runtimes.discovering,
            loading: false,
            onTap: () => this.onRetryRuntimes(),
          })
        }
      }
    }
    .width('100%')
  }

  // ---------------------------------------------------------------- sessions

  @Builder
  SessionsSection() {
    Column({ space: 4 }) {
      Row() {
        this.SectionTitle($r('app.string.device_detail_sessions_section'))
        Blank().layoutWeight(1)
        Row({ space: 8 }) {
          MiniTextAction({
            colors: this.colors,
            label: this.selectMode ? $r('app.string.common_cancel') : $r('app.string.common_select'),
            rowEnabled: this.visibleSessions().length > 0 && !this.bulkBusy,
            primary: false,
            onTap: () => {
              this.selectMode = !this.selectMode;
              this.selectedIds = [];
            },
          })
          if (!this.selectMode) {
            MiniTextAction({
              colors: this.colors,
              label: this.filter === DeviceSessionsFilter.Archived
                ? $r('app.string.device_detail_unarchive_all')
                : $r('app.string.device_detail_archive_all'),
              rowEnabled: this.visibleSessions().length > 0 && !this.bulkBusy,
              primary: false,
              onTap: () => {
                // Android confirms before touching every session on the device,
                // and its dialog text interpolates the scope's own label.
                this.onArchiveAll(
                  this.filter !== DeviceSessionsFilter.Archived,
                  archiveScope(this.filter),
                  this.scopeLabelText(),
                );
              },
            })
          }
        }
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(34)
      .alignItems(VerticalAlign.Center)

      Row({ space: 18 }) {
        this.FilterTag($r('app.string.home_tab_active'), DeviceSessionsFilter.Active)
        this.FilterTag($r('app.string.home_tab_archived'), DeviceSessionsFilter.Archived)
        this.FilterTag($r('app.string.common_all'), DeviceSessionsFilter.All)
      }
      .width('100%')
      .height(44)
      .padding({ bottom: 8 })
      .alignItems(VerticalAlign.Center)

      if (this.selectMode) {
        this.BulkBar()
      }

      if (this.visibleSessions().length === 0) {
        this.EmptyText(
          this.filter === DeviceSessionsFilter.Active
            ? $r('app.string.device_detail_no_active_sessions')
            : (this.filter === DeviceSessionsFilter.Archived
              ? $r('app.string.device_detail_no_archived_sessions')
              : $r('app.string.device_detail_no_sessions')),
        )
      } else {
        ForEach(this.visibleSessions(), (session: AgentSession, index: number) => {
          Column() {
            SessionDetailRow({
              colors: this.colors,
              session: session,
              selectMode: this.selectMode,
              selected: this.selectedIds.includes(session.id),
              onTap: () => {
                if (this.selectMode) {
                  this.toggleSession(session.id);
                } else {
                  this.onOpenSession(session);
                }
              },
            })
            if (index !== this.visibleSessions().length - 1) {
              Column()
                .width('100%')
                .height(1)
                .backgroundColor(this.colors.isDark ? '#27272A' : '#E9E8E5')
            }
          }
          .width('100%')
        }, (session: AgentSession) => `session-${session.id}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  private toggleSession(sessionId: string): void {
    if (this.selectedIds.includes(sessionId)) {
      this.selectedIds = this.selectedIds.filter((id: string) => id !== sessionId);
      return;
    }
    this.selectedIds = this.selectedIds.concat([sessionId]);
  }

  @Builder
  FilterTag(label: ResourceStr, value: DeviceSessionsFilter) {
    Column() {
      Text(label)
        .fontSize(14)
        .fontWeight(this.filter === value ? 700 : 600)
        .fontColor(this.filter === value
          ? this.colors.ink
          : (this.colors.isDark ? '#A1A1AA' : '#8A8A88'))
        .maxLines(1)
    }
    .height(34)
    .padding({ left: 14, right: 14 })
    .borderRadius(17)
    .backgroundColor(this.filter === value
      ? (this.colors.isDark ? '#27272A' : '#ECECE9')
      : '#00000000')
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      this.filter = value;
      this.selectedIds = [];
    })
  }

  @Builder
  BulkBar() {
    Row({ space: 10 }) {
      Row({ space: 7 }) {
        SelectionCircle({ colors: this.colors, selected: this.allSelected() })
        Text($r('app.string.common_all'))
          .fontSize(12.5)
          .fontWeight(700)
          .fontColor(this.colors.muted)
      }
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        if (this.bulkBusy) {
          return;
        }
        this.selectedIds = this.allSelected()
          ? []
          : this.visibleSessions().map((session: AgentSession) => session.id);
      })

      Text($r('app.string.device_detail_selected_count', this.selectedCount()))
        .fontSize(11.5)
        .fontFamily('monospace')
        .fontWeight(600)
        .fontColor(this.colors.faint)
        .maxLines(1)
        .layoutWeight(1)

      MiniTextAction({
        colors: this.colors,
        label: this.bulkBusy
          ? $r('app.string.common_working')
          : (this.targetArchived()
            ? $r('app.string.device_detail_archive_selected')
            : $r('app.string.device_detail_unarchive_selected')),
        rowEnabled: this.selectedCount() > 0 && !this.bulkBusy,
        primary: true,
        onTap: () => {
          if (this.bulkBusy || this.selectedIds.length === 0) {
            return;
          }
          this.onBulkSetArchived(this.selectedIds, this.targetArchived());
          this.selectMode = false;
          this.selectedIds = [];
        },
      })
    }
    .width('100%')
    .height(44)
    .padding({ left: 10, right: 10 })
    .borderRadius(8)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#F6F6F4')
    .border({ width: 1, color: this.colors.border })
    .alignItems(VerticalAlign.Center)
  }

  // ----------------------------------------------------------------- pieces

  /**
   * The device's files and terminal.
   *
   * iOS browses a device's workspaces and projects on this page and opens
   * `WorkspaceFilesSheet` from a row; this is the same entry point, pointing at
   * this app's files page, plus the terminal page Android reaches from home.
   */
  @Builder
  WorkspaceSection() {
    Column({ space: 8 }) {
      this.SectionTitle($r('app.string.new_session_workspace'))

      this.WorkspaceRow(AA_ICONS.FOLDER, $r('app.string.common_files'), () => this.onOpenFiles())
      this.WorkspaceRow(AA_ICONS.TERMINAL, $r('app.string.common_terminal'),
        () => this.onOpenTerminal())
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** One row of the workspace section, in this page's filled-row shape. */
  @Builder
  WorkspaceRow(iconCommands: string, label: ResourceStr, action: () => void) {
    Row({ space: 10 }) {
      AAIcon({ commands: iconCommands, iconSize: 18, color: this.colors.ink })

      Text(label)
        .fontSize(15)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .layoutWeight(1)

      AAIcon({ commands: AA_ICONS.CHEVRON_RIGHT, iconSize: 18, color: this.colors.faint })
    }
    .width('100%')
    .height(52)
    .padding({ left: 14, right: 14 })
    .borderRadius(8)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : '#F6F6F4')
    .border({ width: 1, color: this.colors.border })
    .alignItems(VerticalAlign.Center)
    .onClick(() => action())
  }

  @Builder
  SectionTitle(title: ResourceStr) {
    Text(title)
      .fontSize(14)
      .fontWeight(700)
      .fontColor(this.colors.faint)
      .maxLines(1)
  }

  @Builder
  EmptyText(text: ResourceStr) {
    Text(text)
      .fontSize(13)
      .lineHeight(17)
      .fontWeight(500)
      .fontColor(this.colors.muted)
      .padding({ top: 14, bottom: 14 })
      .width('100%')
  }
}

/** The devices page filter, in Android's order. */
export enum DeviceSessionsFilter {
  Active = 0,
  Archived = 1,
  All = 2,
}

/** Android's `DeviceSessionsFilter.archiveScope()`. */
export function archiveScope(filter: DeviceSessionsFilter): string {
  if (filter === DeviceSessionsFilter.Active) {
    return 'active';
  }
  return filter === DeviceSessionsFilter.Archived ? 'archived' : 'all';
}

/** Android's `DeviceSessionsFilter.archiveScopeLabelRes()`. */
export function archiveScopeLabel(filter: DeviceSessionsFilter): Resource {
  if (filter === DeviceSessionsFilter.Active) {
    return $r('app.string.device_detail_all_active_sessions');
  }
  return filter === DeviceSessionsFilter.Archived
    ? $r('app.string.device_detail_all_archived_sessions')
    : $r('app.string.device_detail_all_sessions');
}

/** `online` / `offline` beside the device name. */
@Component
struct DeviceStatusLabel {
  colors: AAColors = AA_LIGHT_COLORS;
  online: boolean = false;

  private statusColor(): string {
    return this.online ? '#10B981' : this.colors.muted;
  }

  build() {
    Row({ space: 6 }) {
      AAIcon({
        commands: this.online ? AA_ICONS.CIRCLE_CHECK : AA_ICONS.CIRCLE,
        iconSize: 16,
        color: this.online ? this.statusColor() : withAlpha(this.statusColor(), 0.4),
      })
      Text(this.online ? $r('app.string.devices_online') : $r('app.string.devices_offline'))
        .fontSize(13)
        .lineHeight(16)
        .fontWeight(500)
        .fontColor(this.statusColor())
        .maxLines(1)
    }
    .alignItems(VerticalAlign.Center)
  }
}

/** One configured runtime: dot, labels, switch, delete. */
@Component
struct ConfiguredAgentRow {
  colors: AAColors = AA_LIGHT_COLORS;
  runtime: RemoteDeviceRuntime = {
    connectorId: '',
    id: '',
    type: '',
    displayName: '',
    present: false,
    configured: false,
    active: false,
    status: DeviceRuntimeStatus.UNKNOWN,
    discovery: JSON.parse('{}') as Object,
    metadata: JSON.parse('{}') as Object,
    schema: null,
    uiSchema: JSON.parse('{}') as Object,
    config: null,
    error: null,
    lastDiscoveredAt: null,
    updatedAt: null,
  };
  pending: boolean = false;
  operationsEnabled: boolean = true;
  onSetActive: (active: boolean) => void = () => {};
  onDeleteConfig: () => void = () => {};

  private runtimeSecondary(): string {
    const labels: RuntimeInstanceLabels =
      runtimeInstanceLabels(this.runtime.displayName, this.runtime.type);
    return labels.secondary ?? '';
  }

  private runtimePrimary(): string {
    const labels: RuntimeInstanceLabels =
      runtimeInstanceLabels(this.runtime.displayName, this.runtime.type);
    return labels.primary;
  }

  private dotColor(): string {
    const status: string = this.runtime.status;
    if (status === DeviceRuntimeStatus.RUNNING) {
      return this.colors.runtimeRunning;
    }
    if (status === DeviceRuntimeStatus.ERROR) {
      return this.colors.errorIcon;
    }
    if (status === DeviceRuntimeStatus.STARTING || status === DeviceRuntimeStatus.STOPPING) {
      return this.colors.runtimeTransitioning;
    }
    return this.runtime.active ? this.colors.runtimeActive : this.colors.runtimeInactive;
  }

  /** Android's `runtimeStatusLabel`, resolved to the resource it names. */
  private statusLabel(): ResourceStr {
    const status: string = this.runtime.status;
    if (!this.runtime.present) {
      return $r('app.string.device_runtime_not_present');
    }
    if (!this.runtime.configured) {
      return $r('app.string.device_runtime_not_configured');
    }
    if (status === DeviceRuntimeStatus.STOPPED) {
      return $r('app.string.device_runtime_stopped');
    }
    if (status === DeviceRuntimeStatus.DISCOVERING) {
      return $r('app.string.device_runtime_discovering');
    }
    if (status === DeviceRuntimeStatus.AVAILABLE) {
      return $r('app.string.device_runtime_available');
    }
    if (status === DeviceRuntimeStatus.UNAVAILABLE) {
      return $r('app.string.device_runtime_unavailable');
    }
    if (status === DeviceRuntimeStatus.VALIDATING) {
      return $r('app.string.device_runtime_validating');
    }
    if (status === DeviceRuntimeStatus.STARTING) {
      return $r('app.string.device_runtime_starting');
    }
    if (status === DeviceRuntimeStatus.RUNNING) {
      return $r('app.string.device_runtime_running');
    }
    if (status === DeviceRuntimeStatus.STOPPING) {
      return $r('app.string.device_runtime_stopping');
    }
    if (status === DeviceRuntimeStatus.ERROR) {
      return $r('app.string.device_runtime_error');
    }
    return $r('app.string.device_runtime_unknown');
  }

  build() {
    Row({ space: 12 }) {
      // 14dp status indicator: a spinner while pending, else an 8dp dot.
      Column() {
        if (this.pending) {
          LoadingProgress().width(14).height(14).color(this.colors.muted)
        } else {
          Column()
            .width(8)
            .height(8)
            .borderRadius(4)
            .backgroundColor(this.dotColor())
        }
      }
      .width(14)
      .height(14)
      .justifyContent(FlexAlign.Center)

      Column() {
        Text(this.runtimePrimary())
          .fontSize(16.5)
          .fontWeight(700)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        // Android joins the runtime's secondary label with its status text; the
        // status is always present, so the separator follows the secondary half.
        Text() {
          if (this.runtimeSecondary().length > 0) {
            Span(this.runtimeSecondary())
            Span(' · ')
          }
          Span(this.statusLabel())
        }
        .fontSize(11.5)
        .fontWeight(500)
        .fontColor(this.runtime.status === DeviceRuntimeStatus.ERROR
          ? this.colors.errorText
          : this.colors.muted)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Row({ space: 8 }) {
        WebRuntimeSwitch({
          colors: this.colors,
          checked: this.runtime.active,
          rowEnabled: !this.pending && this.operationsEnabled
            && (this.runtime.active || runtimeCanActivate(this.runtime)),
          onToggle: (active: boolean) => this.onSetActive(active),
        })
        AgentIconButton({
          colors: this.colors,
          commands: AA_ICONS.TRASH,
          rowEnabled: !this.pending && this.operationsEnabled && this.runtime.configured,
          description: $r('app.string.device_detail_remove_agent'),
          onTap: () => this.onDeleteConfig(),
        })
      }
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .constraintSize({ minHeight: 72 })
    .padding({ top: 5, bottom: 5 })
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * Android's `WebRuntimeSwitch`: a 32x20 track with a 2dp border, a 16dp thumb at
 * x=2 or x=14, and a 1dp shadow under the thumb.
 */
@Component
struct WebRuntimeSwitch {
  colors: AAColors = AA_LIGHT_COLORS;
  checked: boolean = false;
  rowEnabled: boolean = true;
  onToggle: (active: boolean) => void = () => {};

  build() {
    Stack({ alignContent: this.checked ? Alignment.End : Alignment.Start }) {
      Column()
        .width(32)
        .height(20)
        .borderRadius(16)
        .backgroundColor(this.checked
          ? this.colors.runtimeSwitchCheckedTrack
          : this.colors.runtimeSwitchUncheckedTrack)
        .border({
          width: 2,
          color: this.checked ? this.colors.runtimeSwitchCheckedTrack : '#00000000',
        })
      Column()
        .width(16)
        .height(16)
        .borderRadius(8)
        .backgroundColor(this.checked
          ? this.colors.runtimeSwitchCheckedThumb
          : this.colors.runtimeSwitchUncheckedThumb)
        .shadow({ radius: 1, color: '#22000000', offsetX: 0, offsetY: 0 })
        .margin({ left: 2, right: 2 })
    }
    .width(32)
    .height(20)
    .opacity(this.rowEnabled ? 1 : 0.5)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onToggle(!this.checked);
      }
    })
  }
}

/** 20dp selection circle: filled with a check when selected. */
@Component
struct SelectionCircle {
  colors: AAColors = AA_LIGHT_COLORS;
  selected: boolean = false;

  private fill(): string {
    if (!this.selected) {
      return '#00000000';
    }
    return this.colors.isDark ? '#E4E4E7' : '#181816';
  }

  build() {
    Column() {
      if (this.selected) {
        AAIcon({
          commands: AA_ICONS.CHECK,
          iconSize: 13,
          color: this.colors.isDark ? '#181816' : '#FFFFFF',
        })
      }
    }
    .width(20)
    .height(20)
    .justifyContent(FlexAlign.Center)
    .borderRadius(10)
    .backgroundColor(this.fill())
    .border({
      width: 1,
      color: this.selected ? this.fill() : this.colors.border,
    })
  }
}

/** One session row: optional selection circle, list glyph, title and time. */
@Component
struct SessionDetailRow {
  colors: AAColors = AA_LIGHT_COLORS;
  session: AgentSession | null = null;
  selectMode: boolean = false;
  selected: boolean = false;
  onTap: () => void = () => {};

  build() {
    Row({ space: 12 }) {
      if (this.selectMode) {
        SelectionCircle({ colors: this.colors, selected: this.selected })
      }
      AAIcon({ commands: AA_ICONS.LIST, iconSize: 14, color: this.colors.faint })
      Text(this.session === null ? '' : this.session.title)
        .fontSize(16)
        .lineHeight(20)
        .fontWeight(700)
        .fontColor(this.colors.inkSoft)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Text(this.session === null || this.session.updatedAtLabel.length === 0
        ? $r('app.string.common_now')
        : this.session.updatedAtLabel)
        .fontSize(10.8)
        .fontFamily('monospace')
        .fontWeight(600)
        .fontColor(this.colors.faint)
        .maxLines(1)
    }
    .width('100%')
    .height(52)
    .padding({ top: 4, bottom: 4 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onTap())
  }
}

/** Android's `MiniTextAction`: a 30dp pill at 12.5sp bold. */
@Component
export struct MiniTextAction {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  rowEnabled: boolean = true;
  primary: boolean = false;
  onTap: () => void = () => {};

  private surface(): string {
    if (this.primary) {
      return this.colors.isDark ? '#E4E4E7' : '#181816';
    }
    return this.colors.isDark ? this.colors.subtle : '#ECECE9';
  }

  private contentColor(): string {
    if (this.primary) {
      return this.colors.isDark ? '#181816' : '#FFFFFF';
    }
    return this.colors.ink;
  }

  build() {
    Column() {
      Text(this.label)
        .fontSize(12.5)
        .fontWeight(700)
        .fontColor(withAlpha(this.contentColor(), this.rowEnabled ? 1 : 0.6))
        .maxLines(1)
    }
    .height(30)
    .padding({ left: 11, right: 11 })
    .borderRadius(15)
    .backgroundColor(withAlpha(this.surface(), this.rowEnabled ? 1 : 0.45))
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** Android's `SmallActionButton`: a 34dp 6dp-rounded icon+label button. */
@Component
export struct SmallActionButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  label: ResourceStr = '';
  danger: boolean = false;
  rowEnabled: boolean = true;
  loading: boolean = false;
  onTap: () => void = () => {};

  private surface(): string {
    if (this.danger) {
      return this.colors.isDark ? '#2A1418' : '#FFF3F3';
    }
    return this.colors.isDark ? this.colors.subtle : '#F4F4F2';
  }

  private tint(): string {
    if (this.danger) {
      return this.colors.isDark ? '#F87171' : '#B94848';
    }
    return this.colors.ink;
  }

  build() {
    Row({ space: 5 }) {
      if (this.loading) {
        LoadingProgress().width(15).height(15).color(this.tint())
      } else {
        AAIcon({
          commands: this.commands,
          iconSize: 15,
          color: withAlpha(this.tint(), this.rowEnabled ? 1 : 0.4),
        })
      }
      Text(this.label)
        .fontSize(14)
        .fontWeight(700)
        .fontColor(withAlpha(this.tint(), this.rowEnabled ? 1 : 0.4))
        .maxLines(1)
    }
    .height(34)
    .padding({ left: 11, right: 11 })
    .borderRadius(6)
    .backgroundColor(this.surface())
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** Android's `AgentIconButton`: a 32dp tap target with a 16dp glyph. */
@Component
struct AgentIconButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  rowEnabled: boolean = true;
  /**
   * Android's `contentDescription`, where the glyph is the whole button.
   *
   * A `Resource`, not a `ResourceStr`: `accessibilityText` has separate overloads
   * for a string and a resource and rejects the union.
   */
  description: Resource = $r('app.string.common_delete');
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.commands,
        iconSize: 16,
        color: withAlpha(this.colors.muted, this.rowEnabled ? 1 : 0.5),
      })
    }
    .width(32)
    .height(32)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(this.description)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}
