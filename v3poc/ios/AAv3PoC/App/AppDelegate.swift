import SwiftUI
import UIKit

/// UIKit app lifecycle: the window's root is `ShellViewController`, a plain UIKit view controller, so the WKWebView
/// is never a descendant of a SwiftUI hosting view (whose gesture recognizers would see every touch on the thread).
/// SwiftUI draws the chrome and the sidebar in hosting controllers that are siblings of the web view.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        LaunchClock.mark("App.init")
        AppFontRegistry.registerBundledFonts()
        // A scene session saved by an earlier build (the SwiftUI-lifecycle one) is restored with that build's scene
        // delegate, and `configurationForConnecting` is not asked again: it would come back as an empty window. Such a
        // scene is handed to `SceneDelegate` when it connects.
        NotificationCenter.default.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: nil) { note in
            MainActor.assumeIsolated {
                guard let scene = note.object as? UIWindowScene, !(scene.delegate is SceneDelegate) else { return }
                LaunchClock.mark("adopting a saved scene session (\(scene.delegate.map { String(describing: type(of: $0)) } ?? "nil"))")
                let delegate = SceneDelegate()
                scene.delegate = delegate
                delegate.connect(scene)
            }
        }
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        LaunchClock.mark("scene configuration")
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let account = NativeAccount()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        connect(scene)
    }

    func connect(_ scene: UIWindowScene) {
        guard window == nil else { return }
        LaunchClock.mark("scene connect")
        let window = UIWindow(windowScene: scene)
        switch DebugLaunch.scheme {
        case "dark": window.overrideUserInterfaceStyle = .dark
        case "light": window.overrideUserInterfaceStyle = .light
        default: break
        }
        self.window = window
        #if DEBUG
        if let profile = DevContentProfile.read(), let client = profile.sessionsClient() {
            showWorkspace(workspace: profile.workspace, client: client)
        } else if ProcessInfo.processInfo.environment["AA_POC_DEMO"] == "1" || StressConfig.current != nil {
            var workspace = Fixtures.workspace()
            if let stress = StressConfig.current { workspace.sessions.insert(stress.summary, at: 0) }
            showWorkspace(workspace: workspace, client: MockSessionsClient(workspace: workspace, demo: Fixtures.demo()))
        } else {
            showConnection(reopen: true)
        }
        #else
        showConnection(reopen: true)
        #endif
        window.makeKeyAndVisible()
    }

    private func showConnection(reopen: Bool) {
        window?.rootViewController = UIHostingController(rootView: ConnectionView(account: account, reopen: reopen) { [weak self] connection in
            self?.showWorkspace(workspace: connection.workspace, client: connection.client, close: connection.close)
        })
    }

    private func showWorkspace(workspace: Workspace, client: any SessionsClient, close: (() async -> Void)? = nil) {
        let controller = SessionController(workspace: workspace, client: client, bridge: RendererBridge())
        if let close {
            controller.openDevices = { [weak self, weak controller] in
                controller?.close()
                Task {
                    await close()
                    self?.showConnection(reopen: false)
                }
            }
        }
        window?.rootViewController = ShellViewController(controller: controller)
    }
}
