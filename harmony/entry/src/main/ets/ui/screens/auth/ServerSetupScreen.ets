import { webview } from '@kit.ArkWeb';
import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize } from '../../designsystem/AAMetrics';
import { AuthErrorNotice } from '../../designsystem/AAComponents';
import {
  AAIosGlassButton, AAIosPrimaryButton, AAIosPage, AAIosField,
} from '../../designsystem/AAIosChrome';
import { AuthController } from '../../../feature/auth/AuthController';
import { WebLoginSession, WebLoginState } from '../../../feature/auth/WebLoginModels';
import { AppConfig } from '../../../config/AppConfig';
import { AALog } from '../../../common/AAAppLog';

/**
 * Server setup, which is also the web sign-in host.
 *
 * Port of `WebLoginHostScreen` in
 * `android/app/src/main/java/com/agentsanywhere/app/ui/screens/auth/WebLoginScreen.kt`.
 *
 * One screen, two mutually exclusive pages driven by `WebLoginState`: a host
 * choice page, then the embedded browser once a PKCE session exists. The state
 * machine is `HostChoice -> WebLogin -> Exchanging -> Success`, and every failure
 * returns to `HostChoice` with the message kept.
 */
@Component
export struct ServerSetupScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  controller: AuthController | null = null;
  onBack: () => void = () => {};
  onSignedIn: () => void = () => {};

  @State private state: WebLoginState = WebLoginState.HostChoice;
  @State private serverUrl: string = '';
  @State private selfHostExpanded: boolean = false;
  @State private openingOfficial: boolean = false;
  @State private checkingSelfHost: boolean = false;
  @State private errorMessage: string = '';
  @State private session: WebLoginSession | null = null;
  /**
   * Published by `EntryAbility` when the OS hands the redirect to the ability,
   * which is the external-browser case. The embedded page does not use this
   * slot: its redirect goes straight to `handleCallback`, exactly as
   * `EmbeddedWebLogin` wires `onCallback = viewModel::handleCallback` on Android.
   */
  @StorageProp('oauthCallbackUri') @Watch('onCallbackUriChanged') private callbackUri: string = '';

  aboutToAppear(): void {
    const saved: string = this.controller?.savedServerUrl() ?? '';
    if (saved.length > 0) {
      this.serverUrl = saved;
    }
    // A redirect that arrived before this screen existed cannot be matched to a
    // session: the PKCE verifier lives in memory only, so a cold launch
    // invalidates the attempt. Android drops the URI in that situation too,
    // because `onOAuthCallbackConsumed` runs whether or not it was usable.
    if (this.callbackUri.length > 0) {
      AppStorage.setOrCreate('oauthCallbackUri', '');
    }
  }

  private isBusy(): boolean {
    return this.openingOfficial || this.checkingSelfHost;
  }

  private officialServiceAvailable(): boolean {
    return AppConfig.OFFICIAL_SERVER_URL.length > 0;
  }

  /** Starts sign-in against a given address, moving to the web page on success. */
  private async startLogin(address: string): Promise<void> {
    const auth: AuthController | null = this.controller;
    if (auth === null) {
      return;
    }
    this.errorMessage = '';
    try {
      const created: WebLoginSession = await auth.startWebLogin(address);
      this.session = created;
      this.state = WebLoginState.WebLogin;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Could not reach the server.';
      this.state = WebLoginState.HostChoice;
    } finally {
      this.openingOfficial = false;
      this.checkingSelfHost = false;
    }
  }

  private startOfficialLogin(): void {
    this.openingOfficial = true;
    void this.startLogin(AppConfig.OFFICIAL_SERVER_URL);
  }

  private startSelfHostLogin(): void {
    this.checkingSelfHost = true;
    void this.startLogin(this.serverUrl);
  }

  /**
   * Consumes a redirect the ability received from the system.
   *
   * The slot is cleared before anything else, as Android's
   * `LaunchedEffect(oauthCallbackUri)` does, so a URI that could not be used
   * cannot be replayed against a later login session.
   */
  private onCallbackUriChanged(): void {
    const uri: string = this.callbackUri;
    if (uri.length === 0) {
      return;
    }
    AppStorage.setOrCreate('oauthCallbackUri', '');
    this.handleCallback(uri);
  }

  /**
   * Trades an authorization code for a session.
   *
   * Port of `WebLoginViewModel.handleCallback`. Only an in-flight web page can
   * be completed, so a redirect that arrives in any other state is ignored
   * rather than reported: the page interception and a warm deep link can both
   * deliver the same code, and completing it twice would surface a bogus error.
   */
  private handleCallback(uri: string): void {
    const current: WebLoginSession | null = this.session;
    if (this.state !== WebLoginState.WebLogin || current === null) {
      return;
    }
    void this.completeLogin(uri, current);
  }

  private async completeLogin(uri: string, current: WebLoginSession): Promise<void> {
    const auth: AuthController | null = this.controller;
    if (auth === null) {
      return;
    }
    this.state = WebLoginState.Exchanging;
    try {
      await auth.completeWebLogin(uri, current);
      this.state = WebLoginState.Success;
      this.onSignedIn();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Could not complete web sign-in.';
      this.state = WebLoginState.HostChoice;
      this.session = null;
    }
  }

  /**
   * A web page failure returns to the host choice with the reason kept, matching
   * `WebLoginViewModel.reportWebError`, which ignores a report once exchanging
   * has started.
   */
  private handleWebError(message: string): void {
    if (this.state !== WebLoginState.WebLogin) {
      return;
    }
    this.openingOfficial = false;
    this.checkingSelfHost = false;
    this.errorMessage = message;
    this.state = WebLoginState.HostChoice;
    this.session = null;
  }

  build() {
    Column() {
      if (this.state === WebLoginState.WebLogin || this.state === WebLoginState.Exchanging) {
        WebLoginPage({
          colors: this.colors,
          session: this.session,
          exchanging: this.state === WebLoginState.Exchanging,
          onWebError: (message: string) => this.handleWebError(message),
          onCallback: (uri: string) => this.handleCallback(uri),
          onBack: () => {
            this.state = WebLoginState.HostChoice;
            this.session = null;
          },
        })
      } else {
        this.HostChoicePage()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
  }

  @Builder
  HostChoicePage() {
    // iOS layout (round 40): the navigation row and the large title come from
    // `AAIosPage`, the two entries are the prominent and glass capsules, and the
    // self-hosted form is an underlined field with a footnote — as
    // `ManualLoginView` and its `ServerAddressView` do it.
    AAIosPage({
      colors: this.colors,
      title: $r('app.string.auth_host_choice_title'),
      subtitle: $r('app.string.auth_host_choice_hint'),
      onBack: () => this.onBack(),
    }) {
      Column({ space: 16 }) {
        AAIosPrimaryButton({
          colors: this.colors,
          label: $r('app.string.auth_official_service'),
          iconCommands: AA_ICONS.CLOUD,
          loading: this.openingOfficial,
          buttonEnabled: this.officialServiceAvailable() && !this.isBusy(),
          onTap: () => this.startOfficialLogin(),
        })

        if (!this.selfHostExpanded) {
          AAIosGlassButton({
            colors: this.colors,
            label: $r('app.string.auth_self_host_service'),
            iconCommands: AA_ICONS.SERVER,
            buttonEnabled: !this.isBusy(),
            onTap: () => {
              this.selfHostExpanded = true;
              this.errorMessage = '';
            },
          })
        }

        if (this.selfHostExpanded) {
          Column({ space: 16 }) {
            Text($r('app.string.auth_web_login_subtitle'))
              .fontSize(AAFontSize.LABEL)
              .fontColor(this.colors.muted)
              .lineHeight(19)

            AAIosField({
              colors: this.colors,
              fieldValue: $serverUrl,
              placeholder: $r('app.string.auth_backend_url'),
              fieldEnabled: !this.isBusy(),
              onSubmit: () => this.startSelfHostLogin(),
            })

            AAIosPrimaryButton({
              colors: this.colors,
              label: $r('app.string.auth_continue_in_web'),
              loading: this.checkingSelfHost,
              buttonEnabled: this.serverUrl.trim().length > 0 && !this.isBusy(),
              onTap: () => this.startSelfHostLogin(),
            })

            Text($r('app.string.auth_web_login_help'))
              .fontSize(AAFontSize.CAPTION)
              .fontColor(this.colors.muted)
              .lineHeight(18)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }

        if (this.errorMessage.length > 0) {
          AuthErrorNotice({ colors: this.colors, message: this.errorMessage })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}

/**
 * The embedded web sign-in page.
 *
 * Android injects a document-start script that (a) rewrites `/api/v2` fetches to
 * the login web origin and (b) publishes the visual viewport height so the page
 * can avoid the on-screen keyboard. The same two fixes are applied here; without
 * the first, a self-hosted deployment whose API lives on a different origin than
 * its login page would sign in against the wrong host.
 *
 * Like `EmbeddedWebLogin`, a page failure is not rendered in place: it is handed
 * to `onWebError`, which drops back to the host choice so the user can retry.
 * The page itself is loaded by the declarative `src`; a manual `loadUrl` from
 * `aboutToAppear` would run before the controller is bound to the component and
 * report a failure that never happened.
 */
@Component
struct WebLoginPage {
  colors: AAColors = AA_LIGHT_COLORS;
  session: WebLoginSession | null = null;
  exchanging: boolean = false;
  onBack: () => void = () => {};
  onWebError: (message: string) => void = () => {};
  /**
   * The custom-scheme redirect, handed to the host the moment it is seen.
   *
   * Android's `SecureLoginWebViewClient` is constructed with
   * `onCallback = viewModel::handleCallback` and invokes it from
   * `shouldOverrideUrlLoading`; this prop is that callback. Passing the URI up
   * directly is what makes the flow work: publishing it to storage instead
   * leaves nothing to trigger the exchange, because the web view does not
   * change layout when it intercepts a redirect.
   */
  onCallback: (uri: string) => void = () => {};

  @State private loading: boolean = true;
  private controller: webview.WebviewController = new webview.WebviewController();
  /** Set once the custom-scheme redirect is consumed; see `onErrorReceive`. */
  private callbackHandled: boolean = false;

  private bridgeScript(): string {
    const origin: string = this.session?.oauthWebOrigin ?? '';
    return `(function () {
  var ORIGIN = ${JSON.stringify(origin)};
  var NAMESPACE = '/api/v2';
  function rewrite(raw) {
    try {
      var parsed = new URL(raw, ORIGIN);
      if (parsed.pathname === NAMESPACE || parsed.pathname.indexOf(NAMESPACE + '/') === 0) {
        return ORIGIN + parsed.pathname + parsed.search + parsed.hash;
      }
    } catch (e) { /* relative or opaque URL: leave it alone */ }
    return raw;
  }
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') { input = rewrite(input); }
      else if (input && input.url) { input = new Request(rewrite(input.url), input); }
      return nativeFetch.call(this, input, init);
    };
  }
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(url);
    return nativeOpen.apply(this, args);
  };
  function applyViewportHeight() {
    var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--agents-anywhere-harmony-viewport-height', height + 'px');
  }
  applyViewportHeight();
  window.addEventListener('resize', applyViewportHeight);
})();`;
  }

  build() {
    // The same navigation row as the other sign-in screens, with the page itself
    // as the content: iOS hands the sign-in page to a system web session, so the
    // closest equivalent chrome is the bare back glyph above the page.
    AAIosPage({
      colors: this.colors,
      onBack: () => this.onBack(),
      scrollable: false,
    }) {
      Stack() {
        Web({ src: this.session?.authorizeUrl ?? '', controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          // Injected before any page script so the fetch/XHR patches win.
          .javaScriptOnDocumentStart([{ script: this.bridgeScript(), scriptRules: ['*'] }])
          .darkMode(this.colors.isDark ? WebDarkMode.On : WebDarkMode.Off)
          .onPageBegin(() => {
            this.loading = true;
          })
          .onPageEnd(() => {
            this.loading = false;
          })
          .onErrorReceive((event) => {
            // Only a failed main-frame navigation is a page failure. ArkWeb
            // reports every failed subresource here too (favicon, telemetry,
            // a blocked beacon), which is why Android's `onReceivedError`
            // checks `request.isForMainFrame` before surfacing anything.
            if (event?.request?.isMainFrame() !== true) {
              return;
            }
            if (this.callbackHandled) {
              // Intercepting the custom-scheme redirect aborts the navigation
              // in flight; that abort is the expected end of the flow.
              return;
            }
            const code: number = event?.error?.getErrorCode() ?? 0;
            const description: string = event?.error?.getErrorInfo() ?? '';
            AALog.error(`Web login page failed (${code}): ${description}`);
            this.loading = false;
            this.onWebError(description.length > 0 ? description : 'Could not load the web login page.');
          })
          .onSslErrorEventReceive((event) => {
            // Main-frame only, like Android's `onReceivedSslError`. Never
            // continue past a certificate the platform could not verify.
            event?.handler?.handleCancel();
            AALog.error(`Web login page certificate rejected: ${event?.error ?? 'unknown'}`);
            this.loading = false;
            this.onWebError('The server certificate could not be verified.');
          })
          .onLoadIntercept((event) => {
            const target: string = event?.data?.getRequestUrl() ?? '';
            if (target.toLowerCase().startsWith('agents-anywhere://oauth/callback')) {
              // The redirect is handled by the host; the web view must not try
              // to load a custom scheme it cannot render. Which parameters came
              // back is logged — never their values — because a redirect without
              // `state` is rejected downstream and this is the only place the
              // raw URI is still visible.
              this.callbackHandled = true;
              AALog.info(`OAuth redirect intercepted: code=${target.includes('code=')} state=${target.includes('state=')}`);
              this.onCallback(target);
              return true;
            }
            if (target.startsWith('http://') || target.startsWith('https://')) {
              return false;
            }
            this.onWebError('This link cannot be opened inside the sign-in page.');
            return true;
          })
          .width('100%')
          .height('100%')

        if (this.loading || this.exchanging) {
          Column() {
            LoadingProgress().width(38).height(38).color(this.colors.ink)
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor(this.colors.canvas)
        }
      }
      .width('100%')
      .height('100%')
    }
  }
}
