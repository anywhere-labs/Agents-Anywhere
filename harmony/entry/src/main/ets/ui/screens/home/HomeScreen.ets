import { AgentDevice, AgentProject, AgentSession } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import { SessionsController } from '../../../feature/sessions/SessionsController';
import {
  ProjectSessionsState, ProjectSessionStatusFilter,
} from '../../../feature/sessions/ProjectSessionsState';
import { SIDEBAR_VIEW_SESSION } from '../../../storage/UiPreferences';
import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AASpacing } from '../../designsystem/AAMetrics';
import { AAWordmark } from '../../designsystem/AAWordmark';
import { AASectionHeader } from '../common/AppEmptyState';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { ParsedAuthMe } from '../../../api/AuthDtos';
import { ProfileAvatar } from '../profile/ProfileAccountPage';
import { HomeProjectSessionRow, HomeSessionRow } from './HomeSessionRow';
import { AARowArea, RenameSessionDialog, SessionActionOverlay } from './HomeSessionActions';
import {
  ProjectActionOverlay, ProjectArchiveDialog, ProjectEditSheet, ProjectFilterMenu,
} from './HomeProjectActions';

/**
 * Home: the signed-in landing screen.
 *
 * Port of `ui/screens/home/HomeScreen.kt`.
 *
 * Two behaviours are easy to get wrong from the Android source and are
 * deliberately reproduced:
 *
 *  1. `HomeTab` (`Active`/`Archived`/`Devices`) and its tab strip are **dead
 *     code** on Android — `HomeContent` always passes `HomeTab.Active`, so no
 *     tab strip is ever drawn. The real list switch is the persisted sidebar
 *     view mode, changed from the settings drawer.
 *  2. The search button is a stub: it only raises the "Search is coming soon."
 *     toast. No search UI exists.
 *
 * The project action overlay, the project filter menu and the new-session flow
 * are not part of this pass; the sections, ordering, copy and empty states are.
 */
