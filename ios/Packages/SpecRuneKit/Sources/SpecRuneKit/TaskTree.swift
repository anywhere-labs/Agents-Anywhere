import Foundation

/// 任务树与归档分组——纯数据逻辑，与 UI 无关。
///
/// 抽到包里是为了可测：真机上出现过的「归档漏月」「工作流条目不全」都出在
/// 这类结构变换上，而它们原先写在 View 里，只能靠肉眼截图验证。
public nonisolated enum SpecRuneTaskTree {
    /// 树中的一行：任务 + 缩进层级（面板每层缩进 16pt）。
    public struct Row: Identifiable, Hashable, Sendable {
        public let task: SpecRuneTaskSummary
        public let depth: Int

        public var id: String { task.dir }

        public init(task: SpecRuneTaskSummary, depth: Int) {
            self.task = task
            self.depth = depth
        }
    }

    /// 归档月组。
    public struct ArchiveMonth: Identifiable, Hashable, Sendable {
        public let month: String
        public let tasks: [SpecRuneTaskSummary]

        public var id: String { month }

        public init(month: String, tasks: [SpecRuneTaskSummary]) {
            self.month = month
            self.tasks = tasks
        }
    }

    /// 按 `parent` 在**同一集合内**收树。
    ///
    /// 父不在集合里时子任务当顶层——跨月归档就是这种情况（父在某月、子在
    /// 另一月，强行挂到别的组里反而找不到）。
    public static func rows(_ tasks: [SpecRuneTaskSummary], descending: Bool) -> [Row] {
        let present = Set(tasks.map(\.dir))
        var childrenByParent: [String: [SpecRuneTaskSummary]] = [:]
        for task in tasks {
            guard let parent = task.parent, present.contains(parent) else { continue }
            childrenByParent[parent, default: []].append(task)
        }

        let byDate: (SpecRuneTaskSummary, SpecRuneTaskSummary) -> Bool = { lhs, rhs in
            let left = lhs.createdAt ?? ""
            let right = rhs.createdAt ?? ""
            return descending ? left > right : left < right
        }

        let roots = tasks
            .filter { task in
                guard let parent = task.parent else { return true }
                return !present.contains(parent)
            }
            .sorted(by: byDate)

        var rows: [Row] = []
        var visited = Set<String>()
        func append(_ task: SpecRuneTaskSummary, depth: Int) {
            // 防御环：parent 互相指向时（数据损坏）不至于无限递归。
            guard visited.insert(task.dir).inserted else { return }
            rows.append(Row(task: task, depth: depth))
            for child in (childrenByParent[task.dir] ?? []).sorted(by: byDate) {
                append(child, depth: depth + 1)
            }
        }
        for root in roots { append(root, depth: 0) }
        return rows
    }

    /// 归档按月分组，月组按月份倒序/正序。
    public static func archiveMonths(_ archive: [SpecRuneTaskSummary], descending: Bool) -> [ArchiveMonth] {
        let grouped = Dictionary(grouping: archive) { $0.archiveMonth ?? "未知" }
        let months = grouped.keys.sorted { descending ? $0 > $1 : $0 < $1 }
        return months.map { ArchiveMonth(month: $0, tasks: grouped[$0] ?? []) }
    }
}
