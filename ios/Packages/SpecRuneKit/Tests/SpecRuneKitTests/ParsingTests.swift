import Foundation
import Testing

@testable import SpecRuneKit

/// 错误分类与 jsonl 解析的回归测试。
///
/// 这两处是「静默失败」高发区：分类判错会显示成「未安装」，解析判错会
/// 让上下文清单少条目或混入示例行。
@Suite("错误分类")
struct FailureClassifierTests {
    @Test("dash 的 not found 判为 CLI 缺失")
    func detectsDashNotFound() {
        let error = SpecRuneFailureClassifier.classify(
            exitCode: 1,
            stderr: "dash: 1: specrune: not found",
            truncated: false
        )
        #expect(isCLIMissing(error))
    }

    @Test("bash/zsh 的 command not found 判为 CLI 缺失")
    func detectsBashNotFound() {
        let error = SpecRuneFailureClassifier.classify(
            exitCode: 127,
            stderr: "zsh: command not found: specrune",
            truncated: false
        )
        #expect(isCLIMissing(error))
    }

    @Test("退出码 127 即使 stderr 为空也判为 CLI 缺失")
    func detectsExit127() {
        let error = SpecRuneFailureClassifier.classify(exitCode: 127, stderr: "", truncated: false)
        #expect(isCLIMissing(error))
    }

    @Test("其它非零退出保留 stderr 摘要")
    func keepsStderr() {
        let error = SpecRuneFailureClassifier.classify(
            exitCode: 2,
            stderr: "fatal: not a git repository",
            truncated: false
        )
        guard case let .cliFailed(detail) = error else {
            Issue.record("期望 cliFailed，实际 \(error)")
            return
        }
        #expect(detail.contains("not a git repository"))
    }

    @Test("截断优先于退出码判断")
    func truncatedWins() {
        let error = SpecRuneFailureClassifier.classify(exitCode: 0, stderr: "", truncated: true)
        guard case .truncated = error else {
            Issue.record("期望 truncated，实际 \(error)")
            return
        }
    }

    @Test("错误文案非空")
    func hasMessage() {
        for error in [SpecRuneError.cliMissing, .truncated, .notSpecRuneProject] {
            #expect(!error.message.isEmpty)
        }
    }

    private func isCLIMissing(_ error: SpecRuneError) -> Bool {
        if case .cliMissing = error { return true }
        return false
    }
}

@Suite("上下文 jsonl 解析")
struct ContextParsingTests {
    @Test("解析正常行并保留 file 与 reason")
    func parsesRows() {
        let rows = SpecRuneClient.parseContextRows(
            """
            {"file":"a.py","reason":"改这里"}
            {"path":"b.py","description":"用 path 字段"}
            """
        )

        #expect(rows.count == 2)
        #expect(rows[0].file == "a.py")
        #expect(rows[0].reason == "改这里")
        #expect(rows[1].file == "b.py")
        #expect(rows[1].reason == "用 path 字段")
        #expect(rows.allSatisfy { !$0.example })
    }

    @Test("_example 行标记为示例")
    func marksExample() {
        let rows = SpecRuneClient.parseContextRows(#"{"_example":true}"#)

        #expect(rows.count == 1)
        #expect(rows[0].example)
        #expect(rows[0].file.isEmpty)
    }

    @Test("坏行与缺 file 的行被跳过")
    func skipsBadLines() {
        let rows = SpecRuneClient.parseContextRows(
            """
            not json
            {"reason":"没有 file 字段"}
            {"file":"ok.py"}

            """
        )

        #expect(rows.count == 1)
        #expect(rows[0].file == "ok.py")
    }

    @Test("空输入返回空")
    func handlesEmpty() {
        #expect(SpecRuneClient.parseContextRows("").isEmpty)
    }
}
