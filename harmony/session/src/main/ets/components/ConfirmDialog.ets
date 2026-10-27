import { APP_IS_DARK_KEY, getColors } from 'common';

/**
 * Non-deprecated replacement for `AlertDialog.show` confirmations.
 *
 * Wire it up through a `CustomDialogController` (one per page is enough) and set
 * the title/message/callbacks before calling `controller.open()`:
 *
 *   this.confirmController = new CustomDialogController({
 *     builder: ConfirmDialog({
 *       title: ...,
 *       message: ...,
 *       confirmText: ...,
 *       confirmIsDanger: true,
 *       onConfirm: () => { ...; this.confirmController.close(); },
 *       onCancel: () => { this.confirmController.close(); }
 *     }),
 *     autoCancel: true,
 *     alignment: DialogAlignment.Center
 *   });
 *
 * The page owns the controller: `onConfirm`/`onCancel` call `close()` lazily
 * (arrow-function bodies evaluate only when invoked, so referencing the controller
 * field there is safe). The dialog struct itself no longer holds a controller
 * reference, which avoids a "used before initialization" error.
 * Pass `confirmIsDanger: true` for destructive actions (delete, sign out, …)
 * and the confirm button will use the error text token.
 */
@CustomDialog
export struct ConfirmDialog {
  controller?: CustomDialogController;
  title: ResourceStr = '';
  message: ResourceStr = '';
  confirmText: ResourceStr = $r('app.string.profile_sign_out');
  cancelText: ResourceStr = $r('app.string.profile_cancel');
  confirmIsDanger: boolean = false;
  showCancel: boolean = true;
  onConfirm: () => void = () => {};
  onCancel: () => void = () => {};

  build() {
    Column({ space: 16 }) {
      Text(this.title)
        .width('100%')
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor(getColors().headingText)
      Text(this.message)
        .width('100%')
        .fontSize(14)
        .lineHeight(20)
        .fontColor(getColors().inkSoft)
      Row({ space: 10 }) {
        if (this.showCancel) {
          Button(this.cancelText)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(getColors().inkSoft)
            .backgroundColor(getColors().subtle)
            .height(42)
            .layoutWeight(1)
            .onClick(() => {
              this.onCancel();
            })
        }
        Button(this.confirmText)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(getColors().onPrimaryAction)
          .backgroundColor(this.confirmIsDanger ? getColors().errorText : getColors().primaryAction)
          .height(42)
          .layoutWeight(1)
          .onClick(() => {
            this.onConfirm();
          })
      }
      .width('100%')
    }
    .width('80%')
    .padding(20)
    .borderRadius(16)
    .backgroundColor(getColors().dialogSurface)
  }
}
