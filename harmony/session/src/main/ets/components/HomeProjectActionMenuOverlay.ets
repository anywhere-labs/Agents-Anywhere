import { APP_IS_DARK_KEY, getColors } from 'common';

// Page-root-relative bounds of an anchor component, used to position the
// anchored popups (action menu / filter menu). Captured via onAreaChange with
// the page origin subtracted, mirroring Android boundsInRoot()/boundsInWindow().
export interface HomeMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ACTION_MENU_WIDTH = 252;
const ACTION_MENU_HEIGHT = 168;

@Component
export struct HomeProjectActionMenuOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  // True when opened from the row ellipsis button: a scrimless popup anchored
  // under the button. False for a long-press: a dimmed scrim plus a copy of the
  // pressed row rendered as a floating highlight card.
  @Prop anchored: boolean = true;
  @Prop anchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @Prop projectName: string = '';
  @Prop workspacePath: string = '';
  @Prop projectPinned: boolean = false;
  @Prop highlightExpanded: boolean = false;
  @State overlayWidth: number = 0;
  @State overlayHeight: number = 0;
  onEdit: () => void = () => {};
  onTogglePinned: () => void = () => {};
  onArchive: () => void = () => {};
  onDismiss: () => void = () => {};

  private actionTint(): string {
    return getColors().ink;
  }

  private dangerTint(): string {
    return this.themeIsDark ? '#F87171' : '#B94848';
  }

  private menuX(): number {
    const margin = this.anchored ? 12 : 18;
    const anchorRight = this.anchor.x + this.anchor.width;
    const preferred = this.anchored ? anchorRight - ACTION_MENU_WIDTH : this.anchor.x + 120;
    const max = Math.max(this.overlayWidth - ACTION_MENU_WIDTH - margin, margin);
    return Math.min(Math.max(preferred, margin), max);
  }

  private menuY(): number {
    const gap = this.anchored ? 6 : 10;
    const margin = this.anchored ? 12 : 18;
    const belowY = this.anchor.y + this.anchor.height + gap;
    if (belowY + ACTION_MENU_HEIGHT + margin <= this.overlayHeight) {
      return belowY;
    }
    return Math.max(this.anchor.y - ACTION_MENU_HEIGHT - gap, margin);
  }

  @Builder
  menuRow(icon: Resource, label: ResourceStr, tint: string, action: () => void) {
    Row() {
      Text(label)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(tint)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph(icon)
        .fontSize(21)
        .fontColor([tint])
    }
    .width('100%')
    .height(50)
    .padding({ left: 20, right: 20 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      action();
    })
  }

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.anchored ? Color.Transparent :
          (this.themeIsDark ? '#99000000' : '#66000000'))
        .onClick(() => {
          this.onDismiss();
        })
      if (!this.anchored) {
        Row({ space: 12 }) {
          SymbolGlyph(this.highlightExpanded ? $r('sys.symbol.folder_fill') : $r('sys.symbol.folder'))
            .fontSize(21)
            .fontColor([getColors().faint])
          Column() {
            Text(this.projectName)
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(getColors().inkSoft)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
            Text(this.workspacePath)
              .fontSize(11.2)
              .fontFamily('monospace')
              .fontColor(getColors().faint)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          .layoutWeight(1)
        }
        .width(this.anchor.width)
        .height(this.anchor.height)
        .padding({ left: 12, right: 12 })
        .alignItems(VerticalAlign.Center)
        .borderRadius(15)
        .backgroundColor(this.themeIsDark ? '#202020' : '#FFFFFF')
        .position({ x: this.anchor.x, y: this.anchor.y })
      }
      Column() {
        this.menuRow($r('sys.symbol.pencil_line'), $r('app.string.home_project_edit'),
          this.actionTint(), (): void => {
            this.onEdit();
          })
        this.menuRow($r('sys.symbol.pin'),
          this.projectPinned ? $r('app.string.home_project_unpin') : $r('app.string.home_project_pin'),
          this.actionTint(), (): void => {
            this.onTogglePinned();
          })
        this.menuRow($r('sys.symbol.archivebox'), $r('app.string.home_project_archive'),
          this.dangerTint(), (): void => {
            this.onArchive();
          })
      }
      .width(ACTION_MENU_WIDTH)
      .height(ACTION_MENU_HEIGHT)
      .borderRadius(22)
      .backgroundColor(this.themeIsDark ? '#181818' : '#FFFFFF')
      .border({ width: 1, color: this.themeIsDark ? '#2D2D2F' : '#EFEDE9' })
      .padding({ top: 7, bottom: 7 })
      .position({ x: this.menuX(), y: this.menuY() })
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      const width = newValue.width;
      const height = newValue.height;
      if (typeof width === 'number') {
        this.overlayWidth = width;
      }
      if (typeof height === 'number') {
        this.overlayHeight = height;
      }
    })
  }
}
