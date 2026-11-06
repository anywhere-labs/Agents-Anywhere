import { display } from '@kit.ArkUI';
import {
  RuntimeSelectionGroup, RuntimeSelectionOption,
  groupIsSelected, groupRepresentative, groupSelectionOptions, modelCatalogSelectionOptions,
  permissionCatalogSelectionOptions, validatedSelection,
} from '../../../api/RuntimeCatalogDtos';
import { RuntimeSettingsState } from '../../../feature/sessiondetail/RuntimeSettingsState';
import {
  RuntimePermissionTranslation, runtimePermissionTranslation,
} from '../../../feature/sessiondetail/RuntimePermissionTranslation';
import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AARadius } from '../../designsystem/AAMetrics';
import {
  AABottomSheetColors, AABottomSheetItem, AA_LIGHT_SHEET_COLORS, aaBottomSheetColors,
} from '../../designsystem/AABottomSheet';
import {
  runtimePermissionDescriptionResource, runtimePermissionLabelResource,
} from '../../designsystem/RuntimePermissionLocalization';

/**
 * Runtime settings sheet ("Model settings").
 *
 * Port of `ui/screens/sessiondetail/SessionRuntimeSettingsSheet.kt`.
 *
 * Two pages in one surface:
 *
 *  1. **Model** — one row per model *group*. The catalog flattens a model and its
 *     reasoning variants into separate options labelled `"<model> · <effort>"`,
 *     and the sheet collapses them back into one row per model, showing the
 *     variant that is currently selected.
 *  2. **Mode & effort** — the permission modes, then the effort segments for the
 *     selected model when it has more than one variant.
 *
 * The chrome (handle, header, scrolling body) is drawn here because ArkUI's sheet
 * surface is opened with `bindSheet` from the screen; see `AABottomSheet` for why
 * that split exists.
 *
 * Deviations from Android, all deliberate: the sheet reads the live settings
 * holder instead of a long argument list, because ArkTS cannot pass a localized
 * resource through `RuntimeSelectionOption` without widening that type; the
 * selection error line is drawn here rather than toasted by the screen; and there
 * is no optimistic selection, so a row changes only once the Server echoes it.
 * Hover, focus and pressed states are not ported.
 */

const HANDLE_WIDTH: number = 36;
const HANDLE_HEIGHT: number = 4;
const TRACK_HEIGHT: number = 48;
const TRACK_RADIUS: number = 14;
const SEGMENT_RADIUS: number = 12;
const CONTENT_INSET: number = 16;
/** Handle block plus header height, subtracted from the sheet's own cap. */
const CHROME_HEIGHT: number = 76;

@Component
export struct SessionRuntimeSettingsSheet {
  colors: AAColors = AA_LIGHT_COLORS;
  settings: RuntimeSettingsState = RuntimeSettingsState.empty();
  /** Runtime label, used as the effort section's fallback title. */
  runtimeLabel: string = '';
  onDismiss: () => void = () => {};
  onRetryModels: () => void = () => {};
  onRetryPermissions: () => void = () => {};
  onSelectModel: (selectionId: string) => void = () => {};
  onSelectPermission: (selectionId: string) => void = () => {};

  /** False shows the model page, true the mode and effort page. */
  @State private showModePage: boolean = false;
  @State private trackWidth: number = 0;
  @State private dragSelectionId: string = '';
  @State private dragging: boolean = false;
  /** Measured once; the sheet is capped at 90% of the screen, as Android is. */
  private cachedMaxHeight: number = 0;

  private sheetColors(): AABottomSheetColors {
    return aaBottomSheetColors(this.colors);
  }

  private maxHeight(): number {
    if (this.cachedMaxHeight <= 0) {
      try {
        const screenPx: number = display.getDefaultDisplaySync().height;
        this.cachedMaxHeight = this.getUIContext().px2vp(screenPx) * 0.9;
      } catch (error) {
        // A display that cannot be read falls back to a phone-sized cap; the
        // sheet is scrollable, so nothing is lost but a little height.
        this.cachedMaxHeight = 640;
      }
    }
    return this.cachedMaxHeight;
  }

  // ----------------------------------------------------------------- catalogs

