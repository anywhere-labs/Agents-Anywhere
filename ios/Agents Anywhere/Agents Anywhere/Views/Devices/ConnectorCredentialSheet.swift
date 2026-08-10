import SwiftUI
import UIKit

struct ConnectorCredentialSheet: View {
    @Environment(\.dismiss) private var dismiss

    let connector: V2Connector
    let connectorToken: String
    let serverURL: URL

    @State private var copiedField: ConnectorCredentialField?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Label("Connector disconnected", systemImage: "key.horizontal")
                        .font(.title2.weight(.semibold))

                    Text("The previous credential no longer works. Update the desktop Connector with these values before reconnecting it.")
                        .foregroundStyle(.secondary)

                    ConnectorCredentialValue(
                        title: "Server URL",
                        value: serverURL.absoluteString,
                        copied: copiedField == .serverURL,
                        onCopy: { copy(serverURL.absoluteString, field: .serverURL) }
                    )
                    ConnectorCredentialValue(
                        title: "Connector ID",
                        value: connector.id,
                        copied: copiedField == .connectorId,
                        onCopy: { copy(connector.id, field: .connectorId) }
                    )
                    ConnectorCredentialValue(
                        title: "Connector token",
                        value: connectorToken,
                        copied: copiedField == .connectorToken,
                        onCopy: { copy(connectorToken, field: .connectorToken) }
                    )

                    Label(
                        "This token is shown only now. Store it in the Connector configuration and do not share it.",
                        systemImage: "exclamationmark.shield"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .navigationTitle("New credential")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func copy(_ value: String, field: ConnectorCredentialField) {
        UIPasteboard.general.string = value
        copiedField = field
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

private enum ConnectorCredentialField: Hashable {
    case serverURL
    case connectorId
    case connectorToken
}

private struct ConnectorCredentialValue: View {
    let title: LocalizedStringResource
    let value: String
    let copied: Bool
    let onCopy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            HStack(alignment: .top, spacing: 10) {
                Text(value)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: onCopy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .accessibilityLabel(copied ? "Copied" : "Copy \(String(localized: title))")
            }
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
