import { AAColors, AA_LIGHT_COLORS } from './AAColors';
import { AAIcon } from './AAIcon';
import { AA_ICONS } from './AAIcons';

/**
 * Top-centre toast.
 *
 * Port of `ui/designsystem/AAToast.kt`.
 *
 * Android renders it at `TopCenter` with a fixed 1600 ms timeout, which
 * deliberately overrides the platform snackbar's own duration — including for
 * errors, which are normally long-lived. The same 1600 ms is applied by
 * `AAToastState.show`, so callers never pick a duration.
 *
 * Messages are `ResourceStr` so callers can pass either a `$r(...)` reference or
 * a plain string from a Server error, without resolving resources by hand.
 */

/** Default visible time for every toast, in milliseconds. */
export const AA_TOAST_TIMEOUT_MS: number = 1600;

/**
 * Toast state owned by a screen.
 *
 * A screen keeps one instance and calls `show`; the host renders from its plain
 * fields, so the screen re-reads them on the next redraw.
 */
export class AAToastState {
  message: ResourceStr = '';
  isError: boolean = false;
  actionLabel: ResourceStr = '';
  visible: boolean = false;
  private dismissTimer: number = -1;

  /** Shows a toast and schedules the fixed-timeout dismissal. */
  show(message: ResourceStr, isError: boolean = false, actionLabel: ResourceStr = ''): void {
    this.message = message;
    this.isError = isError;
    this.actionLabel = actionLabel;
    this.visible = true;
    if (this.dismissTimer !== -1) {
      clearTimeout(this.dismissTimer);
    }
    this.dismissTimer = setTimeout(() => {
      this.visible = false;
      this.dismissTimer = -1;
    }, AA_TOAST_TIMEOUT_MS);
  }

  hide(): void {
    this.visible = false;
    if (this.dismissTimer !== -1) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = -1;
    }
  }
}

/** Renders the toast; place it last in a `Stack` so it sits above everything. */
@Component
export struct AAToastHost {
  colors: AAColors = AA_LIGHT_COLORS;
  message: ResourceStr = '';
  isError: boolean = false;
  actionLabel: ResourceStr = '';
  visible: boolean = false;
  onAction: () => void = () => {};

  build() {
    if (this.visible && this.message !== '') {
      Row({ space: 10 }) {
        if (!this.isError) {
          AAIcon({ commands: AA_ICONS.CIRCLE_CHECK, iconSize: 18, color: this.colors.noticeSuccess })
        }
        Text(this.message)
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)
          .maxLines(3)
          .layoutWeight(1)
        if (this.actionLabel !== '') {
          Text(this.actionLabel)
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor('#4CAF50')
            .onClick(() => this.onAction())
        }
      }
      .alignItems(VerticalAlign.Center)
      .constraintSize({ maxWidth: 340 })
      .padding({ left: 18, right: 18, top: 12, bottom: 12 })
      .borderRadius(18)
      .backgroundColor(this.colors.raisedSurface)
      .shadow({ radius: 14, color: this.colors.appShadow, offsetX: 0, offsetY: 4 })
    }
  }
}