  private modelOptions(): RuntimeSelectionOption[] {
    return modelCatalogSelectionOptions(this.settings.modelCatalog);
  }

  private permissionOptions(): RuntimeSelectionOption[] {
    return permissionCatalogSelectionOptions(this.settings.permissionCatalog);
  }

  private modelGroups(): RuntimeSelectionGroup[] {
    return groupSelectionOptions(this.modelOptions());
  }

  /** The selection to show for a scope, falling back to the catalog default. */
  private modelSelection(): string | null {
    return validatedSelection(this.modelOptions(), this.settings.modelSelection());
  }

  private permissionSelection(): string | null {
    return validatedSelection(this.permissionOptions(), this.settings.permissionSelection());
  }

  private selectedModelGroup(): RuntimeSelectionGroup | null {
    const selected: string | null = this.modelSelection();
    if (selected === null) {
      return null;
    }
    for (const group of this.modelGroups()) {
      if (groupIsSelected(group, selected)) {
        return group;
      }
    }
    return null;
  }

  /** The reasoning variants of the selected model, when there is a choice. */
  private effortOptions(): RuntimeSelectionOption[] {
    const group: RuntimeSelectionGroup | null = this.selectedModelGroup();
    if (group === null || group.options.length <= 1) {
      return [];
    }
    return group.options;
  }

  private busy(): boolean {
    return this.settings.busy;
  }

  // ------------------------------------------------------------- localization

  /** The mode kind for an option, looked up so its metadata is available. */
  private permissionTranslation(option: RuntimeSelectionOption): RuntimePermissionTranslation | null {
    const catalog = this.settings.permissionCatalog;
    if (catalog === null) {
      return null;
    }
    for (const permission of catalog.permissions) {
      if (permission.selectionId === option.selectionId) {
        return runtimePermissionTranslation(catalog.runtime, permission.id, permission.metadata);
      }
    }
    return null;
  }

  /**
   * The mode's label: the client's own copy for a recognized mode, else the
   * Server's text. It stays a resource so the language mode still applies.
   */
  private permissionLabel(option: RuntimeSelectionOption): ResourceStr {
    const resource: Resource | null = runtimePermissionLabelResource(this.permissionTranslation(option));
    return resource === null ? option.label : resource;
  }

  /**
   * The mode's supporting line.
   *
   * A disabled mode explains itself first; otherwise the client's own description
   * is used, and the Server's text stands when the client has none.
   */
  private permissionSupporting(option: RuntimeSelectionOption): ResourceStr | null {
    const reason: string | null = option.disabledReason;
    if (reason !== null && reason.length > 0) {
      return reason;
    }
    const resource: Resource | null = runtimePermissionDescriptionResource(this.permissionTranslation(option));
    if (resource !== null) {
      return resource;
    }
    return option.description;
  }

