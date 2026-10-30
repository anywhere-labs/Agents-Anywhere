import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { AAIosInlineBar, AAIosPrimaryButton } from '../../designsystem/AAIosChrome';
import { AALog } from '../../../common/AAAppLog';
import { copyTextToClipboard } from '../../../common/AAClipboard';
import { resolveString } from '../../../common/AAResources';
import { AgentDevice, AgentProject, AgentSession } from '../../../model/AgentSession';
import { runtimeInstanceName, runtimeTypeDisplayName } from '../../../model/RuntimeIdentity';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import {
  DeviceDetailState, deviceDetailState,
} from '../../../feature/devices/DeviceDetailState';
import {
  DeviceRuntimeManagementState, runtimeCanActivate,
} from '../../../feature/devices/DeviceRuntimeState';
import {
  DeviceRuntimeStatus, RemoteDeviceRuntime, RemoteRuntimeType,
} from '../../../api/DevicesDtos';
import { DeviceActionsSheet } from './DeviceActionsSheet';
import { AddDeviceAgentSheet, RuntimeConfigurationSheet } from './RuntimeConfigSheets';
import { DeviceConfirmAction, DeviceActionConfirmDialog } from './DeviceConfirmDialog';
import {
  ProjectArchiveDialog, ProjectEditSheet,
} from '../home/HomeProjectActions';
import { compareProjectsByActivity } from '../home/HomeScreen';

/** The two contents the runtime `bindSheet` can show; `''` is closed. */
const RUNTIME_SHEET_CONFIG: string = 'config';
const RUNTIME_SHEET_ADD: string = 'add';
/** How long a dismissed sheet is given before its body may be emptied. */
const SHEET_DISMISS_MS: number = 400;

/**
 * Device detail page.
 *
 * The iOS client's device page (`Views/Devices/DeviceManagementView.swift`): a
 * scroll column, 28dp between its blocks, of
 *
 *  1. the **Agent Runtime** section (`DeviceAgentSection`) — a subheadline
 *     caption with a trailing 44dp rediscovery button, then a grouped card whose
 *     rows are the runtime's name, its "type · status" line and the on/off
 *     switch, with iOS's context menu (删除配置) on a long press;
 *  2. the **设备内容** switcher — the caption plus a segmented 项目/会话 control;
 *  3. either the **project list** (`DeviceProjectList`): an "N 个项目" caption
 *     with a trailing plus, and a row per project — folder glyph, name, path in
 *     monospace, session count, a folder button (files) and a new-session
 *     button; or the **session list** (`DeviceSessionList`): the project picker,
 *     the session options menu and the new-session button in one row, a
 *     segmented 活跃/已归档/全部 filter, then the session rows.
 *
 * Each of those cards is iOS's `DeviceOverviewSections` GroupBox: one rounded
 * 28dp surface in the palette's grouped fill, a `Divider()` between rows and 8dp
 * of vertical padding per row. The fill is `colors.subtle` rather than
 * `glassFill()`, because this is a *grouped system surface* — not the glass
 * material — and the palette already carries that token in both appearances
 * (`#F1F0ED` light, `#292929` dark).
 *
 * What the port keeps from Android: the bulk-selection bar, its rules and the
 * archive-all confirmation; the runtime switch's pending/disabled rules; and the
 * toast host. The `工作目录` block is gone — its two entries live on a project
 * row (文件) and in the device actions sheet (终端), which is where iOS puts
 * them.
 */
@Component
export struct DeviceDetailScreen {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  /**
   * The session list behind the page.
   *
   * `@Prop`, not a plain member: `destination` stays `DeviceDetail` while the
   * user goes from one device to another, so ArkUI *reuses* this component
   * instead of building a new one. A plain member is only applied at creation,
   * so the page kept the first device's data — which is why picking another
   * device in the sidebar left the page showing the old one.
   */
  @Prop state: SessionsState = SessionsState.empty();
  /** `@Prop` for the same reason: the page has to re-point at the new device. */
  @Prop deviceId: string | null = null;
  /**
   * The device's runtime inventory.
   *
   * `@Prop`, and this one is the reported bug: `openDevice()` sets the loading
   * state *before* it navigates, so the page is born on "正在加载运行时…" and the
   * answer that arrives afterwards could never replace it — a plain member is
   * never written again. The page showed the spinner for good.
   */
  @Prop runtimes: DeviceRuntimeManagementState = DeviceRuntimeManagementState.empty();
  /** Bulk-operation latch, mirroring Android's `sessionBulkBusy`. */
  @Prop bulkBusy: boolean = false;
  /** Bulk-operation feedback, surfaced as this screen's toast. */
  @Prop deviceNotice: ResourceStr = '';
  @Prop @Watch('onDeviceNoticeChanged') deviceNoticeRequest: number;
  onBack: () => void = () => {};
  /**
   * Split layout: the leading glyph folds the shell's sidebar, because this page
   * is what a device row in the sidebar opens (iOS's `DeviceManagementView`).
   */
  sidebarToggle: boolean = false;
  onToggleSidebar: () => void = () => {};
  /**
   * A project row's folder button: the device's files at that project's
   * workspace path. iOS opens `WorkspaceFilesSheet` from the same button, with
   * the project's `workspacePath` as its `initialPath`.
   */
  onOpenFiles: (path: string) => void = () => {};
  /** The standalone terminal, which iOS's device page does not carry. */
  onOpenTerminal: () => void = () => {};
  onOpenSession: (session: AgentSession) => void = () => {};
  /**
   * The new-session button, on both a project row and the session header.
   *
   * iOS passes the project id of the row it was pressed on; this port's
   * new-session page has no project preset (see the port plan), so the button
   * opens its picker — which is what the app's own sidebar rows do.
   */
  onNewSession: () => void = () => {};
  /** The project list's trailing plus, iOS's `onCreate` on `DeviceProjectList`. */
  onCreateProject: () => void = () => {};
  /**
   * A project's context-menu actions.
   *
   * They return a promise because the app owns the request and this screen owns
   * the sheet's or the dialog's busy and error state: the screen awaits the
   * write and keeps its own UI open on a rejection. iOS's `perform {}` splits
   * the same way, with `repository.canWrite` and the toast store in the app.
   */
  onRenameProject: (project: AgentProject, name: string) => Promise<void> =
    () => Promise.reject(new Error('Renaming a project is not connected.'));
  onToggleProjectPin: (project: AgentProject) => Promise<void> =
    () => Promise.reject(new Error('Updating a project is not connected.'));
  onArchiveProject: (project: AgentProject) => Promise<void> =
    () => Promise.reject(new Error('Archiving a project is not connected.'));
  onRetryRuntimes: () => void = () => {};
  onSetRuntimeActive: (runtime: RemoteDeviceRuntime, active: boolean) => void = () => {};
  onDeleteRuntimeConfig: (runtime: RemoteDeviceRuntime) => void = () => {};
  /**
   * The runtime configuration sheet's write.
   *
   * A promise for the same reason as the project writes above: the app owns the
   * request, this screen owns the sheet's busy and error state, and an awaited
   * rejection is what keeps the sheet open with the Server's message.
   */
  onSaveRuntimeConfig: (runtime: RemoteDeviceRuntime, config: Object) => Promise<void> =
    () => Promise.reject(new Error('Saving a runtime configuration is not connected.'));
  /**
   * The add-Agent sheet's data and write.
   *
   * iOS's `DeviceAgentModel` reads inventory and types together; here the app
   * loads the types when the sheet opens and the device's instances are already
   * the `runtimes` prop above, which is what the addable rule counts.
   */
  @Prop runtimeTypes: RemoteRuntimeType[] = [];
  @Prop runtimeTypesLoading: boolean = false;
  @Prop runtimeTypesError: string | null = null;
  onRediscoverRuntimeTypes: () => void = () => {};
  /**
   * Adds a runtime, mirroring iOS's `addRuntime`: it re-reads the inventory,
   * reuses a cleared or already-configured instance of the type when it can, and
   * only then creates a new one. `name` is `null` for the quick-add path.
   */
  onAddRuntime: (
    type: RemoteRuntimeType,
    name: string | null,
    config: Object,
    newInstance: boolean,
  ) => Promise<void> = () => Promise.reject(new Error('Adding a runtime is not connected.'));
  onBulkSetArchived: (sessionIds: string[], archived: boolean) => void = () => {};
  /** Archive-all for the current filter scope, after its confirmation. */
  onArchiveAll: (archived: boolean, scope: string, scopeLabel: string) => void = () => {};
  /** Device actions sheet: rename, token action and delete. */
  onRenameDevice: (name: string) => void = () => {};
  onDeleteDevice: () => void = () => {};
  onPrepareDeviceSetup: () => void = () => {};
  /**
   * Actions-sheet state, owned by the app so a rename failure survives a redraw.
   *
   * All four are `@Prop`, not plain members. They are app state that changes
   * after this screen exists, and a plain member is written only at creation, so
   * with plain members the sheet could not re-open and — worse —
   * `confirmAction` never left `undefined`, which gates the confirmation card:
   * every confirmed action on this page (delete a runtime's config from the new
   * long-press menu, archive all, delete the device) would call the app and then
   * show nothing.
   */
  @Prop actionsOpen: boolean = false;
  @Prop actionBusy: boolean = false;
  @Prop actionError: string = '';
  onCloseActions: () => void = () => {};
  onOpenActions: () => void = () => {};
  /** Confirmation dialog, or `undefined` when none is open. */
  @Prop confirmAction: DeviceConfirmAction | undefined = undefined;
  onDismissConfirm: () => void = () => {};
  onConfirmAction: () => void = () => {};

