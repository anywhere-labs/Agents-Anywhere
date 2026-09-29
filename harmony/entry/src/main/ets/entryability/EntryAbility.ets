import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { AALog } from '../common/AAAppLog';
import { installResourceManager } from '../common/AAResources';
import { AAPreferences } from '../storage/AAPreferences';

/**
 * Entry ability.
 *
 * Responsibilities, mirroring `MainActivity` on Android:
 *  - open the preference stores before any screen composes,
 *  - capture the OAuth deep-link URI and publish it for the sign-in flow,
 *  - publish the system colour scheme and status-bar inset used by the theme,
 *  - draw under the system bars so the app canvas fills the window.
 *
 * The deep link is declared in `module.json5` for
 * `agents-anywhere://oauth/callback`, which is byte-identical to the Android
 * intent filter and the iOS/desktop registered redirect.
 *
 * Brand fonts are registered by the composition root instead of here: the
 * current API is `UIContext.getFont().registerFont`, which needs a UI context
 * and is therefore unavailable in an ability.
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    AAPreferences.initialize(this.context);
    // Resource strings that have to become plain strings are resolved through
    // this manager; a plain function cannot reach a `getUIContext()`.
    installResourceManager(this.context.resourceManager);
    this.publishSystemColorMode();
    this.publishDeepLink(want);
    AALog.info('EntryAbility onCreate');
  }

  onDestroy(): void {
    AALog.info('EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        AALog.error(`Failed to load the content: ${JSON.stringify(error)}`);
        return;
      }
      this.configureWindow(windowStage);
    });
  }

  onWindowStageDestroy(): void {
    AALog.info('EntryAbility onWindowStageDestroy');
  }

  onForeground(): void {
    AALog.info('EntryAbility onForeground');
  }

  onBackground(): void {
    AALog.info('EntryAbility onBackground');
  }

  /**
   * A warm launch with the app already running delivers the OAuth redirect here
   * rather than to `onCreate`, so the URI is republished for the sign-in flow.
   */
  onNewIntent(want: Want): void {
    this.publishDeepLink(want);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.publishSystemColorMode();
  }

  /**
   * Routes the system back gesture into the app's own navigation.
   *
   * Android has no back stack either: its screens rely on the platform back
   * event and each handles it itself. The shell publishes whether the current
   * destination has somewhere to go back to, and this ability only consumes the
   * event when it does — otherwise `false` lets the system background the app,
   * which is what Android does on a root screen.
   */
  onBackPressed(): boolean {
    if (AppStorage.get<boolean>('canNavigateBack') !== true) {
      return false;
    }
    const requests: number = AppStorage.get<number>('backRequest') ?? 0;
    AppStorage.setOrCreate('backRequest', requests + 1);
    return true;
  }

  /**
   * Draws under the system bars so the app canvas fills the window the way
   * Android's edge-to-edge layout does, then publishes the top inset for the
   * shell to pad against.
   *
   * The inset is published in **vp**, because every consumer is a layout length
   * and ArkUI reads a bare number as vp. `getWindowAvoidArea` reports px, so the
   * rectangle is divided by the screen density here: publishing it raw made the
   * shell pad ~3.5x too far down (a 39 vp status bar read as 137 vp), which
   * pushed every screen — and with it the auth screens' back pill — far below
   * where Android's `WindowInsets.statusBars` puts it.
   */
  private configureWindow(windowStage: window.WindowStage): void {
    try {
      const mainWindow: window.Window = windowStage.getMainWindowSync();
      mainWindow.setWindowLayoutFullScreen(true);
      mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        navigationBarColor: '#00000000',
      });
      const avoidArea: window.AvoidArea =
        mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const density: number = display.getDefaultDisplaySync().densityPixels;
      AppStorage.setOrCreate('statusBarHeight', avoidArea.topRect.height / density);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : 'unknown';
      AALog.warn(`Window configuration failed, falling back to system insets: ${message}`);
      AppStorage.setOrCreate('statusBarHeight', 0);
    }
  }

  private publishSystemColorMode(): void {
    const dark: boolean = this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    AppStorage.setOrCreate('systemDarkMode', dark);
  }

  private publishDeepLink(want: Want): void {
    const uri: string = want.uri ?? '';
    if (uri.length > 0) {
      AALog.info(`Deep link received: ${uri}`);
    }
    AppStorage.setOrCreate('oauthCallbackUri', uri);
  }
}
