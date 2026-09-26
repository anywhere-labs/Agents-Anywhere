import { AsyncCallback, BusinessError } from '@kit.BasicServicesKit';
import { customScan, scanBarcode, scanCore } from '@kit.ScanKit';
import { abilityAccessCtrl, common, PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize } from '../../designsystem/AAMetrics';
import { AuthErrorNotice } from '../../designsystem/AAComponents';
import { AAIosPage } from '../../designsystem/AAIosChrome';
import { AuthController } from '../../../feature/auth/AuthController';
import { MobileLoginQrPayload } from '../../../feature/auth/WebLoginModels';
import { MobileLoginStatus, ParsedMobileLoginStatus } from '../../../api/AuthDtos';
import { AALog } from '../../../common/AAAppLog';

/**
 * QR sign-in, both halves.
 *
 * Port of `QrAuthScreens.kt`, restyled to the iOS client's layout in round 40
 * (`Views/Auth/QRCodeLoginView.swift` / `QRCodeScannerView.swift`): the
 * navigation row, large title and subtitle come from `AAIosPage`, and the
 * scanner is a 380pt preview with a 32pt radius carrying a centred white square
 * outline. Android's 286dp frame with corner brackets and the 4F7BFF sweep line
 * was dropped with it — the parameters are recorded in the port plan in case the
 * Android look is wanted back.
 *
 * What the screen *does* is unchanged: the same ScanKit preview, the same
 * permission handling, payload validation, re-emission window and polling state
 * machine, and the same strings.
 */

/** Delay between status polls, matching Android's 1600 ms cadence. */
const POLL_INTERVAL_MS: number = 1600;
/** Scanner preview height, matching iOS `QRScanStepView`'s 380pt frame. */
const SCANNER_HEIGHT: number = 380;
/** Its corner radius, matching iOS's `RoundedRectangle(cornerRadius: 32)`. */
const SCANNER_RADIUS: number = 32;
/**
 * Android's `QrEmissionGate` window: the same code is not handed to the API
 * again for 1200 ms, so a stale QR left in front of the camera cannot spin the
 * sign-in endpoint.
 */
const SAME_QR_RETRY_MS: number = 1200;
/** The only permission the viewfinder needs, matching Android's CAMERA. */
const CAMERA_PERMISSIONS: Array<Permissions> = ['ohos.permission.CAMERA'];