  /** iOS's `DeviceOverviewTab`: which collection the 设备内容 switcher shows. */
  @State private tab: DeviceOverviewTab = DeviceOverviewTab.Projects;
  @State private filter: DeviceSessionsFilter = DeviceSessionsFilter.Active;
  @State private selectMode: boolean = false;
  @State private selectedIds: string[] = [];
  /** Project whose sessions the session list shows, or `null` for every one. */
  @State private projectFilter: string | null = null;
  @State private projectMenuOpen: boolean = false;
  @State private sessionMenuOpen: boolean = false;
  /** Project whose rename sheet is open, or `null` when none is. */
  @State private editingProject: AgentProject | null = null;
  /** Project whose archive confirmation is open, or `null` when none is. */
  @State private archivingProject: AgentProject | null = null;
  /** True while a project write is in flight; disables both project surfaces. */
  @State private projectBusy: boolean = false;
  /** The last project write's failure, shown inside the rename sheet. */
  @State private projectError: string = '';
  /**
   * The toast queue.
   *
   * `@State`, not a plain member: `AAToastState.show` writes the fields the host
   * reads, and ArkUI observes the properties of a `@State` object — a plain
   * member left the host rendering the values it was built with.
   */
  @State private toast: AAToastState = new AAToastState();
  /**
   * Which runtime sheet is open: `''`, `'config'` or `'add'`.
   *
   * Both surfaces share one `bindSheet`, so only one can ever be open, and the
   * content branch keys off this instead of a second sheet modifier — ArkUI
   * keeps only the last `bindSheet` on a node.
   */
  @State private runtimeSheetMode: string = '';
  /** The runtime whose configuration sheet is open, or `null`. */
  @State private configTarget: RemoteDeviceRuntime | null = null;
  /** True while either sheet's write is in flight; the host refuses a dismiss. */
  @State private runtimeSheetBusy: boolean = false;
  @State private runtimeSheetOpen: boolean = false;

  /** Android routes bulk results through the screen's snackbar host. */
  onDeviceNoticeChanged(): void {
    if (this.deviceNoticeRequest > 0) {
      this.toast.show(this.deviceNotice, false);
    }
  }

  private detail(): DeviceDetailState {
    return deviceDetailState(this.state, this.deviceId);
  }

  private device(): AgentDevice | null {
    return this.detail().device;
  }

  private deviceName(): string {
    const device: AgentDevice | null = this.device();
    return device === null ? '' : device.name;
  }

  /** The rows the current filter and project scope show, in Android's order. */
  private visibleSessions(): AgentSession[] {
    const detail: DeviceDetailState = this.detail();
    let rows: AgentSession[];
    if (this.filter === DeviceSessionsFilter.Active) {
      rows = detail.activeSessions;
    } else if (this.filter === DeviceSessionsFilter.Archived) {
      rows = detail.archivedSessions;
    } else {
      const all: AgentSession[] = detail.activeSessions.concat(detail.archivedSessions);
      all.sort((left: AgentSession, right: AgentSession) => {
        if (left.sortKey === right.sortKey) {
          return 0;
        }
        return left.sortKey < right.sortKey ? 1 : -1;
      });
      rows = all;
    }
    const projectId: string | null = this.projectFilter;
    if (projectId === null) {
      return rows;
    }
    return rows.filter((session: AgentSession) => session.projectId === projectId);
  }

  /**
   * This device's projects, in the sidebar's order.
   *
   * iOS's `deviceProjects` filters by connector id and floats pinned projects;
   * the rest keep `compareProjectsByActivity`, which is the order the sidebar
   * shows them in.
   */
  private deviceProjects(): AgentProject[] {
    const device: AgentDevice | null = this.device();
    if (device === null) {
      return [];
    }
    const owned: AgentProject[] = this.state.projects.filter(
      (project: AgentProject) => project.connectorId === device.id,
    );
    const pinned: AgentProject[] = owned.filter((project: AgentProject) => project.pinned);
    const regular: AgentProject[] = owned
      .filter((project: AgentProject) => !project.pinned)
      .sort(compareProjectsByActivity(this.state));
    return pinned.concat(regular);
  }

  /** The project the session list is scoped to, or `null` for every project. */
  private selectedProject(): AgentProject | null {
    const projectId: string | null = this.projectFilter;
    if (projectId === null) {
      return null;
    }
    for (const project of this.deviceProjects()) {
      if (project.id === projectId) {
        return project;
      }
    }
    return null;
  }

