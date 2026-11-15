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
public nonisolated struct SpecRuneTaskList: Decodable, Hashable, Sendable {
    public let tasks: [SpecRuneTaskSummary]
    public let archive: [SpecRuneTaskSummary]

    public init(tasks: [SpecRuneTaskSummary], archive: [SpecRuneTaskSummary]) {
        self.tasks = tasks
        self.archive = archive
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

/// 任务详情：CLI 摘要 + 文档正文。
public nonisolated struct SpecRuneTaskDetail: Hashable, Sendable {
    public let summary: SpecRuneTaskSummary
    public let docs: [SpecRuneDocKind: SpecRuneDoc]

    public init(summary: SpecRuneTaskSummary, docs: [SpecRuneDocKind: SpecRuneDoc]) {
        self.summary = summary
        self.docs = docs
    }
}

/// 任务产物文档种类。顺序即界面标签顺序。
public nonisolated enum SpecRuneDocKind: String, CaseIterable, Hashable, Sendable {
    case prd
    case design
    case implement
    case record
    case research

    public var fileName: String { "\(rawValue).md" }

    public var label: String {
        switch self {
        case .prd: "PRD"
        case .design: "设计"
        case .implement: "实施"
        case .record: "记录"
        case .research: "调研"
        }
    }
}

/// 会话↔任务关联。
public nonisolated struct SpecRuneSessionTask: Decodable, Hashable, Sendable {
    public let taskRef: String
    public let title: String?
    public let createdAt: String?
}
