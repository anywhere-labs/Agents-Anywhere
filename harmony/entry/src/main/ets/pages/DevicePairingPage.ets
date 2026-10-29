import { common, OpenLinkOptions } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { SharedApiClient } from 'session';
import { RemoteDeviceCredential, DevicesApi } from 'network';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import {
  PAIRING_STEP_CONNECTION,
  PAIRING_STEP_DESKTOP_INSTALL,
  PAIRING_STEP_CLI_CONFIRM,
  PAIRING_STEP_NAME,
  PAIRING_STEP_CLI_METHOD,
  PAIRING_STEP_COMMAND,
  PAIRING_STEP_PAIR_CODE,
  DeviceLookupResult,
  DeviceSetupCredential,
  pairingStepPrevious,
  devicePairingCommand,
  deviceTokenCommand,
  randomPairingDeviceName,
  PairingMonitor
} from '../feature/DevicePairingFlow';
import { APP_IS_DARK_KEY, getColors } from 'common';

const DESKTOP_DOWNLOAD_URL = 'https://agents-anywhere.com/download';

class DeviceLookupResultImpl implements DeviceLookupResult {
  ok: boolean = false;
  online: boolean = false;
  fatal: boolean = false;
}

// Declared so object literals in actionRow() have a concrete type.
interface PairingAction {
  label: ResourceStr;
  primary: boolean;
  enabled?: boolean;
  action: () => void;
}