@Component
export struct QrLoginScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  controller: AuthController | null = null;
  onBack: () => void = () => {};
  onScanned: (payload: MobileLoginQrPayload) => void = () => {};

  @State private submitting: boolean = false;
  @State private errorMessage: string = '';
  /** False on a device whose system image has no barcode scanner capability. */
  @State private scannerAvailable: boolean = true;
  /** True once the camera permission has been granted. */
  @State private cameraGranted: boolean = false;
  /** True when the preview could not start, so the frame shows the hint instead. */
  @State private previewFailed: boolean = false;

  private surfaceController: XComponentController = new XComponentController();
  /** Last code handed to the API, and when, for Android's re-emission window. */
  private lastQrValue: string = '';
  private lastQrAt: number = 0;
  /** True once the surface belongs to ScanKit, so it is stopped exactly once. */
  private previewing: boolean = false;
  /** Set in `aboutToDisappear`; every late callback checks it first. */
  private released: boolean = false;

  /**
   * ScanKit's result callback.
   *
   * Held as a field so it stays bound to this component: `customScan` keeps the
   * reference for the whole scanning session and calls it after any await.
   */
  private scanCallback: AsyncCallback<Array<scanBarcode.ScanResult>> =
    (error: BusinessError, results: Array<scanBarcode.ScanResult>): void => {
      this.onScanResults(error, results);
    };

  aboutToAppear(): void {
    // Barcode scanning is a system capability, so it is probed before the frame
    // is presented as usable rather than failing on the first tap.
    this.scannerAvailable = canIUse('SystemCapability.Multimedia.Scan.ScanBarcode');
    if (this.scannerAvailable) {
      void this.requestCamera();
    }
  }

  aboutToDisappear(): void {
    this.released = true;
    void this.stopPreview();
  }

  /**
   * A resource string as plain text.
   *
   * `AuthErrorNotice` takes a `string`, and these notices are fixed sentences
   * rather than exception messages, so they are resolved through the resource
   * manager's id overload — the same route `DeviceDetailScreen` uses for its
   * dialog title.
   */
  private textOf(resource: Resource): string {
    try {
      const context: common.Context | undefined = this.getUIContext().getHostContext();
      if (context === undefined) {
        return '';
      }
      return context.resourceManager.getStringSync(resource.id);
    } catch (error) {
      AALog.debug('QR notice could not be resolved');
      return '';
    }
  }

  /**
   * Requests CAMERA, the permission Android asks for on this same screen.
   *
   * Android answers its system dialog by either rendering the preview or showing
   * `qr_camera_access_needed` inside the frame, and reports a denial with
   * `qr_camera_permission_required`; both branches are reproduced here.
   */
  private async requestCamera(): Promise<void> {
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (context === undefined) {
      this.previewFailed = true;
      return;
    }
    try {
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const result: PermissionRequestResult =
        await manager.requestPermissionsFromUser(context, CAMERA_PERMISSIONS);
      const granted: boolean = result.authResults.length > 0
        && result.authResults[0] === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
      this.cameraGranted = granted;
      if (!granted && !this.released) {
        this.errorMessage = this.textOf($r('app.string.qr_camera_permission_required'));
      }
    } catch (error) {
      this.previewFailed = true;
      AALog.warn(`Camera permission request failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** True while the frame is the scanning surface rather than the hint. */
  private usesCamera(): boolean {
    return this.scannerAvailable && this.cameraGranted && !this.previewFailed;
  }

  /**
   * Hands the XComponent surface to ScanKit and keeps decoding until a code
   * arrives.
   *
   * The callback overload is the one used on purpose: `customScan.rescan()`, the
   * documented way to ask for the next code without restarting the camera, is
   * only valid inside it. Barcode scanning is a system capability, so the calls
   * sit inside a positive `canIUse` branch, which is both the documented way to
   * guard such an API and what the ArkTS linter requires to accept the call
   * sites.
   */
  private startPreview(): void {
    if (this.previewing || this.released || this.submitting) {
      return;
    }
    const surfaceId: string = this.surfaceController.getXComponentSurfaceId();
    if (surfaceId.length === 0) {
      return;
    }
    // ScanKit wants the surface's size in px. The preview is full width and
    // `SCANNER_HEIGHT` tall now, so the surface's own rectangle is read back
    // rather than assumed square; before layout reports it, the height is used
    // for both axes.
    const rect: SurfaceRect = this.surfaceController.getXComponentSurfaceRect();
    const fallback: number = this.getUIContext().vp2px(SCANNER_HEIGHT);
    const viewControl: customScan.ViewControl = {
      width: rect.surfaceWidth > 0 ? rect.surfaceWidth : fallback,
      height: rect.surfaceHeight > 0 ? rect.surfaceHeight : fallback,
      surfaceId: surfaceId,
    };
    if (canIUse('SystemCapability.Multimedia.Scan.ScanBarcode')) {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableMultiMode: false,
        enableAlbum: false,
      };
      try {
        customScan.init(options);
        this.previewing = true;
        customScan.start(viewControl, this.scanCallback);
      } catch (error) {
        this.previewing = false;
        this.previewFailed = true;
        this.errorMessage = this.textOf($r('app.string.qr_start_failed'));
        AALog.warn(`QR preview failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    } else {
      this.previewFailed = true;
    }
  }

  /** Stops the preview stream; safe when nothing is running. */
  private async stopPreview(): Promise<void> {
    if (!this.previewing) {
      return;
    }
    this.previewing = false;
    if (canIUse('SystemCapability.Multimedia.Scan.ScanBarcode')) {
      try {
        await customScan.stop();
        customScan.release();
      } catch (error) {
        AALog.warn(`QR preview stop failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /**
   * One ScanKit callback.
   *
   * ScanKit reports a code once and then waits, so every exit from here re-arms
   * the preview with `rescan()` — including for a code this client is not going
   * to submit. That keeps the feed decoding exactly like Android's always-on
   * image analyser, and leaves the re-emission window as the only brake on
   * repeated submissions, again matching Android.
   */
  private onScanResults(error: BusinessError, results: Array<scanBarcode.ScanResult>): void {
    if (this.released) {
      return;
    }
    if (error) {
      this.previewing = false;
      this.previewFailed = true;
      this.errorMessage = this.textOf($r('app.string.qr_start_failed'));
      AALog.warn(`QR preview failed: ${error.message}`);
      return;
    }
    // The result type is capability-gated as well, so the rest of the callback
    // sits inside the same positive `canIUse` branch the scanning calls use.
    if (canIUse('SystemCapability.Multimedia.Scan.ScanBarcode')) {
      const value: string = results.length > 0 ? results[0].originalValue : '';
      const now: number = Date.now();
      if (value.length === 0) {
        // Nothing in view: forget the last code, like Android's `clearVisibleCode`.
        this.lastQrValue = '';
        this.rearm();
        return;
      }
      if (this.submitting || (value === this.lastQrValue && now - this.lastQrAt < SAME_QR_RETRY_MS)) {
        this.rearm();
        return;
      }
      this.lastQrValue = value;
      this.lastQrAt = now;
      this.rearm();
      void this.submit(value);
    }
  }

  /** Asks ScanKit for the next code; a no-op once the screen is gone. */
  private rearm(): void {
    if (!this.previewing || this.released) {
      return;
    }
    if (canIUse('SystemCapability.Multimedia.Scan.ScanBarcode')) {
      try {
        customScan.rescan();
      } catch (error) {
        AALog.warn(`QR rescan failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /**
   * Opens the system scanner and submits whatever it returns.
   *
   * Android has no equivalent — its CameraX preview always exists — so this is
   * the safety net behind a tap on the frame when the preview cannot run at all:
   * a device without ScanKit's camera capability, a denied camera permission, or
   * a surface that refused to start. Without it the frame would be a dead tap
   * target on exactly those devices.
   */
  private async scanWithSystemScanner(): Promise<void> {
    if (this.submitting) {
      return;
    }
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (context === undefined) {
      this.errorMessage = this.textOf($r('app.string.qr_start_failed'));
      return;
    }

    if (canIUse('SystemCapability.Multimedia.Scan.ScanBarcode')) {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableAlbum: false,
        enableMultiMode: false,
      };
      try {
        const result: scanBarcode.ScanResult =
          await scanBarcode.startScanForResult(context, options);
        await this.submit(result.originalValue);
      } catch (error) {
        // A user-cancelled scan is not an error; anything else is reported.
        const message: string = error instanceof Error ? error.message : '';
        if (message.length > 0 && !message.toLowerCase().includes('cancel')) {
          AALog.warn(`QR scan failed: ${message}`);
        }
      }
    } else {
      this.scannerAvailable = false;
    }
  }

  private async submit(rawValue: string): Promise<void> {
    const auth: AuthController | null = this.controller;
    if (auth === null || rawValue.length === 0) {
      return;
    }
    this.submitting = true;
    this.errorMessage = '';
    try {
      const payload: MobileLoginQrPayload = await auth.requestMobileLoginFromQr(rawValue);
      this.onScanned(payload);
    } catch (error) {
      this.errorMessage = error instanceof Error
        ? error.message
        : this.textOf($r('app.string.qr_start_failed'));
    } finally {
      this.submitting = false;
    }
  }

  build() {
    // iOS layout (round 40): `AAIosPage` supplies the navigation row, the large
    // title and the subtitle, and the scanner is iOS's 380pt rounded preview with
    // a centred white outline rather than Android's brackets and sweep line.
    AAIosPage({
      colors: this.colors,
      title: $r('app.string.auth_continue_qr'),
      subtitle: $r('app.string.qr_help_body'),
      onBack: () => this.onBack(),
    }) {
      Column({ space: 16 }) {
        Stack() {
          if (this.usesCamera()) {
            XComponent({
              id: 'qr-scan-surface',
              type: XComponentType.SURFACE,
              controller: this.surfaceController,
            })
              .width('100%')
              .height(SCANNER_HEIGHT)
              .onLoad(() => {
                this.startPreview();
              })
          } else {
            Text($r('app.string.qr_camera_access_needed'))
              .fontSize(12.5)
              .fontColor(this.colors.muted)
              .lineHeight(16)
              .textAlign(TextAlign.Center)
              .padding({ left: 28, right: 28 })
          }

          // iOS's `ScannerViewController.addOverlay`: a 2pt white outline at 68%
          // of the preview's width, centred, with a 24pt radius, and its label
          // 24pt below the top edge.
          Column()
            .width('68%')
            .aspectRatio(1)
            .borderRadius(24)
            .border({ width: 2, color: '#E6FFFFFF' })
            .hitTestBehavior(HitTestMode.None)

          Column() {
            Text($r('app.string.qr_scan_frame_hint'))
              .fontSize(AAFontSize.HEADER)
              .fontWeight(600)
              .fontColor('#FFFFFF')
              .textAlign(TextAlign.Center)
          }
          .width('100%')
          .height('100%')
          .alignItems(HorizontalAlign.Center)
          .padding({ top: 24 })
          .hitTestBehavior(HitTestMode.None)

          // `QRScanStepView`'s caption: a scrim capsule 18pt above the bottom
          // edge. ArkUI has no glass material, so the scrim's colour is used as
          // the capsule's fill, which is what it looks like over a preview.
          Column() {
            Text($r('app.string.qr_scan_caption'))
              .fontSize(AAFontSize.CAPTION)
              .fontWeight(FontWeight.Medium)
              .fontColor('#FFFFFF')
              .textAlign(TextAlign.Center)
              .padding({ left: 14, right: 14, top: 9, bottom: 9 })
              .borderRadius(999)
              .backgroundColor('#6B000000')
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.End)
          .alignItems(HorizontalAlign.Center)
          .padding({ bottom: 18 })
          .hitTestBehavior(HitTestMode.None)
        }
        .width('100%')
        .height(SCANNER_HEIGHT)
        .borderRadius(SCANNER_RADIUS)
        .clip(true)
        .backgroundColor(this.colors.raisedSurface)
        .onClick(() => {
          if (!this.usesCamera()) {
            void this.scanWithSystemScanner();
          }
        })

        if (this.errorMessage.length > 0) {
          AuthErrorNotice({ colors: this.colors, message: this.errorMessage })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}

@Component
export struct QrWaitingScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  controller: AuthController | null = null;
  payload: MobileLoginQrPayload | null = null;
  onBack: () => void = () => {};
  onSignedIn: () => void = () => {};

  @State private status: string = MobileLoginStatus.PENDING_WEB_CONFIRM;
  @State private exchanging: boolean = false;
  @State private errorMessage: string = '';

  private pollTimer: number = -1;
  private stopped: boolean = false;

  aboutToAppear(): void {
    this.scheduleNextPoll(POLL_INTERVAL_MS);
  }

  aboutToDisappear(): void {
    this.stopPolling();
  }

  private stopPolling(): void {
    this.stopped = true;
    if (this.pollTimer !== -1) {
      clearTimeout(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.pollOnce();
    }, delayMs);
  }

  /**
   * One status poll.
   *
   * A transient network failure keeps the loop alive and surfaces the message,
   * matching Android, because the QR token may still be approved moments later.
   */
  private async pollOnce(): Promise<void> {
    const auth: AuthController | null = this.controller;
    const current: MobileLoginQrPayload | null = this.payload;
    if (auth === null || current === null || this.stopped) {
      return;
    }
    if (this.exchanging) {
      return;
    }
    try {
      const result: ParsedMobileLoginStatus =
        await auth.mobileLoginStatus(current.serverUrl, current.loginToken);
      this.status = result.status;
      if (result.status === MobileLoginStatus.APPROVED) {
        await this.completeSignIn(current);
        return;
      }
      if (result.status === MobileLoginStatus.REJECTED
        || result.status === MobileLoginStatus.EXPIRED
        || result.status === MobileLoginStatus.CONSUMED) {
        this.stopPolling();
        return;
      }
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = error instanceof Error
        ? error.message
        : 'Could not check QR sign-in status.';
    }
    this.scheduleNextPoll(POLL_INTERVAL_MS);
  }

  private async completeSignIn(current: MobileLoginQrPayload): Promise<void> {
    const auth: AuthController | null = this.controller;
    if (auth === null) {
      return;
    }
    this.exchanging = true;
    try {
      await auth.completeMobileLogin(current);
      this.stopPolling();
      this.onSignedIn();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Could not complete QR sign-in.';
      this.exchanging = false;
      this.scheduleNextPoll(POLL_INTERVAL_MS);
    }
  }

  /** Title precedence, identical to Android's `qrWaitingTitle`. */
  private title(): ResourceStr {
    if (this.exchanging) {
      return $r('app.string.qr_completing');
    }
    if (this.payload === null) {
      return $r('app.string.qr_scan_first');
    }
    if (this.status === MobileLoginStatus.REJECTED) {
      return $r('app.string.qr_rejected');
    }
    if (this.status === MobileLoginStatus.EXPIRED) {
      return $r('app.string.qr_expired');
    }
    if (this.status === MobileLoginStatus.CONSUMED) {
      return $r('app.string.qr_consumed');
    }
    return $r('app.string.qr_waiting');
  }

  build() {
    // iOS `QRWaitingStepView`: a navigation row and title, then a centred column
    // of the desktop glyph, the status line and a large spinner, inset 24dp top
    // and bottom. The status stays this screen's existing title, so every
    // rejected/expired/consumed state still reads the way it did.
    AAIosPage({
      colors: this.colors,
      title: this.title(),
      onBack: () => this.onBack(),
    }) {
      Column({ space: 24 }) {
        AAIcon({ commands: AA_ICONS.MONITOR, iconSize: 58, color: this.colors.ink })

        if (this.errorMessage.length > 0) {
          Text(this.errorMessage)
            .fontSize(AAFontSize.LABEL)
            .fontColor(this.colors.errorText)
            .lineHeight(19)
            .textAlign(TextAlign.Center)
            .width('100%')
        }

        LoadingProgress()
          .width(38)
          .height(38)
          .color(this.colors.ink)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
      .padding({ top: 24, bottom: 24 })
    }
  }
}
