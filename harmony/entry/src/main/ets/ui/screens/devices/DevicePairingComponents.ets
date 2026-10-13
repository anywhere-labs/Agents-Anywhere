import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { copyTextToClipboard } from '../../../common/AAClipboard';
import { sanitizePairCode } from '../../../feature/devices/DevicePairingFlow';

/**
 * Pairing wizard components.
 *
 * Port of `ui/screens/devices/DevicePairingComponents.kt`.
 *
 * Geometry, copied value for value:
 *
 *  - headings: 22sp/29sp semi-bold title over 14sp/22sp muted body, 10dp apart;
 *  - choice and instruction cards: 18dp radius, raised surface, a 1dp border
 *    (`#E7E6E2` light, the theme subtle in dark), 16dp padding, and a 21dp icon
 *    with a 15sp/21sp semi-bold title;
 *  - actions: full-width, at least 50dp tall, 16dp radius, 14/16 padding, with a
 *    17dp spinner and an optional trailing 17dp icon, 8dp from the label;
 *  - code blocks: 14dp radius on the subtle colour at 45%, a 1dp border, 14dp
 *    padding, 12sp/19sp monospace that never wraps, and a 44dp copy button that
 *    confirms for two seconds;
 *  - the name field: 54dp tall, 16dp radius, 16dp horizontal padding, monospace
 *    15sp, with the border taking `inkSoft` while focused;
 *  - the code field: six 54dp cells at 12dp radius, 8dp apart, 22sp monospace,
 *    with a caret box in the active cell, and the whole row at 45% while disabled.
 */

/** The hairline the pairing cards use. */
export function pairingBorderColor(colors: AAColors): string {
  return colors.isDark ? colors.subtle : '#E7E6E2';
}

@Component
export struct PairingStepHeading {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  description: ResourceStr = '';

  build() {
    Column({ space: 10 }) {
      Text(this.title)
        .fontSize(22)
        .lineHeight(29)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .width('100%')
      PairingBodyText({ colors: this.colors, text: this.description })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

@Component
export struct PairingBodyText {
  colors: AAColors = AA_LIGHT_COLORS;
  text: ResourceStr = '';

  build() {
    Text(this.text)
      .fontSize(14)
      .lineHeight(22)
      .fontColor(this.colors.muted)
      .width('100%')
  }
}

/** A tappable card: icon, title and description. */
@Component
export struct PairingChoiceCard {
  colors: AAColors = AA_LIGHT_COLORS;
  icon: string = '';
  title: ResourceStr = '';
  description: ResourceStr = '';
  onTap: () => void = () => {};

  build() {
    Column({ space: 8 }) {
      Row({ space: 10 }) {
        AAIcon({ commands: this.icon, iconSize: 21, color: this.colors.inkSoft })
        Text(this.title)
          .fontSize(15)
          .lineHeight(21)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      PairingBodyText({ colors: this.colors, text: this.description })
    }
    .width('100%')
    .padding(16)
    .borderRadius(18)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: pairingBorderColor(this.colors) })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => this.onTap())
  }
}

/** A non-tappable card used for the desktop install steps. */
@Component
export struct PairingInstructionCard {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  description: ResourceStr = '';

  build() {
    Column({ space: 8 }) {
      Text(this.title)
        .fontSize(15)
        .lineHeight(21)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .width('100%')
      PairingBodyText({ colors: this.colors, text: this.description })
    }
    .width('100%')
    .padding(16)
    .borderRadius(18)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: pairingBorderColor(this.colors) })
    .alignItems(HorizontalAlign.Start)
  }
}

/** Full-width primary or secondary action. */
@Component
export struct PairingActionButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  loading: boolean = false;
  secondary: boolean = false;
  /** Lucide path commands for the trailing icon, or empty for none. */
  icon: string = '';
  onTap: () => void = () => {};

  private surface(): string {
    return this.secondary ? this.colors.raisedSurface : this.colors.primaryAction;
  }

  private ink(): string {
    return this.secondary ? this.colors.ink : this.colors.onPrimaryAction;
  }

  build() {
    Row({ space: 8 }) {
      if (this.loading) {
        LoadingProgress().width(17).height(17).color(this.ink())
      }
      Text(this.label)
        .fontSize(15)
        .fontWeight(600)
        .fontColor(withAlpha(this.ink(), this.buttonEnabled && !this.loading ? 1 : 0.6))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.icon.length > 0) {
        AAIcon({ commands: this.icon, iconSize: 17, color: this.ink() })
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 50 })
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .borderRadius(16)
    .backgroundColor(this.surface())
    .border({
      width: this.secondary ? 1 : 0,
      color: this.secondary ? pairingBorderColor(this.colors) : '#00000000',
    })
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .opacity(this.buttonEnabled ? 1 : 0.4)
    .onClick(() => {
      if (this.buttonEnabled && !this.loading) {
        this.onTap();
      }
    })
  }
}

/** A copyable mono-spaced command block. */
@Component
export struct PairingCodeBlock {
  colors: AAColors = AA_LIGHT_COLORS;
  code: string = '';
  onCopyError: () => void = () => {};
  @State private copied: boolean = false;
  private copyTimer: number = -1;

  aboutToDisappear(): void {
    if (this.copyTimer >= 0) {
      clearTimeout(this.copyTimer);
      this.copyTimer = -1;
    }
  }

