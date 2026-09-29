import { AAColors, AA_LIGHT_COLORS, withAlpha } from './AAColors';
import { AAIcon } from './AAIcon';
import { AA_ICONS } from './AAIcons';

/**
 * The app's dropdown menu.
 *
 * Port of `ui/designsystem/AADropdownMenu.kt`.
 *
 * Android uses Material3's `DropdownMenu` with an 18dp radius, a 286dp width, a
 * 328dp height cap, a 4dp gap below the anchor and a themed surface (dark:
 * `subtle`, light: `raisedSurface` plus a 1dp border). HarmonyOS menus are
 * opened with `bindMenu`, so this component supplies the *contents* and the
 * screen keeps the open/closed state — the same split the other screens in this
 * port already use.
 *
 * The row is a separate component because the pressed state is per row, and
 * ArkUI state belongs to a component rather than to a builder loop.
 */

/** One entry of the menu. */
export class AADropdownMenuItemSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;

  constructor(id: string, label: string, description: string = '', enabled: boolean = true) {
    this.id = id;
    this.label = label;
    this.description = description;
    this.enabled = enabled;
  }
}

@Component
export struct AADropdownMenu {
  colors: AAColors = AA_LIGHT_COLORS;
  items: AADropdownMenuItemSpec[] = [];
  selectedId: string = '';
  menuWidth: number = 286;
  menuMaxHeight: number = 328;
  onSelect: (id: string) => void = () => {};
  onDismiss: () => void = () => {};

  build() {
    Column() {
      ForEach(this.items, (item: AADropdownMenuItemSpec) => {
        AADropdownMenuRow({
          colors: this.colors,
          label: item.label,
          description: item.description,
          itemEnabled: item.enabled,
          selected: item.id === this.selectedId,
          onTap: () => {
            this.onSelect(item.id);
            this.onDismiss();
          },
        })
      }, (item: AADropdownMenuItemSpec) => `menu-${item.id}`)
    }
    .width(this.menuWidth)
    .constraintSize({ maxHeight: this.menuMaxHeight })
    .padding({ top: 6, bottom: 6 })
    .borderRadius(18)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : this.colors.raisedSurface)
    .border({
      width: 1,
      color: this.colors.isDark ? '#00000000' : this.colors.border,
    })
    .clip(true)
  }
}

/** One menu row: 48dp minimum, a 14sp/19sp label and an optional 11sp note. */
@Component
struct AADropdownMenuRow {
  colors: AAColors = AA_LIGHT_COLORS;
  label: string = '';
  description: string = '';
  itemEnabled: boolean = true;
  selected: boolean = false;
  onTap: () => void = () => {};

  @State private pressed: boolean = false;

  build() {
    Row({ space: 12 }) {
      Column({ space: 2 }) {
        Text(this.label)
          .fontSize(14)
          .lineHeight(19)
          .fontWeight(600)
          .fontColor(withAlpha(this.colors.ink, this.itemEnabled ? 1 : 0.42))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        if (this.description.length > 0) {
          Text(this.description)
            .fontSize(11)
            .lineHeight(14)
            .fontColor(withAlpha(this.colors.inkSoft, this.itemEnabled ? 0.72 : 0.42))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)

      if (this.selected) {
        AAIcon({
          commands: AA_ICONS.CHECK,
          iconSize: 18,
          color: withAlpha(this.colors.ink, this.itemEnabled ? 1 : 0.42),
        })
      } else {
        Blank().width(18)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .backgroundColor(this.pressed && this.itemEnabled
      ? withAlpha(this.colors.ink, 0.07)
      : '#00000000')
    .alignItems(VerticalAlign.Center)
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressed = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => {
      if (this.itemEnabled) {
        this.onTap();
      }
    })
  }
}
