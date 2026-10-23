import { bundleManager, common, OpenLinkOptions } from '@kit.AbilityKit';
import { AnnouncementsApi, PublicAnnouncement } from 'network';
import { AppUpdatesApi, compareUpdateVersions } from 'network';
import { SharedApiClient } from 'session';
import { AnnouncementReadStore } from 'session';
import { AppUpdateIgnoreStore } from 'session';
import { AuthSessionStore } from 'session';
import { MdBlock, parseMarkdownBlocks } from 'common';
import { AppConfig } from 'common';
import { AnnouncementGateOverlay } from '../components/AnnouncementGateOverlay';
import { AppUpdatePromptOverlay } from 'session';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';
import { HomePage } from 'session';
import { LoginPage } from 'session';

@Entry
@Component
struct Index {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State ready: boolean = false;
  @State signedIn: boolean = false;
  @State announcementVisible: boolean = false;
  @State updateVisible: boolean = false;
  @State updateVersionName: string = '';
  // Keep in sync with the key in api/SharedApiClient.ets.
  @StorageLink('authSessionExpiredTick') @Watch('onAuthSessionExpired') authExpiredTick: number = 0;
  private pathStack: NavPathStack = new NavPathStack();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private announcementsApi: AnnouncementsApi =
    new AnnouncementsApi(SharedApiClient.getInstance());
  private updatesApi: AppUpdatesApi = new AppUpdatesApi(SharedApiClient.getInstance());
  private announcementReadStore: AnnouncementReadStore = AnnouncementReadStore.getInstance();
  private updateIgnoreStore: AppUpdateIgnoreStore = AppUpdateIgnoreStore.getInstance();
  private announcementBlocks: MdBlock[] = [];
  private announcementMarkdown: string = '';
  private announcementPublishedAt: string = '';
  private announcementReady: boolean = false;
  private updateChecking: boolean = false;
  private updateDownloadUrl: string = '';

  aboutToAppear(): void {
    try {
      this.getUIContext().getFont().registerFont({
        familyName: 'Caveat',
        familySrc: $rawfile('caveat_wght.ttf')
      });
    } catch (err) {
      console.warn(`Failed to register Caveat font: ${JSON.stringify(err)}`);
    }
    this.waitUntilReady();
  }

  private async waitUntilReady(): Promise<void> {
    await this.authStore.waitUntilReady();
    try {
      this.signedIn = this.authStore.hasAuthSession();
    } catch (error) {
      this.signedIn = false;
    }
    this.ready = true;
    // Mirrors Android AgentsAnywhereApp: the announcement gate runs on both
    // the login page and inside the app (server url falls back to the official
    // server when signed out), while update checks require an auth session.
    this.loadAnnouncement();
    if (this.signedIn) {
      this.checkForUpdates();
    }
  }

  private onAuthSessionExpired(): void {
    if (!this.signedIn) {
      return;
    }
    this.pathStack.clear();
    this.signedIn = false;
    this.resetUpdateState();
  }

  private resetUpdateState(): void {
    this.updateVisible = false;
    this.updateVersionName = '';
    this.updateDownloadUrl = '';
  }

  private announcementServerUrl(): string {
    const stored = this.authStore.readServerUrl();
    return stored.length > 0 ? stored : AppConfig.OFFICIAL_SERVER_URL;
  }

  private async loadAnnouncement(): Promise<void> {
    const serverUrl = this.announcementServerUrl();
    if (serverUrl.length === 0) {
      return;
    }
    try {
      const announcement = await this.announcementsApi.current(serverUrl);
      if (announcement === null) {
        return;
      }
      if (!this.announcementReadStore.isUnread(serverUrl, announcement)) {
        return;
      }
      this.announcementMarkdown = announcement.markdown;
      this.announcementPublishedAt = announcement.publishedAt;
      this.announcementBlocks = parseMarkdownBlocks(announcement.markdown);
      this.announcementReady = true;
      this.refreshAnnouncementVisibility();
    } catch (error) {
    }
  }

  private refreshAnnouncementVisibility(): void {
    this.announcementVisible = this.announcementReady && !this.updateChecking && !this.updateVisible;
  }

  private closeAnnouncement(): void {
    this.announcementVisible = false;
    this.announcementReady = false;
    const serverUrl = this.announcementServerUrl();
    const announcement: PublicAnnouncement = {
      markdown: this.announcementMarkdown,
      publishedAt: this.announcementPublishedAt
    };
    try {
      this.announcementReadStore.markRead(serverUrl, announcement);
    } catch (error) {
    }
  }

  private currentVersionName(): string {
    try {
      const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionName;
    } catch (error) {
      return '';
    }
  }

  private async checkForUpdates(): Promise<void> {
    const serverUrl = this.authStore.readServerUrl();
    const accessToken = this.authStore.readAccessToken();
    if (serverUrl.length === 0 || accessToken.length === 0) {
      return;
    }
    const current = this.currentVersionName();
    if (current.length === 0) {
      return;
    }
    this.updateChecking = true;
    this.refreshAnnouncementVisibility();
    try {
      const release = await this.updatesApi.check(serverUrl, current);
      this.updateChecking = false;
      if (release !== null) {
        const ignored = this.updateIgnoreStore.readIgnoredVersion(serverUrl);
        if (ignored.length === 0 || compareUpdateVersions(ignored, release.versionName) !== 0) {
          this.updateVersionName = release.versionName;
          this.updateDownloadUrl = release.downloadUrl;
          this.updateVisible = true;
        }
      }
      this.refreshAnnouncementVisibility();
    } catch (error) {
      this.updateChecking = false;
      this.refreshAnnouncementVisibility();
    }
  }

  private ignoreUpdate(): void {
    try {
      this.updateIgnoreStore.saveIgnoredVersion(this.authStore.readServerUrl(), this.updateVersionName);
    } catch (error) {
    }
    this.updateVisible = false;
    this.refreshAnnouncementVisibility();
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

  onBackPress(): boolean {
    if (!this.ready || !this.signedIn) {
      return false;
    }
    const detailPage = AppStorage.get<string>('profileDrawerDetailPage') ?? '';
    if (detailPage.length > 0 && detailPage !== 'none') {
      AppStorage.setOrCreate('profileDrawerDetailPage', 'none');
      return true;
    }
    const drawerOpen = AppStorage.get<boolean>('profileDrawerOpen') ?? false;
    if (drawerOpen) {
      AppStorage.setOrCreate('profileDrawerOpen', false);
      return true;
    }
    return false;
  }

  build() {
    Stack() {
      Column() {
        if (!this.ready) {
          LoadingProgress()
            .width(44)
            .height(44)
        } else if (this.signedIn) {
          Navigation(this.pathStack) {
            HomePage({
              pathStack: this.pathStack,
              onSignedOut: () => {
                this.pathStack.clear();
                this.signedIn = false;
                this.resetUpdateState();
              }
            })
          }
          .mode(NavigationMode.Stack)
          .hideTitleBar(true)
          .width('100%')
          .layoutWeight(1)
        } else {
          LoginPage({ onSignedIn: () => {
            this.signedIn = true;
            this.loadAnnouncement();
            this.checkForUpdates();
          } })
        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      if (this.announcementVisible) {
        AnnouncementGateOverlay({
          blocks: this.announcementBlocks,
          onClose: (): void => {
            this.closeAnnouncement();
          }
        })
      }
      if (this.updateVisible) {
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
    .backgroundColor(getColors().canvas)
  }
}
