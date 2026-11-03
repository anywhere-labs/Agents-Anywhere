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

    var id: String { connectorId }
}

/// How far the last switch got, counted over the runtimes that take part.
nonisolated struct ChannelSummary: Hashable {
    enum Phase: Hashable { case idle, running, done, attention }

    let phase: Phase
    /// Runtimes that can use a channel (everything but `unsupported`).
    let total: Int
    /// Runtimes that reached an end state: applied, restored or failed.
    let finished: Int
    let applied: Int
    let waitingOnline: Int
    let restored: Int
    let failed: Int
}

/// Labels and decisions for the current channel and its switch. Everything
/// comes from the channel state and declared capabilities, never runtime names.
nonisolated enum ChannelPresentation {
    static func label(_ channel: String, profiles: [V2ModelProfile]) -> String {
        switch channel {
        case V2ModelChannel.native: String(localized: "Device's own configuration")
        case V2ModelChannel.tokens: String(localized: "Anywhere")
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

    static func summary(_ state: V2ModelChannelState) -> ChannelSummary {
        let taking = state.runtimes.filter { $0.state != "unsupported" }
        func count(_ value: String) -> Int { taking.filter { $0.state == value }.count }
        let phase: ChannelSummary.Phase = switch state.progress?.state {
        case "running": .running
        case "done": .done
        case "attention": .attention
        default: .idle
        }
        let applied = count("applied"), restored = count("restored"), failed = count("failed")
        return .init(phase: phase, total: taking.count, finished: applied + restored + failed, applied: applied,
            waitingOnline: count("waiting_online"), restored: restored, failed: failed)
    }

    /// Runtimes grouped by device in the dashboard's device order, and the
    /// runtimes that take no model connection, listed apart.
    static func groups(_ state: V2ModelChannelState, runtimes: [V2DeviceRuntime], connectors: [V2Connector])
        -> (devices: [ChannelDeviceGroup], unsupported: [ChannelRuntimeRow]) {
        let known = Dictionary(runtimes.map { ($0.target.key, $0) }, uniquingKeysWith: { first, _ in first })
        let names = Dictionary(connectors.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var supported: [String: [ChannelRuntimeRow]] = [:]
        var order: [String] = connectors.map(\.id)
        var unsupported: [ChannelRuntimeRow] = []
        for entry in state.runtimes {
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
            return ChannelDeviceGroup(connectorId: id, name: names[id] ?? id, rows: rows)
        }
        return (devices, unsupported)
    }

    static func stateLabel(_ entry: V2ChannelRuntime) -> String {
        switch entry.state {
        case "applied": String(localized: "In effect")
        case "pending": String(localized: "Queued")
        case "waiting_online": String(localized: "Switches when online")
        case "switching": entry.step.flatMap(stepLabel).map { String(localized: "Switching · \($0)") } ?? String(localized: "Switching")
        case "restoring": String(localized: "Restoring")
        case "restored": String(localized: "Switch failed, restored")
        case "failed": String(localized: "Needs attention")
        case "unsupported": String(localized: "Not supported")
        default: entry.state
        }
    }

    static func stepLabel(_ step: String) -> String? {
        switch step {
        case "preparing": String(localized: "Preparing")
        case "activating": String(localized: "Activating")
        case "verifying": String(localized: "Verifying")
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

    /// The reason in the user's language; the Server's message when it is a
    /// reason this client does not know.
    static func reasonText(_ entry: V2ChannelRuntime) -> String? {
        guard let reason = entry.reason, !reason.isEmpty else { return entry.message }
        return knownReason(reason) ?? entry.message ?? String(localized: "Cannot switch right now")
    }

    static func knownReason(_ reason: String) -> String? {
        switch reason {
        case "model_connection_unsupported": String(localized: "Takes no model connection")
        case "not_installed": String(localized: "Not installed on the device")
        case "format_unsupported": String(localized: "No protocol in common")
        case "mode_unsupported": String(localized: "No mode that takes a model connection")
        case "models_required": String(localized: "Needs at least one model")
        case "model_unavailable": String(localized: "Its chosen model is not in this channel")
        case "confirmation_required": String(localized: "Changes its own global settings; choose a channel for it to confirm")
        case "connector_upgrade_required": String(localized: "Upgrade the Connector to synchronize channels safely")
        case "profile_unavailable": String(localized: "The channel's profile is no longer available")
        case "validate_failed": String(localized: "The runtime rejected the configuration")
        case "start_failed": String(localized: "The runtime did not start")
        case "verify_failed": String(localized: "The runtime reported a different connection")
        case "probe_failed": String(localized: "The test call to the model failed")
        case "verify_timeout": String(localized: "The runtime did not confirm in time")
        case "device_offline": String(localized: "Device offline")
        case "rollback_failed": String(localized: "Restoring the previous configuration failed")
        case "superseded": String(localized: "Replaced by a newer switch")
        default: nil
        }
    }
}