  private copy(): void {
    void copyTextToClipboard(this.code).then((done: boolean) => {
      if (!done) {
        this.onCopyError();
        return;
      }
      this.copied = true;
      if (this.copyTimer >= 0) {
        clearTimeout(this.copyTimer);
      }
      // Android shows the confirmation for two seconds.
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.copyTimer = -1;
      }, 2000);
    });
  }

  build() {
    Row() {
      Scroll() {
        Text(this.code)
          .fontSize(12)
          .lineHeight(19)
          .fontFamily('monospace')
          .fontColor(this.colors.ink)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .padding(14)

      Column() {
        AAIcon({
          commands: this.copied ? AA_ICONS.CHECK : AA_ICONS.COPY,
          iconSize: 19,
          color: this.colors.muted,
        })
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .onClick(() => this.copy())
    }
    .width('100%')
    .borderRadius(14)
    .backgroundColor(withAlpha(this.colors.subtle, 0.45))
    .border({ width: 1, color: pairingBorderColor(this.colors) })
    .alignItems(VerticalAlign.Center)
  }
}

/** The device-name field, focused on appearance. */
@Component
export struct PairingNameInput {
  colors: AAColors = AA_LIGHT_COLORS;
  @Link value: string;
  fieldEnabled: boolean = true;
  onSubmit: () => void = () => {};
  @State private focused: boolean = false;

  build() {
    Column({ space: 10 }) {
      Text($r('app.string.device_pairing_name_label'))
        .fontSize(13)
        .fontWeight(500)
        .fontColor(this.colors.inkSoft)
        .width('100%')

      TextInput({ text: this.value, placeholder: $r('app.string.device_pairing_name_placeholder') })
        .placeholderColor(this.colors.faint)
        .placeholderFont({ size: 15 })
        .fontSize(15)
        .fontFamily('monospace')
        .fontColor(this.colors.ink)
        .backgroundColor(this.colors.raisedSurface)
        .borderRadius(16)
        .padding({ left: 16, right: 16 })
        .height(54)
        .enabled(this.fieldEnabled)
        .enterKeyType(EnterKeyType.Done)
        .border({
          width: 1,
          color: this.focused ? this.colors.inkSoft : pairingBorderColor(this.colors),
        })
        .onFocus(() => {
          this.focused = true;
        })
        .onBlur(() => {
          this.focused = false;
        })
        .onChange((next: string) => {
          this.value = next;
        })
        .onSubmit(() => this.onSubmit())
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/** Six single-digit cells for the pairing code. */
@Component
export struct PairingCodeInput {
  colors: AAColors = AA_LIGHT_COLORS;
  @Link value: string;
  fieldEnabled: boolean = true;
  onSubmit: () => void = () => {};
  @State private focused: boolean = false;

  private characters(): string[] {
    const digits: string[] = [];
    for (let index = 0; index < 6; index++) {
      digits.push(index < this.value.length ? this.value.substring(index, index + 1) : '');
    }
    return digits;
  }

  build() {
    Column({ space: 10 }) {
      Text($r('app.string.device_pairing_code_label'))
        .fontSize(13)
        .fontWeight(500)
        .fontColor(this.colors.inkSoft)
        .width('100%')

      Stack() {
        Row({ space: 8 }) {
          ForEach(this.characters(), (digit: string, index: number) => {
            Column() {
              Text(digit)
                .fontSize(22)
                .fontFamily('monospace')
                .fontColor(this.colors.ink)
                .textAlign(TextAlign.Center)
              if (this.focused && index === Math.min(this.value.length, 5)
                && this.value.length < 6) {
                Column()
                  .width(1)
                  .height(22)
                  .backgroundColor(this.colors.ink)
              }
            }
            .layoutWeight(1)
            .height(54)
            .borderRadius(12)
            .backgroundColor(this.colors.raisedSurface)
            .border({
              width: 1,
              color: this.focused && index === Math.min(this.value.length, 5)
                ? this.colors.inkSoft
                : pairingBorderColor(this.colors),
            })
            .justifyContent(FlexAlign.Center)
          }, (digit: string, index: number) => `code-cell-${index}`)
        }
        .width('100%')
        .opacity(this.fieldEnabled ? 1 : 0.45)

        // The real field is invisible on top, so the platform keyboard works.
        TextInput({ text: this.value })
          .type(InputType.NUMBER_PASSWORD)
          .fontSize(22)
          .fontColor('#00000000')
          .caretColor('#00000000')
          .backgroundColor('#00000000')
          .borderRadius(0)
          .padding(0)
          .height(54)
          .opacity(0)
          .enabled(this.fieldEnabled)
          .enterKeyType(EnterKeyType.Done)
          .onFocus(() => {
            this.focused = true;
          })
          .onBlur(() => {
            this.focused = false;
          })
          .onChange((next: string) => {
            this.value = sanitizePairCode(next);
          })
          .onSubmit(() => {
            if (this.value.length === 6) {
              this.onSubmit();
            }
          })
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/** A spinner with an explanatory line, used while waiting. */
@Component
export struct PairingWaitingIndicator {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';

  build() {
    Row({ space: 8 }) {
      LoadingProgress().width(16).height(16).color(this.colors.muted)
      PairingBodyText({ colors: this.colors, text: this.label })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }
}
