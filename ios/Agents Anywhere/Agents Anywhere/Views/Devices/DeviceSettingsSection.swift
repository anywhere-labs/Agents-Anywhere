import SwiftUI

/// Switches the user chooses for a desktop device. The Server keeps them and
/// hands them to the device, so they can be changed while it is offline.
struct DeviceSettingsSection: View {
    let model: DeviceSettingsModel
    let canWrite: Bool
    let onConfirmQuitOnShutdownChange: (Bool) -> Void

    var body: some View {
        DeviceSection(String(localized: "Device settings")) {
            if model.settings != nil {
                Toggle(isOn: Binding(
                    get: { model.settings?.confirmQuitOnShutdown ?? false },
                    set: onConfirmQuitOnShutdownChange
                )) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(String(localized: "Ask before quitting on shutdown"))
                            .font(.body.weight(.medium))
                        Text(String(localized: "When on, Agents Anywhere asks before quitting when the computer shuts down or restarts. When off, it quits right away and never blocks shutdown."))
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(.switch).tint(.green)
                .disabled(!canWrite || model.isSaving)
                .padding(.vertical, 10).frame(minHeight: 60)
            } else {
                DeviceEmptyText(text: model.loadError == nil
                    ? String(localized: "Loading device settings…")
                    : String(localized: "Couldn't load device settings."))
            }
        }
    }
}