  /** The project name iOS prints under a session title, or an empty string. */
  private projectNameFor(session: AgentSession): string {
    const projectId: string | null = session.projectId;
    if (projectId === null) {
      return '';
    }
    for (const project of this.state.projects) {
      if (project.id === projectId) {
        return project.name;
      }
    }
    return '';
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

  // ------------------------------------------------------------ project writes

  private openProjectRename(project: AgentProject): void {
    if (this.projectBusy) {
      return;
    }
    this.projectError = '';
    this.editingProject = project;
  }

  private async submitProjectRename(name: string): Promise<void> {
    const project: AgentProject | null = this.editingProject;
    if (project === null || this.projectBusy) {
      return;
    }
    this.projectBusy = true;
    this.projectError = '';
    try {
      await this.onRenameProject(project, name);
      this.projectBusy = false;
      this.editingProject = null;
      this.showToast($r('app.string.home_project_updated'), false);
    } catch (error) {
      this.projectBusy = false;
      this.projectError = error instanceof Error
        ? error.message
        : resolveString($r('app.string.home_project_update_failed'));
    }
  }

  private requestProjectArchive(project: AgentProject): void {
    if (this.projectBusy) {
      return;
    }
    this.projectError = '';
    this.archivingProject = project;
  }

  private async confirmProjectArchive(): Promise<void> {
    const project: AgentProject | null = this.archivingProject;
    if (project === null || this.projectBusy) {
      return;
    }
    this.projectBusy = true;
    try {
      await this.onArchiveProject(project);
      this.projectBusy = false;
      this.archivingProject = null;
      this.showToast($r('app.string.home_project_archived'), false);
    } catch (error) {
      this.projectBusy = false;
      this.showToast(error instanceof Error
        ? error.message
        : resolveString($r('app.string.home_project_archive_failed')), true);
    }
  }

  private async toggleProjectPin(project: AgentProject): Promise<void> {
    const nextPinned: boolean = !project.pinned;
    try {
      await this.onToggleProjectPin(project);
      this.showToast(nextPinned
        ? $r('app.string.home_project_pinned')
        : $r('app.string.home_project_unpinned'), false);
    } catch (error) {
      this.showToast(error instanceof Error
        ? error.message
        : resolveString($r('app.string.home_project_update_failed')), true);
    }
  }

  private async copyProjectPath(project: AgentProject): Promise<void> {
    const copied: boolean = await copyTextToClipboard(project.workspacePath);
    if (copied) {
      this.showToast($r('app.string.files_copied_path'), false);
    }
  }

  /** iOS's `openProjectSessions`: scope the session list, then show it. */
  private openProjectSessions(project: AgentProject): void {
    this.projectFilter = project.id;
    this.filter = DeviceSessionsFilter.Active;
    this.selectedIds = [];
    this.tab = DeviceOverviewTab.Sessions;
  }

  private toggleSession(sessionId: string): void {
    if (this.selectedIds.includes(sessionId)) {
      this.selectedIds = this.selectedIds.filter((id: string) => id !== sessionId);
      return;
    }
    this.selectedIds = this.selectedIds.concat([sessionId]);
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        this.Header()

        List({ space: 28 }) {
          if (this.device() === null) {
            ListItem() {
              this.MissingDevice()
            }
          } else {
            ListItem() {
              this.AgentRuntimeSection()
            }
            ListItem() {
              this.ContentSwitcher()
            }
            if (this.tab === DeviceOverviewTab.Projects) {
              ListItem() {
                this.ProjectSection()
              }
            } else {
              ListItem() {
                this.SessionSection()
              }
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
      // The runtime sheets are hosted by the page column, not by the root: ArkUI
      // keeps only the last `bindSheet` of a node and the root already carries the
      // device actions sheet. Both runtime surfaces share this one overlay, so a
      // configuration sheet and the add-Agent flow can never be open together.
      .bindSheet($$this.runtimeSheetOpen, this.RuntimeSheet(), {
        height: SheetSize.LARGE,
        dragBar: false,
        showClose: false,
        backgroundColor: '#00000000',
        maskColor: withAlpha('#000000', this.colors.isDark ? 0.56 : 0.28),
        shouldDismiss: (sheetDismiss: SheetDismiss) => {
          if (this.runtimeSheetBusy) {
            return;
          }
          this.closeRuntimeSheet();
          sheetDismiss.dismiss();
        },
        onDisappear: () => {
          this.closeRuntimeSheet();
        },
      })

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

      // iOS's project editor and its archive alert, reached from a project row's
      // context menu. Both are the app's own project surfaces, so the writes stay
      // wired to `SessionsController`.
      if (this.editingProject !== null) {
        ProjectEditSheet({
          colors: this.colors,
          project: this.editingProject,
          deviceName: this.deviceName(),
          busy: this.projectBusy,
          errorMessage: this.projectError,
          onCancel: () => {
            if (!this.projectBusy) {
              this.editingProject = null;
              this.projectError = '';
            }
          },
          onSave: (name: string) => {
            void this.submitProjectRename(name);
          },
        })
      }

      if (this.archivingProject !== null) {
        ProjectArchiveDialog({
          colors: this.colors,
          project: this.archivingProject,
          busy: this.projectBusy,
          onCancel: () => {
            if (!this.projectBusy) {
              this.archivingProject = null;
            }
          },
          onConfirm: () => {
            void this.confirmProjectArchive();
          },
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
      deviceName: this.deviceName(),
      deviceOnline: this.deviceOnline(),
      busy: this.actionBusy,
      errorMessage: this.actionError,
      onDismiss: () => this.onCloseActions(),
      onRename: (name: string) => this.onRenameDevice(name),
      onPrepareSetup: () => this.onPrepareDeviceSetup(),
      onOpenTerminal: () => this.onOpenTerminal(),
      onDelete: () => this.onDeleteDevice(),
    })
  }

  /**
   * The runtime configuration sheet, or the add-Agent sheet.
   *
   * Both are iOS's sheets in `DeviceAgentSection`: the first edits one runtime's
   * saved configuration, the second lists the types the device can still add.
   * The branch is driven by `runtimeSheetMode`, so closing the sheet destroys the
   * body and the next open builds a fresh draft from that target's schema.
   */
  @Builder
  RuntimeSheet() {
    if (this.runtimeSheetMode === RUNTIME_SHEET_ADD) {
      AddDeviceAgentSheet({
        colors: this.colors,
        connected: this.deviceOnline(),
        runtimeTypes: this.runtimeTypes,
        typesLoading: this.runtimeTypesLoading,
        typesError: this.runtimeTypesError,
        instances: this.runtimes.runtimes,
        onRediscover: () => this.onRediscoverRuntimeTypes(),
        onClose: () => this.closeRuntimeSheet(),
        onAddRuntime: (
          type: RemoteRuntimeType,
          name: string | null,
          config: Object,
          newInstance: boolean,
        ) => this.onAddRuntime(type, name, config, newInstance),
        onBusyChanged: (busy: boolean) => {
          this.runtimeSheetBusy = busy;
        },
      })
    } else if (this.runtimeSheetMode === RUNTIME_SHEET_CONFIG && this.configTarget !== null) {
      RuntimeConfigurationSheet({
        colors: this.colors,
        title: this.configTargetTitle(),
        subtitle: '',
        allowsNaming: false,
        initialName: '',
        saveLabel: $r('app.string.common_save'),
        canSave: this.deviceOnline(),
        schema: (this.configTarget as RemoteDeviceRuntime).schema,
        uiSchema: (this.configTarget as RemoteDeviceRuntime).uiSchema,
        defaultValues: (this.configTarget as RemoteDeviceRuntime).defaults,
        configValues: (this.configTarget as RemoteDeviceRuntime).config,
        requiresNamedInstance: false,
        onSave: (name: string, config: Object) => {
          const runtime: RemoteDeviceRuntime | null = this.configTarget;
          if (runtime === null) {
            return Promise.resolve();
          }
          return this.onSaveRuntimeConfig(runtime, config);
        },
        onDismiss: () => this.closeRuntimeSheet(),
        onBusyChanged: (busy: boolean) => {
          this.runtimeSheetBusy = busy;
        },
      })
    }
  }

  /**
   * Header: the device name as the inline title, iOS's `connectionDescription`
   * underneath it (see `connectionText`), and the actions menu as a bare glyph.
   */
  @Builder
  Header() {
    AAIosInlineBar({
      colors: this.colors,
      title: this.deviceName(),
      subtitle: this.connectionText(),
      onBack: () => this.onBack(),
      sidebarToggle: this.sidebarToggle,
      onToggleSidebar: () => this.onToggleSidebar(),
      trailingSlots: 1,
    }) {
      this.GlyphButton(AA_ICONS.ELLIPSIS, $r('app.string.device_detail_device_actions'),
        false, true, () => this.onOpenActions())
    }
  }

  /**
   * iOS's `connectionDescription`: `<deviceOs> · <Online|Device offline>`.
   *
   * The bar takes a `ResourceStr`, so the two parts are joined as text — the
   * `Span` pair Android uses needs a `Text` the caller cannot supply here.
   * `compactMap` on iOS drops a missing OS, which is the length test.
   */
  private connectionText(): string {
    const device: AgentDevice | null = this.device();
    if (device === null) {
      return '';
    }
    const os: string = device.deviceOs === null ? '' : device.deviceOs.trim();
    const status: string = device.online
      ? resolveString($r('app.string.devices_online'))
      : resolveString($r('app.string.device_connection_offline'));
    return os.length === 0 ? status : `${os} · ${status}`;
  }

  /**
   * One 44dp square of the page's chrome: a bare glyph, replaced by a small
   * spinner while the action it starts is running, and dimmed when disabled.
   */
  @Builder
  GlyphButton(
    commands: string,
    label: Resource,
    loading: boolean,
    rowEnabled: boolean,
    onTap: () => void,
  ) {
    Column() {
      if (loading) {
        LoadingProgress().width(18).height(18).color(this.colors.ink)
      } else {
        AAIcon({ commands: commands, iconSize: 20, color: this.colors.ink })
      }
    }
    .width(44)
    .height(44)
    .justifyContent(FlexAlign.Center)
    .opacity(rowEnabled ? 1 : 0.4)
    .accessibilityText(label)
    .onClick(() => {
      if (rowEnabled) {
        onTap();
      }
    })
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

  /** iOS's `Divider()`, whose colour `colors.border` drops in dark mode. */
  private dividerColor(): string {
    return this.colors.isDark ? '#27272A' : this.colors.border;
  }

  // -------------------------------------------------------------- agent runtime

  /**
   * The Agent Runtime section.
   *
   * iOS `DeviceAgentSection`: the `dashboard.device.agentRuntimes` caption with
   * `AgentRediscoveryButton` on its trailing edge, the configured runtimes in one
   * grouped card, then the footer slot — iOS's prominent "添加更多 Agent" button,
   * which opens the add-Agent sheet. Each row carries iOS's `slider.horizontal.3`
   * configuration button before its switch.
   */
  @Builder
  AgentRuntimeSection() {
    Column({ space: 12 }) {
      DeviceSectionHeader({ colors: this.colors, label: $r('app.string.device_agent_runtimes') }) {
        this.GlyphButton(
          AA_ICONS.REFRESH,
          this.runtimes.loading
            ? $r('app.string.device_agent_rediscovering')
            : $r('app.string.device_agent_rediscover'),
          this.runtimes.loading || this.runtimes.discovering,
          this.runtimeRefreshEnabled(),
          () => this.onRetryRuntimes(),
        )
      }

      if (this.runtimes.errorMessage !== null) {
        Text(this.runtimes.errorMessage)
          .fontSize(12)
          .lineHeight(16)
          .fontWeight(600)
          .fontColor(this.colors.errorText)
          .width('100%')
      }

      GroupedCard({ colors: this.colors }) {
        if (this.runtimes.loading && this.runtimes.runtimes.length === 0) {
          Row({ space: 10 }) {
            LoadingProgress().width(18).height(18).color(this.colors.ink)
            Text($r('app.string.device_runtime_loading'))
              .fontSize(12)
              .fontWeight(500)
              .fontColor(this.colors.muted)
          }
          .width('100%')
          .constraintSize({ minHeight: 44 })
          .padding({ top: 8, bottom: 8 })
          .alignItems(VerticalAlign.Center)
        } else if (this.runtimes.configuredRuntimes().length === 0) {
          this.EmptyText($r('app.string.device_runtime_no_configured'))
        } else {
          ForEach(this.runtimes.configuredRuntimes(), (runtime: RemoteDeviceRuntime, index: number) => {
            Column() {
              DeviceRuntimeRow({
                colors: this.colors,
                runtime: runtime,
                pending: this.runtimes.pendingRuntimeId === runtime.id,
                operationsEnabled: this.runtimes.operationsEnabled(),
                onConfigure: () => this.openRuntimeConfig(runtime),
                onSetActive: (active: boolean) => this.onSetRuntimeActive(runtime, active),
                onDeleteConfig: () => this.onDeleteRuntimeConfig(runtime),
              })
              if (index !== this.runtimes.configuredRuntimes().length - 1) {
                Divider().strokeWidth(1).color(this.dividerColor())
              }
            }
            .width('100%')
          }, (runtime: RemoteDeviceRuntime) => runtimeRowKey(runtime, this.runtimes))
        }
      }

      // iOS's footer: `AppGlassButton(style: .prominent)` with a plus, which is
      // `AAIosPrimaryButton` in this port's chrome.
      AAIosPrimaryButton({
        colors: this.colors,
        label: $r('app.string.device_add_more_agents'),
        iconCommands: AA_ICONS.PLUS,
        loading: false,
        buttonEnabled: true,
        onTap: () => this.openAddAgents(),
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** iOS's `.disabled(!model.connected || model.isLoading || model.busyID != nil)`. */
  private runtimeRefreshEnabled(): boolean {
    return this.runtimes.operationsEnabled() && !this.runtimes.loading;
  }

  /** iOS's `model.connected`: the connector is online. */
  private deviceOnline(): boolean {
    const device: AgentDevice | null = this.device();
    return device !== null && device.online;
  }

  private openRuntimeConfig(runtime: RemoteDeviceRuntime): void {
    this.configTarget = runtime;
    this.runtimeSheetMode = RUNTIME_SHEET_CONFIG;
    this.runtimeSheetOpen = true;
  }

  private openAddAgents(): void {
    // The type inventory is loaded with the page (see the app's `openDevice`), so
    // opening the sheet only presents it. Loading it here as well changed app
    // state in the same tick and the sheet never appeared.
    this.configTarget = null;
    this.runtimeSheetMode = RUNTIME_SHEET_ADD;
    this.runtimeSheetOpen = true;
  }

  /**
   * Dismisses whichever runtime sheet is open.
   *
   * The body is emptied only *after* the dismissal, never in the same tick.
   * `runtimeSheetMode` is what the sheet's branch reads, so clearing it while the
   * sheet closed handed ArkUI an empty page: the sheet stayed presented as an
   * empty `SheetPage` and its mask kept covering the device page, which is then
   * dimmed grey and cannot be clicked at all (measured: the page read `#B8B8B8`,
   * i.e. white under the 28% mask, with a `SheetWrapper` still in the tree).
   * The delayed clear is guarded so it cannot empty a sheet the user re-opened in
   * the meantime.
   */
  private closeRuntimeSheet(): void {
    this.runtimeSheetOpen = false;
    setTimeout(() => {
      if (!this.runtimeSheetOpen) {
        this.runtimeSheetMode = '';
        this.configTarget = null;
      }
    }, SHEET_DISMISS_MS);
  }

  /**
   * The configuration sheet's title: iOS's `Configure <displayName>`.
   *
   * It uses the same reader as the row, so the sheet names the runtime exactly
   * the way the row that opened it does.
   */
  private configTargetTitle(): ResourceStr {
    const runtime: RemoteDeviceRuntime | null = this.configTarget;
    if (runtime === null) {
      return '';
    }
    return $r('app.string.runtime_config_title',
      runtimeInstanceName(runtime.name, runtime.displayName, runtime.type));
  }

  // ------------------------------------------------------------ content switch

  /**
   * iOS's `contentSwitcher`.
   *
   * `ViewThatFits` has no ArkUI counterpart, so the two parts live in a wrapping
   * `Flex`: side by side and pushed to the edges while they fit — which is what
   * the reference does — and stacked, caption first, when they do not.
   */
  /** The picker's two labels, named once so the width matches what it draws. */
  private contentLabels(): Resource[] {
    return [$r('app.string.home_projects'), $r('app.string.device_content_sessions')];
  }

  @Builder
  ContentSwitcher() {
    Flex({
      wrap: FlexWrap.Wrap,
      justifyContent: FlexAlign.SpaceBetween,
      alignItems: ItemAlign.Center,
    }) {
      Text($r('app.string.device_content'))
        .fontSize(17)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .maxLines(1)

      Column() {
        SegmentedControl({
          colors: this.colors,
          labels: this.contentLabels(),
          selectedIndex: this.tab === DeviceOverviewTab.Sessions ? 1 : 0,
          accessibilityLabel: $r('app.string.device_content'),
          onSelect: (index: number) => {
            this.tab = index === 0 ? DeviceOverviewTab.Projects : DeviceOverviewTab.Sessions;
            this.selectedIds = [];
          },
        })
      }
      // Sized to its labels, not to the row: iOS's picker is `.fixedSize`, and the
      // stretched 180dp it used to get left the two segments twice as wide as the
      // reference (616px against the reference's 255px on a 1280px screen).
      .width(segmentedControlWidth(this.contentLabels()))
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
  }

  // ------------------------------------------------------------ project list

  /**
   * iOS's `DeviceProjectList`.
   *
   * The header is the section's own caption — "N 个项目" and the create button —
   * and the rows are `DeviceDirectoryRow`: name, path, session count and the two
   * 44dp buttons. `项目` reuses the app's `home_projects`, and the create label
   * the sidebar's own "New project" (`new_session_create_project`).
   */
  @Builder
  ProjectSection() {
    Column({ space: 12 }) {
      DeviceSectionHeader({
        colors: this.colors,
        label: $r('app.string.device_projects_count', this.deviceProjects().length),
      }) {
        this.GlyphButton(AA_ICONS.PLUS, $r('app.string.new_session_create_project'),
          false, true, () => this.onCreateProject())
      }

      GroupedCard({ colors: this.colors }) {
        if (this.deviceProjects().length === 0) {
          this.EmptyText($r('app.string.home_no_projects'))
        } else {
          ForEach(this.deviceProjects(), (project: AgentProject, index: number) => {
            Column() {
              ProjectDirectoryRow({
                colors: this.colors,
                project: project,
                onOpen: () => this.openProjectSessions(project),
                onFiles: () => this.onOpenFiles(project.workspacePath),
                onNewSession: () => this.onNewSession(),
                onRename: () => this.openProjectRename(project),
                onTogglePin: () => {
                  void this.toggleProjectPin(project);
                },
                onCopyPath: () => {
                  void this.copyProjectPath(project);
                },
                onArchive: () => this.requestProjectArchive(project),
              })
              if (index !== this.deviceProjects().length - 1) {
                Divider().strokeWidth(1).color(this.dividerColor())
              }
            }
            .width('100%')
          }, (project: AgentProject) => projectRowKey(project))
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ------------------------------------------------------------ session list

  /**
   * iOS's `DeviceSessionList`.
   *
   * Its three trailing controls (the project picker, the options menu and the
   * new-session button) and the segmented filter sit inside the section's own
   * card, exactly as iOS nests them in the `Section`'s content. The bulk bar is
   * Android's, and stays a bar of its own above the card — iOS shows the same
   * summary in a bottom dock.
   */
  @Builder
  SessionSection() {
    Column({ space: 12 }) {
      if (this.selectMode) {
        this.BulkBar()
      }

      GroupedCard({ colors: this.colors }) {
        Row({ space: 4 }) {
          // The picker takes whatever the two 44dp controls leave, so a long
          // project name ellipsizes instead of pushing them off the card.
          Column() {
            this.ProjectPicker()
          }
          .layoutWeight(1)
          // Wrapped because a builder call cannot take the menu's own
          // attributes; the flag it flips is this screen's.
          Column() {
            this.GlyphButton(AA_ICONS.ELLIPSIS, $r('app.string.device_session_actions'),
              this.bulkBusy, true, () => {
                this.sessionMenuOpen = !this.sessionMenuOpen;
              })
          }
          .bindMenu(this.sessionMenuOpen, this.SessionMenu(), {
            placement: Placement.BottomRight,
            enableArrow: false,
            onDisappear: () => {
              this.sessionMenuOpen = false;
            },
          })
          this.GlyphButton(AA_ICONS.SQUARE_PEN, $r('app.string.home_new_session'),
            false, true, () => this.onNewSession())
        }
        .width('100%')
        .height(52)
        .padding({ left: 4 })
        .alignItems(VerticalAlign.Center)

        Divider().strokeWidth(1).color(this.dividerColor())

        Row() {
          SegmentedControl({
            colors: this.colors,
            labels: [
              $r('app.string.home_tab_active'),
              $r('app.string.home_tab_archived'),
              $r('app.string.common_all'),
            ],
            selectedIndex: this.filterIndex(),
            accessibilityLabel: $r('app.string.device_sessions_filter'),
            onSelect: (index: number) => {
              this.filter = filterForIndex(index);
              this.selectedIds = [];
            },
          })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })

        Divider().strokeWidth(1).color(this.dividerColor())

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
                projectName: this.projectNameFor(session),
                onTap: () => {
                  if (this.selectMode) {
                    this.toggleSession(session.id);
                  } else {
                    this.onOpenSession(session);
                  }
                },
              })
              if (index !== this.visibleSessions().length - 1) {
                Divider().strokeWidth(1).color(this.dividerColor())
              }
            }
            .width('100%')
          }, (session: AgentSession) => sessionRowKey(session))
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  private filterIndex(): number {
    if (this.filter === DeviceSessionsFilter.Active) {
      return 0;
    }
    return this.filter === DeviceSessionsFilter.Archived ? 1 : 2;
  }

  /**
   * The project picker: the scoped project's name (or iOS's "All projects")
   * with a chevron, opening the same list the picker's menu shows.
   */
  @Builder
  ProjectPicker() {
    Row({ space: 6 }) {
      Text(this.projectPickerLabel())
        .fontSize(15)
        .fontWeight(500)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      AAIcon({ commands: AA_ICONS.CHEVRON_DOWN, iconSize: 16, color: this.colors.muted })
    }
    .width('100%')
    .height(44)
    .padding({ left: 12, right: 8 })
    .alignItems(VerticalAlign.Center)
    .accessibilityText($r('app.string.new_session_choose_project'))
    .onClick(() => {
      this.projectMenuOpen = !this.projectMenuOpen;
    })
    .bindMenu(this.projectMenuOpen, this.ProjectPickerMenu(), {
      placement: Placement.BottomLeft,
      enableArrow: false,
      onDisappear: () => {
        this.projectMenuOpen = false;
      },
    })
  }

  private projectPickerLabel(): ResourceStr {
    const project: AgentProject | null = this.selectedProject();
    if (project === null) {
      return $r('app.string.archived_all_projects');
    }
    return project.name;
  }

  @Builder
  ProjectPickerMenu() {
    Column() {
      DeviceMenuChoiceRow({
        colors: this.colors,
        label: $r('app.string.archived_all_projects'),
        selected: this.projectFilter === null,
        onTap: () => {
          this.projectFilter = null;
          this.selectedIds = [];
        },
      })
      ForEach(this.deviceProjects(), (project: AgentProject) => {
        DeviceMenuChoiceRow({
          colors: this.colors,
          label: project.name,
          selected: this.projectFilter === project.id,
          onTap: () => {
            this.projectFilter = project.id;
            this.selectedIds = [];
          },
        })
      }, (project: AgentProject) => `project-filter-${project.id}`)
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
  }

  /** iOS's session options menu: select, select-all, then archive-all. */
  @Builder
  SessionMenu() {
    Column() {
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.CHECK,
        label: this.selectMode ? $r('app.string.common_done') : $r('app.string.common_select'),
        danger: false,
        rowEnabled: this.visibleSessions().length > 0 && !this.bulkBusy,
        onTap: () => {
          this.selectMode = !this.selectMode;
          this.selectedIds = [];
        },
      })
      if (this.selectMode) {
        DeviceMenuActionRow({
          colors: this.colors,
          commands: AA_ICONS.LIST,
          label: $r('app.string.device_sessions_select_all'),
          danger: false,
          rowEnabled: !this.bulkBusy,
          onTap: () => {
            this.selectedIds = this.visibleSessions().map((session: AgentSession) => session.id);
          },
        })
      }
      DeviceMenuActionRow({
        colors: this.colors,
        commands: this.filter === DeviceSessionsFilter.Archived
          ? AA_ICONS.ARCHIVE_RESTORE
          : AA_ICONS.ARCHIVE,
        label: this.filter === DeviceSessionsFilter.Archived
          ? $r('app.string.device_detail_unarchive_all')
          : $r('app.string.device_detail_archive_all'),
        danger: false,
        rowEnabled: this.visibleSessions().length > 0 && !this.bulkBusy,
        onTap: () => {
          // Android confirms before touching every session on the device, and its
          // dialog text interpolates the scope's own label. The picker narrows
          // the list and the bulk actions, not this dialog's scope.
          this.onArchiveAll(
            this.filter !== DeviceSessionsFilter.Archived,
            archiveScope(this.filter),
            this.scopeLabelText(),
          );
        },
      })
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
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

  @Builder
  EmptyText(text: ResourceStr) {
    Text(text)
      .fontSize(13)
      .lineHeight(17)
      .fontWeight(500)
      .fontColor(this.colors.muted)
      .padding({ left: 2, top: 14, bottom: 14 })
      .width('100%')
  }
}

/** Which collection the device page's switcher shows; iOS's `DeviceOverviewTab`. */
export enum DeviceOverviewTab {
  Projects = 0,
  Sessions = 1,
}

/** The devices page filter, in Android's order — and iOS's `allCases` order. */
export enum DeviceSessionsFilter {
  Active = 0,
  Archived = 1,
  All = 2,
}

/** The segmented filter's value for a segment index. */
function filterForIndex(index: number): DeviceSessionsFilter {
  if (index === 1) {
    return DeviceSessionsFilter.Archived;
  }
  return index === 2 ? DeviceSessionsFilter.All : DeviceSessionsFilter.Active;
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

/**
 * A runtime row's `ForEach` key.
 *
 * The builder is not re-run while the key is unchanged, so everything the row
 * prints or gates goes into the key: a runtime that starts, stops or is renamed
 * has to be rebuilt rather than reusing the row it was created with — and so does
 * a row whose *enabled* state changed, because `pending` and `operationsEnabled`
 * reach it as props that a reused builder never re-applies.
 */
function runtimeRowKey(
  runtime: RemoteDeviceRuntime,
  runtimes: DeviceRuntimeManagementState,
): string {
  return `runtime-${runtime.id}-${runtime.active}-${runtime.status}-${runtime.displayName}`
    + `-${runtime.configured}-${runtimes.pendingRuntimeId === runtime.id}`
    + `-${runtimes.operationsEnabled()}`;
}

/** A project row's key: name, pin state and session count are all shown. */
function projectRowKey(project: AgentProject): string {
  return `project-${project.id}-${project.name}-${project.pinned}-${project.activeSessionCount}`;
}

/**
 * The width a content-sized segmented control needs.
 *
 * iOS sizes the device-content picker to its labels (`.fixedSize(horizontal:
 * true)`, which measures 85dp for 项目 / 会话), while a full-width use — the
 * session filter — is left to stretch. ArkUI wants the width up front, so this
 * estimates it: at 13sp a CJK ideograph is about 13dp and a Latin glyph about
 * 7dp, each segment carries 16dp of padding, and 44dp is iOS's smallest segment.
 */
function segmentedControlWidth(labels: Resource[]): number {
  let total: number = 0;
  for (const label of labels) {
    const text: string = resolveString(label);
    let textWidth: number = 0;
    for (let i = 0; i < text.length; i++) {
      textWidth += text.charCodeAt(i) > 0x2E80 ? 13 : 7;
    }
    total += Math.max(44, textWidth + 16);
  }
  return total;
}

/** A session row's key: title, time, archived state and scope are all shown. */
function sessionRowKey(session: AgentSession): string {
  return `session-${session.id}-${session.title}-${session.updatedAtLabel}`
    + `-${session.archived}-${session.projectId}`;
}

/**
 * iOS `DeviceOverviewSections`: a section header.
 *
 * `.subheadline` in the secondary colour, leading aligned, with the caller's
 * 44dp action on the trailing edge — the sidebar's own caption geometry
 * (`AASectionHeader`), without that component's chevron and fixed buttons.
 */
@Component
struct DeviceSectionHeader {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  @BuilderParam trailing: () => void;

  build() {
    Row() {
      Text(this.label)
        .fontSize(15)
        .fontWeight(600)
        .fontColor(this.colors.muted)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      this.trailing()
    }
    .width('100%')
    .height(44)
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * iOS `DeviceOverviewSections`: the GroupBox card.
 *
 * One 28dp-radius surface in the grouped fill; the caller draws the `Divider()`
 * between its rows, because a `@BuilderParam` slot is opaque here.
 */
@Component
struct GroupedCard {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @BuilderParam content: () => void;

  build() {
    Column() {
      this.content()
    }
    .width('100%')
    .borderRadius(28)
    .backgroundColor(this.colors.subtle)
    .clip(true)
  }
}

/**
 * iOS's segmented control.
 *
 * The same geometry the files page uses for its Files/Terminal switch: a
 * `#7676801F` track, a white selected pill inset 2dp, 13sp/600 labels and a
 * `Session filter`-style accessibility label. The caller sizes it, so the same
 * component serves the trailing picker and a full-width filter.
 */
@Component
struct SegmentedControl {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  labels: Resource[] = [];
  @Prop selectedIndex: number = 0;
  /**
   * A `Resource`, not a `ResourceStr`: `accessibilityText` has separate
   * overloads for a string and a resource and rejects the union.
   */
  accessibilityLabel: Resource = $r('app.string.device_content');
  onSelect: (index: number) => void = () => {};

  build() {
    // The selected segment *is* the pill, so it inherits the track's own 2dp
    // padding and is inset on all four sides. Drawing a separate pill and placing
    // it by percentage put its left edge at 0% — flush on the track's rounded
    // border at either end — while the 2dp inset applied only to the labels.
    Row() {
      ForEach(this.labels, (label: Resource, index: number) => {
        Row() {
          Text(label)
            .fontSize(13)
            .fontWeight(600)
            .fontColor(this.tabColor(index))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .height(28)
        .borderRadius(7)
        .backgroundColor(index === this.selectedIndex
          ? (this.colors.isDark ? '#48484A' : '#FFFFFF')
          : '#00000000')
        .shadow({
          radius: index === this.selectedIndex ? 3 : 0,
          color: index === this.selectedIndex
            ? (this.colors.isDark ? '#33000000' : '#1F000000')
            : '#00000000',
          offsetX: 0,
          offsetY: index === this.selectedIndex ? 1 : 0,
        })
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => this.onSelect(index))
        // The pill's position is content now, so the key has to carry it.
      }, (label: Resource, index: number) => `segment-${index}-${this.selectedIndex}`)
    }
    .width('100%')
    .height(32)
    .padding(2)
    .borderRadius(9)
    .backgroundColor(this.colors.isDark ? '#1FFFFFFF' : '#1F767680')
    .clip(true)
    .alignItems(VerticalAlign.Center)
    .accessibilityText(this.accessibilityLabel)
  }

  private tabColor(index: number): string {
    if (this.selectedIndex === index) {
      return this.colors.isDark ? '#FAFAFA' : '#242521';
    }
    return this.colors.isDark ? '#71717A' : '#8B8983';
  }
}

/** A 44dp row of a context menu: the glyph, then the label. */
@Component
struct DeviceMenuActionRow {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  @Prop label: ResourceStr = '';
  danger: boolean = false;
  rowEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 12 }) {
      AAIcon({
        commands: this.commands,
        iconSize: 18,
        color: withAlpha(this.danger ? '#F87171' : this.colors.inkSoft, this.rowEnabled ? 1 : 0.4),
      })
      Text(this.label)
        .fontSize(15)
        .fontWeight(500)
        .fontColor(withAlpha(this.danger ? '#F87171' : this.colors.ink, this.rowEnabled ? 1 : 0.4))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width(240)
    .height(44)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.rowEnabled) {
        this.onTap();
      }
    })
  }
}

/** A 44dp menu row with a check on the selected entry: the picker's own list. */
@Component
struct DeviceMenuChoiceRow {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop label: ResourceStr = '';
  @Prop selected: boolean = false;
  onTap: () => void = () => {};

  build() {
    Row({ space: 10 }) {
      Text(this.label)
        .fontSize(15)
        .fontWeight(this.selected ? 600 : 400)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.selected) {
        AAIcon({
          commands: AA_ICONS.CHECK,
          iconSize: 16,
          color: this.colors.sessionStatusAccent,
        })
      }
    }
    .width(240)
    .height(44)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onTap())
  }
}

/**
 * One configured runtime: the name, its "type · status" line and the switch.
 *
 * iOS's row has no status dot, its switch is the last control, and its delete
 * entry lives in the row's context menu — Android's 14dp dot column and its
 * trailing trash button are both gone.
 */
@Component
struct DeviceRuntimeRow {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop runtime: RemoteDeviceRuntime = {
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
    defaults: JSON.parse('{}') as Object,
    config: null,
    error: null,
    lastDiscoveredAt: null,
    updatedAt: null,
  };
  @Prop pending: boolean = false;
  @Prop operationsEnabled: boolean = true;
  onConfigure: () => void = () => {};
  onSetActive: (active: boolean) => void = () => {};
  onDeleteConfig: () => void = () => {};

  /** The long-press menu's open state; ArkUI menus are driven by a flag. */
  @State private menuOpen: boolean = false;

  private primaryLabel(): string {
    return runtimeInstanceName(this.runtime.name, this.runtime.displayName, this.runtime.type);
  }

  private secondaryLabel(): string {
    const typeLabel: string = runtimeTypeDisplayName(this.runtime.typeDisplayName, this.runtime.type);
    // Suppress only an exact repeat of the title, which happens when the instance
    // has no name of its own and the title already fell back to the type label.
    return typeLabel === this.primaryLabel() ? '' : typeLabel;
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

  /** The context menu's delete rule: nothing in flight, and a configuration to remove. */
  private deleteEnabled(): boolean {
    return !this.pending && this.operationsEnabled && this.runtime.configured;
  }

  build() {
    Row({ space: 12 }) {
      Column({ space: 4 }) {
        Text(this.primaryLabel())
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        // Android joins the runtime's secondary label with its status text; the
        // status is always present, so the separator follows the secondary half.
        Text() {
          if (this.secondaryLabel().length > 0) {
            Span(this.secondaryLabel())
            Span(' · ')
          }
          Span(this.statusLabel())
        }
        .fontSize(12)
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

      // iOS's `[config][switch]` order: the 44dp configuration button, then the
      // switch. Both follow the same pending/operations rule as the row's menu.
      Column() {
        if (this.pending) {
          LoadingProgress().width(18).height(18).color(this.colors.ink)
        } else {
          AAIcon({ commands: AA_ICONS.SLIDERS_HORIZONTAL, iconSize: 20, color: this.colors.ink })
        }
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .opacity(this.operationsEnabled ? 1 : 0.4)
      .accessibilityText($r('app.string.device_agent_configure'))
      .onClick(() => {
        if (!this.pending && this.operationsEnabled) {
          this.onConfigure();
        }
      })

      WebRuntimeSwitch({
        colors: this.colors,
        checked: this.runtime.active,
        rowEnabled: !this.pending && this.operationsEnabled
          && (this.runtime.active || runtimeCanActivate(this.runtime)),
        onToggle: (active: boolean) => this.onSetActive(active),
      })
    }
    .width('100%')
    .constraintSize({ minHeight: 44 })
    // iOS insets a `GroupBox`'s rows; `GroupedCard` draws no padding of its own, so
    // without this the row's trailing control and text sat flush against the card's
    // rounded border (measured: 8px of clearance on a 1280px screen).
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .gesture(
      LongPressGesture().onAction(() => {
        this.menuOpen = true;
      }),
    )
    .bindMenu(this.menuOpen, this.ContextMenu(), {
      placement: Placement.BottomRight,
      enableArrow: false,
      onDisappear: () => {
        this.menuOpen = false;
      },
    })
  }

  /**
   * iOS's `contextMenu`: 重命名 and 删除配置.
   *
   * Only the deletion is here: renaming a runtime has no backing call in this
   * client (`DeviceRuntimeState` carries no rename), and a dead entry is worse
   * than a missing one.
   */
  @Builder
  ContextMenu() {
    Column() {
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.TRASH,
        label: $r('app.string.device_detail_remove_agent'),
        danger: true,
        rowEnabled: this.deleteEnabled(),
        onTap: () => this.onDeleteConfig(),
      })
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
  }
}

/**
 * The runtime switch: Android's 32x20 track, in iOS's green while on.
 *
 * The geometry is Android's; the on-state colour is iOS's `.tint(.green)`,
 * which the palette carries as `noticeSuccess` (`#16A34A` light, `#22C55E`
 * dark) because the theme has no system-green token.
 */
@Component
struct WebRuntimeSwitch {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop checked: boolean = false;
  @Prop rowEnabled: boolean = true;
  onToggle: (active: boolean) => void = () => {};

  build() {
    Stack({ alignContent: this.checked ? Alignment.End : Alignment.Start }) {
      Column()
        .width(32)
        .height(20)
        .borderRadius(16)
        .backgroundColor(this.checked
          ? this.colors.noticeSuccess
          : this.colors.runtimeSwitchUncheckedTrack)
        .border({
          width: 2,
          color: this.checked ? this.colors.noticeSuccess : '#00000000',
        })
      Column()
        .width(16)
        .height(16)
        .borderRadius(8)
        .backgroundColor(this.checked
          ? '#FFFFFF'
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

/**
 * One project row, iOS's `DeviceDirectoryRow`.
 *
 * A folder glyph, the name, the workspace path in monospace and the active
 * session count, with the two 44dp buttons iOS puts on the trailing edge: the
 * folder opens this project's files and the square-and-pencil starts a session.
 * A long press opens iOS's `contextMenu`.
 */
@Component
struct ProjectDirectoryRow {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop project: AgentProject = {
    id: '',
    userId: '',
    connectorId: '',
    name: '',
    workspacePath: '',
    pinned: false,
    pinnedAt: null,
    activeSessionCount: 0,
    lastActivityAt: null,
    createdAt: '',
    updatedAt: '',
    manuallyCreated: false,
    sidebarSessionCounts: null,
  };
  onOpen: () => void = () => {};
  onFiles: () => void = () => {};
  onNewSession: () => void = () => {};
  onRename: () => void = () => {};
  onTogglePin: () => void = () => {};
  onCopyPath: () => void = () => {};
  onArchive: () => void = () => {};

  @State private menuOpen: boolean = false;

  build() {
    Row({ space: 12 }) {
      AAIcon({ commands: AA_ICONS.FOLDER, iconSize: 20, color: this.colors.inkSoft })

      Column({ space: 5 }) {
        Text(this.project.name)
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        // iOS truncates this line in the middle; ArkUI only offers trailing
        // ellipsis, so a long path loses its tail rather than its middle.
        Text(this.project.workspacePath)
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor(this.colors.muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Text($r('app.string.device_project_sessions_count', this.project.activeSessionCount))
          .fontSize(12)
          .fontColor(this.colors.muted)
          .maxLines(1)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Row() {
        this.GlyphButton(AA_ICONS.FOLDER, $r('app.string.common_files'), () => this.onFiles())
        this.GlyphButton(AA_ICONS.SQUARE_PEN,
          $r('app.string.home_new_session_in_project', this.project.name),
          () => this.onNewSession())
      }
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .constraintSize({ minHeight: 44 })
    // Inset like the runtime row: the card has no padding of its own, and the
    // trailing folder / new-session buttons were sitting on the card's border.
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .gesture(
      GestureGroup(
        GestureMode.Exclusive,
        TapGesture().onAction(() => this.onOpen()),
        LongPressGesture().onAction(() => {
          this.menuOpen = true;
        }),
      ),
    )
    .bindMenu(this.menuOpen, this.ContextMenu(), {
      placement: Placement.BottomRight,
      enableArrow: false,
      onDisappear: () => {
        this.menuOpen = false;
      },
    })
  }

  /** iOS's 44dp row button: a bare glyph, no surface of its own. */
  @Builder
  GlyphButton(commands: string, label: Resource, onTap: () => void) {
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
   * iOS's `contextMenu`: rename, pin, copy path, archive — and delete, which
   * this client cannot offer: neither `ProjectsApi` nor Android's own project
   * client has a delete endpoint (only empty projects may be deleted, and the
   * Server exposes no call for it).
   */
  @Builder
  ContextMenu() {
    Column() {
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.PENCIL,
        label: $r('app.string.device_project_rename'),
        danger: false,
        rowEnabled: true,
        onTap: () => this.onRename(),
      })
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.PIN,
        label: this.project.pinned
          ? $r('app.string.home_project_unpin')
          : $r('app.string.home_project_pin'),
        danger: false,
        rowEnabled: true,
        onTap: () => this.onTogglePin(),
      })
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.COPY,
        label: $r('app.string.files_copy_path'),
        danger: false,
        rowEnabled: true,
        onTap: () => this.onCopyPath(),
      })
      Divider().strokeWidth(1).color(this.colors.isDark ? '#27272A' : this.colors.border)
      DeviceMenuActionRow({
        colors: this.colors,
        commands: AA_ICONS.ARCHIVE,
        label: $r('app.string.home_project_archive'),
        danger: true,
        rowEnabled: true,
        onTap: () => this.onArchive(),
      })
    }
    .padding({ top: 6, bottom: 6 })
    .borderRadius(14)
    .backgroundColor(this.colors.raisedSurface)
  }
}

/** 20dp selection circle: filled with a check when selected. */
@Component
struct SelectionCircle {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop selected: boolean = false;

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

/**
 * One session row: optional selection circle, list glyph, the title with iOS's
 * `runtime · <project or workspace>` caption under it, and the time.
 */
@Component
struct SessionDetailRow {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop session: AgentSession | null = null;
  @Prop selectMode: boolean = false;
  @Prop selected: boolean = false;
  /** Project the session belongs to, as the caller resolved it; may be empty. */
  @Prop projectName: string = '';
  onTap: () => void = () => {};

  /** iOS's `scopeSubtitle`: the project name, or the workspace it ran in. */
  private caption(): string {
    const session: AgentSession | null = this.session;
    if (session === null) {
      return '';
    }
    const scope: string = this.projectName.length > 0
      ? this.projectName
      : session.workspaceLabel;
    return [session.runtimeLabel, scope]
      .filter((part: string) => part.length > 0)
      .join(' · ');
  }

  build() {
    Row({ space: 12 }) {
      if (this.selectMode) {
        SelectionCircle({ colors: this.colors, selected: this.selected })
      }
      AAIcon({ commands: AA_ICONS.LIST, iconSize: 14, color: this.colors.faint })

      Column({ space: 4 }) {
        Text(this.session === null ? '' : this.session.title)
          .fontSize(17)
          .fontWeight(600)
          .fontColor(this.colors.inkSoft)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(this.caption())
          .fontSize(12)
          .fontColor(this.colors.muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text(this.session === null || this.session.updatedAtLabel.length === 0
        ? $r('app.string.common_now')
        : this.session.updatedAtLabel)
        .fontSize(12)
        .fontFamily('monospace')
        .fontWeight(500)
        .fontColor(this.colors.faint)
        .maxLines(1)
    }
    .width('100%')
    .constraintSize({ minHeight: 52 })
    // The trailing time was flush against the card's border — that is the "text is
    // clipped" this row showed. The card draws no padding of its own.
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onTap())
  }
}

/** Android's `MiniTextAction`: a 30dp pill at 12.5sp bold. */
@Component
export struct MiniTextAction {
  @Prop colors: AAColors = AA_LIGHT_COLORS;
  @Prop label: ResourceStr = '';
  @Prop rowEnabled: boolean = true;
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
