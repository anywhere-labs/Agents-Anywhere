import { webview } from '@kit.ArkWeb';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { ApiClient } from 'network';
import { AuthApi } from 'network';
import { SharedApiClient } from '../api/SharedApiClient';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { LoginServerConnection, resolveLoginServer } from '../auth/LoginServer';
import { MobileLoginQrPayload, parseMobileLoginQrPayload } from '../auth/MobileLoginQrPayload';
import {
  createWebLoginSession,
  parseWebLoginCallback,
  WebLoginCallback,
  WebLoginCallbackKind,
  WebLoginSession,
  WEB_LOGIN_CALLBACK_URI
} from '../auth/WebLoginModels';
import { AppConfig } from 'common';
import { ApiException, errorMessageFrom } from 'common';
import { APP_IS_DARK_KEY, getColors } from 'common';

const PHASE_METHOD_CHOICE = 0;
const PHASE_HOST_CHOICE = 1;
const PHASE_WEB_LOGIN = 2;
const PHASE_EXCHANGING = 3;
const PHASE_QR_WAITING = 4;

const QR_SCAN_CANCELED_CODE = 1000500002;
const QR_POLL_INTERVAL_MS = 1600;

@Component
export struct LoginPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  onSignedIn: () => void = () => {};
  @State phase: number = PHASE_METHOD_CHOICE;
  @State busy: boolean = false;
  @State hostInput: string = '';
  @State selfHostExpanded: boolean = false;
  @State errorMessage: string = '';
  @State authorizeUrl: string = '';
  @State qrError: string = '';
  @State qrStatus: string = 'waiting';
  private webController: webview.WebviewController = new webview.WebviewController();
  private loginSession: WebLoginSession | null = null;
  private client: ApiClient = SharedApiClient.getInstance();
  private authApi: AuthApi = new AuthApi(this.client);
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private qrPayload: MobileLoginQrPayload | null = null;
  private qrTimer: number = -1;

  private webError: string = '';

  aboutToAppear(): void {
    try {
      const serverUrl = this.authStore.readServerUrl();
      if (serverUrl.length > 0) {
        this.hostInput = serverUrl;
      }
    } catch (error) {
    }
  }

  aboutToDisappear(): void {
    this.stopQrPolling();
  }

  private localText(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  private deviceDisplayName(): string {
    const market = deviceInfo.marketName.trim();
    if (market.length > 0) {
      return market;
    }
    const model = deviceInfo.productModel.trim();
    if (model.length > 0) {
      return model;
    }
    return 'HarmonyOS';
  }

  private returnToMethodChoice(): void {
    this.loginSession = null;
    this.webError = '';
    this.errorMessage = '';
    this.selfHostExpanded = false;
    this.phase = PHASE_METHOD_CHOICE;
  }

  private reportWebError(message: string): void {
    if (message.length === 0 || this.webError.length > 0) {
      return;
    }
    this.webError = message;
  }

  private async startWebLogin(serverUrlCandidate: string): Promise<void> {
    this.busy = true;
    this.errorMessage = '';
    const input = serverUrlCandidate.trim();
    try {
      const candidate = input.length > 0 ? input : this.authStore.readServerUrl();
      const connection = resolveLoginServer(candidate);
      if (connection === null) {
        throw new ApiException(this.localText($r('app.string.login_invalid_server')));
      }
      await this.authApi.requireHealthyServer(connection.serverUrl);
      await this.authApi.requireWebLoginHost(connection.oauthWebOrigin);
      this.authStore.saveServerUrl(connection.serverUrl);
      const session = await createWebLoginSession(connection);
      this.loginSession = session;
      this.webController = new webview.WebviewController();
      this.webError = '';
      this.authorizeUrl = session.authorizeUrl;
      this.phase = PHASE_WEB_LOGIN;
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
    }
    this.busy = false;
  }

  private handleCallbackUrl(url: string): void {
    const session = this.loginSession;
    if (session === null) {
      return;
    }
    const callback = parseWebLoginCallback(url, session);
    if (callback.kind === WebLoginCallbackKind.Success) {
      this.exchangeCode(session, callback.code);
      return;
    }
    this.loginSession = null;
    this.phase = PHASE_HOST_CHOICE;
    this.errorMessage = callback.message;
  }

  private async exchangeCode(session: WebLoginSession, code: string): Promise<void> {
    this.phase = PHASE_EXCHANGING;
    try {
      const token = await this.authApi.oauthToken(session.serverUrl, code, session.codeVerifier);
      const me = await this.authApi.me(session.serverUrl, token.accessToken);
      this.authStore.saveAuthSession(session.serverUrl, me.userId, me.role,
        token.accessToken, token.tokenType);
      this.loginSession = null;
      this.onSignedIn();
    } catch (error) {
      this.errorMessage = errorMessageFrom(error as Object);
      this.loginSession = null;
      this.phase = PHASE_HOST_CHOICE;
    }
  }

  private stopQrPolling(): void {
    if (this.qrTimer !== -1) {
      clearInterval(this.qrTimer);
      this.qrTimer = -1;
    }
  }

  private resetQrState(): void {
    this.stopQrPolling();
    this.qrPayload = null;
    this.qrError = '';
    this.qrStatus = 'waiting';
  }

  private async startQrLogin(): Promise<void> {
    this.qrError = '';
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true
    };
    try {
      const context = getContext(this);
      const result = await scanBarcode.startScanForResult(context, options);
      await this.handleQrValue(result.originalValue);
    } catch (error) {
      const businessError = error as BusinessError;
      if (businessError.code !== QR_SCAN_CANCELED_CODE) {
        this.qrError = errorMessageFrom(error as Object);
      }
    }
  }

  private async handleQrValue(qrValue: string): Promise<void> {
    const payload = parseMobileLoginQrPayload(qrValue);
    if (payload === null) {
      this.qrError = this.localText($r('app.string.login_qr_invalid'));
      return;
    }
    this.resetQrState();
    this.qrPayload = payload;
    this.phase = PHASE_QR_WAITING;
    try {
      this.authStore.saveServerUrl(payload.serverUrl);
      await this.authApi.requestMobileLogin(payload.serverUrl, payload.userId, payload.loginToken,
        this.deviceDisplayName());
      this.startQrPolling(payload);
    } catch (error) {
      this.qrError = errorMessageFrom(error as Object);
    }
  }

  private startQrPolling(payload: MobileLoginQrPayload): void {
    this.stopQrPolling();
    const tick = async (): Promise<void> => {
      try {
        const status = await this.authApi.mobileLoginStatus(payload.serverUrl, payload.loginToken);
        if (status.status === 'approved') {
          this.stopQrPolling();
          await this.completeQrLogin(payload);
          return;
        }
        if (status.status === 'rejected' || status.status === 'expired' || status.status === 'consumed') {
          this.stopQrPolling();
          this.qrStatus = status.status;
          return;
        }
        this.qrStatus = 'waiting';
        this.qrError = '';
      } catch (error) {
        // Transient network errors keep polling, mirroring the Android client.
        this.qrError = errorMessageFrom(error as Object);
      }
    };
    this.qrTimer = setInterval(() => {
      tick();
    }, QR_POLL_INTERVAL_MS);
    tick();
  }

  private async completeQrLogin(payload: MobileLoginQrPayload): Promise<void> {
    this.qrStatus = 'completing';
    try {
      const exchange = await this.authApi.exchangeMobileLogin(payload.serverUrl, payload.userId,
        payload.loginToken);
      this.authStore.saveAuthSession(payload.serverUrl, exchange.userId, exchange.role,
        exchange.accessToken, 'Bearer');
      this.qrPayload = null;
      this.onSignedIn();
    } catch (error) {
      this.qrError = errorMessageFrom(error as Object);
    }
  }

  @Builder
  MethodChoiceView() {
    Column({ space: 30 }) {
      Column({ space: 6 }) {
        Text($r('app.string.login_continue_to'))
          .fontSize(24)
          .fontWeight(FontWeight.Medium)
          .lineHeight(26)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.EntryAbility_label'))
          .fontSize(42)
          .fontWeight(FontWeight.Medium)
          .lineHeight(44)
          .fontFamily('Caveat')
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.login_choose_method'))
          .fontSize(14)
          .lineHeight(18)
          .fontColor(getColors().muted)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column({ space: 24 }) {
        Button($r('app.string.login_qr_login'))
          .width('100%')
          .height(56)
          .fontSize(15.3)
          .fontWeight(FontWeight.Medium)
          .backgroundColor(getColors().subtle)
          .fontColor(getColors().ink)
          .borderRadius(12)
          .onClick(() => {
            this.startQrLogin();
          })
        Button($r('app.string.login_password_login'))
          .width('100%')
          .height(56)
          .fontSize(15.3)
          .fontWeight(FontWeight.Medium)
          .backgroundColor(Color.Transparent)
          .fontColor(getColors().muted)
          .borderRadius(12)
          .border({ width: 1, color: getColors().border })
          .onClick(() => {
            this.selfHostExpanded = false;
            this.phase = PHASE_HOST_CHOICE;
          })
      }
      .width('100%')

      Text($r('app.string.login_qr_help'))
        .fontSize(12)
        .fontColor(getColors().faint)
        .width('100%')

      if (this.qrError.length > 0) {
        Text(this.qrError)
          .fontSize(13)
          .fontColor(getColors().errorText)
          .width('100%')
      }
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 32, right: 32, top: 104, bottom: 30 })
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.Start)
  }

  @Builder
  HostChoiceView() {
    Column() {
      Row() {
        Button($r('app.string.login_back'))
          .fontSize(13)
          .fontWeight(600)
          .height(36)
          .borderRadius(18)
          .padding({ left: 12, right: 12 })
          .backgroundColor(getColors().raisedSurface)
          .fontColor(getColors().onRaisedSurface)
          .border({ width: 1.2, color: getColors().border })
          .onClick(() => {
            this.returnToMethodChoice();
          })
      }
      .width('100%')
      .padding({ left: 32, right: 32, top: 74 })

      Scroll() {
        Column({ space: 24 }) {
          Column({ space: 10 }) {
            Text($r('app.string.login_host_choice_title'))
              .fontSize(28)
              .fontWeight(600)
              .lineHeight(34)
              .fontColor(getColors().ink)
              .width('100%')
            Text($r('app.string.login_host_choice_hint'))
              .fontSize(13)
              .lineHeight(19)
              .fontColor(getColors().muted)
              .width('100%')
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          if (this.errorMessage.length > 0) {
            Text(this.errorMessage)
              .fontSize(13.5)
              .fontWeight(FontWeight.Medium)
              .lineHeight(17)
              .fontColor(getColors().errorText)
              .width('100%')
          }

          if (this.busy) {
            Button($r('app.string.login_checking'))
              .width('100%')
              .height(56)
              .fontSize(15.3)
              .fontWeight(FontWeight.Medium)
              .backgroundColor(getColors().subtle)
              .fontColor(getColors().ink)
              .borderRadius(12)
              .enabled(false)
              .onClick(() => {
                this.startWebLogin(AppConfig.OFFICIAL_SERVER_URL);
              })
          } else {
            Button($r('app.string.login_official_service'))
              .width('100%')
              .height(56)
              .fontSize(15.3)
              .fontWeight(FontWeight.Medium)
              .backgroundColor(getColors().subtle)
              .fontColor(getColors().ink)
              .borderRadius(12)
              .enabled(true)
              .onClick(() => {
                this.startWebLogin(AppConfig.OFFICIAL_SERVER_URL);
              })
          }

          if (!this.selfHostExpanded) {
            Button($r('app.string.login_self_host_service'))
              .width('100%')
              .height(56)
              .fontSize(15.3)
              .fontWeight(FontWeight.Medium)
              .backgroundColor(Color.Transparent)
              .fontColor(getColors().muted)
              .borderRadius(12)
              .border({ width: 1, color: getColors().border })
              .enabled(!this.busy)
              .onClick(() => {
                this.selfHostExpanded = true;
              })
          } else {
            Row({ space: 12 }) {
              Divider()
                .strokeWidth(1)
                .color(getColors().border)
                .layoutWeight(1)
              Text($r('app.string.login_or'))
                .fontSize(14)
                .fontColor(getColors().muted)
              Divider()
                .strokeWidth(1)
                .color(getColors().border)
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)

            Column({ space: 12 }) {
              Text($r('app.string.login_self_host_service'))
                .fontSize(15.3)
                .fontWeight(FontWeight.Medium)
                .lineHeight(21)
                .fontColor(getColors().ink)
                .width('100%')
              TextInput({ placeholder: $r('app.string.login_server_placeholder'), text: this.hostInput })
                .onChange((value: string) => {
                  this.hostInput = value;
                })
                .width('100%')
                .height(62)
                .fontSize(15.3)
                .fontColor(getColors().ink)
                .placeholderColor(getColors().muted)
                .backgroundColor(getColors().raisedSurface)
                .borderRadius(17)
                .border({ width: 1.2, color: getColors().border })
                .enabled(!this.busy)
              Button($r('app.string.login_connect_server'))
                .width('100%')
                .height(56)
                .fontSize(15.3)
                .fontWeight(FontWeight.Medium)
                .backgroundColor(getColors().subtle)
                .fontColor(getColors().ink)
                .borderRadius(12)
                .enabled(!this.busy && this.hostInput.trim().length > 0)
                .onClick(() => {
                  this.startWebLogin(this.hostInput);
                })
            }
            .width('100%')
          }
        }
        .width('100%')
        .padding({ left: 32, right: 32, top: 30, bottom: 30 })
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.None)
    }
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  QrWaitingView() {
    Column() {
      Row() {
        Button($r('app.string.login_back'))
          .fontSize(13)
          .fontWeight(600)
          .height(36)
          .borderRadius(18)
          .padding({ left: 12, right: 12 })
          .backgroundColor(getColors().raisedSurface)
          .fontColor(getColors().onRaisedSurface)
          .border({ width: 1.2, color: getColors().border })
          .onClick(() => {
            this.resetQrState();
            this.phase = PHASE_METHOD_CHOICE;
          })
      }
      .width('100%')
      .padding({ left: 32, right: 32, top: 74 })

      Column({ space: 18 }) {
        if (this.qrStatus === 'completing') {
          LoadingProgress()
            .width(40)
            .height(40)
        } else if (this.qrStatus === 'waiting') {
          LoadingProgress()
            .width(40)
            .height(40)
        }

        if (this.qrStatus === 'completing') {
          Text($r('app.string.login_qr_completing'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .lineHeight(22.5)
            .fontColor(getColors().ink)
            .textAlign(TextAlign.Center)
            .width('100%')
        } else if (this.qrStatus === 'rejected') {
          Text($r('app.string.login_qr_rejected'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .lineHeight(22.5)
            .fontColor(getColors().ink)
            .textAlign(TextAlign.Center)
            .width('100%')
        } else if (this.qrStatus === 'expired') {
          Text($r('app.string.login_qr_expired'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .lineHeight(22.5)
            .fontColor(getColors().ink)
            .textAlign(TextAlign.Center)
            .width('100%')
        } else if (this.qrStatus === 'consumed') {
          Text($r('app.string.login_qr_consumed'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .lineHeight(22.5)
            .fontColor(getColors().ink)
            .textAlign(TextAlign.Center)
            .width('100%')
        } else {
          Text($r('app.string.login_qr_waiting'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .lineHeight(22.5)
            .fontColor(getColors().ink)
            .textAlign(TextAlign.Center)
            .width('100%')
        }

        if (this.qrError.length > 0) {
          Text(this.qrError)
            .fontSize(12.5)
            .lineHeight(16)
            .fontColor(getColors().errorText)
            .textAlign(TextAlign.Center)
            .width('100%')
        }

        if (this.qrError.length > 0 || this.qrStatus === 'rejected' ||
          this.qrStatus === 'expired' || this.qrStatus === 'consumed') {
          Button($r('app.string.login_qr_rescan'))
            .width('100%')
            .height(56)
            .fontSize(15.3)
            .fontWeight(FontWeight.Medium)
            .backgroundColor(getColors().subtle)
            .fontColor(getColors().ink)
            .borderRadius(12)
            .onClick(() => {
              this.resetQrState();
              this.startQrLogin();
            })
        }
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 32, right: 32, bottom: 30 })
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  WebLoginView() {
    Column() {
      Row({ space: 8 }) {
        Button($r('app.string.login_back'))
          .fontSize(13)
          .fontWeight(600)
          .height(36)
          .borderRadius(18)
          .padding({ left: 12, right: 12 })
          .backgroundColor(getColors().raisedSurface)
          .fontColor(getColors().onRaisedSurface)
          .border({ width: 1.2, color: getColors().border })
          .onClick(() => {
            if (this.phase !== PHASE_EXCHANGING) {
              this.loginSession = null;
              this.webError = '';
              this.phase = PHASE_HOST_CHOICE;
            }
          })
        if (this.webError.length > 0) {
          Text(this.webError)
            .fontSize(12)
            .fontColor(getColors().errorText)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10 })
      Web({ src: this.authorizeUrl, controller: this.webController })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .mixedMode(MixedMode.All)
        .width('100%')
        .layoutWeight(1)
        .onLoadIntercept((event) => {
          const url = event.data.getRequestUrl();
          if (url.toLowerCase().startsWith(WEB_LOGIN_CALLBACK_URI)) {
            this.handleCallbackUrl(url);
            return true;
          }
          if (url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://')) {
            return false;
          }
          this.reportWebError(this.localText($r('app.string.login_web_link_error')));
          return true;
        })
        .onErrorReceive((event) => {
          const errorCode = event.error.getErrorCode();
          if (event.request.isMainFrame() && errorCode !== 0) {
            const info = event.error.getErrorInfo();
            this.reportWebError(info.length > 0 ? info : this.localText($r('app.string.login_web_load_error')));
          }
        })
        .onHttpErrorReceive((event) => {
          const response = event.response;
          if (event.request.isMainFrame() && response.getResponseCode() >= 400) {
            this.reportWebError(`${this.localText($r('app.string.login_web_load_error'))} (HTTP ${response.getResponseCode()}).`);
          }
        })
    }
    .width('100%')
    .layoutWeight(1)
  }

  build() {
    Column() {
      if (this.phase === PHASE_METHOD_CHOICE) {
        this.MethodChoiceView()
      } else if (this.phase === PHASE_HOST_CHOICE) {
        this.HostChoiceView()
      } else if (this.phase === PHASE_QR_WAITING) {
        this.QrWaitingView()
      } else if (this.phase === PHASE_WEB_LOGIN) {
        this.WebLoginView()
      } else {
        Column({ space: 12 }) {
          LoadingProgress()
            .width(44)
            .height(44)
          Text($r('app.string.login_signing_in'))
            .fontSize(14)
            .fontColor(getColors().faint)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(getColors().canvas)
  }
}
