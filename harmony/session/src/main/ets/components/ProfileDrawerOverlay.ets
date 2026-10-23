import { bundleManager, common, OpenLinkOptions } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { AuthApi } from 'network';
import { AuthMeResponse } from 'network';
import { SharedApiClient, notifyAuthSessionExpired } from '../api/SharedApiClient';
import { AppUpdatesApi, compareUpdateVersions } from 'network';
import { AppUpdateIgnoreStore } from '../auth/AppUpdateIgnoreStore';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { SidebarViewModeStore, SIDEBAR_VIEW_MODE_KEY, SIDEBAR_VIEW_PROJECT, SIDEBAR_VIEW_SESSION } from '../auth/SidebarViewModeStore';
import { AppConfig } from 'common';
import { errorMessageFrom } from 'common';
import { APP_IS_DARK_KEY, APP_MODE_KEY, AppAppearanceMode, getColors } from 'common';
import { AppearanceSettings } from 'common';
import { LanguageSettings, AppLanguageMode, APP_LANGUAGE_KEY } from 'common';
import { showToast } from 'common';
import { avatarDataUrlFromUri } from 'common';
import { HomeMenuAnchor } from './HomeProjectActionMenuOverlay';
import { AppUpdatePromptOverlay } from './AppUpdatePromptOverlay';

const APPEARANCE_MENU_WIDTH = 286;
const LOG_TAG = 'ProfileDrawer';

