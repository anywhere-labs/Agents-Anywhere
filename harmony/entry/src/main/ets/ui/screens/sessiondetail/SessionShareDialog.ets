import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { ProfileDialogButton, ProfileDialogFrame } from '../profile/ProfileDialogs';

/**
 * The share dialog.
 *
 * Port of `SessionShareDialog` and `SessionShareOption` in
 * `ui/screens/sessiondetail/SessionDetailScreen.kt`.
 *
 * A 26dp-radius card with the title, the explanatory body, the two scope rows
 * (the reply the user asked about, or the whole session) and a cancel/create pair.
 * The selected row takes the subtle surface and an ink border at 0.28 alpha; the
 * create button reports `session_share_creating` while the request is in flight
 * and both buttons stop responding.
 *
 * The scopes are Android's `SessionShareScope`, whose API values are the Server's
 * own vocabulary.
 */

/** `message` or `session`, exactly as the share endpoint expects them. */
export const SHARE_SCOPE_REPLY: string = 'message';
export const SHARE_SCOPE_SESSION: string = 'session';

@Component
export struct SessionShareDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  /** The scope the radio list is on; one of the two constants above. */
  scope: string = SHARE_SCOPE_REPLY;
  busy: boolean = false;
  onSelectScope: (scope: string) => void = () => {};
  onDismiss: () => void = () => {};
  onConfirm: () => void = () => {};

  build() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.session_share_dialog_title'),
      onDismiss: () => {
        if (!this.busy) {
          this.onDismiss();
        }
      },
    }) {
      Column({ space: 16 }) {
        Text($r('app.string.session_share_dialog_body'))
          .fontSize(14)
          .lineHeight(20)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.muted)
          .width('100%')

        Column({ space: 8 }) {
          this.ScopeOption(
            $r('app.string.session_share_reply'),
            $r('app.string.session_share_reply_description'),
            this.scope === SHARE_SCOPE_REPLY,
            SHARE_SCOPE_REPLY,
          )
          this.ScopeOption(
            $r('app.string.session_share_entire_session'),
            $r('app.string.session_share_entire_session_description'),
            this.scope === SHARE_SCOPE_SESSION,
            SHARE_SCOPE_SESSION,
          )
        }
        .width('100%')

        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            buttonEnabled: !this.busy,
            onTap: () => this.onDismiss(),
          })

          ProfileDialogButton({
            colors: this.colors,
            label: this.busy
              ? $r('app.string.session_share_creating')
              : $r('app.string.session_share_create'),
            primary: true,
            buttonEnabled: !this.busy,
            onTap: () => this.onConfirm(),
          })
        }
        .width('100%')
        .padding({ top: 4 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  ScopeOption(title: ResourceStr, description: ResourceStr, selected: boolean, scope: string) {
    Column({ space: 4 }) {
      Text(title)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(withAlpha(this.colors.ink, this.busy ? 0.55 : 1))

      Text(description)
        .fontSize(12)
        .lineHeight(16)
        .fontColor(withAlpha(this.colors.muted, this.busy ? 0.55 : 1))
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .borderRadius(16)
    .backgroundColor(selected ? this.colors.subtle : '#00000000')
    .border({
      width: 1,
      color: selected ? withAlpha(this.colors.ink, 0.28) : this.colors.border,
    })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      if (!this.busy) {
        this.onSelectScope(scope);
      }
    })
  }
}
