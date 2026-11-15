import Foundation

/// 取数失败的分类。
///
/// 因为走的是通用 `shell/exec`，拿不到结构化错误码，所以分类在客户端按
/// 「退出码 + stderr 文本 + 解析结果」判定。UI 只需按 case 给出可读文案，
/// 不必理解底层细节。
public nonisolated enum SpecRuneError: Error, Hashable, Sendable {
    /// 工作设备上找不到 `specrune` 命令。
    case cliMissing
    /// CLI 执行失败，携带 stderr 摘要。
    case cliFailed(String)
    /// CLI 输出不是合法 JSON（项目损坏或 CLI 版本不符）。
    case badOutput(String)
    /// 输出被 `shell.exec` 的 64K 上限截断，JSON 可能不完整。
    case truncated
    /// 目标目录不是 SpecRune 项目（缺 `.specrune/workflow.md`）。
    case notSpecRuneProject
    /// 网络或连接失败。
    case offline(String)

    /// 面向用户的简短文案。
    public var message: String {
        switch self {
        case .cliMissing:
            "工作设备未安装 SpecRune"
        case let .cliFailed(detail):
            detail.isEmpty ? "SpecRune 执行失败" : "SpecRune 执行失败：\(detail)"
        case let .badOutput(detail):
            "无法读取任务数据：\(detail)"
        case .truncated:
            "任务过多，仅显示部分"
        case .notSpecRuneProject:
            "该项目未启用 SpecRune"
        case let .offline(detail):
            detail.isEmpty ? "无法连接工作设备" : "无法连接工作设备：\(detail)"
        }
    }
}

/// 判定一条失败的 shell 结果属于哪种错误。
///
/// 「命令不存在」在 macOS / Linux / Windows 上的 stderr 措辞不同，这里
/// 只匹配共同的关键片段；匹配不到就归为一般执行失败，避免把真实错误
/// 误报成「未安装」。
enum SpecRuneFailureClassifier {
    static func classify(exitCode: Int?, stderr: String, truncated: Bool) -> SpecRuneError {
        if truncated {
            return .truncated
        }
        // 127 是 shell 的「命令未找到」约定退出码，比匹配措辞可靠。
        if exitCode == 127 { return .cliMissing }
        let lower = stderr.lowercased()
        // 各家 shell 措辞不同：bash/zsh 是 "command not found"，dash 是
        // "dash: 1: x: not found"，Windows 是 "not recognized"，中文环境可能给「找不到」。
        let missingMarkers = [
            "command not found", "not found", "no such file", "not recognized", "找不到",
        ]
        if missingMarkers.contains(where: lower.contains) {
            return .cliMissing
        }
        let trimmed = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return .cliFailed(String(trimmed.prefix(300)))
    }
}
