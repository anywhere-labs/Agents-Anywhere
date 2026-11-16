import SwiftUI

/// 设备详情里的「端到端加密」：是否已配对、设备指纹，以及配对入口。
/// 是否显示由 `DeviceEncryptionModel.isVisible` 决定，由设备页负责加载。
struct DeviceEncryptionSection: View {
    let connector: V2Connector
    let status: E2EEDeviceEncryptionStatus
    let service: V2E2EEService
    let serverURL: URL
    let onChange: () -> Void
    @State private var pairing = false

    var body: some View {
        DeviceSection(String(localized: "e2ee.device.section")) {
            DevicePillButton(title: status.record == nil ? String(localized: "e2ee.device.pair")
                                                         : String(localized: "e2ee.device.repair")) { pairing = true }
        } content: {
            DeviceRows {
                statusRow
                if let record = status.record {
                    detailRow(String(localized: "e2ee.device.fingerprint"), value: record.fingerprint, monospaced: true)
                    if let date = Self.date(record.grantedAt) {
                        detailRow(String(localized: "e2ee.device.pairedAt"),
                                  value: date.formatted(date: .abbreviated, time: .shortened), monospaced: false)
                    }
                }
            }
        }
        .sheet(isPresented: $pairing, onDismiss: onChange) {
            E2EEPairSheet(deviceId: connector.id, deviceName: connector.name, serverURL: serverURL,
                          service: service, onPaired: onChange)
        }
    }

    private var statusRow: some View {
        HStack(alignment: .top, spacing: 12) {
            DeviceStatusDot(tone: status.record != nil ? .ok : (status.requiresEncryption ? .warning : .neutral))
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 3) {
                Text(status.record != nil ? String(localized: "e2ee.device.paired") : String(localized: "e2ee.device.notPaired"))
                    .font(.body.weight(.medium))
                if status.requiresEncryption && status.record == nil {
                    Text(String(localized: "e2ee.device.required"))
                        .font(.footnote).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private func detailRow(_ title: String, value: String, monospaced: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value).font(monospaced ? .footnote.monospaced() : .subheadline)
                .multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.vertical, 10).padding(.leading, 26)
        .accessibilityElement(children: .combine)
    }

    private static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return ISO8601DateFormatter().date(from: value) ?? fractional.date(from: value)
    }
}
