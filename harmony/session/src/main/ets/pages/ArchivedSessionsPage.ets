import { SessionsApi } from 'network';
import { RemoteProject, RemoteSession, RemoteSessionPage } from 'network';
import { SharedApiClient } from '../api/SharedApiClient';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { HomeMenuAnchor } from '../components/HomeProjectActionMenuOverlay';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';

const ARCHIVED_PAGE_LIMIT = 100;

interface ArchivedSessionGroup {
  projectId: string;
  project: RemoteProject | null;
  sessions: RemoteSession[];
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatArchivedTime(value: string): string {
  if (value.length === 0) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

@Component
export struct ArchivedSessionsPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State loading: boolean = true;
  @State loadingMore: boolean = false;
  @State loadError: boolean = false;
  @State hasMore: boolean = false;
  @State groups: ArchivedSessionGroup[] = [];
  @State projects: RemoteProject[] = [];
  @State selectedProjectId: string = '';
  @State pickerOpen: boolean = false;
  @State pickerAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @State restoringIds: Set<string> = new Set<string>();
  @State restoringProjectId: string = '';
  private navPathStack: NavPathStack = new NavPathStack();
  private requestSeq: number = 0;
  private nextCursor: string | null = null;
  private sessionsById: Map<string, RemoteSession> = new Map<string, RemoteSession>();
  private restoredIds: Set<string> = new Set<string>();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private sessionsApi: SessionsApi = new SessionsApi(SharedApiClient.getInstance());

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private secondaryInk(): string {
    return this.themeIsDark ? getColors().muted : '#565656';
  }

  private cardBorderColor(): ResourceColor {
    return this.themeIsDark ? Color.Transparent : '#E7E6E2';
  }

  private rowDividerColor(): string {
    return this.themeIsDark ? 'rgba(250, 250, 250, 0.07)' : 'rgba(28, 28, 30, 0.07)';
  }

  private mutating(): boolean {
    return this.restoringIds.size > 0 || this.restoringProjectId.length > 0;
  }

  private findProject(projectId: string): RemoteProject | null {
    if (projectId.length === 0) {
      return null;
    }
    for (const project of this.projects) {
      if (project.id === projectId) {
        return project;
      }
    }
    return null;
  }

  private projectOrder(projectId: string): number {
    for (let index = 0; index < this.projects.length; index++) {
      if (this.projects[index].id === projectId) {
        return index;
      }
    }
    return 2147483647;
  }

  private groupName(group: ArchivedSessionGroup): ResourceStr {
    if (group.project === null) {
      return $r('app.string.archived_unknown_project');
    }
    return group.project.name;
  }

  private groupWorkspacePath(group: ArchivedSessionGroup): string {
    if (group.project === null) {
      return '';
    }
    return group.project.workspacePath;
  }

  private selectedProjectName(): ResourceStr {
    if (this.selectedProjectId.length === 0) {
      return $r('app.string.archived_all_projects');
    }
    const project = this.findProject(this.selectedProjectId);
    if (project === null) {
      return $r('app.string.archived_all_projects');
    }
    return project.name;
  }

  private rebuildGroups(): void {
    const sessions: RemoteSession[] = [];
    this.sessionsById.forEach((value: RemoteSession) => {
      if (value.archived && !this.restoredIds.has(value.id)) {
        sessions.push(value);
      }
    });
    sessions.sort((a: RemoteSession, b: RemoteSession): number => {
      const aKey = a.archivedAt ?? a.sortAt ?? '';
      const bKey = b.archivedAt ?? b.sortAt ?? '';
      if (aKey !== bKey) {
        return aKey < bKey ? 1 : -1;
      }
      return a.id.localeCompare(b.id);
    });
    const groupMap: Map<string, ArchivedSessionGroup> = new Map<string, ArchivedSessionGroup>();
    const groups: ArchivedSessionGroup[] = [];
    for (const session of sessions) {
      const projectId = session.projectId === null || session.projectId.length === 0 ? '' : session.projectId;
      let group = groupMap.get(projectId);
      if (group === undefined) {
        group = {
          projectId: projectId,
          project: this.findProject(projectId),
          sessions: []
        };
        groupMap.set(projectId, group);
        groups.push(group);
      }
      group.sessions.push(session);
    }
    groups.sort((a: ArchivedSessionGroup, b: ArchivedSessionGroup): number => {
      const aUnknown = a.projectId.length === 0;
      const bUnknown = b.projectId.length === 0;
      if (aUnknown !== bUnknown) {
        return aUnknown ? 1 : -1;
      }
      const orderDiff = this.projectOrder(a.projectId) - this.projectOrder(b.projectId);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      const aName = a.project === null ? '' : a.project.name;
      const bName = b.project === null ? '' : b.project.name;
      return aName.localeCompare(bName);
    });
    this.groups = groups;
  }

  private acceptPage(page: RemoteSessionPage, reset: boolean): void {
    const previousCursor = reset ? null : this.nextCursor;
    if (reset) {
      this.sessionsById = new Map<string, RemoteSession>();
    }
    for (const session of page.sessions) {
      this.sessionsById.set(session.id, session);
    }
    const nextCursor = page.nextCursor;
    this.hasMore = page.hasMore && nextCursor !== null && nextCursor.length > 0 &&
      (reset || previousCursor === null || nextCursor !== previousCursor);
    this.nextCursor = nextCursor;
    this.rebuildGroups();
  }

  private async loadSessions(reset: boolean): Promise<void> {
    if (!reset) {
      if (this.loading || this.loadingMore || !this.hasMore) {
        return;
      }
      if (this.nextCursor === null) {
        return;
      }
    }
    const serverUrl = this.serverUrl();
    const accessToken = this.token();
    if (serverUrl.length === 0 || accessToken.length === 0) {
      return;
    }
    let seq = this.requestSeq;
    if (reset) {
      seq = ++this.requestSeq;
      this.restoredIds = new Set<string>();
      this.sessionsById = new Map<string, RemoteSession>();
      this.loading = true;
      this.loadError = false;
      this.hasMore = false;
      this.nextCursor = null;
      this.rebuildGroups();
    } else {
      this.loadingMore = true;
    }
    try {
      const cursor = reset ? null : this.nextCursor;
      let page: RemoteSessionPage;
      if (this.selectedProjectId.length > 0) {
        page = await this.sessionsApi.listProjectSessions(serverUrl, accessToken,
          this.selectedProjectId, true, ARCHIVED_PAGE_LIMIT, cursor);
      } else {
        page = await this.sessionsApi.listSessions(serverUrl, accessToken, true, ARCHIVED_PAGE_LIMIT, cursor);
      }
      if (seq !== this.requestSeq) {
        return;
      }
      this.acceptPage(page, reset);
      this.loading = false;
      this.loadingMore = false;
      this.loadError = false;
    } catch (error) {
      if (seq !== this.requestSeq) {
        return;
      }
      this.loading = false;
      this.loadingMore = false;
      this.loadError = true;
    }
  }

  private async loadProjects(): Promise<void> {
    try {
      const response = await this.sessionsApi.listProjects(this.serverUrl(), this.token());
      this.projects = response.projects;
      if (this.selectedProjectId.length > 0 && this.findProject(this.selectedProjectId) === null) {
        this.selectedProjectId = '';
        this.loadSessions(true);
      } else {
        this.rebuildGroups();
      }
    } catch (error) {
    }
  }

  private selectProject(projectId: string): void {
    this.pickerOpen = false;
    if (this.selectedProjectId === projectId) {
      return;
    }
    this.selectedProjectId = projectId;
    this.loadSessions(true);
  }

  private openPicker(): void {
    if (this.mutating() || this.pickerOpen) {
      return;
    }
    try {
      const uiContext = this.getUIContext();
      const utils = uiContext.getComponentUtils();
      const rootRect = utils.getRectangleById('archived_anchor_origin');
      const rect = utils.getRectangleById('archived_project_selector');
      // getRectangleById returns px while position() takes vp: convert via px2vp.
      this.pickerAnchor = {
        x: uiContext.px2vp(rect.windowOffset.x - rootRect.windowOffset.x),
        y: uiContext.px2vp(rect.windowOffset.y - rootRect.windowOffset.y),
        width: uiContext.px2vp(rect.size.width),
        height: uiContext.px2vp(rect.size.height)
      };
    } catch (error) {
      return;
    }
    this.pickerOpen = true;
  }

  private async restoreSession(sessionId: string): Promise<void> {
    if (this.mutating()) {
      return;
    }
    const restoring = new Set<string>(this.restoringIds);
    restoring.add(sessionId);
    this.restoringIds = restoring;
    let restored = false;
    try {
      const response = await this.sessionsApi.unarchiveSessions(this.serverUrl(), this.token(), [sessionId]);
      for (const session of response.sessions) {
        if (session.id === sessionId && !session.archived) {
          restored = true;
        }
      }
    } catch (error) {
    }
    const cleared = new Set<string>(this.restoringIds);
    cleared.delete(sessionId);
    this.restoringIds = cleared;
    if (!restored) {
      showToast($r('app.string.archived_restore_failed'));
      return;
    }
    const restoredSet = new Set<string>(this.restoredIds);
    restoredSet.add(sessionId);
    this.restoredIds = restoredSet;
    this.sessionsById.delete(sessionId);
    this.rebuildGroups();
    showToast($r('app.string.archived_restored'));
  }

  private async restoreProject(group: ArchivedSessionGroup): Promise<void> {
    if (group.project === null || this.mutating()) {
      return;
    }
    this.restoringProjectId = group.projectId;
    let failed = false;
    try {
      const sessions = await this.sessionsApi.archiveAllProjectSessions(this.serverUrl(), this.token(),
        group.projectId, false, 'archived');
      const restoredSet = new Set<string>(this.restoredIds);
      for (const session of sessions) {
        restoredSet.add(session.id);
        this.sessionsById.delete(session.id);
      }
      this.restoredIds = restoredSet;
    } catch (error) {
      failed = true;
    }
    this.restoringProjectId = '';
    this.rebuildGroups();
    if (failed) {
      showToast($r('app.string.archived_restore_failed'));
      return;
    }
    showToast($r('app.string.archived_restored'));
  }

  private archivedTimeText(session: RemoteSession): string {
    const formatted = formatArchivedTime(session.archivedAt ?? session.sortAt ?? '');
    if (formatted.length === 0) {
      return this.timeUnavailableText();
    }
    return formatted;
  }

  private timeUnavailableText(): string {
    try {
      const context = this.getUIContext().getHostContext();
      if (context !== undefined) {
        return context.resourceManager.getStringSync($r('app.string.archived_time_unavailable'));
      }
    } catch (error) {
    }
    return 'Time unavailable';
  }

  private sessionRestoring(group: ArchivedSessionGroup, session: RemoteSession): boolean {
    if (this.restoringIds.has(session.id)) {
      return true;
    }
    return this.restoringProjectId.length > 0 && this.restoringProjectId === group.projectId;
  }

  @Builder
  projectSelector() {
    Row({ space: 12 }) {
      SymbolGlyph($r('sys.symbol.folder'))
        .fontSize(21)
        .fontColor([this.secondaryInk()])
      Text(this.selectedProjectName())
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .lineHeight(20)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph(this.pickerOpen ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
        .fontSize(18)
        .fontColor([this.secondaryInk()])
    }
    .width('100%')
    .height(48)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(18)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: this.cardBorderColor() })
    .id('archived_project_selector')
    .enabled(!this.mutating())
    .onClick(() => {
      this.openPicker();
    })
  }

