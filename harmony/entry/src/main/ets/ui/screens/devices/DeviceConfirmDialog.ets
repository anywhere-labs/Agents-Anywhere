import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { RemoteDeviceRuntime } from '../../../api/DevicesDtos';
import { runtimeInstanceName } from '../../../model/RuntimeIdentity';

/**
 * The device confirmation dialog.
 *
 * Port of `ui/screens/devices/DeviceConfirmDialog.kt`.
 *
 * One card serves five confirmations, each supplying its own title, body, confirm
 * label and tone:
 *
 * | Action                 | Danger | Confirm label                  |
 * | ---                    | ---    | ---                            |
 * | Delete device          | yes    | Delete / Deleting… / Retry delete |
 * | Revoke device token    | yes    | Revoke / Revoking…             |
 * | Delete runtime config  | yes    | Delete configuration / …       |
 * | Archive/unarchive all  | no     | Archive all / Unarchive all    |
 *
 * Geometry: a 26dp radius card capped at 380dp with 22dp padding and 18dp between
 * its parts, a 24sp/29sp extra-bold title, a 15sp/21sp medium body, an optional
 * 13sp/17sp semi-bold error line, and two 50dp/16dp buttons 10dp apart whose
 * confirm button is `#EF4444` when dangerous (at 38% while busy).
 *
 * Android hosts this in a modal `Dialog`; here the screen draws the same card in
 * a scrim overlay, which keeps the dismissal and busy rules identical without a
 * dialog controller.
 */
export enum DeviceConfirmKind {
  DeleteDevice = 0,
  RevokeDevice = 1,
  DeleteRuntimeConfig = 2,
  ArchiveAllSessions = 3,
}

/** What the dialog is confirming; Android models this as a sealed interface. */
export class DeviceConfirmAction {
  readonly kind: DeviceConfirmKind;
  readonly deviceName: string;
  /** Archive-all only. */
  readonly archived: boolean;
  readonly scope: string;
  readonly scopeLabel: string;
  /** Runtime-config deletion only. */
  readonly runtimeId: string;
  readonly runtimeLabel: string;
  readonly runtimeActive: boolean;

  constructor(
    kind: DeviceConfirmKind,
    deviceName: string,
    archived: boolean,
    scope: string,
    scopeLabel: string,
    runtimeId: string,
    runtimeLabel: string,
    runtimeActive: boolean,
  ) {
    this.kind = kind;
    this.deviceName = deviceName;
    this.archived = archived;
    this.scope = scope;
    this.scopeLabel = scopeLabel;
    this.runtimeId = runtimeId;
    this.runtimeLabel = runtimeLabel;
    this.runtimeActive = runtimeActive;
  }

  static deleteDevice(): DeviceConfirmAction {
    return new DeviceConfirmAction(
      DeviceConfirmKind.DeleteDevice, '', false, '', '', '', '', false,
    );
  }

  static revokeDevice(deviceName: string): DeviceConfirmAction {
    return new DeviceConfirmAction(
      DeviceConfirmKind.RevokeDevice, deviceName, false, '', '', '', '', false,
    );
  }

  static deleteRuntimeConfig(runtime: RemoteDeviceRuntime): DeviceConfirmAction {
    // The same reader the runtime row uses, so the confirmation names the instance
    // exactly the way the row that opened it does.
    const name: string = runtimeInstanceName(runtime.name, runtime.displayName, runtime.type);
    return new DeviceConfirmAction(
      DeviceConfirmKind.DeleteRuntimeConfig, '', false, '', '', runtime.id, name,
      runtime.active,
    );
  }

  static archiveAllSessions(
    deviceName: string,
    archived: boolean,
    scope: string,
    scopeLabel: string,
  ): DeviceConfirmAction {
    return new DeviceConfirmAction(
      DeviceConfirmKind.ArchiveAllSessions, deviceName, archived, scope, scopeLabel, '', '', false,
    );
  }
}

/**
 * The confirmation card.
 *
 * Both of Android's overloads live here: `DeviceConfirmDialog` takes the text
 * directly (used by the pairing wizard's exit prompt), and
 * `DeviceActionConfirmDialog` derives it from a `DeviceConfirmAction`.
 */
