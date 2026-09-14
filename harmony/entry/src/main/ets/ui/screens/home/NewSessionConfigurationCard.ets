import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AADropdownMenu, AADropdownMenuItemSpec } from '../../designsystem/AADropdownMenu';

/**
 * The configuration card under the workspace chooser.
 *
 * Originally a port of `ui/screens/home/NewSessionConfigurationCard.kt`; restyled
 * in round 40 to the iOS client's option rows
 * (`Views/Chat/Composer/ComposerOptionsSheet.swift`'s `optionRow`): a symbol in a
 * 23dp box, the field's name at 17sp with its current value on a 15sp secondary
 * line under it, and a 14dp chevron — inside a 12dp-radius card whose separators
 * are inset to the text column. Android's single-line label/value pair is gone.
 *
 * A row is only tappable when it has at least one usable option and is not
 * loading; a loading row shows a placeholder bar instead of its value. The
 * dropdown itself is the shared `AADropdownMenu`, opened with `bindMenu`.
 */

export enum NewSessionConfigurationKey {
  Device = 0,
  Agent = 1,
  Model = 2,
  Effort = 3,
  Permission = 4,
}

export class NewSessionConfigurationOption {
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

export class NewSessionConfigurationField {
  readonly key: NewSessionConfigurationKey;
  readonly label: string;
  readonly value: string;
  readonly selectedId: string;
  readonly options: NewSessionConfigurationOption[];
  readonly enabled: boolean;
  readonly loading: boolean;

  constructor(
    key: NewSessionConfigurationKey,
    label: string,
    value: string,
    selectedId: string,
    options: NewSessionConfigurationOption[],
    enabled: boolean,
    loading: boolean = false,
  ) {
    this.key = key;
    this.label = label;
    this.value = value;
    this.selectedId = selectedId;
    this.options = options;
    this.enabled = enabled;
    this.loading = loading;
  }

  /** A row is active when it is enabled, settled, and has something to offer. */
  active(): boolean {
    if (this.loading || !this.enabled) {
      return false;
    }
    return this.options.some((option: NewSessionConfigurationOption) => option.enabled);
  }
}

@Component
export struct NewSessionConfigurationCard {
  colors: AAColors = AA_LIGHT_COLORS;
  fields: NewSessionConfigurationField[] = [];
  /** The key whose menu is open, or -1. */
  expandedKey: number = -1;
  onToggle: (key: NewSessionConfigurationKey) => void = () => {};
  onDismiss: () => void = () => {};
  onSelect: (key: NewSessionConfigurationKey, optionId: string) => void = () => {};

  build() {
    Column() {
      ForEach(this.fields, (field: NewSessionConfigurationField, index: number) => {
        this.ConfigurationRow(field)

        if (index < this.fields.length - 1) {
          // iOS insets the separator to the text column: `.padding(.leading, 52)`.
          Row()
            .width('100%')
            .height(1)
            .margin({ left: 52, right: 16 })
            .backgroundColor(this.colors.isDark ? '#545458' : '#3C3C43')
            .opacity(0.36)
        }
      }, (field: NewSessionConfigurationField) => `field-${field.key}`)
    }
    .width('100%')
    .borderRadius(12)
    .backgroundColor(this.colors.raisedSurface)
    .clip(true)
  }

  /** iOS's symbol for each selector; Android's rows carried no glyph at all. */
  private fieldIcon(key: NewSessionConfigurationKey): string {
    if (key === NewSessionConfigurationKey.Device) {
      return AA_ICONS.MONITOR;
    }
    if (key === NewSessionConfigurationKey.Agent) {
      return AA_ICONS.TERMINAL;
    }
    if (key === NewSessionConfigurationKey.Model) {
      return AA_ICONS.BRACES;
    }
    if (key === NewSessionConfigurationKey.Effort) {
      return AA_ICONS.SLIDERS_HORIZONTAL;
    }
    return AA_ICONS.CIRCLE_CHECK;
  }

  @Builder
  ConfigurationRow(field: NewSessionConfigurationField) {
    Row({ space: 14 }) {
      Column() {
        AAIcon({
          commands: this.fieldIcon(field.key),
          iconSize: 20,
          color: withAlpha(this.colors.ink, field.active() ? 1 : 0.45),
        })
      }
      .width(23)
      .alignItems(HorizontalAlign.Start)

      Column({ space: 5 }) {
        Text(field.label)
          .fontSize(17)
          .fontColor(withAlpha(this.colors.ink, field.active() ? 1 : 0.5))
          .maxLines(1)

        if (field.loading) {
          Row()
            .width(96)
            .height(15)
            .borderRadius(6)
            .backgroundColor(withAlpha(this.colors.ink, this.colors.isDark ? 0.12 : 0.08))
        } else {
          Text(field.value)
            .fontSize(15)
            .fontColor(this.colors.muted)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      AAIcon({
        commands: AA_ICONS.CHEVRON_RIGHT,
        iconSize: 14,
        color: withAlpha(this.colors.muted, field.active() ? 1 : 0.38),
      })
    }
    .width('100%')
    .padding(16)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (field.active()) {
        this.onToggle(field.key);
      }
    })
    .bindMenu(this.expandedKey === field.key && field.active(), this.OptionsMenu(field), {
      placement: Placement.BottomRight,
      enableArrow: false,
      onDisappear: () => this.onDismiss(),
    })
  }

  @Builder
  OptionsMenu(field: NewSessionConfigurationField) {
    AADropdownMenu({
      colors: this.colors,
      items: this.menuItems(field),
      selectedId: field.selectedId,
      onSelect: (optionId: string) => this.onSelect(field.key, optionId),
      onDismiss: () => this.onDismiss(),
    })
  }

  private menuItems(field: NewSessionConfigurationField): AADropdownMenuItemSpec[] {
    const items: AADropdownMenuItemSpec[] = [];
    for (const option of field.options) {
      items.push(new AADropdownMenuItemSpec(
        option.id, option.label, option.description, option.enabled,
      ));
    }
    return items;
  }
}
