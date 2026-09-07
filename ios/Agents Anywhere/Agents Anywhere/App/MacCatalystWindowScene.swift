#if targetEnvironment(macCatalyst)
import UIKit

/// Supply scene configuration before SwiftUI creates the window and its
/// navigation hosts. SwiftUI continues to own the window and root controller.
final class MacCatalystAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        if connectingSceneSession.role == .windowApplication {
            configuration.delegateClass = MacCatalystWindowSceneDelegate.self
        }
        return configuration
    }
}

final class MacCatalystWindowSceneDelegate: NSObject, UIWindowSceneDelegate {
    func preferredWindowingControlStyle(for windowScene: UIWindowScene) -> UIWindowScene.WindowingControlStyle {
        // Let UIKit place window controls within the content and handle their
        // local exclusion area instead of reserving a separate row above every column.
        .unified
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        configureTitlebar(in: scene)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        configureTitlebar(in: scene)
    }

    private func configureTitlebar(in scene: UIScene) {
        guard let titlebar = (scene as? UIWindowScene)?.titlebar else { return }
        titlebar.titleVisibility = .hidden
        titlebar.toolbar = nil
        titlebar.separatorStyle = .none
    }
}
#endif
