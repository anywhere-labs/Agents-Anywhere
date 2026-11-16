import SwiftUI
import UIKit

/// 加密配对：扫设备上的二维码或粘贴 `aa-pair://` 链接，核对设备指纹后配对。
struct E2EEPairSheet: View {
    let deviceName: String?
    let service: V2E2EEService
    let onPaired: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var model: E2EEPairingModel
    @State private var scannerError: String?

    init(deviceId: String?, deviceName: String?, serverURL: URL?, service: V2E2EEService, onPaired: @escaping () -> Void) {
        self.deviceName = deviceName
        self.service = service
        self.onPaired = onPaired
        _model = State(initialValue: E2EEPairingModel(expectedDeviceId: deviceId, serverURL: serverURL))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let paired = model.paired {
                    success(paired)
                } else if model.payload != nil {
                    confirmation
                } else {
                    reader
                }
            }
            .scrollContentBackground(.hidden).scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: 560).frame(maxWidth: .infinity)
            .navigationTitle(String(localized: "e2ee.pair.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar(disabled: model.isPairing) { dismiss() } }
        }
        .appSheetPresentation(.expanded)
        .interactiveDismissDisabled(model.isPairing)
    }

    @ViewBuilder private var reader: some View {
        Section {
            Text(String(localized: "e2ee.pair.scanHint")).foregroundStyle(.secondary)
            QRCodeScannerView(onCode: { model.read($0) }, onError: { scannerError = $0 })
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .listRowInsets(EdgeInsets())
            if let scannerError { Text(scannerError).font(.footnote).foregroundStyle(.secondary) }
        } header: {
            if let deviceName { Text(deviceName).textCase(nil) }
        }
        Section {
            TextField(String(localized: "e2ee.pair.linkPlaceholder"), text: $model.link, axis: .vertical)
                .font(.footnote.monospaced()).lineLimit(1...4)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.done).onSubmit { model.read(model.link) }
            HStack(spacing: 12) {
                AppGlassButton(String(localized: "e2ee.pair.paste"), systemImage: "doc.on.doc") {
                    if let text = UIPasteboard.general.string { model.link = text; model.read(text) }
                }
                AppGlassButton(String(localized: "e2ee.pair.readLink"), systemImage: "link", style: .prominent,
                               disabled: model.link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    model.read(model.link)
                }
            }
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            if let parseError = model.parseError { Text(parseError).font(.footnote).foregroundStyle(.red) }
        }
    }

    @ViewBuilder private var confirmation: some View {
        Section {
            Text(model.fingerprint)
                .font(.title3.monospaced().weight(.semibold))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(String(localized: "e2ee.device.fingerprint"))
                .accessibilityValue(model.fingerprint)
        } header: {
            Text(String(localized: "e2ee.pair.fingerprintTitle")).textCase(nil)
        } footer: {
            Text(String(localized: "e2ee.pair.fingerprintHint"))
        }
        Section {
            if model.isForAnotherDevice { warning(String(localized: "e2ee.pair.otherDevice"), color: .red) }
            if model.isExpired { warning(String(localized: "e2ee.pair.expired"), color: .red) }
            if model.isForAnotherServer { warning(String(localized: "e2ee.pair.otherServer"), color: .orange) }
            AppGlassButton(String(localized: "e2ee.pair.pairButton"), systemImage: "checkmark.shield", style: .prominent,
                           isLoading: model.isPairing, disabled: !model.canPair) {
                Task {
                    await model.pair(service: service)
                    if model.paired != nil { onPaired() }
                }
            }
            AppGlassButton(String(localized: "e2ee.pair.rescan"), systemImage: "qrcode.viewfinder", disabled: model.isPairing) {
                model.reset()
            }
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
    }

    @ViewBuilder private func success(_ paired: E2EEDeviceTrust) -> some View {
        Section {
            Label(String(localized: "e2ee.device.paired"), appSymbol: "checkmark.shield").font(.headline)
            Text(String(localized: "e2ee.pair.success")).foregroundStyle(.secondary)
            LabeledContent(String(localized: "e2ee.device.fingerprint")) {
                Text(paired.fingerprint).font(.footnote.monospaced()).textSelection(.enabled)
            }
        }
        Section {
            AppGlassButton(String(localized: "e2ee.pair.done"), style: .prominent) { dismiss() }
        }
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
    }

    private func warning(_ text: String, color: Color) -> some View {
        Label(text, appSymbol: "exclamationmark.shield").font(.footnote).foregroundStyle(color)
    }
}
