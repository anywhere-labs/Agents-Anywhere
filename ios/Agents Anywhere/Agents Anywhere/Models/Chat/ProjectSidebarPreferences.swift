import Foundation
import Observation

@MainActor @Observable final class ProjectSidebarPreferences {
    static let sessionListKey = "aa.native.sidebar.session-list"
    var expandedProjects: Set<String> { didSet { persist() } }
    var projectsExpanded: Bool { didSet { persist() } }
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String?

    private struct Saved: Codable {
        var expandedProjects: Set<String> = []
        var projectsExpanded = true
    }

    init(scope: V2ClientScope? = nil, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        key = scope.map { "aa.native.sidebar.projects.v1." + Data(($0.serverURL.absoluteString + "\n" + $0.accountID).utf8).base64EncodedString() }
        let saved = key.flatMap { defaults.data(forKey: $0) }.flatMap { try? JSONDecoder().decode(Saved.self, from: $0) } ?? Saved()
        expandedProjects = saved.expandedProjects
        projectsExpanded = saved.projectsExpanded
    }

    private func persist() {
        guard let key, let value = try? JSONEncoder().encode(Saved(expandedProjects: expandedProjects, projectsExpanded: projectsExpanded)) else { return }
        defaults.set(value, forKey: key)
    }
}
