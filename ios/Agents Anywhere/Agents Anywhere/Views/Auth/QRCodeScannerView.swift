import AVFoundation
import SwiftUI
import UIKit

struct QRCodeScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = onCode
        controller.onError = onError
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didReadCode = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureScanner()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.stopRunning()
            }
        }
    }

    private func configureScanner() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setupCaptureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.setupCaptureSession()
                    } else {
                        self?.onError?("Camera access is required to scan the login QR code.")
                    }
                }
            }
        case .denied, .restricted:
            onError?("Camera access is required to scan the login QR code.")
        @unknown default:
            onError?("Camera is not available.")
        }
    }

    private func setupCaptureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onError?("Camera is not available.")
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                onError?("Camera input is not available.")
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                onError?("QR scanner output is not available.")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            previewLayer = layer

            addOverlay()
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        } catch {
            onError?(error.localizedDescription)
        }
    }

    private func addOverlay() {
        let label = UILabel()
        label.text = "Scan Agents Anywhere QR"
        label.textColor = .white
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)

        let box = UIView()
        box.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        box.layer.borderWidth = 2
        box.layer.cornerRadius = 24
        box.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(box)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            box.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            box.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            box.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.68),
            box.heightAnchor.constraint(equalTo: box.widthAnchor),
        ])
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection,
    ) {
        guard !didReadCode else { return }
        guard
            let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            object.type == .qr,
            let value = object.stringValue
        else {
            return
        }
        didReadCode = true
        session.stopRunning()
        onCode?(value)
    }
}