@Component
export struct DevicePairingPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State step: number = PAIRING_STEP_CONNECTION;
  @State deviceName: string = '';
  @State pairCode: string = '';
  @State busy: boolean = false;
  @State waitingOnline: boolean = false;
  @State onlineConfirmed: boolean = false;
  @State errorText: string = '';
  @State copiedCode: string = '';
  @State credential: RemoteDeviceCredential | null = null;
  @State monitorDeviceId: string = '';
  onDeviceOnline: (device: RemoteDeviceCredential) => void = (): void => {};
  private navPathStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private monitor: PairingMonitor | null = null;
  private copiedTimer: number = -1;
  private pageActive: boolean = false;

  aboutToAppear(): void {
    this.pageActive = true;
    this.deviceName = randomPairingDeviceName();
  }

  aboutToDisappear(): void {
    this.pageActive = false;
    this.stopOnlineMonitor();
    if (this.copiedTimer >= 0) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = -1;
    }
  }

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private credentialNow(): DeviceSetupCredential | null {
    const credential = this.credential;
    if (credential === null) {
      return null;
    }
    return {
      deviceId: credential.device.id,
      deviceName: credential.device.name,
      serverUrl: this.serverUrl(),
      connectorToken: credential.deviceToken
    };
  }

  private handleDeviceOnline(): void {
    if (!this.pageActive) {
      return;
    }
    this.onlineConfirmed = true;
    this.waitingOnline = false;
    const credential = this.credential;
    if (credential !== null) {
      this.onDeviceOnline(credential);
      this.navPathStack.pop();
    }
  }

  private handleMonitorStopped(reason: string): void {
    this.pageActive = false;
    this.waitingOnline = false;
    this.errorText = reason;
    this.stopOnlineMonitor();
  }

  private startOnlineMonitor(): void {
    const deviceId = this.credential === null ? '' : this.credential.device.id;
    if (this.monitor !== null || deviceId.length === 0) {
      return;
    }
    this.monitorDeviceId = deviceId;
    const page = this;
    const monitor = new PairingMonitor(async (targetId: string): Promise<DeviceLookupResult> => {
      try {
        const device = await page.devicesApi.getDevice(page.serverUrl(), page.token(), targetId);
        const result = new DeviceLookupResultImpl();
        result.ok = true;
        result.online = device.status === 'online';
        result.fatal = false;
        return result;
      } catch (error) {
        const result = new DeviceLookupResultImpl();
        result.ok = false;
        result.online = false;
        result.fatal = false;
        return result;
      }
    });
    monitor.start(deviceId, () => {
      this.handleDeviceOnline();
    }, (reason: string) => {
      this.handleMonitorStopped(reason);
    });
    this.monitor = monitor;
  }

  private stopOnlineMonitor(): void {
    if (this.monitor !== null) {
      this.monitor.stop();
      this.monitor = null;
    }
  }

  private goStep(next: number): void {
    if (this.busy) {
      return;
    }
    this.errorText = '';
    this.waitingOnline = false;
    this.step = next;
    this.scroller.scrollEdge(Edge.Top);
  }

  private goBack(): void {
    if (this.busy) {
      return;
    }
    if (this.step === PAIRING_STEP_CONNECTION) {
      this.navPathStack.pop();
      return;
    }
    this.goStep(pairingStepPrevious(this.step));
  }

  private async createCredential(): Promise<void> {
    const name = this.deviceName.trim();
    if (this.busy || name.length === 0) {
      return;
    }
    this.busy = true;
    this.errorText = '';
    try {
      const existing = this.credential;
      if (existing === null) {
        const created = await this.devicesApi.createDevice(this.serverUrl(), this.token(), name);
        this.credential = created;
        this.deviceName = created.device.name;
        this.step = PAIRING_STEP_CLI_METHOD;
        this.startOnlineMonitor();
        return;
      }
      const previous = existing.device;
      if (previous.name === name) {
        this.step = PAIRING_STEP_CLI_METHOD;
        this.startOnlineMonitor();
        return;
      }
      const renamed = await this.devicesApi.updateDevice(this.serverUrl(), this.token(), previous.id, name);
      this.credential = {
        device: renamed,
        deviceToken: existing.deviceToken,
        tokenPrefix: existing.tokenPrefix
      };
      this.deviceName = renamed.name;
      this.step = PAIRING_STEP_CLI_METHOD;
      this.startOnlineMonitor();
    } catch (error) {
      this.errorText = errorMessageFrom(error as Object);
    }
    this.busy = false;
  }

  private openCommandStep(): void {
    this.step = PAIRING_STEP_COMMAND;
    this.waitingOnline = true;
  }

  private async claimPairCode(): Promise<void> {
    const code = this.pairCode.toUpperCase();
    const credential = this.credential;
    if (this.busy || credential === null || code.length !== 6) {
      return;
    }
    this.busy = true;
    this.errorText = '';
    try {
      const claimed = await this.devicesApi.claimPairing(this.serverUrl(), this.token(), code,
        credential.device.name, credential.device.id, credential.deviceToken);
      this.credential = {
        device: claimed,
        deviceToken: credential.deviceToken,
        tokenPrefix: credential.tokenPrefix
      };
      this.stopOnlineMonitor();
      this.onlineConfirmed = false;
      this.onDeviceOnline(this.credential);
      this.navPathStack.pop();
    } catch (error) {
      this.errorText = errorMessageFrom(error as Object);
    }
    this.busy = false;
  }

  private copyCodeBlock(code: string): void {
    try {
      const board = pasteboard.getSystemPasteboard();
      const unit = pasteboard.createPlainTextData(code);
      board.setDataSync(unit);
      this.copiedCode = code;
      if (this.copiedTimer >= 0) {
        clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = setTimeout(() => {
        this.copiedTimer = -1;
        this.copiedCode = '';
      }, 2000);
    } catch (error) {
      this.errorText = 'Could not copy the command.';
    }
  }

  @Builder
  codeBlock(code: string) {
    Row({ space: 6 }) {
      Text(code)
        .fontSize(12)
        .lineHeight(19)
        .fontFamily('monospace')
        .fontColor(getColors().ink)
        .layoutWeight(1)
      Button(this.copiedCode === code ? '✓' : '⧉')
        .fontSize(19)
        .width(44)
        .height(44)
        .padding(0)
        .borderRadius(22)
        .backgroundColor(Color.Transparent)
        .fontColor(getColors().muted)
        .onClick(() => {
          this.copyCodeBlock(code);
        })
    }
    .width('100%')
    .padding(10)
    .borderRadius(14)
    .backgroundColor(getColors().subtle)
    .border({ width: 1, color: getColors().border })
  }

  @Builder
  stepConnection() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_title'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text($r('app.string.pairing_intro'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    Column({ space: 10 }) {
      this.choiceCard($r('app.string.pairing_desktop'), $r('app.string.pairing_desktop_desc'),
        () => {
          this.goStep(PAIRING_STEP_DESKTOP_INSTALL);
        })
      this.choiceCard($r('app.string.pairing_cli'), $r('app.string.pairing_cli_desc'),
        () => {
          this.goStep(PAIRING_STEP_CLI_CONFIRM);
        })
    }
    .width('100%')
    this.actionRow(this.connectionActions());
  }

  private connectionActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_cancel'),
      primary: false,
      action: (): void => {
        this.navPathStack.pop();
      }
    });
    actions.push({
      label: $r('app.string.pairing_continue'),
      primary: true,
      action: (): void => {
        this.goStep(PAIRING_STEP_NAME);
      }
    });
    return actions;
  }

  @Builder
  stepDesktopInstall() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_install_desktop'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text($r('app.string.pairing_install_desktop_desc'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    this.instructionCard($r('app.string.pairing_download'), `Get the desktop installer from ${DESKTOP_DOWNLOAD_URL}`)
    this.instructionCard($r('app.string.pairing_signin'), 'Open the app and sign in with the same account you use here.')
    this.instructionCard($r('app.string.pairing_card_online'), 'The new device will show up in the device list automatically.')
    this.actionRow(this.desktopInstallActions());
  }

  private desktopInstallActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_back'),
      primary: false,
      action: (): void => {
        this.goStep(PAIRING_STEP_CONNECTION);
      }
    });
    actions.push({
      label: $r('app.string.pairing_open_download'),
      primary: true,
      action: (): void => {
        this.openDesktopDownload();
      }
    });
    actions.push({
      label: $r('app.string.pairing_done'),
      primary: false,
      action: (): void => {
        this.finishDesktopInstall();
      }
    });
    return actions;
  }

  @Builder
  stepCliConfirm() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_cli_confirm_title'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text($r('app.string.pairing_cli_requires'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
      Text($r('app.string.pairing_cli_fallback'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    this.actionRow(this.cliConfirmActions());
  }

  private cliConfirmActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_use_desktop'),
      primary: false,
      action: (): void => {
        this.goStep(PAIRING_STEP_DESKTOP_INSTALL);
      }
    });
    actions.push({
      label: $r('app.string.pairing_have_cli'),
      primary: true,
      action: (): void => {
        this.goStep(PAIRING_STEP_NAME);
      }
    });
    return actions;
  }

  @Builder
  stepName() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_name_title'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text($r('app.string.pairing_name_desc'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
      TextInput({ text: this.deviceName, placeholder: $r('app.string.pairing_name_placeholder') })
        .fontSize(15)
        .fontFamily('monospace')
        .height(54)
        .width('100%')
        .backgroundColor(getColors().raisedSurface)
        .borderRadius(16)
        .border({ width: 1, color: getColors().border })
        .fontColor(getColors().ink)
        .placeholderColor(getColors().faint)
        .enabled(!this.busy)
        .onChange((value: string) => {
          this.deviceName = value;
        })
      if (this.errorText.length > 0) {
        Text(this.errorText)
          .fontSize(12.5)
          .fontWeight(600)
          .lineHeight(17)
          .fontColor(getColors().errorText)
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    this.actionRow(this.nameStepActions());
  }

  private nameStepActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_back'),
      primary: false,
      action: (): void => {
        this.goStep(pairingStepPrevious(this.step));
      }
    });
    actions.push({
      label: $r('app.string.pairing_continue'),
      primary: true,
      enabled: this.deviceName.trim().length > 0 && !this.busy,
      action: (): void => {
        this.createCredential();
      }
    });
    return actions;
  }

  @Builder
  stepCliMethod() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_method_title'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text(`"${this.deviceName}" is ready. Pick how the Connector authenticates.`)
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    Column({ space: 10 }) {
      this.choiceCard($r('app.string.pairing_pairing_code_choice'), $r('app.string.pairing_pairing_code_choice_desc'),
        () => {
          this.goStep(PAIRING_STEP_PAIR_CODE);
        })
      this.choiceCard($r('app.string.pairing_connector_token_choice'), $r('app.string.pairing_connector_token_choice_desc'),
        () => {
          this.openCommandStep();
        })
    }
    .width('100%')
    this.actionRow(this.cliMethodActions());
  }

  private cliMethodActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_back'),
      primary: false,
      action: (): void => {
        this.goStep(PAIRING_STEP_NAME);
      }
    });
    return actions;
  }

  private commandCredentialText(): string {
    const credential = this.credentialNow();
    if (credential === null) {
      return '';
    }
    return deviceTokenCommand(credential);
  }

  private commandPairUrl(): string {
    const credential = this.credentialNow();
    if (credential === null) {
      return '';
    }
    return devicePairingCommand(credential.serverUrl);
  }

  @Builder
  stepCommand() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_run_connector'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text(`Copy this command into a terminal on ${this.deviceName}. The token keeps working for this device only.`)
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
      if (this.commandCredentialText().length > 0) {
        this.codeBlock(this.commandCredentialText())
        Text($r('app.string.pairing_screen_hint'))
          .fontSize(14)
          .lineHeight(22)
          .fontColor(getColors().muted)
          .width('100%')
        this.codeBlock(`screen -S anywhere\n${this.commandCredentialText()}`)
        this.codeBlock('screen -r anywhere')
      }
      if (this.waitingOnline) {
        Row({ space: 8 }) {
          LoadingProgress()
            .width(16)
            .height(16)
          Text($r('app.string.pairing_waiting_online'))
            .fontSize(14)
            .lineHeight(22)
            .fontColor(getColors().muted)
        }
        .width('100%')
      }
      if (this.onlineConfirmed) {
        Text($r('app.string.pairing_online_msg'))
          .fontSize(13)
          .fontColor(getColors().sessionStatusAccent)
          .width('100%')
      }
      if (this.errorText.length > 0) {
        Text(this.errorText)
          .fontSize(12.5)
          .fontWeight(600)
          .lineHeight(17)
          .fontColor(getColors().errorText)
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    this.actionRow(this.commandActions());
  }

  private commandActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_back'),
      primary: false,
      action: (): void => {
        this.goStep(PAIRING_STEP_CLI_METHOD);
      }
    });
    actions.push({
      label: $r('app.string.pairing_done_online'),
      primary: true,
      enabled: this.onlineConfirmed,
      action: (): void => {
        const credential = this.credential;
        if (credential !== null) {
          this.stopOnlineMonitor();
          this.onDeviceOnline(credential);
          this.navPathStack.pop();
        }
      }
    });
    return actions;
  }

  @Builder
  stepPairCode() {
    Column({ space: 10 }) {
      Text($r('app.string.pairing_enter_code'))
        .fontSize(22)
        .fontWeight(600)
        .lineHeight(29)
        .fontColor(getColors().ink)
      Text($r('app.string.pairing_enter_code_desc'))
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
      if (this.commandPairUrl().length > 0) {
        this.codeBlock(this.commandPairUrl())
        Text($r('app.string.pairing_code_hint'))
          .fontSize(14)
          .lineHeight(22)
          .fontColor(getColors().muted)
          .width('100%')
      }
      Text($r('app.string.pairing_code_label'))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().inkSoft)
      TextInput({ text: this.pairCode, placeholder: $r('app.string.pairing_code_placeholder') })
        .type(InputType.Number)
        .maxLength(6)
        .fontSize(22)
        .fontFamily('monospace')
        .height(54)
        .width('100%')
        .backgroundColor(getColors().raisedSurface)
        .borderRadius(12)
        .border({ width: 1, color: getColors().border })
        .fontColor(getColors().ink)
        .placeholderColor(getColors().faint)
        .enabled(!this.busy)
        .onChange((value: string) => {
          this.pairCode = value;
        })
      if (this.busy) {
        Row({ space: 8 }) {
          LoadingProgress()
            .width(16)
            .height(16)
          Text($r('app.string.pairing_confirming'))
            .fontSize(14)
            .lineHeight(22)
            .fontColor(getColors().muted)
        }
        .width('100%')
      }
      if (this.errorText.length > 0) {
        Text(this.errorText)
          .fontSize(12.5)
          .fontWeight(600)
          .lineHeight(17)
          .fontColor(getColors().errorText)
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 12 })
    this.actionRow(this.pairCodeActions());
  }

  private pairCodeActions(): PairingAction[] {
    const actions: PairingAction[] = [];
    actions.push({
      label: $r('app.string.pairing_back'),
      primary: false,
      action: (): void => {
        this.goStep(PAIRING_STEP_CLI_METHOD);
      }
    });
    actions.push({
      label: $r('app.string.pairing_claim_code'),
      primary: true,
      enabled: this.pairCode.length === 6 && !this.busy,
      action: (): void => {
        this.claimPairCode();
      }
    });
    return actions;
  }

  @Builder
  choiceCard(title: ResourceStr, description: ResourceStr, onPick: () => void) {
    Row({ space: 10 }) {
      Column({ space: 4 }) {
        Text(title)
          .fontSize(15)
          .fontWeight(600)
          .lineHeight(21)
          .fontColor(getColors().ink)
        Text(description)
          .fontSize(14)
          .lineHeight(22)
          .fontColor(getColors().muted)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Text('→')
        .fontSize(16)
        .fontColor(getColors().primaryAction)
    }
    .width('100%')
    .padding(16)
    .borderRadius(18)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: getColors().border })
    .onClick(() => {
      onPick();
    })
  }

  @Builder
  instructionCard(title: ResourceStr, body: ResourceStr) {
    Column({ space: 4 }) {
      Text(title)
        .fontSize(15)
        .fontWeight(600)
        .lineHeight(21)
        .fontColor(getColors().ink)
      Text(body)
        .fontSize(14)
        .lineHeight(22)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(16)
    .borderRadius(18)
    .backgroundColor(getColors().raisedSurface)
    .border({ width: 1, color: getColors().border })
  }

  @Builder
  actionRow(actions: PairingAction[]) {
    Row({ space: 8 }) {
      ForEach(actions, (action: PairingAction) => {
        Button(action.label)
          .fontSize(15)
          .fontWeight(600)
          .height(50)
          .borderRadius(16)
          .layoutWeight(1)
          .padding({ left: 12, right: 12 })
          .backgroundColor(action.primary ? getColors().primaryAction : getColors().raisedSurface)
          .fontColor(action.primary ? getColors().onPrimaryAction : getColors().ink)
          .border({ width: 1, color: action.primary ? Color.Transparent : getColors().border })
          .enabled(this.actionEnabled(action))
          .onClick(() => {
            action.action();
          })
      }, (action: PairingAction, index: number) => `${index}_${action.label}`)
    }
    .width('100%')
    .padding({ top: 14, bottom: 10 })
  }

  private actionEnabled(action: PairingAction): boolean {
    if (action.enabled === undefined) {
      return true;
    }
    return action.enabled;
  }

  private openDesktopDownload(): void {
    const context = getContext(this) as common.UIAbilityContext;
    const options: OpenLinkOptions = { appLinkingOnly: false };
    context.openLink(DESKTOP_DOWNLOAD_URL, options).catch(() => {
      this.errorText = 'Could not open the download page.';
    });
  }

  private finishDesktopInstall(): void {
    this.navPathStack.pop();
  }

  build() {
    NavDestination() {
      Column() {
        Row({ space: 8 }) {
          Button('‹')
            .fontSize(18)
            .width(36)
            .height(36)
            .padding(0)
            .borderRadius(18)
            .backgroundColor(getColors().raisedSurface)
            .fontColor(getColors().ink)
            .onClick(() => {
              this.goBack();
            })
          Text($r('app.string.devices_pair'))
            .fontSize(17)
            .fontWeight(600)
            .fontColor(getColors().ink)
            .layoutWeight(1)
          if (this.step !== PAIRING_STEP_CONNECTION) {
            Button('×')
              .fontSize(16)
              .width(36)
              .height(36)
              .padding(0)
              .borderRadius(18)
              .backgroundColor(getColors().raisedSurface)
              .fontColor(getColors().ink)
              .onClick(() => {
                this.navPathStack.pop();
              })
          }
        }
        .width('100%')
        .padding({ left: 18, right: 18, top: 10, bottom: 6 })
        Scroll(this.scroller) {
          Column() {
            if (this.step === PAIRING_STEP_CONNECTION) {
              this.stepConnection()
            } else if (this.step === PAIRING_STEP_DESKTOP_INSTALL) {
              this.stepDesktopInstall()
            } else if (this.step === PAIRING_STEP_CLI_CONFIRM) {
              this.stepCliConfirm()
            } else if (this.step === PAIRING_STEP_NAME) {
              this.stepName()
            } else if (this.step === PAIRING_STEP_CLI_METHOD) {
              this.stepCliMethod()
            } else if (this.step === PAIRING_STEP_COMMAND) {
              this.stepCommand()
            } else {
              this.stepPairCode()
            }
          }
          .width('100%')
          .padding({ left: 18, right: 18, top: 8, bottom: 24 })
        }
        .width('100%')
        .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
      .backgroundColor(getColors().canvas)
    }
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
    })
  }
}

@Builder
export function DevicePairingPageBuilder() {
  DevicePairingPage()
}
