import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AABottomSheetColors, AABottomSheetItem, aaBottomSheetColors } from '../../designsystem/AABottomSheet';
import { SheetTextButton } from '../../designsystem/AAComponents';
import { AARadius } from '../../designsystem/AAMetrics';

/**
 * Device actions sheet.
 *
 * Port of `ui/screens/devices/DeviceActionsSheet.kt`.
 *
 * The sheet opens on the device's name with three rows — Rename (`Pencil`),
 * Revoke/Reconnect (`KeyRound`, labelled by the device's connectivity) and Delete
 * (`Trash2`, danger). Choosing Rename swaps the whole body for a rename form: a
 * 50dp field at 12dp radius on the sheet's selected container, an optional 13sp
 * error line, and a Cancel/Save pair of 44dp pills with Save in the primary tone.
 *
 * The chrome (handle, header, scrolling body) is drawn here for the same reason as
 * the runtime settings sheet: ArkUI's `bindSheet` is opened by the screen.
 *
 * The Reconnect/Revoke row hands off to the pairing wizard's token step, which is
 * where the replacement credentials are shown — revoking without showing them
 * would leave the device unable to reconnect.
 *
 * The Terminal row is this port's own: iOS has no standalone terminal, and the
 * device page used to reach it from a `工作目录` block that iOS does not draw
 * either, so it moved into this sheet with the device's other actions.
 */
@Component
export struct DeviceActionsSheet {
  colors: AAColors = AA_LIGHT_COLORS;
  deviceName: string = '';
  deviceOnline: boolean = false;
  busy: boolean = false;
  /** Message for a failed rename, shown under the field. */
  errorMessage: string = '';
  onDismiss: () => void = () => {};
  onRename: (name: string) => void = () => {};
  onPrepareSetup: () => void = () => {};
  /** The standalone terminal for this device. */
  onOpenTerminal: () => void = () => {};
  onDelete: () => void = () => {};

  @State private renaming: boolean = false;
  @State private draftName: string = '';

  aboutToAppear(): void {
    this.draftName = this.deviceName;
  }

  private sheetColors(): AABottomSheetColors {
    return aaBottomSheetColors(this.colors);
  }

  /**
   * Android's `submitRename`: a blank or unchanged name simply closes the form,
   * and a failure keeps it open with the Server's message.
   */
  private submitRename(): void {
    if (this.busy) {
      return;
    }
    const next: string = this.draftName.trim();
    if (next.length === 0 || next === this.deviceName) {
      this.draftName = this.deviceName;
      this.renaming = false;
      return;
    }
    this.onRename(next);
  }

  build() {
    Column() {
      // Drag handle, as in the runtime settings sheet.
      Column() {
        Column()
          .width(36)
          .height(4)
          .borderRadius(2)
          .backgroundColor(this.sheetColors().handle)
      }
      .width('100%')
      .padding({ top: 12, bottom: 8 })
      .alignItems(HorizontalAlign.Center)

      Row() {
        Text(this.renaming ? $r('app.string.device_actions_rename_device') : this.deviceName)
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
            color: this.busy
              ? withAlpha(this.sheetColors().secondaryContent, 0.38)
              : this.sheetColors().secondaryContent,
          })
        }
        .width(48)
        .height(48)
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          if (!this.busy) {
            this.onDismiss();
          }
        })
      }
      .width('100%')
      .constraintSize({ minHeight: 52 })
      .padding({ left: 24, right: 12 })
      .alignItems(VerticalAlign.Center)

      Column({ space: 8 }) {
        if (this.renaming) {
          TextInput({ text: this.draftName })
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.ink)
            .padding({ left: 14, right: 14 })
            .height(50)
            .enabled(!this.busy)
            .enterKeyType(EnterKeyType.Done)
            .onChange((next: string) => {
              this.draftName = next;
            })
            .onSubmit(() => this.submitRename())
            .borderRadius(12)
            .backgroundColor(this.sheetColors().selectedContainer)
            .border({ width: 1, color: this.colors.border })

          if (this.errorMessage.length > 0) {
            Text(this.errorMessage)
              .fontSize(13)
              .lineHeight(17)
              .fontWeight(600)
              .fontColor(this.colors.errorText)
              .width('100%')
          }

          Row() {
            SheetTextButton({
              colors: this.colors,
              label: $r('app.string.common_cancel'),
              buttonEnabled: !this.busy,
              primary: false,
              onTap: () => {
                this.draftName = this.deviceName;
                this.renaming = false;
              },
            })
            Blank().layoutWeight(1)
            SheetTextButton({
              colors: this.colors,
              label: this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
              buttonEnabled: !this.busy,
              primary: true,
              onTap: () => this.submitRename(),
            })
          }
          .width('100%')
          .padding({ top: 8 })
          .alignItems(VerticalAlign.Center)
        } else {
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: $r('app.string.device_actions_rename'),
            icon: AA_ICONS.PENCIL,
            rowEnabled: true,
            onTap: () => {
              this.renaming = true;
            },
          })
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: this.deviceOnline
              ? $r('app.string.common_revoke')
              : $r('app.string.device_actions_setup'),
            icon: AA_ICONS.KEY_ROUND,
            rowEnabled: true,
            onTap: () => this.onPrepareSetup(),
          })
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: $r('app.string.common_terminal'),
            icon: AA_ICONS.TERMINAL,
            rowEnabled: !this.busy,
            onTap: () => {
              // The sheet is bound to the page that opened it, so it is closed
              // before the terminal replaces that page.
              this.onDismiss();
              this.onOpenTerminal();
            },
          })
          AABottomSheetItem({
            sheetColors: this.sheetColors(),
            text: $r('app.string.common_delete'),
            icon: AA_ICONS.TRASH,
            danger: true,
            rowEnabled: true,
            onTap: () => this.onDelete(),
          })
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 20 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .constraintSize({ maxHeight: 560 })
    .borderRadius({ topLeft: AARadius.SHEET, topRight: AARadius.SHEET })
    .clip(true)
    .backgroundColor(this.sheetColors().container)
  }
}