@Component
export struct ProfileDrawerOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @StorageLink('profileDrawerDetailPage') detailPage: string = 'none';
  @StorageLink(APP_LANGUAGE_KEY) selectedLanguage: string = 'system';
  @StorageLink(APP_MODE_KEY) selectedAppearance: string = 'system';
  @State account: AuthMeResponse | null = null;
  @State avatarBusy: boolean = false;
  @State appearanceMenuOpen: boolean = false;
  @State appearanceAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @StorageProp(SIDEBAR_VIEW_MODE_KEY) sidebarViewMode: string = SIDEBAR_VIEW_PROJECT;
  @State sidebarMenuOpen: boolean = false;
  @State sidebarMenuAnchor: HomeMenuAnchor = { x: 0, y: 0, width: 0, height: 0 };
  @State menuOverlayWidth: number = 0;
  @State appVersionLabel: string = '';
  @State updateChecking: boolean = false;
  @State updateFailed: boolean = false;
  @State updateAvailable: boolean = false;
  @State updateVersionName: string = '';
  @State updateDownloadUrl: string = '';
  @State updatePromptVisible: boolean = false;
  @State nicknameOpen: boolean = false;
  @State nicknameInput: string = '';
  @State nicknameBusy: boolean = false;
  @State nicknameError: string = '';
  @State emailOpen: boolean = false;
  @State emailInput: string = '';
  @State emailBusy: boolean = false;
  @State emailError: string = '';
  @State pendingEmail: string = '';
  @State codeOpen: boolean = false;
  @State codeInput: string = '';
  @State codeBusy: boolean = false;
  @State codeError: string = '';
  @State passwordOpen: boolean = false;
  @State passwordInput: string = '';
  @State confirmInput: string = '';
  @State passwordBusy: boolean = false;
  @State passwordError: string = '';
  @State signOutOpen: boolean = false;
  onOpenArchivedSessions: () => void = () => {};
  onClose: () => void = () => {};
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private sidebarViewStore: SidebarViewModeStore = SidebarViewModeStore.getInstance();
  private authApi: AuthApi = new AuthApi(SharedApiClient.getInstance());
  private updatesApi: AppUpdatesApi = new AppUpdatesApi(SharedApiClient.getInstance());
  private updateIgnoreStore: AppUpdateIgnoreStore = AppUpdateIgnoreStore.getInstance();

  aboutToAppear(): void {
    this.detailPage = 'none';
    this.loadAccount();
    this.appVersionLabel = `v${this.currentVersionName()}`;
    this.checkForUpdates();
  }

  aboutToDisappear(): void {
    this.detailPage = 'none';
  }

  private pageBg(): string {
    return this.themeIsDark ? getColors().canvas : '#F4F3EF';
  }

  private cardBg(): string {
    return this.themeIsDark ? getColors().raisedSurface : '#FFFFFF';
  }

  private cardBorder(): string {
    return this.themeIsDark ? getColors().border : '#B8EAE8E2';
  }

  private dividerColor(): string {
    return this.themeIsDark ? getColors().border : '#C7E7E5DF';
  }

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private currentVersionName(): string {
    try {
      const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionName;
    } catch (error) {
      return '';
    }
  }

  private isOfficialServer(): boolean {
    let normalized = this.serverUrl().trim().toLowerCase();
    if (normalized.length > 0 && normalized.charAt(normalized.length - 1) === '/') {
      normalized = normalized.substring(0, normalized.length - 1);
    }
    return normalized === AppConfig.OFFICIAL_SERVER_URL;
  }

  private serviceLabel(): ResourceStr {
    return this.isOfficialServer()
      ? $r('app.string.profile_official_service')
      : $r('app.string.profile_self_hosted');
  }

  private async loadAccount(): Promise<void> {
    try {
      this.account = await this.authApi.me(this.serverUrl(), this.token());
    } catch (error) {
    }
  }

  private accountLabel(): string {
    const account = this.account;
    if (account === null) {
      return '';
    }
    if (account.displayName.trim().length > 0) {
      return account.displayName.trim();
    }
    return account.email ?? '';
  }

  private identityTitle(): ResourceStr {
    const label = this.accountLabel();
    if (label.length === 0) {
      return $r('app.string.profile_account_fallback');
    }
    return label;
  }

  private initialChar(): string {
    const label = this.accountLabel();
    if (label.length === 0) {
      return 'A';
    }
    return label.charAt(0).toUpperCase();
  }

  private avatarUrl(): string {
    const account = this.account;
    if (account === null) {
      return '';
    }
    const avatar = account.avatar;
    return avatar === null ? '' : avatar.trim();
  }

  private hasAvatar(): boolean {
    return this.avatarUrl().length > 0;
  }

  private prettyRole(role: string): string {
    if (role.length === 0) {
      return 'member';
    }
    return role.charAt(0).toUpperCase() + role.substring(1);
  }

  private roleValue(): string {
    const account = this.account;
    if (account === null) {
      return '';
    }
    return this.prettyRole(account.role);
  }

  private nicknameValue(): ResourceStr {
    const account = this.account;
    if (account === null) {
      return $r('app.string.profile_account_fallback');
    }
    if (account.displayName.trim().length > 0) {
      return account.displayName;
    }
    return $r('app.string.profile_account_fallback');
  }

  private emailValue(): ResourceStr {
    const account = this.account;
    if (account === null) {
      return '';
    }
    const email = account.email;
    if (email === null || email.length === 0) {
      return $r('app.string.profile_not_bound');
    }
    return email;
  }

  private changeAppearance(mode: AppAppearanceMode): void {
    if (this.selectedAppearance === mode) {
      return;
    }
    AppearanceSettings.getInstance().setMode(mode);
  }

  private changeLanguage(mode: AppLanguageMode): void {
    if (this.selectedLanguage === mode) {
      return;
    }
    LanguageSettings.getInstance().setLanguage(mode);
  }

  private openAppearanceMenu(): void {
    let anchor: HomeMenuAnchor = { x: 16, y: 640, width: 0, height: 0 };
    try {
      const uiContext = this.getUIContext();
      const utils = uiContext.getComponentUtils();
      const rootRect = utils.getRectangleById('profile_drawer_root');
      const rect = utils.getRectangleById('profile_appearance_row');
      // getRectangleById returns px while position() takes vp: convert via px2vp.
      anchor = {
        x: uiContext.px2vp(rect.windowOffset.x - rootRect.windowOffset.x),
        y: uiContext.px2vp(rect.windowOffset.y - rootRect.windowOffset.y),
        width: uiContext.px2vp(rect.size.width),
        height: uiContext.px2vp(rect.size.height)
      };
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(0x0000, LOG_TAG, `openAppearanceMenu getRectangleById failed: ${err.code} ${err.message}`);
    }
    this.appearanceAnchor = anchor;
    this.appearanceMenuOpen = true;
  }

  private appearanceMenuX(): number {
    const margin = 12;
    const preferred = this.appearanceAnchor.x + this.appearanceAnchor.width - APPEARANCE_MENU_WIDTH - 8;
    if (this.menuOverlayWidth > 0) {
      const max = Math.max(this.menuOverlayWidth - APPEARANCE_MENU_WIDTH - margin, margin);
      return Math.min(Math.max(preferred, margin), max);
    }
    return Math.max(preferred, margin);
  }

  private appearanceMenuY(): number {
    return this.appearanceAnchor.y + this.appearanceAnchor.height + 4;
  }

  private changeSidebarView(mode: string): void {
    if (this.sidebarViewMode === mode) {
      return;
    }
    this.sidebarViewStore.setMode(mode);
  }

  private openSidebarMenu(): void {
    let anchor: HomeMenuAnchor = { x: 16, y: 640, width: 0, height: 0 };
    try {
      const uiContext = this.getUIContext();
      const utils = uiContext.getComponentUtils();
      const rootRect = utils.getRectangleById('profile_drawer_root');
      const rect = utils.getRectangleById('profile_sidebar_view_row');
      // getRectangleById returns px while position() takes vp: convert via px2vp.
      anchor = {
        x: uiContext.px2vp(rect.windowOffset.x - rootRect.windowOffset.x),
        y: uiContext.px2vp(rect.windowOffset.y - rootRect.windowOffset.y),
        width: uiContext.px2vp(rect.size.width),
        height: uiContext.px2vp(rect.size.height)
      };
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(0x0000, LOG_TAG, `openSidebarMenu getRectangleById failed: ${err.code} ${err.message}`);
    }
    this.sidebarMenuAnchor = anchor;
    this.sidebarMenuOpen = true;
  }

  private sidebarMenuX(): number {
    const margin = 12;
    const preferred = this.sidebarMenuAnchor.x + this.sidebarMenuAnchor.width - APPEARANCE_MENU_WIDTH - 8;
    if (this.menuOverlayWidth > 0) {
      const max = Math.max(this.menuOverlayWidth - APPEARANCE_MENU_WIDTH - margin, margin);
      return Math.min(Math.max(preferred, margin), max);
    }
    return Math.max(preferred, margin);
  }

  private sidebarMenuY(): number {
    return this.sidebarMenuAnchor.y + this.sidebarMenuAnchor.height + 4;
  }

  private async checkForUpdates(): Promise<void> {
    if (this.updateChecking) {
      return;
    }
    const serverUrl = this.serverUrl();
    const accessToken = this.token();
    const current = this.currentVersionName();
    if (serverUrl.length === 0 || accessToken.length === 0 || current.length === 0) {
      this.updateFailed = true;
      return;
    }
    this.updateChecking = true;
    this.updateFailed = false;
    try {
      await this.updateIgnoreStore.waitUntilReady();
      const release = await this.updatesApi.check(serverUrl, current);
      const ignored = this.updateIgnoreStore.readIgnoredVersion(serverUrl);
      this.updateChecking = false;
      if (release !== null && (ignored.length === 0 || compareUpdateVersions(ignored, release.versionName) !== 0)) {
        this.updateVersionName = release.versionName;
        this.updateDownloadUrl = release.downloadUrl;
        this.updateAvailable = true;
      } else {
        this.updateAvailable = false;
      }
    } catch (error) {
      this.updateChecking = false;
      this.updateFailed = true;
    }
  }

  private onCheckUpdatesClicked(): void {
    if (this.updateChecking) {
      this.detailPage = 'updates';
      return;
    }
    if (this.updateAvailable) {
      this.updatePromptVisible = true;
      return;
    }
    this.detailPage = 'updates';
    this.checkForUpdates();
  }

  private ignoreUpdate(): void {
    try {
      this.updateIgnoreStore.saveIgnoredVersion(this.serverUrl(), this.updateVersionName);
    } catch (error) {
    }
    this.updatePromptVisible = false;
    this.updateAvailable = false;
  }

  private downloadUpdate(): void {
    const url = this.updateDownloadUrl;
    if (url.length === 0) {
      return;
    }
    const options: OpenLinkOptions = { appLinkingOnly: false };
    try {
      const context = getContext(this) as common.UIAbilityContext;
      context.openLink(url, options).catch(() => {
        this.showDownloadFallback(url);
      });
    } catch (error) {
      this.showDownloadFallback(url);
    }
  }

  private showDownloadFallback(url: string): void {
    showToast($r('app.string.update_open_link_fallback', url));
  }

  private changeAvatar(): void {
    if (this.avatarBusy) {
      return;
    }
    const photoPicker = new picker.PhotoViewPicker();
    photoPicker.select({ MIMEType: picker.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 1 })
      .then((result: picker.PhotoSelectResult) => {
        const uris = result.photoUris;
        if (uris === undefined || uris.length === 0) {
          return;
        }
        this.uploadAvatar(uris[0]);
      })
      .catch(() => {
      });
  }

  private async uploadAvatar(uri: string): Promise<void> {
    this.avatarBusy = true;
    let dataUrl = '';
    try {
      dataUrl = await avatarDataUrlFromUri(uri);
    } catch (error) {
      this.avatarBusy = false;
      showToast($r('app.string.profile_avatar_read_failed'));
      return;
    }
    try {
      this.account = await this.authApi.updateAvatar(this.serverUrl(), this.token(), dataUrl);
      showToast($r('app.string.profile_avatar_updated'));
    } catch (error) {
      showToast(errorMessageFrom(error as Object));
    }
    this.avatarBusy = false;
  }

  private cancelNickname(): void {
    if (this.nicknameBusy) {
      return;
    }
    this.nicknameOpen = false;
    this.nicknameError = '';
  }

  private nicknameCanSave(): boolean {
    const name = this.nicknameInput.trim();
    return name.length > 0 && name.length <= 64 && !this.nicknameBusy;
  }

  private async saveNickname(): Promise<void> {
    if (!this.nicknameCanSave()) {
      return;
    }
    this.nicknameBusy = true;
    this.nicknameError = '';
    try {
      this.account = await this.authApi.updateDisplayName(this.serverUrl(), this.token(), this.nicknameInput.trim());
      this.nicknameOpen = false;
      showToast($r('app.string.profile_updated'));
    } catch (error) {
      this.nicknameError = errorMessageFrom(error as Object);
    }
    this.nicknameBusy = false;
  }

  private cancelEmail(): void {
    if (this.emailBusy) {
      return;
    }
    this.emailOpen = false;
    this.emailError = '';
  }

  private emailCanSend(): boolean {
    return !this.emailBusy && this.emailInput.trim().length > 0;
  }

  private async sendEmailCode(): Promise<void> {
    const trimmed = this.emailInput.trim();
    const atIndex = trimmed.indexOf('@');
    if (trimmed.length === 0 || atIndex <= 0 || atIndex === trimmed.length - 1) {
      showToast($r('app.string.profile_email_invalid'));
      return;
    }
    const serverUrl = this.serverUrl();
    const accessToken = this.token();
    if (serverUrl.length === 0 || accessToken.length === 0) {
      return;
    }
    this.emailBusy = true;
    this.emailError = '';
    try {
      await this.authApi.sendEmailCode(serverUrl, accessToken, trimmed);
      this.pendingEmail = trimmed;
      this.emailOpen = false;
      this.codeInput = '';
      this.codeOpen = true;
      showToast($r('app.string.profile_email_code_sent'));
    } catch (error) {
      this.emailError = errorMessageFrom(error as Object);
    }
    this.emailBusy = false;
  }

  private cancelCode(): void {
    if (this.codeBusy) {
      return;
    }
    this.codeOpen = false;
    this.pendingEmail = '';
    this.codeError = '';
  }

  private codeCanSave(): boolean {
    return !this.codeBusy && this.codeInput.trim().length > 0;
  }

  private async saveEmailCode(): Promise<void> {
    const code = this.codeInput.trim();
    if (code.length === 0 || this.codeBusy) {
      return;
    }
    const serverUrl = this.serverUrl();
    const accessToken = this.token();
    if (serverUrl.length === 0 || accessToken.length === 0) {
      return;
    }
    this.codeBusy = true;
    this.codeError = '';
    try {
      this.account = await this.authApi.bindEmail(serverUrl, accessToken, this.pendingEmail, code);
      this.codeOpen = false;
      this.pendingEmail = '';
      showToast($r('app.string.profile_email_bound_msg'));
    } catch (error) {
      this.codeError = errorMessageFrom(error as Object);
    }
    this.codeBusy = false;
  }

  private cancelPassword(): void {
    if (this.passwordBusy) {
      return;
    }
    this.passwordOpen = false;
    this.passwordError = '';
  }

  private passwordCanSave(): boolean {
    return this.passwordInput.length >= 8 && this.passwordInput === this.confirmInput && !this.passwordBusy;
  }

  private async savePassword(): Promise<void> {
    if (!this.passwordCanSave()) {
      return;
    }
    this.passwordBusy = true;
    this.passwordError = '';
    try {
      await this.authApi.changePassword(this.serverUrl(), this.token(), this.passwordInput);
      this.passwordOpen = false;
      this.passwordInput = '';
      this.confirmInput = '';
      showToast($r('app.string.profile_password_updated_title'));
    } catch (error) {
      this.passwordError = errorMessageFrom(error as Object);
    }
    this.passwordBusy = false;
  }

  private signOutNow(): void {
    this.signOutOpen = false;
    try {
      this.authStore.clearAuthSession();
    } catch (error) {
    }
    notifyAuthSessionExpired();
  }

  @Builder
  drawerHeader(title: ResourceStr, onBack: () => void) {
    Row() {
      Button() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(20)
          .fontColor([getColors().ink])
      }
      .width(40)
      .height(40)
      .borderRadius(20)
      .padding(0)
      .backgroundColor(Color.Transparent)
      .onClick(() => {
        onBack();
      })
      Text(title)
        .fontSize(17)
        .fontWeight(600)
        .lineHeight(22)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Center)
        .layoutWeight(1)
      Column()
        .width(40)
        .height(40)
    }
    .width('100%')
    .height(64)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  settingIcon(symbol: Resource, tint: string) {
    Stack() {
      SymbolGlyph(symbol)
        .fontSize(22)
        .fontColor([tint])
    }
    .width(34)
    .height(34)
    .alignContent(Alignment.Center)
  }

  @Builder
  profileDivider(start: number, end: number) {
    Divider()
      .color(this.dividerColor())
      .margin({ left: start, right: end })
  }

  @Builder
  avatarView(size: number, fontSize: number) {
    Stack() {
      if (this.hasAvatar()) {
        Image(this.avatarUrl())
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
      } else {
        Text(this.initialChar())
          .fontSize(fontSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(Color.White)
      }
      if (this.avatarBusy) {
        Column() {
          LoadingProgress()
            .width(24)
            .height(24)
            .color(getColors().muted)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('rgba(0, 0, 0, 0.35)')
      }
    }
    .width(size)
    .height(size)
    .borderRadius(size / 2)
    .backgroundColor('#7857D8')
    .clip(true)
  }

  @Builder
  identityCard() {
    Row({ space: 11 }) {
      this.avatarView(42, 22)
      Column({ space: 1 }) {
        Text(this.identityTitle())
          .fontSize(17)
          .fontWeight(600)
          .lineHeight(21)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.serviceLabel())
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .lineHeight(16)
          .fontColor(getColors().muted)
          .maxLines(1)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([getColors().faint])
    }
    .width('100%')
    .height(72)
    .padding({ left: 12, right: 12 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
    .onClick(() => {
      this.closeAccountDialogs();
      this.detailPage = 'account';
    })
  }

  private closeAccountDialogs(): void {
    if (!this.nicknameBusy) {
      this.nicknameOpen = false;
    }
    if (!this.emailBusy) {
      this.emailOpen = false;
    }
    if (!this.codeBusy) {
      this.codeOpen = false;
    }
    if (!this.passwordBusy) {
      this.passwordOpen = false;
    }
  }

  @Builder
  appearanceTrailingLabel() {
    if (this.selectedAppearance === 'system') {
      Text($r('app.string.profile_follow_system'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    } else if (this.selectedAppearance === 'light') {
      Text($r('app.string.profile_light'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    } else {
      Text($r('app.string.profile_dark'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    }
  }

  @Builder
  appearanceCard() {
    Column() {
      Row({ space: 11 }) {
        this.settingIcon($r('sys.symbol.moon'), getColors().inkSoft)
        Text($r('app.string.profile_appearance'))
          .fontSize(16)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        this.appearanceTrailingLabel()
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(20)
          .fontColor([getColors().faint])
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 8 })
      .alignItems(VerticalAlign.Center)
      .id('profile_appearance_row')
      .onClick(() => {
        this.openAppearanceMenu();
      })
    }
    .width('100%')
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
  }

  @Builder
  appearanceOption(mode: AppAppearanceMode, label: ResourceStr, symbol: Resource) {
    Row({ space: 12 }) {
      SymbolGlyph(symbol)
        .fontSize(20)
        .fontColor([getColors().ink])
      Text(label)
        .fontSize(14)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (this.selectedAppearance === mode) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([getColors().ink])
      } else {
        Column()
          .width(18)
          .height(18)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.changeAppearance(mode);
      this.appearanceMenuOpen = false;
    })
  }

  @Builder
  appearanceMenuOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.appearanceMenuOpen = false;
        })
      Column() {
        this.appearanceOption('system', $r('app.string.profile_follow_system'), $r('sys.symbol.circle'))
        this.appearanceOption('light', $r('app.string.profile_light'), $r('sys.symbol.sun'))
        this.appearanceOption('dark', $r('app.string.profile_dark'), $r('sys.symbol.moon'))
      }
      .width(APPEARANCE_MENU_WIDTH)
      .constraintSize({ maxHeight: 328 })
      .borderRadius(18)
      .backgroundColor(this.themeIsDark ? getColors().subtle : getColors().raisedSurface)
      .border({ width: 1, color: this.themeIsDark ? Color.Transparent : getColors().border })
      .padding({ top: 8, bottom: 8 })
      .position({ x: this.appearanceMenuX(), y: this.appearanceMenuY() })
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      const width = newValue.width;
      if (typeof width === 'number') {
        this.menuOverlayWidth = width;
      }
    })
  }

  @Builder
  sidebarTrailingLabel() {
    if (this.sidebarViewMode === SIDEBAR_VIEW_SESSION) {
      Text($r('app.string.profile_session_view'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    } else {
      Text($r('app.string.profile_project_view'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    }
  }

  @Builder
  sidebarViewCard() {
    Column() {
      Row({ space: 11 }) {
        this.settingIcon($r('sys.symbol.list_bullet'), getColors().inkSoft)
        Text($r('app.string.profile_sidebar_display'))
          .fontSize(16)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        this.sidebarTrailingLabel()
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(20)
          .fontColor([getColors().faint])
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 8 })
      .alignItems(VerticalAlign.Center)
      .id('profile_sidebar_view_row')
      .onClick(() => {
        this.openSidebarMenu();
      })
    }
    .width('100%')
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
  }

  @Builder
  sidebarViewOption(mode: string, label: ResourceStr, symbol: Resource) {
    Row({ space: 12 }) {
      SymbolGlyph(symbol)
        .fontSize(20)
        .fontColor([getColors().ink])
      Text(label)
        .fontSize(14)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (this.sidebarViewMode === mode) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([getColors().ink])
      } else {
        Column()
          .width(18)
          .height(18)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.changeSidebarView(mode);
      this.sidebarMenuOpen = false;
    })
  }

  @Builder
  sidebarViewMenuOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.sidebarMenuOpen = false;
        })
      Column() {
        this.sidebarViewOption(SIDEBAR_VIEW_PROJECT, $r('app.string.profile_project_view'), $r('sys.symbol.folder'))
        this.sidebarViewOption(SIDEBAR_VIEW_SESSION, $r('app.string.profile_session_view'), $r('sys.symbol.list_bullet'))
      }
      .width(APPEARANCE_MENU_WIDTH)
      .constraintSize({ maxHeight: 328 })
      .borderRadius(18)
      .backgroundColor(this.themeIsDark ? getColors().subtle : getColors().raisedSurface)
      .border({ width: 1, color: this.themeIsDark ? Color.Transparent : getColors().border })
      .padding({ top: 8, bottom: 8 })
      .position({ x: this.sidebarMenuX(), y: this.sidebarMenuY() })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  languageTrailingLabel() {
    if (this.selectedLanguage === 'system') {
      Text($r('app.string.profile_language_system'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    } else if (this.selectedLanguage === 'en') {
      Text($r('app.string.profile_language_english'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    } else {
      Text($r('app.string.profile_language_chinese'))
        .fontSize(14)
        .fontWeight(600)
        .fontColor(getColors().muted)
        .maxLines(1)
    }
  }

  @Builder
  languageCard() {
    Row({ space: 11 }) {
      this.settingIcon($r('sys.symbol.character'), getColors().inkSoft)
      Text($r('app.string.profile_language'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      this.languageTrailingLabel()
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([getColors().faint])
    }
    .width('100%')
    .height(56)
    .padding({ left: 12, right: 8 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
    .onClick(() => {
      this.detailPage = 'language';
    })
  }

  @Builder
  versionCard() {
    Column() {
      Row({ space: 11 }) {
        this.settingIcon($r('sys.symbol.square_stack_3d'), getColors().inkSoft)
        Text($r('app.string.profile_version'))
          .fontSize(16)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.appVersionLabel)
          .fontSize(14)
          .fontWeight(600)
          .fontColor(getColors().muted)
          .maxLines(1)
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 8 })
      .alignItems(VerticalAlign.Center)
      this.profileDivider(57, 12)
      Row({ space: 11 }) {
        this.settingIcon($r('sys.symbol.desktop'), getColors().inkSoft)
        Text($r('app.string.profile_check_updates'))
          .fontSize(16)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.updateAvailable) {
          Stack({ alignContent: Alignment.TopEnd }) {
            SymbolGlyph($r('sys.symbol.download'))
              .fontSize(20)
              .fontColor([getColors().faint])
            Circle({ width: 5, height: 5 })
              .fill(getColors().errorText)
              .offset({ x: -1, y: 1 })
          }
          .width(24)
          .height(24)
          .accessibilityText($r('app.string.update_new_version_badge'))
        } else {
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(20)
            .fontColor([getColors().faint])
        }
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 8 })
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onCheckUpdatesClicked();
      })
    }
    .width('100%')
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
  }

  @Builder
  archivedCard() {
    Row({ space: 11 }) {
      this.settingIcon($r('sys.symbol.archivebox'), getColors().inkSoft)
      Text($r('app.string.profile_archived_sessions'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(20)
        .fontColor([getColors().faint])
    }
    .width('100%')
    .height(56)
    .padding({ left: 12, right: 8 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
    .onClick(() => {
      this.onOpenArchivedSessions();
    })
  }

  @Builder
  signOutCard() {
    Row({ space: 11 }) {
      this.settingIcon($r('sys.symbol.power'), getColors().errorText)
      Text($r('app.string.profile_sign_out'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().errorText)
        .maxLines(1)
        .layoutWeight(1)
    }
    .width('100%')
    .height(56)
    .padding({ left: 12, right: 12 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
    .onClick(() => {
      this.signOutOpen = true;
    })
  }

  @Builder
  accountInfoRow(label: ResourceStr, value: ResourceStr) {
    Row() {
      Text(label)
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().ink)
        .maxLines(1)
        .layoutWeight(1)
      Text(value)
        .fontSize(15)
        .fontWeight(600)
        .lineHeight(19)
        .fontColor(getColors().muted)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 14 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  accountActionRow(symbol: Resource, label: ResourceStr, tint: string, onClick: () => void) {
    Row({ space: 11 }) {
      this.settingIcon(symbol, tint)
      Text(label)
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(tint)
        .maxLines(1)
        .layoutWeight(1)
    }
    .width('100%')
    .height(56)
    .padding({ left: 12, right: 16 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      onClick();
    })
  }

  @Builder
  accountDetail() {
    Column() {
      Column() {
        this.avatarView(86, 45)
      }
      .onClick(() => {
        this.changeAvatar();
      })
      Text(this.avatarBusy ? $r('app.string.profile_avatar_updating') : $r('app.string.profile_avatar_change'))
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().muted)
        .maxLines(1)
        .margin({ top: 15 })
        .onClick(() => {
          this.changeAvatar();
        })
      Column() {
        this.accountInfoRow($r('app.string.profile_nickname'), this.nicknameValue())
        this.profileDivider(12, 12)
        this.accountInfoRow($r('app.string.profile_email'), this.emailValue())
        this.profileDivider(12, 12)
        this.accountInfoRow($r('app.string.profile_role'), this.roleValue())
      }
      .width('100%')
      .margin({ top: 28 })
      .borderRadius(15)
      .backgroundColor(this.cardBg())
      .border({ width: 0.8, color: this.cardBorder() })
      Column() {
        this.accountActionRow($r('sys.symbol.pencil_line'), $r('app.string.profile_edit_nickname'), getColors().ink, (): void => {
          this.nicknameInput = this.account === null ? '' : this.account.displayName;
          this.nicknameError = '';
          this.nicknameOpen = true;
        })
        this.profileDivider(12, 12)
        this.accountActionRow($r('sys.symbol.envelope'), $r('app.string.profile_bind_email'), getColors().ink, (): void => {
          this.emailInput = this.account === null || this.account.email === null ? '' : this.account.email;
          this.emailError = '';
          this.emailOpen = true;
        })
        this.profileDivider(12, 12)
        this.accountActionRow($r('sys.symbol.key'), $r('app.string.profile_change_password'), getColors().ink, (): void => {
          this.passwordInput = '';
          this.confirmInput = '';
          this.passwordError = '';
          this.passwordOpen = true;
        })
      }
      .width('100%')
      .margin({ top: 24 })
      .borderRadius(15)
      .backgroundColor(this.cardBg())
      .border({ width: 0.8, color: this.cardBorder() })
      Row({ space: 11 }) {
        this.settingIcon($r('sys.symbol.power'), getColors().errorText)
        Text($r('app.string.profile_sign_out'))
          .fontSize(16)
          .fontWeight(600)
          .lineHeight(20)
          .fontColor(getColors().errorText)
          .maxLines(1)
          .layoutWeight(1)
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 12 })
      .alignItems(VerticalAlign.Center)
      .margin({ top: 18 })
      .borderRadius(15)
      .backgroundColor(this.cardBg())
      .border({ width: 0.8, color: this.cardBorder() })
      .onClick(() => {
        this.signOutOpen = true;
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  languageOptionRow(mode: AppLanguageMode, label: ResourceStr) {
    Row() {
      Text(label)
        .fontSize(16)
        .fontWeight(600)
        .lineHeight(20)
        .fontColor(getColors().ink)
        .maxLines(1)
        .layoutWeight(1)
      if (this.selectedLanguage === mode) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(20)
          .fontColor([getColors().ink])
      }
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.changeLanguage(mode);
    })
  }

  @Builder
  languageDetail() {
    Column() {
      this.languageOptionRow('system', $r('app.string.profile_language_system'))
      this.profileDivider(12, 12)
      this.languageOptionRow('en', $r('app.string.profile_language_english'))
      this.profileDivider(12, 12)
      this.languageOptionRow('zh_CN', $r('app.string.profile_language_chinese'))
    }
    .width('100%')
    .borderRadius(15)
    .backgroundColor(this.cardBg())
    .border({ width: 0.8, color: this.cardBorder() })
  }

  @Builder
  updatesDetail() {
    if (this.updateAvailable) {
      Column({ space: 14 }) {
        Text($r('app.string.update_available_title'))
          .fontSize(18)
          .fontWeight(600)
          .lineHeight(22)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.update_available_message', this.updateVersionName))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .lineHeight(20)
          .fontColor(getColors().muted)
          .width('100%')
        Button($r('app.string.update_now'))
          .fontSize(15)
          .fontWeight(600)
          .height(50)
          .borderRadius(16)
          .width('100%')
          .fontColor(getColors().onPrimaryAction)
          .backgroundColor(getColors().primaryAction)
          .onClick(() => {
            this.updatePromptVisible = true;
          })
      }
      .width('100%')
      .padding(18)
      .borderRadius(15)
      .backgroundColor(this.cardBg())
      .border({ width: 0.8, color: this.cardBorder() })
    } else {
      Column() {
        if (this.updateChecking) {
          LoadingProgress()
            .width(24)
            .height(24)
            .color(getColors().muted)
        } else if (this.updateFailed) {
          Text($r('app.string.update_check_failed'))
            .fontSize(16)
            .fontWeight(600)
            .lineHeight(21)
            .fontColor(getColors().muted)
            .textAlign(TextAlign.Center)
          Button($r('app.string.common_retry'))
            .fontSize(15)
            .fontWeight(600)
            .height(50)
            .borderRadius(16)
            .padding({ left: 24, right: 24 })
            .margin({ top: 16 })
            .fontColor(getColors().ink)
            .backgroundColor(getColors().secondaryActionSurface)
            .onClick(() => {
              this.checkForUpdates();
            })
        } else {
          Text($r('app.string.update_up_to_date'))
            .fontSize(16)
            .fontWeight(600)
            .lineHeight(21)
            .fontColor(getColors().muted)
            .textAlign(TextAlign.Center)
        }
      }
      .width('100%')
      .constraintSize({ minHeight: 260 })
      .justifyContent(FlexAlign.Center)
    }
  }

  @Builder
  dialogScrim(onCancel: () => void) {
    Column()
      .width('100%')
      .height('100%')
      .backgroundColor('rgba(0,0,0,0.45)')
      .onClick(() => {
        onCancel();
      })
  }

  @Builder
  dialogCancelButton(onCancel: () => void) {
    Button($r('app.string.common_cancel'))
      .fontSize(15)
      .fontWeight(600)
      .height(50)
      .borderRadius(16)
      .layoutWeight(1)
      .fontColor(getColors().ink)
      .backgroundColor(getColors().secondaryActionSurface)
      .onClick(() => {
        onCancel();
      })
  }

  @Builder
  dialogPrimaryButton(label: ResourceStr, enabled: boolean, onClick: () => void) {
    Button(label)
      .fontSize(15)
      .fontWeight(600)
      .height(50)
      .borderRadius(16)
      .layoutWeight(1)
      .fontColor(getColors().onPrimaryAction)
      .backgroundColor(getColors().primaryAction)
      .opacity(this.primaryButtonOpacity(enabled))
      .enabled(enabled)
      .onClick(() => {
        onClick();
      })
  }

  private primaryButtonOpacity(enabled: boolean): number {
    return enabled ? 1 : 0.5;
  }

  @Builder
  dialogHint(message: string) {
    Text(message)
      .fontSize(12.5)
      .fontWeight(600)
      .fontColor(getColors().errorText)
      .width('100%')
  }

  @Builder
  nicknameDialog() {
    Stack() {
      this.dialogScrim((): void => {
        this.cancelNickname();
      })
      Column({ space: 16 }) {
        Text($r('app.string.profile_edit_nickname'))
          .fontSize(22)
          .fontWeight(800)
          .lineHeight(28)
          .fontColor(getColors().ink)
          .width('100%')
        TextInput({ text: this.nicknameInput, placeholder: $r('app.string.profile_nickname') })
          .fontSize(15)
          .height(50)
          .width('100%')
          .borderRadius(12)
          .backgroundColor(getColors().subtle)
          .border({ width: 1, color: getColors().border })
          .fontColor(getColors().ink)
          .placeholderColor(getColors().faint)
          .enabled(!this.nicknameBusy)
          .onChange((value: string) => {
            this.nicknameInput = value;
            this.nicknameError = '';
          })
        if (this.nicknameError.length > 0) {
          this.dialogHint(this.nicknameError)
        }
        Row({ space: 10 }) {
          this.dialogCancelButton((): void => {
            this.cancelNickname();
          })
          this.dialogPrimaryButton(this.saveButtonLabel(), this.nicknameCanSave(), (): void => {
            this.saveNickname();
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(22)
      .margin({ left: 22, right: 22 })
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }

  private saveButtonLabel(): ResourceStr {
    if (this.nicknameBusy || this.emailBusy || this.codeBusy || this.passwordBusy) {
      return $r('app.string.common_saving');
    }
    return $r('app.string.common_save');
  }

  @Builder
  emailDialog() {
    Stack() {
      this.dialogScrim((): void => {
        this.cancelEmail();
      })
      Column({ space: 16 }) {
        Text($r('app.string.profile_bind_email'))
          .fontSize(22)
          .fontWeight(800)
          .lineHeight(28)
          .fontColor(getColors().ink)
          .width('100%')
        TextInput({ text: this.emailInput, placeholder: $r('app.string.profile_email_placeholder') })
          .fontSize(15)
          .height(50)
          .width('100%')
          .borderRadius(12)
          .backgroundColor(getColors().subtle)
          .border({ width: 1, color: getColors().border })
          .fontColor(getColors().ink)
          .placeholderColor(getColors().faint)
          .enabled(!this.emailBusy)
          .onChange((value: string) => {
            this.emailInput = value;
            this.emailError = '';
          })
        if (this.emailError.length > 0) {
          this.dialogHint(this.emailError)
        }
        Row({ space: 10 }) {
          this.dialogCancelButton((): void => {
            this.cancelEmail();
          })
          this.dialogPrimaryButton($r('app.string.profile_send'), this.emailCanSend(), (): void => {
            this.sendEmailCode();
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(22)
      .margin({ left: 22, right: 22 })
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  codeDialog() {
    Stack() {
      this.dialogScrim((): void => {
        this.cancelCode();
      })
      Column({ space: 16 }) {
        Text($r('app.string.profile_email_code_placeholder'))
          .fontSize(22)
          .fontWeight(800)
          .lineHeight(28)
          .fontColor(getColors().ink)
          .width('100%')
        Text(this.pendingEmail)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .lineHeight(19)
          .fontColor(getColors().muted)
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        TextInput({ text: this.codeInput, placeholder: $r('app.string.profile_email_code_placeholder') })
          .type(InputType.Number)
          .fontSize(15)
          .height(50)
          .width('100%')
          .borderRadius(12)
          .backgroundColor(getColors().subtle)
          .border({ width: 1, color: getColors().border })
          .fontColor(getColors().ink)
          .placeholderColor(getColors().faint)
          .enabled(!this.codeBusy)
          .onChange((value: string) => {
            this.codeInput = value;
            this.codeError = '';
          })
        if (this.codeError.length > 0) {
          this.dialogHint(this.codeError)
        }
        Row({ space: 10 }) {
          this.dialogCancelButton((): void => {
            this.cancelCode();
          })
          this.dialogPrimaryButton($r('app.string.common_save'), this.codeCanSave(), (): void => {
            this.saveEmailCode();
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(22)
      .margin({ left: 22, right: 22 })
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  passwordDialog() {
    Stack() {
      this.dialogScrim((): void => {
        this.cancelPassword();
      })
      Column({ space: 16 }) {
        Text($r('app.string.profile_change_password'))
          .fontSize(22)
          .fontWeight(800)
          .lineHeight(28)
          .fontColor(getColors().ink)
          .width('100%')
        TextInput({ text: this.passwordInput, placeholder: $r('app.string.profile_new_password_placeholder') })
          .type(InputType.Password)
          .fontSize(15)
          .height(50)
          .width('100%')
          .borderRadius(12)
          .backgroundColor(getColors().subtle)
          .border({ width: 1, color: getColors().border })
          .fontColor(getColors().ink)
          .placeholderColor(getColors().faint)
          .enabled(!this.passwordBusy)
          .onChange((value: string) => {
            this.passwordInput = value;
            this.passwordError = '';
          })
        TextInput({ text: this.confirmInput, placeholder: $r('app.string.profile_confirm_password') })
          .type(InputType.Password)
          .fontSize(15)
          .height(50)
          .width('100%')
          .borderRadius(12)
          .backgroundColor(getColors().subtle)
          .border({ width: 1, color: getColors().border })
          .fontColor(getColors().ink)
          .placeholderColor(getColors().faint)
          .enabled(!this.passwordBusy)
          .onChange((value: string) => {
            this.confirmInput = value;
            this.passwordError = '';
          })
        if (this.passwordInput.length > 0 && this.passwordInput.length < 8) {
          this.dialogHint(this.passwordMinLengthText())
        } else if (this.confirmInput.length > 0 && this.passwordInput !== this.confirmInput) {
          this.dialogHint(this.passwordNoMatchText())
        }
        if (this.passwordError.length > 0) {
          this.dialogHint(this.passwordError)
        }
        Row({ space: 10 }) {
          this.dialogCancelButton((): void => {
            this.cancelPassword();
          })
          this.dialogPrimaryButton(this.saveButtonLabel(), this.passwordCanSave(), (): void => {
            this.savePassword();
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(22)
      .margin({ left: 22, right: 22 })
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }

  private passwordMinLengthText(): string {
    try {
      const context = this.getUIContext().getHostContext();
      if (context !== undefined) {
        return context.resourceManager.getStringSync($r('app.string.profile_password_min_length'));
      }
    } catch (error) {
    }
    return 'Use at least 8 characters.';
  }

  private passwordNoMatchText(): string {
    try {
      const context = this.getUIContext().getHostContext();
      if (context !== undefined) {
        return context.resourceManager.getStringSync($r('app.string.auth_passwords_do_not_match'));
      }
    } catch (error) {
    }
    return 'Passwords do not match.';
  }

  @Builder
  signOutDialog() {
    Stack() {
      this.dialogScrim((): void => {
        this.signOutOpen = false;
      })
      Column({ space: 16 }) {
        Text($r('app.string.profile_sign_out_title'))
          .fontSize(22)
          .fontWeight(800)
          .lineHeight(28)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.profile_sign_out_msg'))
          .fontSize(14)
          .lineHeight(19)
          .fontColor(getColors().muted)
          .width('100%')
        Row({ space: 10 }) {
          this.dialogCancelButton((): void => {
            this.signOutOpen = false;
          })
          this.dialogPrimaryButton($r('app.string.profile_sign_out'), true, (): void => {
            this.signOutNow();
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(22)
      .margin({ left: 22, right: 22 })
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Stack() {
      Column() {
        Scroll() {
          Column({ space: 10 }) {
            if (this.detailPage === 'none') {
              this.drawerHeader($r('app.string.profile_settings'), (): void => {
                this.onClose();
              })
              this.identityCard()
              this.appearanceCard()
              this.languageCard()
              this.sidebarViewCard()
              this.versionCard()
              this.archivedCard()
              this.signOutCard()
            } else if (this.detailPage === 'account') {
              this.drawerHeader($r('app.string.profile_account'), (): void => {
                this.closeAccountDialogs();
                this.detailPage = 'none';
              })
              this.accountDetail()
            } else if (this.detailPage === 'language') {
              this.drawerHeader($r('app.string.profile_language'), (): void => {
                this.detailPage = 'none';
              })
              this.languageDetail()
            } else {
              this.drawerHeader($r('app.string.profile_updates'), (): void => {
                this.detailPage = 'none';
              })
              this.updatesDetail()
            }
          }
          .width('100%')
          .padding({ left: 18, right: 18, bottom: 28 })
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.pageBg())
      .id('profile_drawer_root')
      if (this.appearanceMenuOpen) {
        this.appearanceMenuOverlay()
      }
      if (this.sidebarMenuOpen) {
        this.sidebarViewMenuOverlay()
      }
      if (this.detailPage === 'account' && this.nicknameOpen) {
        this.nicknameDialog()
      }
      if (this.detailPage === 'account' && this.emailOpen) {
        this.emailDialog()
      }
      if (this.detailPage === 'account' && this.codeOpen) {
        this.codeDialog()
      }
      if (this.detailPage === 'account' && this.passwordOpen) {
        this.passwordDialog()
      }
      if (this.signOutOpen) {
        this.signOutDialog()
      }
      if (this.updatePromptVisible) {
        AppUpdatePromptOverlay({
          versionName: this.updateVersionName,
          onDownload: (): void => {
            this.downloadUpdate();
          },
          onIgnore: (): void => {
            this.ignoreUpdate();
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .transition(TransitionEffect.move(TransitionEdge.START).animation({ duration: 240, curve: Curve.EaseOut }))
  }
}