@Component
export struct DeviceConfirmDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  body: ResourceStr = '';
  dismissLabel: ResourceStr = '';
  confirmLabel: ResourceStr = '';
  danger: boolean = false;
  busy: boolean = false;
  errorMessage: string = '';
  onDismiss: () => void = () => {};
  onConfirm: () => void = () => {};

  private titleColor(): string {
    return this.colors.isDark ? '#F5F5F5' : this.colors.ink;
  }

  private bodyColor(): string {
    return this.colors.isDark ? '#858585' : this.colors.muted;
  }

  build() {
    // Scrim: Android's dialog scrim, dismissed only when no action is running.
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.colors.isDark ? '#8F000000' : '#47000000')
        .onClick(() => {
          if (!this.busy) {
            this.onDismiss();
          }
        })

      Column({ space: 18 }) {
        Text(this.title)
          .fontSize(24)
          .lineHeight(29)
          .fontWeight(800)
          .fontColor(this.titleColor())
          .width('100%')

        Text(this.body)
          .fontSize(15)
          .lineHeight(21)
          .fontWeight(500)
          .fontColor(this.bodyColor())
          .width('100%')

        if (this.errorMessage.length > 0) {
          Text(this.errorMessage)
            .fontSize(13)
            .lineHeight(17)
            .fontWeight(600)
            .fontColor(this.colors.errorText)
            .width('100%')
        }

        Row({ space: 10 }) {
          this.DialogButton(
            this.dismissLabel === '' ? $r('app.string.common_cancel') : this.dismissLabel,
            this.colors.secondaryActionSurface,
            this.colors.isDark ? '#F5F5F5' : this.colors.ink,
            () => this.onDismiss(),
          )
          this.DialogButton(
            this.confirmLabel,
            this.danger
              ? withAlpha('#EF4444', this.busy ? 0.38 : 1)
              : (this.colors.isDark ? '#E4E4E7' : '#181816'),
            this.danger
              ? '#FFFFFF'
              : (this.colors.isDark ? '#181816' : '#FFFFFF'),
            () => this.onConfirm(),
          )
        }
        .width('100%')
        .padding({ top: 6 })
      }
      .constraintSize({ maxWidth: 380 })
      .padding(22)
      .borderRadius(26)
      .backgroundColor(this.colors.dialogSurface)
      .shadow({ radius: 34, color: '#33000000', offsetX: 0, offsetY: 0 })
      .margin({ left: 22, right: 22 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  DialogButton(label: ResourceStr, background: string, content: string, onTap: () => void) {
    Column() {
      Text(label)
        .fontSize(15)
        .lineHeight(19)
        .fontWeight(FontWeight.Bold)
        .fontColor(withAlpha(content, this.busy ? 0.55 : 1))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .layoutWeight(1)
    .height(50)
    .borderRadius(16)
    .backgroundColor(background)
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      if (!this.busy) {
        onTap();
      }
    })
  }
}

/** The five device actions, with their copy derived from the action. */
@Component
export struct DeviceActionConfirmDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  action: DeviceConfirmAction = DeviceConfirmAction.deleteDevice();
  busy: boolean = false;
  errorMessage: string = '';
  onDismiss: () => void = () => {};
  onConfirm: () => void = () => {};

  private danger(): boolean {
    return this.action.kind !== DeviceConfirmKind.ArchiveAllSessions;
  }

  private title(): ResourceStr {
    if (this.action.kind === DeviceConfirmKind.DeleteDevice) {
      return $r('app.string.device_confirm_delete_device_title');
    }
    if (this.action.kind === DeviceConfirmKind.RevokeDevice) {
      return $r('app.string.device_confirm_revoke_title');
    }
    if (this.action.kind === DeviceConfirmKind.DeleteRuntimeConfig) {
      return $r('app.string.device_confirm_delete_runtime_config_title', this.action.runtimeLabel);
    }
    return this.action.archived
      ? $r('app.string.device_confirm_archive_all_title', this.action.scopeLabel)
      : $r('app.string.device_confirm_unarchive_all_title', this.action.scopeLabel);
  }

  private body(): ResourceStr {
    if (this.action.kind === DeviceConfirmKind.DeleteDevice) {
      return $r('app.string.device_confirm_delete_device_body');
    }
    if (this.action.kind === DeviceConfirmKind.RevokeDevice) {
      return $r('app.string.device_confirm_revoke_body', this.action.deviceName);
    }
    if (this.action.kind === DeviceConfirmKind.DeleteRuntimeConfig) {
      return this.action.runtimeActive
        ? $r('app.string.device_confirm_delete_active_runtime_config_body', this.action.runtimeLabel)
        : $r('app.string.device_confirm_delete_runtime_config_body', this.action.runtimeLabel);
    }
    return this.action.archived
      ? $r('app.string.device_confirm_archive_all_body', this.action.deviceName)
      : $r('app.string.device_confirm_unarchive_all_body', this.action.deviceName);
  }

  private confirmLabel(): ResourceStr {
    if (this.action.kind === DeviceConfirmKind.RevokeDevice) {
      return this.busy ? $r('app.string.device_confirm_revoking') : $r('app.string.common_revoke');
    }
    if (this.action.kind === DeviceConfirmKind.ArchiveAllSessions) {
      return this.busy
        ? $r('app.string.common_working')
        : (this.action.archived
          ? $r('app.string.device_confirm_archive_all_confirm')
          : $r('app.string.device_confirm_unarchive_all_confirm'));
    }
    if (this.busy) {
      return $r('app.string.device_confirm_deleting');
    }
    if (this.errorMessage.length > 0) {
      return $r('app.string.device_confirm_retry_delete');
    }
    return this.action.kind === DeviceConfirmKind.DeleteRuntimeConfig
      ? $r('app.string.device_confirm_delete_runtime_config')
      : $r('app.string.common_delete');
  }

  build() {
    DeviceConfirmDialog({
      colors: this.colors,
      title: this.title(),
      body: this.body(),
      dismissLabel: $r('app.string.common_cancel'),
      confirmLabel: this.confirmLabel(),
      danger: this.danger(),
      busy: this.busy,
      errorMessage: this.errorMessage,
      onDismiss: () => this.onDismiss(),
      onConfirm: () => this.onConfirm(),
    })
  }
}
