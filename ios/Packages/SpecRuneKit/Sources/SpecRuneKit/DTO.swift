import Foundation

/// `specrune task list --json` 的单条任务。
///
/// 字段与 `contracts/specrune/1.0` 的 `TaskListItem` 对齐；CLI 输出是
/// camelCase，故无需自定义 CodingKeys。缺省字段一律 optional，避免
/// CLI 版本差异导致整张列表解码失败。
public nonisolated struct SpecRuneTaskSummary: Decodable, Hashable, Sendable, Identifiable {
    public let dir: String
    public let name: String?
    public let title: String
    public let status: String
    public let priority: String?
    public let assignee: String?
    public let parent: String?
    public let children: [String]?
    public let childDone: Int?
    public let dependsOn: [String]?
    public let decomposeReason: String?
    public let implDone: Int?
    public let implTotal: Int?
    public let hasPrd: Bool?
    public let hasDesign: Bool?
    public let hasImplement: Bool?
    public let contextCount: Int?
    public let specRefs: [String]?
    public let createdAt: String?
    public let completedAt: String?
    public let archived: Bool?
    public let archiveMonth: String?
    public let active: Bool?
    /// 任务目录绝对路径（工作设备上）。后续读文档要用它。
    public let path: String

    public var id: String { dir }
}

/// `specrune task list --json` 的顶层。
///
/// `tasks` / `archive` 在空项目上可能是 `null`（不是空数组）——真机实测
/// `DecodingError.valueNotFound ... Path: tasks`。所以自定义解码把 null
/// 与缺失都归一成空数组，别让一个空项目把整页打成错误态。
public nonisolated struct SpecRuneTaskList: Decodable, Hashable, Sendable {
    public let tasks: [SpecRuneTaskSummary]
    public let archive: [SpecRuneTaskSummary]

    public init(tasks: [SpecRuneTaskSummary], archive: [SpecRuneTaskSummary]) {
        self.tasks = tasks
        self.archive = archive
    }

    private enum CodingKeys: String, CodingKey {
        case tasks, archive
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try container.decodeIfPresent([SpecRuneTaskSummary].self, forKey: .tasks) ?? []
        archive = try container.decodeIfPresent([SpecRuneTaskSummary].self, forKey: .archive) ?? []
    }
}

/// 任务文档正文（`prd.md` / `design.md` / `implement.md` / `record.md` / `research.md`）。
public nonisolated struct SpecRuneDoc: Hashable, Sendable {
    public let content: String
    public let truncated: Bool

    public init(content: String, truncated: Bool = false) {
        self.content = content
        self.truncated = truncated
    }
}

/// 上下文清单的一行（`implement.jsonl` / `check.jsonl`）。
///
/// `example` 为 true 表示模板占位行（行内含 `_example`），界面显示成「示例」。
public nonisolated struct SpecRuneContextRow: Hashable, Sendable, Identifiable {
    public let file: String
    public let reason: String
    public let example: Bool

    public var id: String { "\(file)|\(reason)|\(example)" }

    public init(file: String, reason: String, example: Bool) {
        self.file = file
        self.reason = reason
        self.example = example
    }
}

/// 任务详情：CLI 摘要 + 文档正文 + 上下文清单。
public nonisolated struct SpecRuneTaskDetail: Hashable, Sendable {
    public let summary: SpecRuneTaskSummary
    public let docs: [SpecRuneDocKind: SpecRuneDoc]
    /// implement.jsonl + check.jsonl 合并（与面板概览「上下文」同源）。
    public let context: [SpecRuneContextRow]

    public init(
        summary: SpecRuneTaskSummary,
        docs: [SpecRuneDocKind: SpecRuneDoc],
        context: [SpecRuneContextRow] = []
    ) {
        self.summary = summary
        self.docs = docs
        self.context = context
    }
}

/// 任务产物文档种类。顺序即界面标签顺序。
public nonisolated enum SpecRuneDocKind: String, CaseIterable, Hashable, Sendable {
    case prd
    case design
    case implement
    case record
    case research
    /// 评审台账（`review.md`）。与其他文档一样按需读取。
    case review

    public var fileName: String { "\(rawValue).md" }

    public var label: String {
        switch self {
        case .prd: "PRD"
        case .design: "设计"
        case .implement: "实施"
        case .record: "记录"
        case .research: "调研"
        case .review: "审查"
        }
    }
}

/// 会话↔任务关联。
public nonisolated struct SpecRuneSessionTask: Decodable, Hashable, Sendable {
    public let taskRef: String
    public let title: String?
    public let createdAt: String?
}
