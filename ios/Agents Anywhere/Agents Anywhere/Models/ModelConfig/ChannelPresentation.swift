import Foundation

/// A channel the user can pick: the device's own configuration, the linked
/// Anywhere account, or an active manual profile.
nonisolated struct ModelChannelOption: Identifiable, Hashable {
    enum Kind: Hashable { case native, tokens, profile }

    let id: String
    let label: String
    let kind: Kind
}

/// One runtime in the channel list, with what the dashboard knows about it.
nonisolated struct ChannelRuntimeRow: Identifiable, Hashable {
    let entry: V2ChannelRuntime
    let runtimeName: String
    let deviceName: String
    let maturity: String?
    /// Takes the connection in its own global settings, so an AA channel needs confirmation.
    let changesGlobalSettings: Bool
    /// Declares no model connection at all.
    let isUnsupported: Bool

    var id: String { entry.id }
    var target: V2ModelTarget { entry.target }
    var canRetry: Bool { entry.state == "restored" || entry.state == "failed" }
    /// Choosing `channel` for this runtime needs `confirmNativeGlobal`.
    func needsGlobalConfirmation(for channel: String?) -> Bool {
        changesGlobalSettings && channel != nil && channel != V2ModelChannel.native
    }
}

nonisolated struct ChannelDeviceGroup: Identifiable, Hashable {
    let connectorId: String
    let name: String
    let rows: [ChannelRuntimeRow]
    /// nil while the device's presence is unknown.
    var online: Bool? = nil

    var id: String { connectorId }
}

/// Counts behind one channel's status line, over the runtimes that should use it.
nonisolated struct ChannelProgress: Hashable {
    enum Phase: Hashable { case none, running, done, attention }

    let phase: Phase
    /// Runtimes taking part: every one that can use the channel it should.
    let total: Int
    let applied: Int
    let unfinished: Int
    /// Devices that are offline with runtimes waiting on them.
    let offlineDevices: Int
    let restored: Int
    let failed: Int
    let unsupported: Int
}

