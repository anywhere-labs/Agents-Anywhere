import { bundleManager } from '@kit.AbilityKit';
import { normalizeServerOrigin } from '../api/ServerOrigin';
import { AALog } from '../common/AAAppLog';

/**
 * Build-time and fixed client configuration.
 *
 * Port of `config/AppConfig.kt` and the `BuildConfig` fields the Android client
 * reads from `app/build.gradle.kts`.
 *
 * The default service is the same Cloud origin Android ships, so a fresh install
 * on either platform lands on the same account.
 */
export class AppConfig {
  /** Cloud service address. A self-hosted address is entered in the sign-in flow. */
  static readonly OFFICIAL_SERVER_URL: string = 'https://web.agents-anywhere.com';
  /** Where the "add a device" wizard sends the user to install the desktop app. */
  static readonly DESKTOP_DOWNLOAD_URL: string = 'https://agents-anywhere.com/download';
  /**
   * In-app update package address.
   *
   * Kept as an explicit `.invalid` placeholder, exactly like the Android client
   * ships, so the update check and prompt can be exercised end to end while the
   * download step reports that no package is available yet. HarmonyOS has no
   * APK installer, so the install step is a Phase 5 decision.
   */
  static readonly UPDATE_DOWNLOAD_URL: string = 'https://downloads.example.invalid/agents-anywhere.hap';

  /** Client version reported against `/health`. */
  static readonly CLIENT_VERSION_NAME: string = '2.0.0';

  private static debugBuildCache: boolean | null = null;

  /**
   * Whether this is a debug build.
   *
   * Android gates the local-stack convenience (redirecting a `:8000` API origin
   * to the `:5174` web login host) on `BuildConfig.DEBUG`. The equivalent here is
   * `appInfo.debug`, so a release build never rewrites a user's address.
   */
  static isDebugBuild(): boolean {
    if (AppConfig.debugBuildCache !== null) {
      return AppConfig.debugBuildCache;
    }
    let debug: boolean = false;
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION,
      );
      debug = info.appInfo.debug;
    } catch (error) {
      const message: string = error instanceof Error ? error.message : 'unknown';
      AALog.warn(`Could not read the debug flag, assuming release: ${message}`);
    }
    AppConfig.debugBuildCache = debug;
    return debug;
  }

  /**
   * True when the stored address is the official Cloud service, which the
   * settings drawer surfaces as "Official Service" versus "Self-host Service".
   * An unparseable official address yields false, matching Android.
   */
  static isOfficialServer(serverUrl: string): boolean {
    const official: string | null = normalizeServerOrigin(AppConfig.OFFICIAL_SERVER_URL);
    if (official === null) {
      return false;
    }
    return normalizeServerOrigin(serverUrl) === official;
  }
}
