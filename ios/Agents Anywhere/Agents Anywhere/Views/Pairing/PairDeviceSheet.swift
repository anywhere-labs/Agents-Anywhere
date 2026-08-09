import SwiftUI
import UIKit

struct PairDeviceSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var path: [PairDeviceRoute] = []
    @State private var credential: V2ConnectorCreateResponse?
    @State private var pairedConnector: V2Connector?
    @State private var runtimes: [V2DeviceRuntime] = []
    @State private var discoveryError: String?
    @State private var isConfirmingExit = false

    var body: some View {
        NavigationStack(path: $path) {
            PairDeviceNameStep(onCancel: requestDismiss, onCreate: createDevice)
                .navigationDestination(for: PairDeviceRoute.self) { route in
                    switch route {
                    case .code:
                        if let credential {
                            PairDeviceCodeStep(
                                name: credential.connector.name,
                                serverAddress: appState.serverURL?.absoluteString ?? "",
                                onCancel: requestDismiss,
                                onClaim: claimDevice
                            )
                            .navigationBarBackButtonHidden(true)
                        }
                    case .connecting:
                        if let pairedConnector {
                            PairDeviceConnectingStep(
                                connectorId: pairedConnector.id,
                                deviceName: pairedConnector.name,
                                onCancel: requestDismiss,
                                onConnected: finishPairing
                            )
                            .navigationBarBackButtonHidden(true)
                        }
                    case .agents:
                        if let pairedConnector {
                            PairDeviceAgentsStep(
                                deviceName: pairedConnector.name,
                                runtimes: runtimes,
                                discoveryError: discoveryError,
                                onRefresh: refreshRuntimes,
                                onDone: { dismiss() }
                            )
                            .navigationBarBackButtonHidden(true)
                        }
                    }
                }
        }
        .interactiveDismissDisabled(credential != nil && path.last != .agents)
        .confirmationDialog(
            "Device already created",
            isPresented: $isConfirmingExit,
            titleVisibility: .visible
        ) {
            Button("Continue pairing", role: .cancel) {}
            Button("Close anyway", role: .destructive) {
                dismiss()
            }
        } message: {
            Text("This device has been created but pairing is not complete. You can remove it later from Devices.")
        }
    }

    private func createDevice(name: String) async throws {
        credential = try await appState.createDevicePairing(name: name)
        path.append(.code)
    }

    private func claimDevice(code: String) async throws {
        guard let credential else { throw V2BusinessError.pairingNotClaimed }
        pairedConnector = try await appState.claimDevicePairing(
            code: code,
            name: credential.connector.name,
            connectorId: credential.connector.id,
            connectorToken: credential.connectorToken
        )
        path.append(.connecting)
    }

    private func finishPairing(
        connector: V2Connector,
        discoveredRuntimes: [V2DeviceRuntime],
        error: String?
    ) {
        pairedConnector = connector
        runtimes = discoveredRuntimes.filter(\.present)
        discoveryError = error
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        path.append(.agents)
    }

    private func refreshRuntimes() async {
        guard let pairedConnector else { return }
        do {
            runtimes = try await appState
                .discoverDevicePairingRuntimes(connectorId: pairedConnector.id)
                .filter(\.present)
            discoveryError = nil
        } catch {
            discoveryError = error.localizedDescription
        }
    }

    private func requestDismiss() {
        if credential == nil || path.last == .agents {
            dismiss()
        } else {
            isConfirmingExit = true
        }
    }
}

private enum PairDeviceRoute: Hashable {
    case code
    case connecting
    case agents
}

private enum PairDeviceStep: Int, CaseIterable {
    case name
    case code
    case connecting
    case agents
}

private struct PairDeviceProgress: View {
    let current: PairDeviceStep

