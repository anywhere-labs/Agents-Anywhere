// Installed only in a disposable build by scripts/probe-composer-draft.py.
import SwiftUI
import UIKit
import Darwin

@main struct ComposerDraftProbeApp: App {
    private let services = V2ClientServices(api: V2APIClient(
        serverURL: URL(string: "http://127.0.0.1:1")!,
        tokenProvider: StaticAuthTokenProvider(token: nil)), accountID: "composer-probe")
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                SessionChatView(session: services.sessionRepository.session(id: "probe"),
                    services: services, deviceName: "Offline benchmark", onMenu: {})
            }.background(ComposerProbeDriver())
        }
    }
}

@MainActor enum ComposerProbe {
    static let legacy = ProcessInfo.processInfo.environment["AA_COMPOSER_BASELINE"] == "1"
    static var counts: [String: Int] = [:]
    static var characters = 0
    static var chat: SessionChatModel?
    static func hit(_ name: String) { counts[name, default: 0] += 1 }
    static func configure(_ model: SessionChatModel) {
        chat = model
        let text = String(repeating: "这是固定的中文历史消息，用于测量输入时的会话页面更新。工具保持折叠，内容不再流式输出。English text and **Markdown**.\n\n", count: 12)
        var items: [V2TimelineItem] = []
        for index in 0..<24 {
            let tool = index % 3 == 1
            let content: [String: Any] = tool
                ? ["kind": "command", "command": "rg test", "output": String(repeating: "done\n", count: 100)]
                : ["text": index % 3 == 0 ? "请检查这一部分。" : text]
            var value: [String: Any] = ["id": "row-\(index)", "sessionId": "probe",
                "type": tool ? "tool" : "message", "status": "done", "content": content,
                "orderSeq": index, "updatedSeq": index]
            if !tool { value["role"] = index % 3 == 0 ? "user" : "assistant" }
            items.append(try! JSONDecoder().decode(V2TimelineItem.self,
                from: JSONSerialization.data(withJSONObject: value)))
        }
        characters = text.count * 8
        model.timeline.presentOpening(items, pendingMessages: [])
        model.prepareComposerProbe()
    }
    static func cpu() -> Double {
        var value = rusage(); getrusage(RUSAGE_SELF, &value)
        return Double(value.ru_utime.tv_sec + value.ru_stime.tv_sec)
            + Double(value.ru_utime.tv_usec + value.ru_stime.tv_usec) / 1_000_000
    }
    static func report(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try! data.write(to: URL.documentsDirectory.appending(path: "composer-result.json"))
        print(String(data: data, encoding: .utf8)!); fflush(stdout)
    }
}

struct ComposerProbeDriver: UIViewRepresentable {
    func makeUIView(context: Context) -> ComposerProbeDriverView { ComposerProbeDriverView() }
    func updateUIView(_ view: ComposerProbeDriverView, context: Context) {}
}

final class ComposerProbeDriverView: UIView {
    private var started = false
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !started else { return }; started = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
            guard let window, let editor = descendants(window).compactMap({ $0 as? ComposerTextView }).first,
                  let chat = ComposerProbe.chat else {
                ComposerProbe.report(["error": "composer did not mount"]); return
            }
            editor.becomeFirstResponder()
            editor.insertText("起始 ")
            editor.delegate?.textViewDidChange?(editor)
            try? await Task.sleep(for: .seconds(2))
            ComposerProbe.counts = [:]
            let cpu = ComposerProbe.cpu(), start = CACurrentMediaTime()
            var intervals: [Double] = [], previous = start, markedUpdates = 0
            let syllables = ["n", "ni", "nih", "niha", "nihao", "你好"]
            for index in 0..<120 {
                let syllable = syllables[index % syllables.count]
                editor.setMarkedText(syllable, selectedRange: NSRange(location: (syllable as NSString).length, length: 0))
                if editor.markedTextRange != nil { markedUpdates += 1 }
                editor.delegate?.textViewDidChange?(editor)
                if index % syllables.count == syllables.count - 1 {
                    editor.unmarkText(); editor.delegate?.textViewDidChange?(editor)
                }
                try? await Task.sleep(for: .milliseconds(50))
                let now = CACurrentMediaTime(); intervals.append((now - previous) * 1000); previous = now
            }
            let elapsed = CACurrentMediaTime() - start, consumed = ComposerProbe.cpu() - cpu
            let counts = ComposerProbe.counts
            let finalText = editor.text ?? ""
            let textMatches = finalText == chat.session.composer.text
            let savesBeforeAttachment = ComposerProbe.counts["persistence", default: 0]
            chat.session.composer.attachments.append(ChatAttachment(name: "probe.txt", data: Data("probe".utf8), mediaType: "text/plain"))
            try? await Task.sleep(for: .milliseconds(200))
            let attachmentSaved = ComposerProbe.counts["persistence", default: 0] > savesBeforeAttachment
            intervals.sort()
            ComposerProbe.report(["baseline": ComposerProbe.legacy, "historyCharacters": ComposerProbe.characters,
                "updates": 120, "markedUpdates": markedUpdates, "cpuSeconds": consumed, "wallSeconds": elapsed,
                "stepP50ms": intervals[60], "stepP95ms": intervals[113], "stepMaxms": intervals.last!,
                "counts": counts, "draftMatchesEditor": textMatches, "attachmentCallback": attachmentSaved,
                "finalTextCharacters": finalText.count])
        }
    }
}