/// Labels and decisions for the current channel and its switch. Everything
/// comes from the channel state and declared capabilities, never runtime names.
nonisolated enum ChannelPresentation {
    static func label(_ channel: String, profiles: [V2ModelProfile]) -> String {
        switch channel {
        case V2ModelChannel.native: String(localized: "pages.settings.modelConfigs.current.native")
        case V2ModelChannel.tokens: String(localized: "pages.settings.modelConfigs.channels.anywhere")
        default: profiles.first { $0.id == channel }?.name ?? channel
        }
    }

    /// The channels to offer. The current one is always included so a picker
    /// can show it, even after its account or profile went away.
    static func options(overview: V2ModelConfigOverview, current: String?) -> [ModelChannelOption] {
        var options = [ModelChannelOption(id: V2ModelChannel.native, label: label(V2ModelChannel.native, profiles: []), kind: .native)]
        if overview.tokens?.available == true && overview.tokens?.link?.isLinked == true {
            options.append(.init(id: V2ModelChannel.tokens, label: label(V2ModelChannel.tokens, profiles: []), kind: .tokens))
        }
        for profile in overview.profiles where !profile.isTokens && profile.isActive {
            options.append(.init(id: profile.id, label: profile.name, kind: .profile))
        }
        if let current, !options.contains(where: { $0.id == current }) {
            let kind: ModelChannelOption.Kind = current == V2ModelChannel.tokens ? .tokens : .profile
            options.append(.init(id: current, label: label(current, profiles: overview.profiles), kind: kind))
        }
        return options
    }

    /// The manager that marks instances the model configuration created.
    static let modelConfigManager = "model-config"

    /// The channel row for a runtime. A managed instance is not listed itself:
    /// its row is the one of the runtime of the same type it serves on that device.
    static func row(for target: V2ModelTarget, in state: V2ModelChannelState?, runtimes: [V2DeviceRuntime],
                    assignments: [V2ModelAssignment]) -> V2ChannelRuntime? {
        guard let state else { return nil }
        if let direct = state.runtimes.first(where: { $0.target == target }) { return direct }
        func isManaged(_ runtime: V2DeviceRuntime) -> Bool {
            runtime.managedBy == modelConfigManager || assignments.contains { $0.createdRuntime && $0.target == runtime.target }
        }
        guard let runtime = runtimes.first(where: { $0.target == target }), isManaged(runtime) else { return nil }
        return state.runtimes.first { row in
            row.connectorId == target.connectorId && runtimes.contains {
                $0.target == row.target && $0.runtimeType == runtime.runtimeType && !isManaged($0)
            }
        }
    }

    /// Changes whenever the channel a runtime actually uses changes, or settles;
    /// progress messages and timestamps do not change it.
    static func runtimeKey(_ row: V2ChannelRuntime?) -> String {
        row.map { "\($0.actual):\($0.appliedGeneration.map(String.init) ?? ""):\($0.state == "applied")" } ?? ""
    }

    /// Runtimes that should use `channel`: following it as the applied one, or chosen for it.
    static func rows(_ state: V2ModelChannelState?, for channel: String) -> [V2ChannelRuntime] {
        state?.runtimes.filter { $0.desired == channel } ?? []
    }

    static func progress(_ rows: [V2ChannelRuntime]) -> ChannelProgress {
        let taking = rows.filter { $0.state != "unsupported" }
        func count(_ value: String) -> Int { taking.filter { $0.state == value }.count }
        let restored = count("restored"), failed = count("failed")
        let unfinished = taking.filter { isInProgress($0.state) }.count
        let phase: ChannelProgress.Phase = taking.isEmpty ? .none
            : restored + failed > 0 ? .attention
            : unfinished > 0 ? .running : .done
        return .init(phase: phase, total: taking.count, applied: count("applied"), unfinished: unfinished,
            offlineDevices: Set(taking.filter { $0.state == "waiting_online" }.map(\.connectorId)).count,
            restored: restored, failed: failed, unsupported: rows.count - taking.count)
    }

    /// Runtimes grouped by device in the dashboard's device order, and the
    /// runtimes that take no model connection, listed apart.
    static func groups(_ state: V2ModelChannelState, runtimes: [V2DeviceRuntime], connectors: [V2Connector])
        -> (devices: [ChannelDeviceGroup], unsupported: [ChannelRuntimeRow]) {
        groups(state.runtimes, runtimes: runtimes, connectors: connectors)
    }

    static func groups(_ entries: [V2ChannelRuntime], runtimes: [V2DeviceRuntime], connectors: [V2Connector])
        -> (devices: [ChannelDeviceGroup], unsupported: [ChannelRuntimeRow]) {
        let known = Dictionary(runtimes.map { ($0.target.key, $0) }, uniquingKeysWith: { first, _ in first })
        let names = Dictionary(connectors.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var supported: [String: [ChannelRuntimeRow]] = [:]
        var order: [String] = connectors.map(\.id)
        var unsupported: [ChannelRuntimeRow] = []
        for entry in entries {
            let runtime = known[entry.id]
            let row = ChannelRuntimeRow(entry: entry,
                runtimeName: runtime?.sessionDisplayName ?? entry.runtimeId,
                deviceName: names[entry.connectorId] ?? entry.connectorId,
                maturity: runtime?.badgeMaturity,
                changesGlobalSettings: runtime?.modelConnection?.scope == "native_global" || entry.reason == "confirmation_required",
                isUnsupported: runtime.map { $0.modelConnection == nil }
                    ?? (entry.state == "unsupported" && ["model_connection_unsupported", "not_installed"].contains(entry.reason ?? "")))
            if row.isUnsupported { unsupported.append(row); continue }
            if !order.contains(entry.connectorId) { order.append(entry.connectorId) }
            supported[entry.connectorId, default: []].append(row)
        }
        let devices = order.compactMap { id -> ChannelDeviceGroup? in
            guard let rows = supported[id], !rows.isEmpty else { return nil }
            let presence = connectors.first { $0.id == id }?.status
            return ChannelDeviceGroup(connectorId: id, name: names[id] ?? id, rows: rows,
                online: presence == .online ? true : presence == .offline ? false : nil)
        }
        return (devices, unsupported)
    }

    /// The state as the desktop names it; switching also says which step.
    static func stateLabel(_ entry: V2ChannelRuntime) -> String {
        let label: String = switch entry.state {
        case "applied": String(localized: "pages.settings.modelConfigs.state.applied")
        case "pending": String(localized: "pages.settings.modelConfigs.state.pending")
        case "waiting_online": String(localized: "pages.settings.modelConfigs.state.waiting_online")
        case "switching": String(localized: "pages.settings.modelConfigs.state.switching")
        case "restoring": String(localized: "pages.settings.modelConfigs.state.restoring")
        case "restored": String(localized: "pages.settings.modelConfigs.state.restored")
        case "failed": String(localized: "pages.settings.modelConfigs.state.failed")
        case "unsupported": String(localized: "pages.settings.modelConfigs.state.unsupported")
        default: entry.state
        }
        guard entry.state == "switching", let step = entry.step.flatMap(stepLabel) else { return label }
        return "\(label) · \(step)"
    }

    static func stepLabel(_ step: String) -> String? {
        switch step {
        case "preparing": String(localized: "pages.settings.modelConfigs.step.preparing")
        case "activating": String(localized: "pages.settings.modelConfigs.step.activating")
        case "verifying": String(localized: "pages.settings.modelConfigs.step.verifying")
        default: nil
        }
    }

    static func tone(_ state: String) -> ModelStatusTone {
        switch state {
        case "applied": .ok
        case "pending", "waiting_online", "switching", "restoring": .progress
        case "restored": .warning
        case "failed": .error
        default: .neutral
        }
    }

    /// True while the runtime has not reached an end state.
    static func isInProgress(_ state: String) -> Bool {
        ["pending", "waiting_online", "switching", "restoring"].contains(state)
    }

    /// Why a runtime cannot switch or failed to, as on the desktop: only for those two.
    static func reasonText(_ entry: V2ChannelRuntime) -> String? {
        guard entry.state == "unsupported" || entry.state == "restored" || entry.state == "failed",
              let reason = entry.reason, !reason.isEmpty else { return nil }
        return knownReason(reason) ?? String(localized: "pages.settings.modelConfigs.reason.unknown")
    }

    static func knownReason(_ reason: String) -> String? {
        switch reason {
        case "model_connection_unsupported": String(localized: "pages.settings.modelConfigs.reason.model_connection_unsupported")
        case "not_installed": String(localized: "pages.settings.modelConfigs.reason.not_installed")
        case "format_unsupported": String(localized: "pages.settings.modelConfigs.reason.format_unsupported")
        case "mode_unsupported": String(localized: "pages.settings.modelConfigs.reason.mode_unsupported")
        case "models_required": String(localized: "pages.settings.modelConfigs.reason.models_required")
        case "model_unavailable": String(localized: "pages.settings.modelConfigs.reason.model_unavailable")
        case "confirmation_required": String(localized: "pages.settings.modelConfigs.reason.confirmation_required")
        case "connector_upgrade_required": String(localized: "pages.settings.modelConfigs.reason.connector_upgrade_required")
        case "profile_unavailable": String(localized: "pages.settings.modelConfigs.reason.profile_unavailable")
        case "validate_failed": String(localized: "pages.settings.modelConfigs.reason.validate_failed")
        case "start_failed": String(localized: "pages.settings.modelConfigs.reason.start_failed")
        case "verify_failed": String(localized: "pages.settings.modelConfigs.reason.verify_failed")
        case "probe_failed": String(localized: "pages.settings.modelConfigs.reason.probe_failed")
        case "verify_timeout": String(localized: "pages.settings.modelConfigs.reason.verify_timeout")
        case "device_offline": String(localized: "pages.settings.modelConfigs.reason.device_offline")
        case "rollback_failed": String(localized: "pages.settings.modelConfigs.reason.rollback_failed")
        case "superseded": String(localized: "pages.settings.modelConfigs.reason.superseded")
        default: nil
        }
    }
}