@Component
export struct HomeScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  @Prop state: SessionsState;
  controller: SessionsController | null = null;
  /** Lazily loaded per-project session lists, keyed by project. */
  @Prop projectSessions: ProjectSessionsState;
  /** Which archived states the project tree shows. */
  projectStatusFilter: ProjectSessionStatusFilter = ProjectSessionStatusFilter.Active;
  onLoadProjectSessions: (projectId: string) => void = () => {};
  /** Persists and applies a new project-tree status filter. */
  onProjectFilterChange: (filter: ProjectSessionStatusFilter) => void = () => {};
  /** Sidebar state restored from preferences for this account. */
  initialExpandedProjectIds: string[] = [];
  initialProjectsSectionExpanded: boolean = true;
  /** Called whenever the expanded set or the section state changes. */
  onSidebarStateChange: (expandedProjectIds: string[], sectionExpanded: boolean) => void = () => {};
  /** `"project"` or `"session"`; anything else normalizes to project. */
  sidebarViewMode: string = 'project';
  /** The signed-in account, for the bottom bar's avatar control. */
  account: ParsedAuthMe | null = null;
  onStateChange: (next: SessionsState) => void = () => {};
  onOpenSession: (session: AgentSession) => void = () => {};
  onNewSession: () => void = () => {};
  /** Android's `onCreateProject`: the project editor, not the session picker. */
  onNewProject: () => void = () => {};
  /** Opens one device's page, which is what the sidebar's device rows do. */
  onOpenDevice: (device: AgentDevice) => void = () => {};
  onOpenProfile: () => void = () => {};
  onPairDevice: () => void = () => {};
  /** Resolves when the refresh finished, so the indicator can be cleared. */
  onRefresh: () => Promise<void> = async () => {};
  onLoadMore: () => void = () => {};

  /** Expanded project ids; an array so a toggle replaces the reference. */
  @State private expandedProjectIds: string[] = [];
  @State private sectionsExpanded: boolean = true;
  /** Session whose long-press action card is open, with its measured bounds. */
  @State private actionSession: AgentSession | null = null;
  @State private actionArea: AARowArea = { x: 0, y: 0, width: 0, height: 0 };
  @State private renaming: boolean = false;
  @State private renameBusy: boolean = false;
  @State private renameError: string = '';
  /** Project whose long-press action card is open, with its measured bounds. */
  @State private actionProject: AgentProject | null = null;
  @State private projectArea: AARowArea = { x: 0, y: 0, width: 0, height: 0 };
  @State private editingProject: boolean = false;
  @State private archivingProject: boolean = false;
  @State private projectBusy: boolean = false;
  @State private projectError: string = '';
  @State private filterMenuOpen: boolean = false;
  @State private screenWidth: number = 360;
  @State private screenHeight: number = 800;
  @State private refreshing: boolean = false;
  private toast: AAToastState = new AAToastState();
  /** Bumped after a toast mutation so the host re-reads the toast fields. */
  @State private toastRevision: number = 0;

  private isProjectView(): boolean {
    return this.sidebarViewMode !== SIDEBAR_VIEW_SESSION;
  }

  aboutToAppear(): void {
    // Restored from preferences so the tree opens the way the user left it.
    this.expandedProjectIds = this.initialExpandedProjectIds.slice();
    this.sectionsExpanded = this.initialProjectsSectionExpanded;
  }

  private persistSidebarState(): void {
    this.onSidebarStateChange(this.expandedProjectIds, this.sectionsExpanded);
  }

  private isExpanded(projectId: string): boolean {
    return this.expandedProjectIds.includes(projectId);
  }

  private toggleProject(projectId: string): void {
    const next: string[] = [];
    let removed: boolean = false;
    for (const id of this.expandedProjectIds) {
      if (id === projectId) {
        removed = true;
      } else {
        next.push(id);
      }
    }
    if (!removed) {
      next.push(projectId);
      // Expanding is what triggers the on-demand fetch; the loader skips it when
      // the list is still fresh or already in flight.
      this.onLoadProjectSessions(projectId);
    }
    this.expandedProjectIds = next;
    this.persistSidebarState();
  }

  /**
   * Sessions shown under a project.
   *
   * Uses the lazily loaded project list when present, otherwise the dashboard's
   * own sessions for that project so the tree is not briefly empty.
   */
  private projectSessionsFor(projectId: string): AgentSession[] {
    return this.projectSessions.sessionsFor(
      projectId,
      this.projectStatusFilter,
      this.state.sessionsForProject(projectId),
    );
  }

  /** Error text for an expanded project, or an empty string when it loaded. */
  private projectErrorFor(projectId: string): string {
    const message: string | null = this.projectSessions.anyErrorFor(projectId);
    return message === null ? '' : message;
  }

  // -------------------------------------------------------- project actions

  private openProjectActions(project: AgentProject, area: AARowArea): void {
    this.projectArea = area;
    this.actionProject = project;
  }

  private dismissProjectActions(): void {
    this.actionProject = null;
    this.editingProject = false;
    this.archivingProject = false;
    this.projectBusy = false;
    this.projectError = '';
  }

  /** Device label shown in the edit sheet's read-only field. */
  private deviceNameFor(project: AgentProject): string {
    for (const device of this.state.devices) {
      if (device.id === project.connectorId) {
        return device.name;
      }
    }
    return project.connectorId;
  }

  private async toggleProjectPin(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const project: AgentProject | null = this.actionProject;
    if (controller === null || project === null) {
      return;
    }
    const nextPinned: boolean = !project.pinned;
    try {
      const next: SessionsState = await controller.updateProject(
        this.state, project.id, null, nextPinned,
      );
      this.onStateChange(next);
      this.showToast(nextPinned
        ? $r('app.string.home_project_pinned')
        : $r('app.string.home_project_unpinned'));
      this.dismissProjectActions();
    } catch (error) {
      this.showErrorToast(error instanceof Error
        ? error.message
        : 'Could not update project.');
    }
  }

  private async confirmProjectRename(name: string): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const project: AgentProject | null = this.actionProject;
    if (controller === null || project === null) {
      return;
    }
    this.projectBusy = true;
    this.projectError = '';
    try {
      const next: SessionsState = await controller.updateProject(this.state, project.id, name, null);
      this.onStateChange(next);
      this.projectBusy = false;
      this.showToast($r('app.string.home_project_updated'));
      this.dismissProjectActions();
    } catch (error) {
      this.projectBusy = false;
      this.projectError = error instanceof Error ? error.message : 'Could not update project.';
    }
  }

  private async confirmProjectArchive(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const project: AgentProject | null = this.actionProject;
    if (controller === null || project === null) {
      return;
    }
    this.projectBusy = true;
    try {
      const next: SessionsState = await controller.archiveProjectSessions(this.state, project.id);
      this.onStateChange(next);
      this.projectBusy = false;
      this.showToast($r('app.string.home_project_archived'));
      this.dismissProjectActions();
    } catch (error) {
      this.projectBusy = false;
      this.showErrorToast(error instanceof Error
        ? error.message
        : 'Could not archive project sessions.');
    }
  }

  private selectProjectFilter(filter: ProjectSessionStatusFilter): void {
    this.filterMenuOpen = false;
    this.onProjectFilterChange(filter);
  }

  private showToast(message: ResourceStr): void {
    this.toast.show(message);
    this.toastRevision += 1;
  }

  private showErrorToast(message: string): void {
    this.toast.show(message, true);
    this.toastRevision += 1;
  }

  // -------------------------------------------------------- session actions

  private openSessionActions(session: AgentSession, area: AARowArea): void {
    this.actionArea = area;
    this.actionSession = session;
  }

  private dismissSessionActions(): void {
    this.actionSession = null;
    this.renaming = false;
    this.renameError = '';
    this.renameBusy = false;
  }

  /**
   * Applies a session mutation and reports the outcome.
   *
   * The controller returns the authoritative row from the Server, so the list is
   * updated from the response rather than from an optimistic guess.
   */
  private async togglePin(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const session: AgentSession | null = this.actionSession;
    if (controller === null || session === null) {
      return;
    }
    const nextPinned: boolean = !session.pinned;
    try {
      const next: SessionsState = await controller.setPinned(this.state, session.id, nextPinned);
      this.onStateChange(next);
      this.showToast(nextPinned
        ? $r('app.string.home_session_pinned')
        : $r('app.string.home_session_unpinned'));
      this.dismissSessionActions();
    } catch (error) {
      this.showErrorToast(error instanceof Error
        ? error.message
        : 'Could not update pin state.');
    }
  }

  private async toggleArchive(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const session: AgentSession | null = this.actionSession;
    if (controller === null || session === null) {
      return;
    }
    const nextArchived: boolean = !session.archived;
    try {
      const next: SessionsState = await controller.setArchived(this.state, session.id, nextArchived);
      this.onStateChange(next);
      this.showToast(nextArchived
        ? $r('app.string.home_session_archived')
        : $r('app.string.home_session_restored'));
      this.dismissSessionActions();
    } catch (error) {
      this.showErrorToast(error instanceof Error
        ? error.message
        : (nextArchived ? 'Could not archive session.' : 'Could not restore session.'));
    }
  }

  private async confirmRename(title: string): Promise<void> {
    const controller: SessionsController | null = this.controller;
    const session: AgentSession | null = this.actionSession;
    if (controller === null || session === null) {
      return;
    }
    this.renameBusy = true;
    this.renameError = '';
    try {
      const next: SessionsState = await controller.rename(this.state, session.id, title);
      this.onStateChange(next);
      this.renameBusy = false;
      this.showToast($r('app.string.home_session_renamed'));
      this.dismissSessionActions();
    } catch (error) {
      this.renameBusy = false;
      this.renameError = error instanceof Error ? error.message : 'Could not rename session.';
    }
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        // 1. Header. iOS's `ChatSidebarHeaderView`: the wordmark alone, 24sp and
        // leading-aligned in a 44dp row inset 18dp. Android's profile and search
        // glyphs are gone with the rest of its chrome — the account control is the
        // bottom bar's avatar, and search was only ever a "coming soon" toast.
        Row() {
          AAWordmark({
            colors: this.colors,
            fontSize: 24,
            lineHeight: 30,
          })
        }
        .width('100%')
        .height(44)
        // The list's own inset is 14dp, so 4dp here puts the wordmark at iOS's 18.
        .padding({ left: 4, right: 10 })
        .alignItems(VerticalAlign.Center)

        // 2. List area, in the active view mode. Pull-to-refresh uses the same
        // indicator colours Android does.
        Refresh({ refreshing: $$this.refreshing }) {
          Column() {
            if (this.state.isLoading && !this.state.hasLoaded) {
              this.LoadingState()
            } else if (this.state.errorMessage !== null && !this.state.hasLoaded) {
              Text(this.state.errorMessage)
                .fontSize(13.5)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.colors.errorText)
                .padding({ top: 10 })
            } else if (this.isProjectView()) {
              this.ProjectModeList()
            } else {
              this.SessionModeList()
            }
          }
          .width('100%')
          .height('100%')
        }
        .layoutWeight(1)
        .width('100%')
        .margin({ top: 10 })
        .onRefreshing(() => {
          this.onRefresh().then(() => {
            this.refreshing = false;
          }).catch(() => {
            this.refreshing = false;
          });
        })
      }
      .width('100%')
      .height('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 14, right: 14, top: AASpacing.HOME_TOP })

      // 3. Bottom controls, as iOS's `ChatSidebarBottomControls`: a prominent
      // "New session" capsule hugging the leading edge and a 50dp glass circle
      // around the account's 38dp avatar on the trailing one — both the sizes and
      // the hugging capsule come from `AppGlassButton` and `AccountAvatarView`.
      // Android's circular FAB and the header's profile button are gone; the
      // actions are unchanged.
      Column() {
        Row({ space: 10 }) {
          this.NewSessionCapsule()

          Blank().layoutWeight(1)

          this.BottomAccountButton()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.End)
      // ArkUI's default hit test mode blocks every node this one masks, and this
      // wrapper covers the whole screen although only the controls inside it are
      // drawn. Without `Transparent` the header and every list row underneath stop
      // receiving taps — the screen looks fine and is inert.
      .hitTestBehavior(HitTestMode.Transparent)
      .padding({ left: 18, right: 18, bottom: 12 })

      // 4. Toasts sit above everything else. The wrapper is transparent to the
      // hit test for the same reason as the button overlay above: it spans the
      // full width, so a visible toast would otherwise swallow the taps beside
      // and beneath it.
      Column() {
        AAToastHost({
          colors: this.colors,
          message: this.toast.message,
          isError: this.toast.isError,
          actionLabel: this.toast.actionLabel,
          visible: this.toast.visible,
        })
      }
      .width('100%')
      .hitTestBehavior(HitTestMode.Transparent)
      .padding({ left: 22, right: 22, top: 86 })

      // 5. Long-press action card and the rename dialog sit above the list.
      if (this.actionSession !== null && !this.renaming) {
        SessionActionOverlay({
          colors: this.colors,
          session: this.actionSession,
          area: this.actionArea,
          screenWidth: this.screenWidth,
          screenHeight: this.screenHeight,
          onDismiss: () => this.dismissSessionActions(),
          onRename: () => {
            this.renameError = '';
            this.renaming = true;
          },
          onTogglePin: () => {
            void this.togglePin();
          },
          onToggleArchive: () => {
            void this.toggleArchive();
          },
        })
      }

      if (this.renaming && this.actionSession !== null) {
        RenameSessionDialog({
          colors: this.colors,
          initialTitle: this.actionSession.title,
          busy: this.renameBusy,
          errorMessage: this.renameError,
          onCancel: () => this.dismissSessionActions(),
          onSave: (title: string) => {
            void this.confirmRename(title);
          },
        })
      }

      // 7. Project action card, edit sheet, archive confirmation, filter menu.
      if (this.actionProject !== null && !this.editingProject && !this.archivingProject) {
        ProjectActionOverlay({
          colors: this.colors,
          project: this.actionProject,
          area: this.projectArea,
          screenWidth: this.screenWidth,
          screenHeight: this.screenHeight,
          onDismiss: () => this.dismissProjectActions(),
          onEdit: () => {
            this.projectError = '';
            this.editingProject = true;
          },
          onTogglePin: () => {
            void this.toggleProjectPin();
          },
          onArchive: () => {
            this.archivingProject = true;
          },
        })
      }

      if (this.editingProject && this.actionProject !== null) {
        ProjectEditSheet({
          colors: this.colors,
          project: this.actionProject,
          deviceName: this.deviceNameFor(this.actionProject),
          busy: this.projectBusy,
          errorMessage: this.projectError,
          onCancel: () => this.dismissProjectActions(),
          onSave: (name: string) => {
            void this.confirmProjectRename(name);
          },
        })
      }

      if (this.archivingProject && this.actionProject !== null) {
        ProjectArchiveDialog({
          colors: this.colors,
          project: this.actionProject,
          busy: this.projectBusy,
          onCancel: () => this.dismissProjectActions(),
          onConfirm: () => {
            void this.confirmProjectArchive();
          },
        })
      }

      if (this.filterMenuOpen) {
        ProjectFilterMenu({
          colors: this.colors,
          filter: this.projectStatusFilter,
          onSelect: (filter: ProjectSessionStatusFilter) => this.selectProjectFilter(filter),
          onDismiss: () => {
            this.filterMenuOpen = false;
          },
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      // The overlay positions the action card from these, so they must track
      // rotation and window resizes.
      this.screenWidth = Number(newValue.width);
      this.screenHeight = Number(newValue.height);
    })
  }

  // ---------------------------------------------------------------- list modes

  @Builder
  ProjectModeList() {
    // iOS draws the sidebar whatever the account holds: an empty device list is
    // a caption under its heading, an empty project tree a caption under the
    // projects heading. Android's full-page empty states — each with its own
    // pair/create button — are gone with them; the pair row under the device
    // section and the projects heading's "+" carry those two actions.
    List({ space: 6 }) {
      ListItem() {
        this.DeviceSection()
      }

      ListItem() {
        this.PairDeviceRow()
      }

      if (this.hasPinnedItems()) {
        // iOS labels "Pinned" with the plain section caption, not a disclosure:
        // the section is drawn only while something is pinned.
        ListItem() {
          AASectionHeader({
            colors: this.colors,
            label: $r('app.string.home_pinned'),
            collapsible: false,
          })
        }
        ForEach(this.pinnedProjects(), (project: AgentProject) => {
          ListItem() {
            this.ProjectTreeItem(project)
          }
        }, (project: AgentProject) => `pinned-project-${project.id}`)

        ForEach(this.pinnedSessions(), (session: AgentSession) => {
          ListItem() {
            // Android lists pinned sessions in the project view with
            // `HomeProjectSessionRow(inset = false)`: a 42dp row with the
            // indicator on the trailing side.
            HomeProjectSessionRow({
              colors: this.colors,
              session: session,
              inset: false,
              onOpen: (opened: AgentSession) => this.onOpenSession(opened),
              onLongPress: (pressed: AgentSession, area: AARowArea) =>
                this.openSessionActions(pressed, area),
            })
          }
        }, (session: AgentSession) => `pinned-session-${session.id}`)
      }

      ListItem() {
        // Android gives the Projects header its two icon buttons: the ellipsis
        // opens the session-status filter, the plus creates a project. The
        // filter belongs here, not on a project row.
        AASectionHeader({
          colors: this.colors,
          label: $r('app.string.home_projects'),
          expanded: this.sectionsExpanded,
          showFilter: true,
          onFilter: () => {
            this.filterMenuOpen = true;
          },
          showCreate: true,
          onCreate: () => this.onNewProject(),
          onToggle: () => {
            this.sectionsExpanded = !this.sectionsExpanded;
            this.persistSidebarState();
          },
        })
      }

      if (this.sectionsExpanded) {
        if (this.regularProjects().length === 0) {
          ListItem() {
            this.EmptyListText($r('app.string.home_no_projects'))
          }
        } else {
          ForEach(this.regularProjects(), (project: AgentProject) => {
            ListItem() {
              this.ProjectTreeItem(project)
            }
          }, (project: AgentProject) => `project-${project.id}`)
        }
      }

      if (this.ungroupedSessions().length > 0) {
        // iOS's "未分组会话" section (`ChatSidebarProjects.swift`): the active
        // sessions that belong to no listed project, listed at the tree's foot.
        ListItem() {
          AASectionHeader({
            colors: this.colors,
            label: $r('app.string.home_ungrouped_sessions'),
            collapsible: false,
          })
        }
        ForEach(this.ungroupedSessions(), (session: AgentSession) => {
          ListItem() {
            HomeProjectSessionRow({
              colors: this.colors,
              session: session,
              inset: false,
              onOpen: (opened: AgentSession) => this.onOpenSession(opened),
              onLongPress: (pressed: AgentSession, area: AARowArea) =>
                this.openSessionActions(pressed, area),
            })
          }
        }, (session: AgentSession) => `ungrouped-session-${session.id}`)
      }

      ListItem() {
        // A trailing spacer keeps the last row clear of the FAB.
        // iOS keeps 82dp of clearance under the sidebar list for its bottom bar.
        Column().height(82)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    // No list-level divider: Android draws its hairline inside session rows
    // only, so project rows and section headers stay open.
    .onReachEnd(() => this.onLoadMore())
  }

  @Builder
  ProjectTreeItem(project: AgentProject) {
    Column() {
      // iOS's project row (`ChatSidebarProjects.swift`): an 18dp folder glyph —
      // filled while expanded — the name at body size, and the 44dp
      // new-session button on the trailing side. iOS has no row-level options
      // button: its project actions live in the row's context menu, which is
      // this app's long press.
      Row({ space: 10 }) {
        AAIcon({
          commands: this.isExpanded(project.id) ? AA_ICONS.FOLDER_OPEN : AA_ICONS.FOLDER,
          iconSize: 18,
          color: this.colors.ink,
        })
        Text(project.name)
          .fontSize(17)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        this.ProjectIconButton(
          AA_ICONS.SQUARE_PEN,
          $r('app.string.home_new_session_in_project', project.name),
          () => this.onNewSession(),
        )
      }
      .width('100%')
      .height(44)
      .padding({ left: 10, right: 0 })
      .alignItems(VerticalAlign.Center)
      .onAreaChange((_oldValue: Area, newValue: Area) => {
        this.projectArea = {
          x: Number(newValue.globalPosition.x),
          y: Number(newValue.globalPosition.y),
          width: Number(newValue.width),
          height: Number(newValue.height),
        };
      })
      .gesture(
        GestureGroup(GestureMode.Exclusive,
          TapGesture().onAction(() => this.toggleProject(project.id)),
          LongPressGesture().onAction(() => this.openProjectActions(project, this.projectArea)),
        ),
      )

      if (this.isExpanded(project.id)) {
        if (this.projectErrorFor(project.id).length > 0) {
          // Android's inline retry line, which re-triggers the load on tap.
          Text($r('app.string.home_project_load_retry'))
            .fontSize(13)
            .fontColor(this.colors.errorText)
            .padding({ left: 36, top: 10, bottom: 10 })
            .onClick(() => this.onLoadProjectSessions(project.id))
        } else if (this.projectSessionsFor(project.id).length === 0) {
          if (this.projectSessions.isLoadingAny(project.id)) {
            Row() {
              LoadingProgress().width(18).height(18).color(this.colors.muted)
            }
            .height(48)
            .padding({ left: 38 })
            .alignItems(VerticalAlign.Center)
          } else {
            // Android's 42dp box with a 38dp inset and a semibold label.
            Row() {
              Text($r('app.string.home_project_no_sessions'))
                .fontSize(13)
                .fontWeight(600)
                .fontColor(this.colors.faint)
            }
            .height(42)
            .padding({ left: 38 })
            .alignItems(VerticalAlign.Center)
          }
        } else {
          ForEach(this.projectSessionsFor(project.id), (session: AgentSession) => {
            HomeProjectSessionRow({
              colors: this.colors,
              session: session,
              onOpen: (opened: AgentSession) => this.onOpenSession(opened),
              onLongPress: (pressed: AgentSession, area: AARowArea) =>
                this.openSessionActions(pressed, area),
            })
          }, (session: AgentSession) => `project-session-${session.id}`)
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  SessionModeList() {
    // The same iOS sidebar as the project mode with the flat session list in
    // place of the tree; an empty account gets the caption iOS draws there.
    List({ space: 6 }) {
      ListItem() {
        this.DeviceSection()
      }

      ListItem() {
        this.PairDeviceRow()
      }

      if (this.pinnedSessions().length > 0) {
        ListItem() {
          AASectionHeader({
            colors: this.colors,
            label: $r('app.string.home_pinned'),
            collapsible: false,
          })
        }
        ForEach(this.pinnedSessions(), (session: AgentSession) => {
          ListItem() {
            HomeSessionRow({
              colors: this.colors,
              session: session,
              showSubtitle: true,
              onOpen: (opened: AgentSession) => this.onOpenSession(opened),
              onLongPress: (pressed: AgentSession, area: AARowArea) =>
                this.openSessionActions(pressed, area),
            })
          }
        }, (session: AgentSession) => `session-pinned-${session.id}`)
      }

      ListItem() {
        AASectionHeader({
          colors: this.colors,
          label: $r('app.string.home_recents'),
          expanded: this.sectionsExpanded,
          onToggle: () => {
            this.sectionsExpanded = !this.sectionsExpanded;
            this.persistSidebarState();
          },
        })
      }
      if (this.sectionsExpanded) {
        if (this.recentSessions().length === 0) {
          ListItem() {
            this.EmptyListText($r('app.string.home_no_sessions_yet'))
          }
        } else {
          ForEach(this.recentSessions(), (session: AgentSession) => {
            ListItem() {
              HomeSessionRow({
                colors: this.colors,
                session: session,
                showSubtitle: false,
                onOpen: (opened: AgentSession) => this.onOpenSession(opened),
                onLongPress: (pressed: AgentSession, area: AARowArea) =>
                  this.openSessionActions(pressed, area),
              })
            }
          }, (session: AgentSession) => `session-recent-${session.id}`)
        }
      }

      ListItem() {
        // iOS keeps 82dp of clearance under the sidebar list for its bottom bar.
        Column().height(82)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    // Session rows carry their own hairline, as Android's row shell does.
    .onReachEnd(() => this.onLoadMore())
  }

  // ------------------------------------------------------------- small pieces

  /**
   * iOS's device section: a plain caption over one 42dp row per device.
   *
   * `ChatSidebarDeviceSection` draws a 7dp presence dot — green online, the
   * secondary colour at 45% offline — and the name in the subheadline size in a
   * monospaced face, on a 10dp inset. An account without devices gets the
   * section's own caption row ("No devices") and nothing else; iOS's loading row
   * is not needed here because the whole list is a skeleton until the first load
   * lands.
   */
  @Builder
  DeviceSection() {
    Column({ space: 4 }) {
      AASectionHeader({
        colors: this.colors,
        label: $r('app.string.devices_title'),
        collapsible: false,
      })

      if (this.state.devices.length === 0) {
        // iOS's `ChatSidebarEmptyRow`: the caption says so instead of the
        // sidebar being replaced by a full-page empty state.
        this.EmptyListText($r('app.string.devices_empty'))
      } else {
        ForEach(this.state.devices, (device: AgentDevice) => {
          this.DeviceRow(device)
        }, (device: AgentDevice) => `sidebar-device-${device.id}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  DeviceRow(device: AgentDevice) {
    Row({ space: 10 }) {
      Column()
        .width(7)
        .height(7)
        .borderRadius(999)
        .backgroundColor(device.online ? '#10B981' : withAlpha(this.colors.muted, 0.45))

      Text(device.name)
        .fontSize(15)
        .fontFamily('monospace')
        .fontColor(device.online ? this.colors.ink : this.colors.muted)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height(42)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .accessibilityText(device.name)
    .onClick(() => this.onOpenDevice(device))
  }

  /**
   * iOS's `ChatSidebarPairDeviceButton`: a plus glyph and a semibold label on the
   * leading edge of a 46dp row, with no surface of its own.
   */
  @Builder
  PairDeviceRow() {
    Row({ space: 8 }) {
      AAIcon({ commands: AA_ICONS.PLUS, iconSize: 18, color: this.colors.ink })

      Text($r('app.string.home_pair_new_device'))
        .fontSize(17)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height(46)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onPairDevice())
  }

  /**
   * iOS's `ChatSidebarEmptyRow`: a caption row inset 10dp in a 38dp box, in
   * the secondary colour. The sidebar never draws a full-page empty state.
   */
  @Builder
  EmptyListText(label: ResourceStr) {
    Row() {
      Text(label)
        .fontSize(AAFontSize.CAPTION)
        .fontColor(this.colors.muted)
        .maxLines(2)
    }
    .width('100%')
    .height(38)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  LoadingState() {
    Column({ space: 14 }) {
      ForEach([0, 1, 2, 3, 4, 5], (index: number) => {
        Row() {
          Column()
            .width('82%')
            .height(16)
            .borderRadius(8)
            .backgroundColor(this.colors.subtle)
        }
        .width('100%')
        .height(52)
        .alignItems(VerticalAlign.Center)
      }, (index: number) => `skeleton-${index}`)
    }
    .width('100%')
    .padding({ top: 8 })
  }

  /**
   * The sidebar's "New session" control.
   *
   * iOS's `AppGlassButton(style: .prominent, maxWidth: nil)`: a capsule that
   * hugs its label instead of filling the bar, which is why this is not the
   * shared full-width `AAIosPrimaryButton`.
   */
  @Builder
  NewSessionCapsule() {
    Row({ space: 10 }) {
      AAIcon({ commands: AA_ICONS.SQUARE_PEN, iconSize: 18, color: this.colors.onPrimaryAction })

      Text($r('app.string.home_new_session'))
        .fontSize(AAFontSize.HEADER)
        .fontWeight(600)
        .fontColor(this.colors.onPrimaryAction)
        .maxLines(1)
    }
    .height(50)
    .padding({ left: 20, right: 20 })
    .borderRadius(25)
    .backgroundColor(this.colors.primaryAction)
    .accessibilityText($r('app.string.home_new_session'))
    .onClick(() => this.onNewSession())
  }

  /** iOS's `ChatSidebarIconControlStyle`: a 44dp square around an 18dp glyph. */
  @Builder
  ProjectIconButton(iconCommands: string, label: Resource, action: () => void) {
    Column() {
      AAIcon({ commands: iconCommands, iconSize: 18, color: this.colors.ink })
    }
    .width(44)
    .height(44)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(label)
    .onClick(() => action())
  }

  /**
   * The account control of iOS's bottom bar.
   *
   * `Button { AccountAvatarView(size: 38) }.buttonStyle(.glass)
   * .buttonBorderShape(.circle)`: a 50dp glass circle around the account's 38dp
   * avatar, which falls back to the label's first letter — the shared
   * `ProfileAvatar` draws both.
   */
  @Builder
  BottomAccountButton() {
    Column() {
      ProfileAvatar({
        colors: this.colors,
        account: this.account,
        avatarSize: 38,
      })
    }
    .width(50)
    .height(50)
    .justifyContent(FlexAlign.Center)
    .borderRadius(25)
    .backgroundColor(this.colors.isDark ? '#0FFFFFFF' : '#0A000000')
    .border({ width: 1, color: this.colors.isDark ? '#38FFFFFF' : '#24000000' })
    .accessibilityText($r('app.string.profile_settings'))
    .onClick(() => this.onOpenProfile())
  }

  // ------------------------------------------------------------------ selectors

  private hasPinnedItems(): boolean {
    return this.pinnedProjects().length > 0 || this.pinnedSessions().length > 0;
  }

  private pinnedProjects(): AgentProject[] {
    return this.state.projects.filter((project: AgentProject) => project.pinned);
  }

  private regularProjects(): AgentProject[] {
    return this.state.projects
      .filter((project: AgentProject) => !project.pinned)
      .sort(compareProjectsByActivity(this.state));
  }

  private pinnedSessions(): AgentSession[] {
    return this.state.pinnedSessions();
  }

  private recentSessions(): AgentSession[] {
    return this.state.recentSessions();
  }

  /**
   * The sessions iOS lists under "未分组会话": active, unpinned sessions whose
   * project is absent from the project list, in the sidebar's own order.
   */
  private ungroupedSessions(): AgentSession[] {
    const projectIds: string[] = this.state.projects.map((project: AgentProject) => project.id);
    return this.state.sortedSessions().filter((session: AgentSession) => !session.pinned
      && (session.projectId === null || !projectIds.includes(session.projectId)));
  }
}

/**
 * Project ordering, matching `sortProjectsByActivity`: projects with active
 * sessions first, then most recent activity, then creation time, then name,
 * then id.
 */
function compareProjectsByActivity(state: SessionsState): (a: AgentProject, b: AgentProject) => number {
  return (left: AgentProject, right: AgentProject): number => {
    const leftCount: number = state.activeSessionCountForProject(left.id);
    const rightCount: number = state.activeSessionCountForProject(right.id);
    if ((leftCount === 0) !== (rightCount === 0)) {
      return leftCount === 0 ? 1 : -1;
    }
    const leftKey: string = left.lastActivityAt ?? '';
    const rightKey: string = right.lastActivityAt ?? '';
    if (leftKey !== rightKey) {
      return leftKey > rightKey ? -1 : 1;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt > right.createdAt ? -1 : 1;
    }
    if (left.name !== right.name) {
      return left.name < right.name ? -1 : 1;
    }
    return left.id < right.id ? -1 : 1;
  };
}
