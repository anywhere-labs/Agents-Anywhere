import AAClientCore
import AVFoundation
import SwiftUI
import UIKit

/// Pair with an encrypted device by scanning the `aa-pair://v1/…` QR code it shows (or pasting the link).
/// The device key comes only from that code; the first handshake is Noise IKpsk2, later ones IK.
struct PairingView: View {
    let expectedDeviceID: String?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .scanning
    @State private var pasted = ""

    enum Phase: Equatable {
        case scanning
        case pairing(String)
        case done(deviceName: String, fingerprint: String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .scanning:
                    scanner
                case .pairing(let name):
                    VStack(spacing: 16) {
                        ProgressView()
                        Text("正在与「\(name)」建立端到端加密连接…")
                        Text("如果工作设备要求本机确认，请在那台设备上点「允许」。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .multilineTextAlignment(.center)
                    .padding()
                case .done(let name, let fingerprint):
                    ContentUnavailableView {
                        Label("已配对", systemImage: "lock.fill").foregroundStyle(.green)
                    } description: {
                        VStack(spacing: 8) {
                            Text("「\(name)」与本机之间的对话现在端到端加密，服务端看不到内容。")
                            Text("设备公钥指纹").font(.caption).foregroundStyle(.secondary)
                            Text(fingerprint).font(.caption.monospaced())
                        }
                    } actions: {
                        Button("完成") { dismiss() }.buttonStyle(.borderedProminent)
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("配对没有成功", systemImage: "exclamationmark.lock")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("重新扫描") { phase = .scanning }.buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("配对加密设备")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
            }
        }
    }

    private var scanner: some View {
        VStack(spacing: 16) {
            QRScannerView { code in pair(code) }
                .frame(maxWidth: .infinity)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(.rect(cornerRadius: 24))
                .overlay {
                    RoundedRectangle(cornerRadius: 24).strokeBorder(.secondary.opacity(0.4), lineWidth: 1)
                }
            Text("在工作设备上打开「添加客户端」，把它显示的二维码放进框内。二维码只在那台设备上生成，不经过服务端。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack {
                TextField("或粘贴 aa-pair:// 链接", text: $pasted)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                Button("配对") { pair(pasted) }
                    .buttonStyle(.bordered)
                    .disabled(!pasted.hasPrefix("aa-pair://"))
            }
            Spacer()
        }
        .padding()
    }

    private func pair(_ code: String) {
        guard case .scanning = phase, let services = model.services else { return }
        let payload: PairingPayload
        do {
            payload = try PairingPayload.parse(code)
        } catch {
            phase = .failed(AppModel.describe(error))
            return
        }
        if let expectedDeviceID, expectedDeviceID != payload.instanceID {
            phase = .failed("这个二维码属于另一台设备。")
            return
        }
        let name = model.device(payload.instanceID)?.name ?? "工作设备"
        phase = .pairing(name)
        Task {
            do {
                let status = try await services.tunnels.pair(uri: code, deviceNameHint: model.device(payload.instanceID)?.name)
                model.trustChanged()
                Haptics.play("success")
                phase = .done(deviceName: status.deviceName, fingerprint: KeyFingerprint.format(payload.devicePub))
                await model.refreshSessions()
            } catch {
                Haptics.play("warning")
                phase = .failed(AppModel.describe(error))
            }
        }
    }
}

/// Camera QR reader (AVFoundation). Shows a notice when the camera is unavailable (Simulator, or denied).
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.configure() : self.showNotice("没有相机权限。可以在系统设置里允许，或粘贴配对链接。") }
            }
        }

        private func configure() {
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input)
            else {
                showNotice("这台设备没有可用的相机，请粘贴配对链接。")
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        private func showNotice(_ text: String) {
            let label = UILabel()
            label.text = text
            label.textColor = .white
            label.numberOfLines = 0
            label.textAlignment = .center
            label.font = .preferredFont(forTextStyle: .footnote)
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
                label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            ])
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
            MainActor.assumeIsolated {
                guard !delivered, let value, value.hasPrefix("aa-pair://") else { return }
                delivered = true
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onCode?(value)
            }
        }
    }
}
