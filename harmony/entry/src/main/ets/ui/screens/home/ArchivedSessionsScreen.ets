import { AgentProject, AgentSession } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import { SessionsController } from '../../../feature/sessions/SessionsController';
import {
  ArchivedSessionGroup, formatArchivedAt, groupArchivedSessions, groupSessionIds,
} from '../../../feature/sessions/ArchivedSessions';
import { AAColors, AA_LIGHT_COLORS, compositeOverAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius, AASpacing } from '../../designsystem/AAMetrics';
import { AAIosInlineBar } from '../../designsystem/AAIosChrome';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';

/**
 * Archived sessions, grouped by project.
 *
 * Port of `ui/screens/home/ArchivedSessionsScreen.kt`.
 *
 * The page has no back stack of its own: it reports up to the shell, which
 * returns to Home. Restoring is the only mutation, and every restore control is
 * disabled while one is in flight so a double tap cannot queue two restores.
 */
@Component
export struct ArchivedSessionsScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  @Prop state: SessionsState;
  controller: SessionsController | null = null;
  onStateChange: (next: SessionsState) => void = () => {};
  onBack: () => void = () => {};
  onOpenSession: (session: AgentSession) => void = () => {};

  /** Selected project filter; null means "All projects". */
  @State private selectedProjectId: string | null = null;
  @State private pickerOpen: boolean = false;
  @State private loading: boolean = true;
  @State private loadError: string = '';
  @State private restoring: boolean = false;
  /** True once the first page has been requested, so the empty state is honest. */
  @State private loadedOnce: boolean = false;
  private toast: AAToastState = new AAToastState();
  @State private toastRevision: number = 0;

  aboutToAppear(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    if (controller === null) {
      return;
    }
    this.loading = true;
    this.loadError = '';
    try {
      const next: SessionsState = await controller.loadArchived(this.state);
      this.onStateChange(next);
      this.loadedOnce = true;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : 'Could not load archived sessions';
      this.loadedOnce = true;
    } finally {
      this.loading = false;
    }
  }

  private async loadMore(): Promise<void> {
    const controller: SessionsController | null = this.controller;
    if (controller === null) {
      return;
    }
    const next: SessionsState = await controller.loadMoreArchived(this.state);
    this.onStateChange(next);
  }

  private async restore(sessionIds: string[]): Promise<void> {
    const controller: SessionsController | null = this.controller;
    if (controller === null || sessionIds.length === 0 || this.restoring) {
      return;
    }
    this.restoring = true;
    try {
      const next: SessionsState = await controller.setArchivedBulk(this.state, sessionIds, false);
      const refreshed: SessionsState = await controller.loadArchived(next);
      this.onStateChange(refreshed);
      this.showToast($r('app.string.archived_restored'), false);
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : 'Could not restore sessions. Try again.',
        true,
      );
    } finally {
      this.restoring = false;
    }
  }

  private showToast(message: ResourceStr, isError: boolean): void {
    this.toast.show(message, isError);
    this.toastRevision += 1;
  }

  /** Groups limited to the selected project, if any. */
  private groups(): ArchivedSessionGroup[] {
    const all: ArchivedSessionGroup[] = groupArchivedSessions(
      this.state.archivedSessions, this.state.projects,
    );
    const selected: string | null = this.selectedProjectId;
    if (selected === null) {
      return all;
    }
    return all.filter((group: ArchivedSessionGroup) => group.projectId === selected);
  }

  private selectedProjectName(): ResourceStr {
    const selected: string | null = this.selectedProjectId;
    if (selected === null) {
      return $r('app.string.archived_all_projects');
    }
    for (const project of this.state.projects) {
      if (project.id === selected) {
        return project.name;
      }
    }
    return $r('app.string.archived_all_projects');
  }

  private totalCount(): number {
    let count: number = 0;
    for (const group of this.groups()) {
      count += group.sessions.length;
    }
    return count;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        // iOS's `ArchivedSessionsSheet`: an inline navigation bar — dismiss glyph,
        // centred 17sp/600 title — instead of Android's 64dp bar.
        AAIosInlineBar({
          colors: this.colors,
          title: $r('app.string.profile_archived_sessions'),
          onBack: () => this.onBack(),
        })

        // Project filter selector.
        Column() {
          // The project filter as an iOS list row: a bare 18dp glyph, the value at
          // 17sp and the up-down chevrons that mark a picker.
          Row({ space: 12 }) {
            AAIcon({ commands: AA_ICONS.FOLDER, iconSize: 18, color: this.colors.ink })
            Text(this.selectedProjectName())
              .fontSize(17)
              .fontColor(this.colors.ink)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            AAIcon({ commands: AA_ICONS.CHEVRONS_UP_DOWN, iconSize: 14, color: this.colors.faint })
          }
          .width('100%')
          .height(48)
          .padding({ left: 16, right: 16 })
          .borderRadius(12)
          .backgroundColor(this.colors.raisedSurface)
          .alignItems(VerticalAlign.Center)
          .onClick(() => {
            if (!this.restoring) {
              this.pickerOpen = !this.pickerOpen;
            }
          })

          if (this.pickerOpen) {
            this.ProjectPicker()
          }
        }
        .width('100%')
        .margin({ top: 12 })

        // Body: loading, error, empty, or the grouped list.
        Column() {
          if (this.loading && !this.loadedOnce) {
            this.StatusPanel($r('app.string.archive_loading'), '', AA_ICONS.ARCHIVE, false, true, '', false)
          } else if (this.groups().length === 0 && this.loadError.length > 0) {
            this.StatusPanel(
              $r('app.string.archive_load_failed'), $r('app.string.archive_retry_hint'),
              AA_ICONS.CIRCLE_ALERT, false, false, $r('app.string.archived_retry'), false,
            )
          } else if (this.groups().length === 0
            && this.state.archivedHasMore && this.state.archivedNextCursor !== null) {
            this.StatusPanel(
              $r('app.string.archive_page_empty'), $r('app.string.archive_more_hint'),
              AA_ICONS.ARCHIVE, true, false, $r('app.string.archived_load_more'), false,
            )
          } else if (this.groups().length === 0) {
            this.StatusPanel(
              this.selectedProjectId === null
                ? $r('app.string.archived_empty')
                : $r('app.string.archive_project_empty'),
              '', AA_ICONS.ARCHIVE, true, false, '', false,
            )
          } else {
            this.GroupedList()
          }
        }
        .layoutWeight(1)
        .width('100%')
      }
      .width('100%')
      .height('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: AASpacing.HOME_H, right: AASpacing.HOME_H })

      Column() {
        AAToastHost({
          colors: this.colors,
          message: this.toast.message,
          isError: this.toast.isError,
          visible: this.toast.visible,
        })
      }
      .width('100%')
      .padding({ left: 22, right: 22, top: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
  }

  @Builder
  ProjectPicker() {
    Column() {
      this.PickerRow($r('app.string.archived_all_projects'), null)
      ForEach(this.state.projects, (project: AgentProject) => {
        this.PickerRow(project.name, project.id)
      }, (project: AgentProject) => `picker-${project.id}`)
    }
    .width('100%')
    .constraintSize({ maxHeight: 320 })
    .padding({ top: 6, bottom: 6 })
    .margin({ top: 6 })
    .borderRadius(AARadius.CARD)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    .shadow({ radius: 18, color: this.colors.appShadow, offsetX: 0, offsetY: 6 })
  }

  @Builder
  PickerRow(label: ResourceStr, projectId: string | null) {
    Row({ space: 10 }) {
      AAIcon({ commands: AA_ICONS.FOLDER, iconSize: 20, color: this.colors.inkSoft })
      Text(label)
        .fontSize(AAFontSize.BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (this.selectedProjectId === projectId) {
        AAIcon({ commands: AA_ICONS.CHECK, iconSize: 18, color: this.colors.sessionStatusAccent })
      }
    }
    .width('100%')
    .height(48)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.selectedProjectId = projectId;
      this.pickerOpen = false;
    })
  }

  /**
   * Android's `archiveSecondaryInk`: the muted tone in dark mode, and the soft
   * ink composited over the raised surface in light mode.
   */
  private secondaryInk(): string {
    return this.colors.isDark
      ? this.colors.muted
      : compositeOverAlpha(this.colors.inkSoft, 0.8, this.colors.raisedSurface);
  }

  /**
   * Status panel for the archived page.
   *
   * Port of `ArchivedStatusPanel`: a 128dp `ic_archive_empty_*` illustration for
   * the empty states, otherwise an 80dp 26dp-rounded tile holding a 26dp spinner
   * while loading or a 32dp icon; then 24dp, the 16sp/23sp semi-bold title, an
   * optional 13sp/20sp description 10dp below it, and an optional action 24dp
   * after that.
   */
  @Builder
  StatusPanel(
    title: ResourceStr,
    description: ResourceStr,
    iconCommands: string,
    showEmptyIllustration: boolean,
    loading: boolean,
    actionLabel: ResourceStr,
    actionLoading: boolean,
  ) {
    Column() {
      if (showEmptyIllustration) {
        Image(this.colors.isDark ? $r('app.media.ic_archive_empty_dark')
          : $r('app.media.ic_archive_empty_light'))
          .width(128)
          .height(128)
          .objectFit(ImageFit.Contain)
      } else {
        Column() {
          if (loading) {
            LoadingProgress().width(26).height(26).color(this.colors.inkSoft)
          } else {
            AAIcon({ commands: iconCommands, iconSize: 32, color: this.secondaryInk() })
          }
        }
        .width(80)
        .height(80)
        .justifyContent(FlexAlign.Center)
        .borderRadius(26)
        .backgroundColor(this.colors.raisedSurface)
      }

      Column().height(24)

      Text(title)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.inkSoft)
        .lineHeight(23)
        .textAlign(TextAlign.Center)

      if (description !== '') {
        Text(description)
          .fontSize(13)
          .fontColor(this.secondaryInk())
          .lineHeight(20)
          .textAlign(TextAlign.Center)
          .constraintSize({ maxWidth: 260 })
          .margin({ top: 10 })
      }

      if (actionLabel !== '') {
        Column().height(24)
        Row({ space: 6 }) {
          if (actionLoading) {
            LoadingProgress().width(15).height(15).color(this.secondaryInk())
          }
          Text(actionLoading ? $r('app.string.archived_loading_more') : actionLabel)
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.colors.inkSoft)
            .maxLines(1)
        }
        .constraintSize({ minHeight: 44 })
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .borderRadius(12)
        .backgroundColor(this.colors.subtle)
        .border({
          width: this.colors.isDark ? 0 : 1,
          color: this.colors.isDark ? '#00000000' : '#E7E6E2',
        })
        .opacity(this.restoring ? 0.4 : 1)
        .onClick(() => {
          if (actionLoading) {
            void this.loadMore();
          } else {
            void this.reload();
          }
        })
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 40, bottom: 40 })
  }

  @Builder
  GroupedList() {
    List() {
      ForEach(this.groups(), (group: ArchivedSessionGroup) => {
        ListItem() {
          this.GroupHeader(group)
        }
        ForEach(group.sessions, (session: AgentSession) => {
          ListItem() {
            this.SessionRow(session)
          }
        }, (session: AgentSession) => `archived-${session.id}`)
      }, (group: ArchivedSessionGroup) => `group-${group.projectId ?? 'unknown'}`)

      ListItem() {
        this.Footer()
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    .margin({ top: 12 })
    .onReachEnd(() => {
      if (this.state.archivedHasMore && !this.restoring) {
        void this.loadMore();
      }
    })
  }

  @Builder
  GroupHeader(group: ArchivedSessionGroup) {
    Row({ space: 10 }) {
      AAIcon({ commands: AA_ICONS.FOLDER_OPEN, iconSize: 20, color: this.colors.inkSoft })
      Column({ space: 2 }) {
        Text(group.projectId === null
          ? $r('app.string.archived_unknown_project')
          : group.projectName)
          .fontSize(AAFontSize.BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.ink)
          .maxLines(1)
        if (group.projectPath.length > 0) {
          Text(group.projectPath)
            .fontSize(11)
            .fontColor(this.colors.faint)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text($r('app.string.archived_restore_project'))
        .fontSize(AAFontSize.CAPTION)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.inkSoft)
        .padding({ left: 12, right: 12, top: 6, bottom: 6 })
        .borderRadius(AARadius.PILL)
        .border({ width: 1, color: this.colors.border })
        .opacity(this.restoring ? 0.5 : 1)
        .enabled(!this.restoring)
        .onClick(() => {
          void this.restore(groupSessionIds(group));
        })
    }
    .width('100%')
    .padding({ top: 14, bottom: 6, left: 4 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  SessionRow(session: AgentSession) {
    // iOS's archived row: the title at body size with a caption line under it, and
    // a bare restore glyph on the trailing side (a spinner while it works) rather
    // than Android's labelled pill.
    Row({ space: 10 }) {
      Column({ space: 2 }) {
        Text(session.title)
          .fontSize(17)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(this.archivedLabel(session))
          .fontSize(12)
          .fontColor(this.colors.muted)
          .maxLines(1)
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Column() {
        if (this.restoring) {
          LoadingProgress().width(16).height(16).color(this.colors.muted)
        } else {
          AAIcon({ commands: AA_ICONS.ARCHIVE_RESTORE, iconSize: 18, color: this.colors.ink })
        }
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .accessibilityText($r('app.string.archived_restore'))
      .enabled(!this.restoring)
      .onClick(() => {
        void this.restore([session.id]);
      })
    }
    .width('100%')
    .height(56)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.onOpenSession(session))
  }

  /** `Archived <timestamp>`, or the shared "unavailable" copy. */
  private archivedLabel(session: AgentSession): ResourceStr {
    const formatted: string = formatArchivedAt(session.archivedAt);
    if (formatted.length === 0) {
      return $r('app.string.archived_time_unavailable');
    }
    return $r('app.string.archive_archived_at', formatted);
  }

  @Builder
  Footer() {
    Column({ space: 8 }) {
      if (this.state.archivedHasMore && this.state.archivedNextCursor !== null) {
        if (this.state.isLoadingMoreArchived) {
          Row({ space: 8 }) {
            LoadingProgress().width(18).height(18).color(this.colors.ink)
            Text($r('app.string.archived_loading_more'))
              .fontSize(AAFontSize.CAPTION)
              .fontColor(this.colors.muted)
          }
          .height(48)
        } else {
          Text($r('app.string.archived_load_more'))
            .fontSize(AAFontSize.CAPTION)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.inkSoft)
            .height(48)
            .onClick(() => {
              void this.loadMore();
            })
        }
      }
      Column().height(24)
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}