    var body: some View {
        HStack(spacing: 8) {
            ForEach(PairDeviceStep.allCases, id: \.self) { step in
                Capsule()
                    .fill(step.rawValue <= current.rawValue ? Color.accentColor : Color.secondary.opacity(0.2))
                    .frame(height: 4)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pairing progress")
        .accessibilityValue("Step \(current.rawValue + 1) of \(PairDeviceStep.allCases.count)")
    }
}

private struct PairDeviceNameStep: View {
    let onCancel: () -> Void
    let onCreate: (String) async throws -> Void

    @State private var name = "New device"
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        AuthScreen(
            title: "Name your device",
            subtitle: "Give this device a name so you can identify it later.",
            onCancel: onCancel
        ) {
            VStack(alignment: .leading, spacing: 22) {
                PairDeviceProgress(current: .name)

                TextField("Device name", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.name)
                    .padding(16)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                if let errorMessage {
                    PairDeviceInlineError(message: errorMessage)
                }

                AuthPrimaryButton(
                    title: "Create device",
                    systemImage: "desktopcomputer",
                    isLoading: isCreating,
                    disabled: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    Task { await create() }
                }
            }
        }
    }

    private func create() async {
        guard !isCreating else { return }
        isCreating = true
        defer { isCreating = false }
        do {
            try await onCreate(name)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct PairDeviceCodeStep: View {
    let name: String
    let serverAddress: String
    let onCancel: () -> Void
    let onClaim: (String) async throws -> Void

    @State private var code = ""
    @State private var isClaiming = false
    @State private var errorMessage: String?

    var body: some View {
        AuthScreen(
            title: "Pair with code",
            subtitle: "Start pairing in the desktop Connector on \(name), then enter its 6-digit code.",
            onCancel: onCancel
        ) {
            VStack(alignment: .leading, spacing: 22) {
                PairDeviceProgress(current: .code)
                PairDeviceServerAddress(address: serverAddress)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Pair code from device")
                        .font(.headline)
                    TextField("000000", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.system(size: 30, weight: .semibold, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .tracking(10)
                        .padding(.vertical, 16)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .onChange(of: code) { _, nextCode in
                            code = String(nextCode.filter(\.isNumber).prefix(6))
                        }
                }

                if let errorMessage {
                    PairDeviceInlineError(message: errorMessage)
                }

                AuthPrimaryButton(
                    title: "Pair device",
                    systemImage: "link",
                    isLoading: isClaiming,
                    disabled: code.count != 6
                ) {
                    Task { await claim() }
                }
            }
        }
    }

    private func claim() async {
        guard !isClaiming else { return }
        isClaiming = true
        defer { isClaiming = false }
        do {
            try await onClaim(code)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct PairDeviceServerAddress: View {
    let address: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Server address", systemImage: "network")
                .font(.headline)
            Text(address)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("Enter this address in the target desktop Connector before starting pairing.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct PairDeviceConnectingStep: View {
    @EnvironmentObject private var appState: AppState

    let connectorId: V2ConnectorID
    let deviceName: String
    let onCancel: () -> Void
    let onConnected: (V2Connector, [V2DeviceRuntime], String?) -> Void

    @State private var statusMessage = "Sending credentials to the device..."
    @State private var transientError: String?

    var body: some View {
        AuthScreen(
            title: "Connecting device",
            subtitle: "Keep the desktop Connector open while \(deviceName) comes online.",
            onCancel: onCancel
        ) {
            VStack(spacing: 26) {
                PairDeviceProgress(current: .connecting)
                ProgressView()
                    .controlSize(.large)
                    .padding(.top, 28)
                Text(statusMessage)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                if let transientError {
                    Text(transientError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .task(id: connectorId) {
            await waitUntilOnline()
        }
    }

    private func waitUntilOnline() async {
        while !Task.isCancelled {
            do {
                let connector = try await appState.devicePairingConnector(connectorId: connectorId)
                transientError = nil
                if connector.status == .online {
                    statusMessage = "Discovering agents..."
                    do {
                        let runtimes = try await appState.discoverDevicePairingRuntimes(connectorId: connectorId)
                        onConnected(connector, runtimes, nil)
                    } catch {
                        onConnected(connector, [], error.localizedDescription)
                    }
                    return
                }
                statusMessage = "Waiting for the device to come online..."
                try await Task.sleep(for: .seconds(2))
            } catch is CancellationError {
                return
            } catch {
                transientError = error.localizedDescription
                statusMessage = "Still waiting for the device..."
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

private struct PairDeviceAgentsStep: View {
    let deviceName: String
    let runtimes: [V2DeviceRuntime]
    let discoveryError: String?
    let onRefresh: () async -> Void
    let onDone: () -> Void

    @State private var isRefreshing = false

    var body: some View {
        AuthScreen(
            title: "Device paired",
            subtitle: "\(deviceName) is online and ready to run sessions.",
            showsCancel: false,
            onCancel: onDone
        ) {
            VStack(alignment: .leading, spacing: 22) {
                PairDeviceProgress(current: .agents)

                Label("Connected", systemImage: "checkmark.circle.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.green)

                PairDeviceRuntimeList(runtimes: runtimes)

                if let discoveryError {
                    PairDeviceInlineError(message: discoveryError)
                }

                if runtimes.isEmpty || discoveryError != nil {
                    AppGlassButton(
                        "Refresh agents",
                        systemImage: "arrow.clockwise",
                        isLoading: isRefreshing
                    ) {
                        Task { await refresh() }
                    }
                }

                AuthPrimaryButton(title: "Done", systemImage: "checkmark", action: onDone)
            }
        }
    }

    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await onRefresh()
    }
}

private struct PairDeviceRuntimeList: View {
    let runtimes: [V2DeviceRuntime]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Agents on this device")
                .font(.headline)

            if runtimes.isEmpty {
                Text("No supported agents were discovered on this device.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
            } else {
                ForEach(runtimes) { runtime in
                    PairDeviceRuntimeRow(
                        displayName: runtime.displayName,
                        configured: runtime.configured,
                        active: runtime.active,
                        status: runtime.status
                    )
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct PairDeviceRuntimeRow: View {
    let displayName: String
    let configured: Bool
    let active: Bool
    let status: V2DeviceRuntimeStatus

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: status == .running ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(status == .running ? .green : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                    .font(.subheadline.weight(.semibold))
                Text(stateTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var stateTitle: LocalizedStringResource {
        if active && status == .running { return "Configured and running" }
        if configured { return "Configured" }
        return "Ready to configure"
    }
}

private struct PairDeviceInlineError: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}