  private permissionOptionFor(selectionId: string | null): RuntimeSelectionOption | null {
    if (selectionId === null) {
      return null;
    }
    for (const option of this.permissionOptions()) {
      if (option.selectionId === selectionId) {
        return option;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ labels

  /** The effort part of an option's label, or the "Default" fallback. */
  private effortDisplayLabel(option: RuntimeSelectionOption): ResourceStr {
    const index: number = option.label.lastIndexOf(' · ');
    if (index > 0) {
      return option.label.substring(index + 3);
    }
    return $r('app.string.session_runtime_effort_default');
  }

  private groupRepresentativeFor(group: RuntimeSelectionGroup): RuntimeSelectionOption | null {
    return groupRepresentative(group, this.modelSelection());
  }

  /** The mode row's first supporting segment: the permission, else the effort. */
  private modeSummaryPrimary(): ResourceStr {
    const permission: RuntimeSelectionOption | null =
      this.permissionOptionFor(this.permissionSelection());
    if (permission !== null) {
      return this.permissionLabel(permission);
    }
    const effort: ResourceStr | null = this.modeSummaryEffort();
    return effort === null ? $r('app.string.session_runtime_no_settings') : effort;
  }

  /** The effort segment, shown only when a permission label leads the line. */
  private modeSummarySuffix(): ResourceStr | null {
    const permission: RuntimeSelectionOption | null =
      this.permissionOptionFor(this.permissionSelection());
    if (permission === null) {
      return null;
    }
    return this.modeSummaryEffort();
  }

  private modeSummaryEffort(): ResourceStr | null {
    const group: RuntimeSelectionGroup | null = this.selectedModelGroup();
    if (group === null) {
      return null;
    }
    const option: RuntimeSelectionOption | null = this.groupRepresentativeFor(group);
    return option === null ? null : this.effortDisplayLabel(option);
  }

  private groupSupportingText(group: RuntimeSelectionGroup): string | null {
    const option: RuntimeSelectionOption | null = this.groupRepresentativeFor(group);
    if (option === null) {
      return null;
    }
    return option.disabledReason;
  }

  // -------------------------------------------------------------------- build

  build() {
    Column() {
      // Drag handle: a 36x4 bar, as in Android.
      Column() {
        Column()
          .width(HANDLE_WIDTH)
          .height(HANDLE_HEIGHT)
          .borderRadius(2)
          .backgroundColor(this.sheetColors().handle)
      }
      .width('100%')
      .padding({ top: 12, bottom: 8 })
      .alignItems(HorizontalAlign.Center)

      this.Header()

      Scroll() {
        Column({ space: 4 }) {
          if (this.showModePage) {
            this.ModeEffortPage()
          } else {
            this.ModelPage()
          }
        }
        .width('100%')
        .padding({
          left: CONTENT_INSET, right: CONTENT_INSET, top: 8, bottom: 20,
        })
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
      .constraintSize({ maxHeight: this.maxHeight() - CHROME_HEIGHT })
    }
    .width('100%')
    .constraintSize({ maxHeight: this.maxHeight() })
    .borderRadius({ topLeft: AARadius.SHEET, topRight: AARadius.SHEET })
    .clip(true)
    .backgroundColor(this.sheetColors().container)
  }

  @Builder
  Header() {
    Row() {
      if (this.showModePage) {
        Column() {
          AAIcon({
            commands: AA_ICONS.CHEVRON_LEFT,
            iconSize: 22,
            color: this.sheetColors().content,
          })
        }
        .width(48)
        .height(48)
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          if (!this.busy()) {
            this.showModePage = false;
          }
        })
      }

      Text(this.showModePage
        ? $r('app.string.session_runtime_mode_effort')
        : $r('app.string.session_runtime_select_model'))
        .fontSize(18)
        .lineHeight(24)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.sheetColors().content)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .padding({ top: 8, bottom: 8 })

      Column() {
        AAIcon({
          commands: AA_ICONS.X,
          iconSize: 20,
          color: this.busy()
            ? withAlpha(this.sheetColors().secondaryContent, 0.38)
            : this.sheetColors().secondaryContent,
        })
      }
      .width(48)
      .height(48)
      .justifyContent(FlexAlign.Center)
      .onClick(() => {
        if (!this.busy()) {
          this.onDismiss();
        }
      })
    }
    .width('100%')
    .constraintSize({ minHeight: 52 })
    .padding({ left: this.showModePage ? 12 : 24, right: 12 })
    .alignItems(VerticalAlign.Center)
  }

  // ------------------------------------------------------------------- page 1

  @Builder
  ModelPage() {
    this.ModelOptions()
    this.DividerLine()
    AABottomSheetItem({
      sheetColors: this.sheetColors(),
      text: $r('app.string.session_runtime_mode_effort'),
      supportingText: this.modeSummaryPrimary(),
      supportingSuffix: this.modeSummarySuffix(),
      rowEnabled: !this.busy(),
      showChevron: true,
      onTap: () => {
        this.showModePage = true;
      },
    })
  }

  @Builder
  ModelOptions() {
    if (this.settings.modelLoading && this.modelGroups().length === 0) {
      this.LoadingBox(210)
    } else if (this.settings.modelError !== null && this.modelGroups().length === 0) {
      this.ErrorBox(this.settings.modelError ?? '', 210, !this.busy() && !this.settings.modelLoading, true)
    } else if (this.modelGroups().length === 0) {
      this.EmptyBox()
    } else {
      Column({ space: 4 }) {
        ForEach(this.modelGroups(), (group: RuntimeSelectionGroup) => {
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: group.label,
            supportingText: this.groupSupportingText(group),
            isChoice: true,
            isSelected: groupIsSelected(group, this.modelSelection()),
            rowEnabled: !this.busy() && !this.settings.modelLoading
              && this.groupRepresentativeEnabled(group),
            onTap: () => this.selectGroup(group),
          })
        }, (group: RuntimeSelectionGroup) => `model-${group.label}`)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  private groupRepresentativeEnabled(group: RuntimeSelectionGroup): boolean {
    const option: RuntimeSelectionOption | null = this.groupRepresentativeFor(group);
    return option !== null && option.enabled;
  }

  private selectGroup(group: RuntimeSelectionGroup): void {
    const option: RuntimeSelectionOption | null = this.groupRepresentativeFor(group);
    if (option === null || !option.enabled) {
      return;
    }
    this.onSelectModel(option.selectionId);
  }

  // ------------------------------------------------------------------- page 2

  @Builder
  ModeEffortPage() {
    Column({ space: 12 }) {
      this.SectionLabel($r('app.string.session_runtime_permission_mode'))
      this.PermissionOptions()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)

    if (this.effortOptions().length > 1) {
      this.DividerLine()
      Column({ space: 10 }) {
        this.SectionLabel($r('app.string.session_runtime_effort_for', this.effortModelLabel()))
        this.EffortSegments(this.effortOptions())
        ForEach(this.disabledEffortOptions(), (option: RuntimeSelectionOption) => {
          Text() {
            Span(this.effortDisplayLabel(option))
            Span(': ')
            Span(option.disabledReason ?? '')
          }
          .fontSize(11.5)
          .fontColor(this.sheetColors().secondaryContent)
          .width('100%')
        }, (option: RuntimeSelectionOption) => `reason-${option.selectionId}`)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  PermissionOptions() {
    if (this.settings.permissionLoading && this.permissionOptions().length === 0) {
      this.LoadingBox(72)
    } else if (this.settings.permissionError !== null && this.permissionOptions().length === 0) {
      this.ErrorBox(this.settings.permissionError ?? '', 96,
        !this.busy() && !this.settings.permissionLoading, false)
    } else if (this.permissionOptions().length === 0) {
      this.EmptyBox()
    } else {
      Column({ space: 4 }) {
        ForEach(this.permissionOptions(), (option: RuntimeSelectionOption) => {
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: this.permissionLabel(option),
            supportingText: this.permissionSupporting(option),
            isChoice: true,
            isSelected: option.selectionId === this.permissionSelection(),
            rowEnabled: !this.busy() && !this.settings.permissionLoading && option.enabled,
            onTap: () => {
              this.onSelectPermission(option.selectionId);
            },
          })
        }, (option: RuntimeSelectionOption) => `permission-${option.selectionId}`)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  /** The selected model's name, or the runtime's when no group is selected. */
  private effortModelLabel(): string {
    const group: RuntimeSelectionGroup | null = this.selectedModelGroup();
    return group === null ? this.runtimeLabel : group.label;
  }

  private disabledEffortOptions(): RuntimeSelectionOption[] {
    const disabled: RuntimeSelectionOption[] = [];
    for (const option of this.effortOptions()) {
      if (!option.enabled) {
        disabled.push(option);
      }
    }
    return disabled;
  }

  /**
   * Effort segmented control.
   *
   * One segment per reasoning variant on a 48dp track; the selected segment is
   * filled and shadowed. Dragging selects the segment under the pointer and only
   * commits on release, which is how Android's control behaves.
   */
  @Builder
  EffortSegments(options: RuntimeSelectionOption[]) {
    Row({ space: 4 }) {
      ForEach(options, (option: RuntimeSelectionOption) => {
        Column() {
          Text(this.effortDisplayLabel(option))
            .fontSize(10)
            .lineHeight(11)
            .fontWeight(this.effortSelected(option) ? FontWeight.Bold : FontWeight.Medium)
            .fontColor(this.effortTextColor(option))
            .textAlign(TextAlign.Center)
            .maxLines(2)
        }
        .layoutWeight(1)
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .borderRadius(SEGMENT_RADIUS)
        .backgroundColor(this.effortSelected(option) ? this.sheetColors().container : '#00000000')
        .shadow(this.effortSelected(option)
          ? { radius: 3, color: this.sheetColors().shadow, offsetX: 0, offsetY: 0 }
          : { radius: 0, color: '#00000000', offsetX: 0, offsetY: 0 })
        .onClick(() => this.selectEffort(option))
      }, (option: RuntimeSelectionOption) => `effort-${option.selectionId}`)
    }
    .width('100%')
    .height(TRACK_HEIGHT)
    .padding(4)
    .borderRadius(TRACK_RADIUS)
    .backgroundColor(this.sheetColors().selectedContainer)
    .onAreaChange((oldArea: Area, newArea: Area) => {
      const width: Length = newArea.width;
      this.trackWidth = typeof width === 'number' ? width : 0;
    })
    .gesture(
      PanGesture({ direction: PanDirection.Horizontal })
        .onActionStart((event: GestureEvent) => {
          this.dragging = true;
          this.dragSelectionId = '';
          this.selectEffortAt(event, options);
        })
        .onActionUpdate((event: GestureEvent) => {
          this.selectEffortAt(event, options);
        })
        .onActionEnd(() => {
          const chosen: string = this.dragSelectionId;
          this.dragging = false;
          this.dragSelectionId = '';
          if (chosen.length > 0 && chosen !== this.modelSelection()) {
            this.onSelectModel(chosen);
          }
        }),
    )
  }

  private effortSelected(option: RuntimeSelectionOption): boolean {
    const current: string = this.dragging ? this.dragSelectionId : (this.modelSelection() ?? '');
    return current === option.selectionId;
  }

  private effortTextColor(option: RuntimeSelectionOption): string {
    const selected: boolean = this.effortSelected(option);
    const base: string = selected
      ? this.sheetColors().content
      : this.sheetColors().secondaryContent;
    const alpha: number = option.enabled || selected ? 1 : 0.45;
    return alpha === 1 ? base : withAlpha(base, alpha);
  }

  private effortEnabled(): boolean {
    return !this.busy() && !this.settings.modelLoading;
  }

  private selectEffort(option: RuntimeSelectionOption): void {
    if (!this.effortEnabled() || !option.enabled) {
      return;
    }
    this.onSelectModel(option.selectionId);
  }

  /** Selects the segment under a drag position; commits on release only. */
  private selectEffortAt(event: GestureEvent, options: RuntimeSelectionOption[]): void {
    if (!this.effortEnabled() || this.trackWidth <= 0 || options.length === 0) {
      return;
    }
    if (event.fingerList.length === 0) {
      return;
    }
    const position: number = event.fingerList[0].localX;
    let index: number = Math.floor((position / this.trackWidth) * options.length);
    if (index < 0) {
      index = 0;
    }
    if (index > options.length - 1) {
      index = options.length - 1;
    }
    const option: RuntimeSelectionOption = options[index];
    if (option.enabled) {
      this.dragSelectionId = option.selectionId;
    }
  }

  // ------------------------------------------------------------------ chrome

  @Builder
  SectionLabel(text: ResourceStr) {
    Text(text)
      .fontSize(12)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.sheetColors().secondaryContent)
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
  }

  @Builder
  DividerLine() {
    Column()
      .width('100%')
      .height(1)
      .backgroundColor(this.sheetColors().divider)
  }

  @Builder
  LoadingBox(height: number) {
    Column() {
      LoadingProgress().width(24).height(24).color(this.sheetColors().content)
    }
    .width('100%')
    .height(height)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  ErrorBox(message: string, height: number, retryEnabled: boolean, modelScope: boolean) {
    Column() {
      AABottomSheetItem({
        sheetColors: this.sheetColors(),
        text: $r('app.string.common_retry'),
        errorMessage: message,
        rowEnabled: retryEnabled,
        onTap: () => {
          if (modelScope) {
            this.onRetryModels();
          } else {
            this.onRetryPermissions();
          }
        },
      })
    }
    .width('100%')
    .height(height)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  EmptyBox() {
    Column() {
      Text($r('app.string.session_runtime_no_settings'))
        .fontSize(13)
        .fontColor(this.sheetColors().secondaryContent)
    }
    .width('100%')
    .height(72)
    .justifyContent(FlexAlign.Center)
  }
}
