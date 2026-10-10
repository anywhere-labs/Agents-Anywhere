import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { NewSessionPathEntry } from '../../../feature/sessions/NewSessionState';
import {
  BackSmallPill, ListToggleButton, MiniCircleButton, PathMessage, PathRetryAction, PathRow,
} from './NewSessionComponents';
import { resolveString } from '../../../common/AAResources';

/**
 * The directory browser used when choosing a workspace.
 *
 * Port of `ui/screens/home/NewSessionPathSection.kt`.
 *
 * A 32dp title row (17sp/21sp extra-bold, with an optional "Back" pill), a 56dp
 * current-directory bar — a folder, the path in the middle, and on the right
 * either an expand toggle or a confirm button — and then the directory listing:
 * `..` first, then one 58dp row per entry. The list collapses when a directory
 * is confirmed, and a collapsed bar can be tapped to open it again.
 */
@Component
export struct NewSessionPathSection {
  colors: AAColors = AA_LIGHT_COLORS;
  currentPath: string = '';
  /** The path as it should be shown, which may be abbreviated or a home label. */
  currentPathLabel: string = '';
  parentPath: string | null = null;
  entries: NewSessionPathEntry[] = [];
  loading: boolean = false;
  errorMessage: string = '';
  canUseCurrent: boolean = false;
  /** Named `sectionEnabled` because `enabled` collides with the component modifier. */
  sectionEnabled: boolean = true;
  collapsible: boolean = false;
  /** The section heading; empty uses "Choose path". */
  title: string = '';
  hasBack: boolean = false;
  hasUseCurrent: boolean = false;
  hasRetry: boolean = false;
  onBack: () => void = () => {};
  onParent: () => void = () => {};
  onUseCurrent: () => void = () => {};
  onRetry: () => void = () => {};
  onOpenEntry: (entry: NewSessionPathEntry) => void = () => {};

  @State private expanded: boolean = true;

  private openParent(): void {
    this.expanded = true;
    this.onParent();
  }

  private canGoParent(): boolean {
    return this.parentPath !== null && this.sectionEnabled && !this.loading;
  }

  private canConfirm(): boolean {
    return this.canUseCurrent && this.sectionEnabled && !this.loading && this.errorMessage.length === 0;
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Text(this.title.length === 0 ? $r('app.string.new_session_choose_path') : this.title)
          .fontSize(17)
          .lineHeight(21)
          .fontWeight(800)
          .fontColor(this.colors.ink)
          .layoutWeight(1)

        if (this.hasBack) {
          BackSmallPill({
            colors: this.colors,
            label: $r('app.string.common_back'),
            pillEnabled: this.sectionEnabled,
            onTap: () => this.onBack(),
          })
        }
      }
      .width('100%')
      .height(32)
      .justifyContent(FlexAlign.SpaceBetween)
      .alignItems(VerticalAlign.Center)

      this.CurrentDirectoryBar()

      if (this.expanded || this.loading || this.errorMessage.length > 0) {
        List() {
          if (this.loading) {
            ListItem() {
              PathMessage({ colors: this.colors, message: $r('app.string.new_session_loading_directory') })
            }
          } else if (this.errorMessage.length > 0) {
            ListItem() {
              Column() {
                PathMessage({ colors: this.colors, message: this.errorMessage })
                if (this.hasRetry) {
                  PathRetryAction({
                    colors: this.colors,
                    label: $r('app.string.common_retry'),
                    rowEnabled: this.sectionEnabled,
                    onTap: () => this.onRetry(),
                  })
                }
              }
              .alignItems(HorizontalAlign.Start)
            }
          } else {
            if (this.parentPath !== null) {
              ListItem() {
                PathRow({
                  colors: this.colors,
                  name: '..',
                  rowEnabled: this.sectionEnabled,
                  onTap: () => this.openParent(),
                })
              }
            }
            if (this.entries.length === 0) {
              ListItem() {
                PathMessage({ colors: this.colors, message: $r('app.string.new_session_empty_directory') })
              }
            }
            ForEach(this.entries, (entry: NewSessionPathEntry) => {
              ListItem() {
                PathRow({
                  colors: this.colors,
                  name: entry.name,
                  rowEnabled: this.sectionEnabled,
                  onTap: () => {
                    this.expanded = true;
                    this.onOpenEntry(entry);
                  },
                })
              }
            }, (entry: NewSessionPathEntry) => `entry-${entry.path}`)
          }
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  /** The bar: folder, path, then either the toggle or the confirm button. */
  @Builder
  CurrentDirectoryBar() {
    Row({ space: 14 }) {
      AAIcon({
        commands: AA_ICONS.FOLDER,
        iconSize: 20,
        color: this.colors.ink,
      })

      Text(this.currentPathLabel)
        .fontSize(17)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.canGoParent()) {
        MiniCircleButton({
          colors: this.colors,
          commands: AA_ICONS.CHEVRON_LEFT,
          iconSize: 22,
          iconColor: this.colors.ink,
          buttonEnabled: true,
          onTap: () => this.openParent(),
        })
      }

      if (this.collapsible) {
        ListToggleButton({
          colors: this.colors,
          expanded: this.expanded,
          buttonEnabled: this.sectionEnabled,
          onTap: () => {
            this.expanded = !this.expanded;
          },
        })
      } else if (this.hasUseCurrent) {
        MiniCircleButton({
          colors: this.colors,
          commands: AA_ICONS.CHECK,
          iconSize: 22,
          iconColor: this.colors.isDark ? '#A1A1AA' : '#555555',
          dimIconColor: this.colors.isDark ? '#52525B' : '#BDBDBD',
          buttonEnabled: this.canConfirm(),
          description: resolveString($r('app.string.common_done')),
          onTap: () => {
            this.onUseCurrent();
            this.expanded = false;
          },
        })
      }
    }
    .width('100%')
    .height(48)
    .padding({ left: 16, right: 8 })
    .borderRadius(12)
    .backgroundColor(this.colors.raisedSurface)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      // A collapsed bar opens its list when tapped, but only when the caller
      // asked for a collapsible section (Android's `onOpenList`).
      if (this.collapsible && !this.expanded && this.sectionEnabled) {
        this.expanded = true;
      }
    })
  }
}