  @Builder
  pickerOption(symbol: Resource, label: ResourceStr, supportingText: string, selected: boolean,
    onClick: () => void) {
    Row({ space: 12 }) {
      SymbolGlyph(symbol)
        .fontSize(18)
        .fontColor([this.secondaryInk()])
      Column({ space: 2 }) {
        Text(label)
          .fontSize(14)
          .fontWeight(600)
          .lineHeight(19)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (supportingText.length > 0) {
          Text(supportingText)
            .fontSize(12)
            .lineHeight(16)
            .fontColor(this.secondaryInk())
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      if (selected) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([getColors().ink])
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      onClick();
    })
  }

  @Builder
  pickerOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.pickerOpen = false;
        })
      Scroll() {
        Column() {
          this.pickerOption($r('sys.symbol.folder'), $r('app.string.archived_all_projects'), '',
            this.selectedProjectId.length === 0, (): void => {
              this.selectProject('');
            })
          ForEach(this.projects, (project: RemoteProject) => {
            this.pickerOption($r('sys.symbol.folder'), project.name, project.workspacePath,
              this.selectedProjectId === project.id, (): void => {
                this.selectProject(project.id);
              })
          }, (project: RemoteProject) => project.id)
        }
        .width('100%')
      }
      .scrollBar(BarState.Off)
      .width(this.pickerAnchor.width)
      .constraintSize({ maxHeight: 328 })
      .borderRadius(18)
      .backgroundColor(this.themeIsDark ? getColors().subtle : getColors().raisedSurface)
      .border({ width: 1, color: this.themeIsDark ? Color.Transparent : getColors().border })
      .position({ x: this.pickerAnchor.x, y: this.pickerAnchor.y + this.pickerAnchor.height + 4 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  statusBox(showLoading: boolean, symbol: Resource) {
    Column() {
      if (showLoading) {
        LoadingProgress()
          .width(26)
          .height(26)
          .color(getColors().inkSoft)
      } else {
        SymbolGlyph(symbol)
          .fontSize(32)
          .fontColor([this.secondaryInk()])
      }
    }
    .width(80)
    .height(80)
    .borderRadius(26)
    .backgroundColor(getColors().raisedSurface)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  statusActionButton(label: ResourceStr, busy: boolean, onClick: () => void) {
    Row({ space: 6 }) {
      if (busy) {
        LoadingProgress()
          .width(15)
          .height(15)
          .color(this.secondaryInk())
      }
      Text(busy ? $r('app.string.archived_loading_more') : label)
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().inkSoft)
        .maxLines(1)
    }
    .constraintSize({ minHeight: 44 })
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .borderRadius(12)
    .backgroundColor(getColors().subtle)
    .border({ width: 1, color: this.cardBorderColor() })
    .margin({ top: 24 })
    .onClick(() => {
      onClick();
    })
  }

  @Builder
  loadingPanel() {
    Column() {
      this.statusBox(true, $r('sys.symbol.archivebox'))
      Text($r('app.string.archive_loading'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(23)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .margin({ top: 24 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 40, bottom: 40 })
  }

  @Builder
  errorPanel() {
    Column() {
      this.statusBox(false, $r('sys.symbol.exclamationmark_circle'))
      Text($r('app.string.archive_load_failed'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(23)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .margin({ top: 24 })
      Text($r('app.string.archive_retry_hint'))
        .fontSize(13)
        .lineHeight(20)
        .fontColor(this.secondaryInk())
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 260 })
        .margin({ top: 10 })
      this.statusActionButton($r('app.string.archived_retry'), false, (): void => {
        this.loadSessions(!this.hasMore);
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 40, bottom: 40 })
  }

  @Builder
  pageEmptyPanel() {
    Column() {
      this.statusBox(false, $r('sys.symbol.archivebox'))
      Text($r('app.string.archive_page_empty'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(23)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .margin({ top: 24 })
      Text($r('app.string.archive_more_hint'))
        .fontSize(13)
        .lineHeight(20)
        .fontColor(this.secondaryInk())
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 260 })
        .margin({ top: 10 })
      this.statusActionButton($r('app.string.archived_load_more'), this.loadingMore, (): void => {
        this.loadSessions(false);
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 40, bottom: 40 })
  }

  @Builder
  emptyPanel() {
    Column() {
      this.statusBox(false, $r('sys.symbol.archivebox'))
      Text(this.selectedProjectId.length === 0 ? $r('app.string.archived_empty') :
        $r('app.string.archive_project_empty'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(23)
        .fontColor(getColors().inkSoft)
        .textAlign(TextAlign.Center)
        .margin({ top: 24 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 40, bottom: 40 })
  }

  @Builder
  groupHeader(group: ArchivedSessionGroup) {
    Column() {
      Row({ space: 8 }) {
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(20)
          .fontColor([this.secondaryInk()])
        Text(this.groupName(group))
          .fontSize(15)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (group.project !== null) {
          Row({ space: 6 }) {
            if (this.restoringProjectId === group.projectId) {
              LoadingProgress()
                .width(15)
                .height(15)
                .color(this.secondaryInk())
            }
            Text(this.restoringProjectId === group.projectId ? $r('app.string.archived_restoring') :
              $r('app.string.archived_restore_project'))
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.restoringProjectId === group.projectId ? this.secondaryInk() :
                getColors().inkSoft)
              .maxLines(1)
          }
          .constraintSize({ minHeight: 44 })
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .borderRadius(12)
          .enabled(!this.mutating())
          .onClick(() => {
            this.restoreProject(group);
          })
        }
      }
      .width('100%')
      .constraintSize({ minHeight: 44 })
      .alignItems(VerticalAlign.Center)
      if (this.groupWorkspacePath(group).length > 0) {
        Text(this.groupWorkspacePath(group))
          .fontSize(11)
          .lineHeight(16)
          .fontColor(this.secondaryInk())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ left: 28, right: 12 })
      }
    }
    .width('100%')
    .padding({ top: 16, bottom: 12 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sessionRow(group: ArchivedSessionGroup, session: RemoteSession, index: number) {
    Column() {
      Row({ space: 12 }) {
        Column({ space: 8 }) {
          Text(session.title ?? '')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .lineHeight(21)
            .fontColor(getColors().ink)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text($r('app.string.archive_archived_at', this.archivedTimeText(session)))
            .fontSize(11)
            .lineHeight(16)
            .fontColor(this.secondaryInk())
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Row({ space: 6 }) {
          if (this.sessionRestoring(group, session)) {
            LoadingProgress()
              .width(15)
              .height(15)
              .color(this.secondaryInk())
          } else {
            SymbolGlyph($r('sys.symbol.arrow_up_circle'))
              .fontSize(16)
              .fontColor([getColors().inkSoft])
          }
          Text(this.sessionRestoring(group, session) ? $r('app.string.archived_restoring') :
            $r('app.string.archived_restore'))
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.sessionRestoring(group, session) ? this.secondaryInk() : getColors().inkSoft)
            .maxLines(1)
        }
        .constraintSize({ minHeight: 44 })
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .borderRadius(12)
        .backgroundColor(getColors().subtle)
        .border({ width: 1, color: this.cardBorderColor() })
        .enabled(!this.mutating())
        .onClick(() => {
          this.restoreSession(session.id);
        })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 14, bottom: 14 })
      .alignItems(VerticalAlign.Center)
      if (index < group.sessions.length - 1) {
        Divider()
          .color(this.rowDividerColor())
          .margin({ left: 16, right: 16 })
      }
    }
    .width('100%')
  }

  @Builder
  groupCard(group: ArchivedSessionGroup) {
    Column() {
      ForEach(group.sessions, (session: RemoteSession, index: number) => {
        this.sessionRow(group, session, index)
      }, (session: RemoteSession) => session.id)
    }
    .width('100%')
    .borderRadius(18)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: this.cardBorderColor() })
    .clip(true)
  }

  @Builder
  listFooter() {
    Column({ space: 8 }) {
      if (this.loadError) {
        Text($r('app.string.archive_more_failed'))
          .fontSize(13)
          .fontColor(this.secondaryInk())
      }
      Row({ space: 6 }) {
        if (this.loadingMore) {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(this.secondaryInk())
        } else {
          SymbolGlyph(this.loadError ? $r('sys.symbol.arrow_clockwise') : $r('sys.symbol.chevron_down'))
            .fontSize(16)
            .fontColor([getColors().inkSoft])
        }
        Text(this.footerButtonLabel())
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.loadingMore ? this.secondaryInk() : getColors().inkSoft)
          .maxLines(1)
      }
      .constraintSize({ minHeight: 44 })
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .borderRadius(12)
      .enabled(!this.mutating() && !this.loadingMore)
      .onClick(() => {
        this.loadSessions(false);
      })
    }
    .width('100%')
    .margin({ top: 20 })
    .alignItems(HorizontalAlign.Center)
  }

  private footerButtonLabel(): ResourceStr {
    if (this.loadingMore) {
      return $r('app.string.archived_loading_more');
    }
    if (this.loadError) {
      return $r('app.string.archived_retry');
    }
    return $r('app.string.archived_load_more');
  }

  @Builder
  sessionList() {
    List({ space: 0 }) {
      ForEach(this.groups, (group: ArchivedSessionGroup) => {
        ListItem() {
          Column() {
            this.groupHeader(group)
            this.groupCard(group)
          }
        }
      }, (group: ArchivedSessionGroup) => `group:${group.projectId}`)
      if (this.loadError || this.hasMore) {
        ListItem() {
          this.listFooter()
        }
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    .padding({ top: 4, bottom: 24 })
  }

  build() {
    NavDestination() {
      Stack() {
        // Zero-size origin marker used to calibrate picker anchors; see the
        // matching comment in HomePage for why page-root ids are unreliable.
        Column()
          .width(0)
          .height(0)
          .position({ x: 0, y: 0 })
          .id('archived_anchor_origin')
        Column() {
          this.projectSelector()
          if (this.loading) {
            this.loadingPanel()
          } else if (this.groups.length === 0 && this.loadError) {
            this.errorPanel()
          } else if (this.groups.length === 0 && this.hasMore) {
            this.pageEmptyPanel()
          } else if (this.groups.length === 0) {
            this.emptyPanel()
          } else {
            this.sessionList()
          }
        }
        .width('100%')
        .height('100%')
        .padding({ left: 18, right: 18, top: 12 })
        if (this.pickerOpen) {
          this.pickerOverlay()
        }
      }
      .width('100%')
      .height('100%')
      .id('archived_page_root')
    }
    .title($r('app.string.profile_archived_sessions'))
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      this.loadProjects();
      this.loadSessions(true);
    })
    .onBackPressed((): boolean => {
      if (this.pickerOpen) {
        this.pickerOpen = false;
        return true;
      }
      return false;
    })
  }
}

@Builder
export function ArchivedSessionsPageBuilder() {
  ArchivedSessionsPage()
}
