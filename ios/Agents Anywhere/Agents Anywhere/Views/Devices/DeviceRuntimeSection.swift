import SwiftUI

struct DeviceRuntimeSection: View {
    let connectorIsOnline: Bool
    let configuredRuntimes: [V2DeviceRuntime]
    let availableRuntimes: [V2DeviceRuntime]
    let isLoading: Bool
    let isDiscovering: Bool
    let busyRuntimeId: V2RuntimeID?
    let onRefresh: () -> Void
    let onConfigure: (V2DeviceRuntime) -> Void
    let onToggleActive: (V2DeviceRuntime, Bool) -> Void
    let onDeleteConfiguration: (V2DeviceRuntime) -> Void

    @State private var runtimePendingDeletion: V2DeviceRuntime?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Agent Runtime")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Button(action: onRefresh) {
                    if isDiscovering {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(!connectorIsOnline || isDiscovering)
            }

            if isLoading && configuredRuntimes.isEmpty && availableRuntimes.isEmpty {
                DeviceRuntimeLoadingView()
            } else {
                if !configuredRuntimes.isEmpty {
                    Text("Configured")
                        .font(.subheadline.weight(.semibold))

                    VStack(spacing: 0) {
                        ForEach(configuredRuntimes) { runtime in
                            DeviceConfiguredRuntimeRow(
                                runtime: runtime,
                                connectorIsOnline: connectorIsOnline,
                                isBusy: busyRuntimeId == runtime.id,
                                onConfigure: { onConfigure(runtime) },
                                onToggleActive: { active in onToggleActive(runtime, active) },
                                onDelete: { runtimePendingDeletion = runtime }
                            )

                            if runtime.id != configuredRuntimes.last?.id {
                                Divider().padding(.leading, 42)
                            }
                        }
                    }
                }

                if !availableRuntimes.isEmpty {
                    Text("Discovered, not configured")
                        .font(.subheadline.weight(.semibold))
                        .padding(.top, configuredRuntimes.isEmpty ? 0 : 8)

                    VStack(spacing: 0) {
                        ForEach(availableRuntimes) { runtime in
                            DeviceAvailableRuntimeRow(
                                runtime: runtime,
                                connectorIsOnline: connectorIsOnline,
                                isBusy: busyRuntimeId == runtime.id,
                                onConfigure: { onConfigure(runtime) }
                            )

                            if runtime.id != availableRuntimes.last?.id {
                                Divider().padding(.leading, 42)
                            }
                        }
                    }
                }

                if configuredRuntimes.isEmpty && availableRuntimes.isEmpty {
                    ContentUnavailableView(
                        "No Agent runtimes found",
                        systemImage: "shippingbox",
                        description: Text(connectorIsOnline
                            ? "Refresh to search this device again."
                            : "Bring the Connector online to discover local runtimes.")
                    )
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .confirmationDialog(
            "Delete runtime configuration?",
            isPresented: deletionBinding,
            titleVisibility: .visible
        ) {
            Button("Delete configuration", role: .destructive) {
                guard let runtimePendingDeletion else { return }
                onDeleteConfiguration(runtimePendingDeletion)
                self.runtimePendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                runtimePendingDeletion = nil
            }
        } message: {
            Text("The runtime will stop and its saved configuration will be removed from this device.")
        }
    }

    private var deletionBinding: Binding<Bool> {
        Binding(
            get: { runtimePendingDeletion != nil },
            set: { isPresented in
                if !isPresented { runtimePendingDeletion = nil }
            }
        )
    }
}

private struct DeviceConfiguredRuntimeRow: View {
    let runtime: V2DeviceRuntime
    let connectorIsOnline: Bool
    let isBusy: Bool
    let onConfigure: () -> Void
    let onToggleActive: (Bool) -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            RuntimePresenceDot(runtime: runtime)

            VStack(alignment: .leading, spacing: 3) {
                Text(runtime.displayName)
                    .font(.body.weight(.medium))
                Text(runtime.status.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if isBusy {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 44)
            } else {
                Button(action: onConfigure) {
                    Image(systemName: "gearshape")
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Configure \(runtime.displayName)")

                Toggle(
                    "Run \(runtime.displayName)",
                    isOn: Binding(
                        get: { runtime.active },
                        set: onToggleActive
                    )
                )
                .labelsHidden()
                .toggleStyle(.switch).tint(nil).accentColor(nil)
                .disabled(!connectorIsOnline)
            }
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Configure", systemImage: "gearshape", action: onConfigure)
            Button("Delete configuration", systemImage: "trash", role: .destructive, action: onDelete)
        }
    }
}

private struct DeviceAvailableRuntimeRow: View {
    let runtime: V2DeviceRuntime
    let connectorIsOnline: Bool
    let isBusy: Bool
    let onConfigure: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(.secondary.opacity(0.55))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 3) {
                Text(runtime.displayName)
                    .font(.body.weight(.medium))
                Text("Available to configure")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button(action: onConfigure) {
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Configure")
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .disabled(!connectorIsOnline || isBusy)
        }
        .padding(.vertical, 12)
    }
}

private struct RuntimePresenceDot: View {
    let runtime: V2DeviceRuntime

    var body: some View {
        Circle()
            .fill(runtime.status == .running ? Color.green : Color.secondary.opacity(0.55))
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

private struct DeviceRuntimeLoadingView: View {
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Loading runtimes...")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 18)
    }
}

private extension V2DeviceRuntimeStatus {
    var title: LocalizedStringResource {
        switch self {
        case .stopped: "Stopped"
        case .discovering: "Discovering"
        case .available: "Available"
        case .unavailable: "Unavailable"
        case .validating: "Validating"
        case .starting: "Starting"
        case .running: "Running"
        case .stopping: "Stopping"
        case .error: "Error"
        case .unknown: "Unknown"
        }
    }
}
