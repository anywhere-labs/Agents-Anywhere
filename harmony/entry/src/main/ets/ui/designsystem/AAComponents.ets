import { AAColors, AA_LIGHT_COLORS, withAlpha } from './AAColors';
import { AAIcon } from './AAIcon';
import { AA_ICONS } from './AAIcons';
import { AAFontSize, AARadius } from './AAMetrics';

/**
 * Shared design-system components.
 *
 * Port of the reusable pieces in
 * `android/app/src/main/java/com/agentsanywhere/app/ui/designsystem/Components.kt`
 * that the sign-in screens need. Screens add their own components as they land,
 * so this file grows with the port rather than being written ahead of use.
 */

/**
 * Full-width error banner.
 *
 * Android uses it for every recoverable auth, list-load and terminal error, so
 * it is the single error surface a user learns to recognise.
 */
@Component
export struct AuthErrorNotice {
  colors: AAColors = AA_LIGHT_COLORS;
  message: string = '';
  /** Optional retry affordance; omitted for purely informational errors. */
  actionLabel: string = '';
  onAction: () => void = () => {};

  build() {
    Row({ space: 10 }) {
      AAIcon({ commands: AA_ICONS.CIRCLE_ALERT, iconSize: 20, color: this.colors.errorIcon })
      Text(this.message)
        .fontSize(13.5)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.colors.errorText)
        .lineHeight(17)
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      if (this.actionLabel.length > 0) {
        Text(this.actionLabel)
          .fontSize(13.5)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.errorText)
          .onClick(() => this.onAction())
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .borderRadius(AARadius.CHIP)
    .backgroundColor(this.colors.errorSurface)
    .border({ width: 1.2, color: this.colors.errorBorder })
  }
}

/** Compact 36dp back pill used by the sign-in screens. */
@Component
export struct BackPill {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  onTap: () => void = () => {};

  build() {
    Row({ space: 6 }) {
      AAIcon({ commands: AA_ICONS.ARROW_LEFT, iconSize: 16, color: this.colors.inkSoft })
      Text(this.label)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.inkSoft)
    }
    .height(36)
    .padding({ left: 14, right: 16 })
    .borderRadius(AARadius.PILL)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    .onClick(() => this.onTap())
  }
}

/**
 * 40dp circular back button used by the list-page headers.
 *
 * Port of `BackIconButton` in `Components.kt`.
 */
@Component
export struct BackIconButton {
  colors: AAColors = AA_LIGHT_COLORS;
  diameter: number = 40;
  /**
   * Named `buttonEnabled` because `enabled` collides with the component
   * modifier. Android's `noRippleClickable(enabled = ...)` only drops the click;
   * the glyph keeps full opacity, which is what happens here too.
   */
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({ commands: AA_ICONS.CHEVRON_LEFT, iconSize: 22, color: this.colors.ink })
    }
    .width(this.diameter)
    .height(this.diameter)
    .justifyContent(FlexAlign.Center)
    .borderRadius(this.diameter / 2)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    // Android's `BackIconButton` always carries this description, because the
    // chevron is the whole button.
    .accessibilityText($r('app.string.common_back'))
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * 44dp pill button used inside bottom sheets.
 *
 * Port of `SheetTextButton` in `ui/screens/devices/DeviceDetailControls.kt`: a
 * minimum 104dp wide pill with a 1dp border when secondary, 15sp bold text, and
 * a 0.5 alpha when disabled.
 */
@Component
export struct SheetTextButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  primary: boolean = false;
  onTap: () => void = () => {};

  private surface(): string {
    if (this.primary) {
      return this.colors.isDark ? '#E4E4E7' : '#181816';
    }
    return this.colors.isDark ? '#111113' : '#F7F7F5';
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
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(withAlpha(this.contentColor(), this.buttonEnabled ? 1 : 0.5))
        .maxLines(1)
    }
    .height(44)
    .constraintSize({ minWidth: 104 })
    .padding({ left: 20, right: 20 })
    .borderRadius(22)
    .backgroundColor(this.surface())
    .border({
      width: this.primary ? 0 : 1,
      color: this.primary ? '#00000000' : this.colors.border,
    })
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      if (this.buttonEnabled) {
        this.onTap();
      }
    })
  }
}

/**
 * 62dp address field with a leading icon.
 *
 * Used for the backend address, which is the only text field the sign-in flow
 * needs before authentication.
 */
@Component
export struct AuthInputRow {
  colors: AAColors = AA_LIGHT_COLORS;
  @Link value: string;
  placeholder: ResourceStr = '';
  iconCommands: string = '';
  /** Named `fieldEnabled` because `enabled` collides with the component modifier. */
  fieldEnabled: boolean = true;
  onSubmit: () => void = () => {};

  build() {
    Row({ space: 12 }) {
      AAIcon({ commands: this.iconCommands, iconSize: 22, color: this.colors.faint })
      TextInput({ text: this.value, placeholder: this.placeholder })
        .placeholderColor(this.colors.faint)
        .placeholderFont({ size: AAFontSize.BODY })
        .fontSize(AAFontSize.BODY)
        .fontColor(this.colors.ink)
        .backgroundColor('#00000000')
        .borderRadius(0)
        .padding(0)
        .layoutWeight(1)
        .enabled(this.fieldEnabled)
        .enterKeyType(EnterKeyType.Go)
        .onChange((next: string) => {
          this.value = next;
        })
        .onSubmit(() => this.onSubmit())
    }
    .width('100%')
    .height(62)
    .padding({ left: 16, right: 16 })
    .borderRadius(AARadius.AUTH_INPUT)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1.2, color: this.colors.border })
  }
}
