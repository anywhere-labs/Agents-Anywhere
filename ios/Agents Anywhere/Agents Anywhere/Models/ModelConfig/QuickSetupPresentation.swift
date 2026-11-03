import Foundation

nonisolated enum QuickSetupPhase: Hashable {
    /// Choosing which runtimes to set up.
    case setup
    /// A setup on its way, including the browser authorization this page started.
    case progress
    /// The linked account's own page; once runtimes use Tokens, later runs
    /// (new runtimes, changed models) show there too.
    case done
}

nonisolated enum QuickStepStatus: Hashable {
    case pending, active, done, failed
}

nonisolated struct QuickSetupSteps: Hashable {
    let authorize: QuickStepStatus
    let sync: QuickStepStatus
    let apply: QuickStepStatus
}

/// A runtime already using the Tokens profile, as `newQuickCandidates` compares it.
nonisolated struct QuickAssignedTarget: Hashable {
    let connectorId: String
    let runtimeId: String
    let runtimeType: String?
    let createdRuntime: Bool
}

/// The one-click Tokens Anywhere card, ported from the Web presentation. It
/// reads only the link, the pushed progress and each candidate's fields.
nonisolated enum QuickSetupPresentation {
    static func phase(link: V2TokensLink?, progress: V2QuickSetupProgress?, configured: Bool, authorizing: Bool) -> QuickSetupPhase {
        let linked = link?.isLinked == true
        let state = progress?.state
        if authorizing && !linked { return .progress }
        if linked && configured && state != "failed" { return .done }
        if state == "syncing" || state == "applying" || state == "failed" { return linked ? .progress : .setup }
        return linked ? .done : .setup
    }

    /// A setup or a model change is being written to runtimes right now.
    static func isRunning(_ progress: V2QuickSetupProgress?) -> Bool {
        progress?.state == "syncing" || progress?.state == "applying"
    }

    static func steps(link: V2TokensLink?, progress: V2QuickSetupProgress?, authorizing: Bool) -> QuickSetupSteps {
        guard link?.isLinked == true else {
            return .init(authorize: authorizing ? .active : .pending, sync: .pending, apply: .pending)
        }
        guard let progress else { return .init(authorize: .done, sync: .pending, apply: .pending) }
        switch progress.state {
        case "failed":
            return progress.step == "sync"
                ? .init(authorize: .done, sync: .failed, apply: .pending)
                : .init(authorize: .done, sync: .done, apply: .failed)
        case "syncing": return .init(authorize: .done, sync: .active, apply: .pending)
        case "applying": return .init(authorize: .done, sync: .done, apply: .active)
        default: return .init(authorize: .done, sync: .done, apply: .done)
        }
    }

    /// Ticked by default: everything that can be applied without changing a
    /// runtime's own global settings.
    static func defaultSelection(_ candidates: [V2ModelPreviewTarget]) -> Set<String> {
        Set(candidates.filter { $0.decision == "apply" && !$0.requiresConfirmation }.map(\.id))
    }

    /// Runtimes that could use Tokens Anywhere but do not yet. A runtime served
    /// by a managed instance counts as set up: the instance carries the assignment.
    static func newCandidates(_ candidates: [V2ModelPreviewTarget], assigned: [QuickAssignedTarget]) -> [V2ModelPreviewTarget] {
        let taken = Set(assigned.map { "\($0.connectorId)/\($0.runtimeId)" })
        let managed = Set(assigned.compactMap { item -> String? in
            guard item.createdRuntime, let type = item.runtimeType, !type.isEmpty else { return nil }
            return "\(item.connectorId)/\(type)"
        })
        return candidates.filter { item in
            item.decision == "apply" && !taken.contains(item.id)
                && !(item.effect == "new_instance" && managed.contains("\(item.connectorId)/\(item.runtimeType)"))
        }
    }

    /// The request for the ticked candidates; confirms global changes only when
    /// a ticked runtime needs it.
    static func request(candidates: [V2ModelPreviewTarget], selection: Set<String>) -> V2QuickSetupRequest {
        let chosen = candidates.filter { $0.decision == "apply" && selection.contains($0.id) }
        return .init(targets: chosen.map(\.target), confirmNativeGlobal: chosen.contains { $0.requiresConfirmation })
    }

    static func candidateNote(_ item: V2ModelPreviewTarget) -> String {
        if item.decision != "apply" { return reasonText(item.reason) }
        if item.requiresConfirmation { return String(localized: "Changes its own global settings; set up only when ticked") }
        if item.effect == "new_instance" { return String(localized: "Gets a separate managed instance; the original stays as it is") }
        if item.effect == "restart" && item.runningSessions > 0 { return String(localized: "Tasks are running; applies when idle") }
        return ModelConfigPresentation.effectLabel(item.effect ?? "restart") ?? ModelConfigPresentation.effectLabel("restart") ?? ""
    }

    static func assignmentNote(status: String, createdRuntime: Bool) -> String {
        if status == "deferred" { return String(localized: "Tasks are running; applies when idle") }
        let label = ModelConfigPresentation.assignmentStatusLabel(status)
        return createdRuntime ? label + String(localized: "pages.settings.modelConfigs.quick.viaManagedInstance") : label
    }

    /// A skip reason when it names one, else an error code, else a generic reason.
    static func reasonText(_ reason: String?) -> String {
        if let reason, let text = ModelConfigPresentation.knownSkipReason(reason) { return text }
        if let reason, let text = ModelConfigErrorText.text(code: reason) { return text }
        return ModelConfigPresentation.skipReason(nil)
    }

    static func failureText(_ progress: V2QuickSetupProgress?) -> String {
        progress?.code.flatMap(ModelConfigErrorText.text(code:)) ?? String(localized: "That did not finish. Try again later.")
    }
}
