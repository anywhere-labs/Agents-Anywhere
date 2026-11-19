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

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        connect(scene)
    }

    func connect(_ scene: UIWindowScene) {
        guard window == nil else { return }
        LaunchClock.mark("scene connect")
        var workspace = Fixtures.workspace()
        if let stress = StressConfig.current { workspace.sessions.insert(stress.summary, at: 0) }
        let client = MockSessionsClient(workspace: workspace, demo: Fixtures.demo())
        // One WKWebView for the app's lifetime, created by the conversation page once its view is in the window
        // (RendererBridge.makeWebView): never before the window exists.
        let controller = SessionController(workspace: workspace, client: client, bridge: RendererBridge())
        let window = UIWindow(windowScene: scene)
        switch DebugLaunch.scheme {
        case "dark": window.overrideUserInterfaceStyle = .dark
        case "light": window.overrideUserInterfaceStyle = .light
        default: break
        }
        window.rootViewController = ShellViewController(controller: controller)
        self.window = window
        window.makeKeyAndVisible()
    }
}
