import Foundation
import Testing

@testable import SpecRuneKit

/// 任务树与归档分组的回归测试。
///
/// 这几条覆盖的都是真机上真出过问题的路径：归档漏月、子任务层级错乱、
/// 父任务跨月时子任务消失。
@Suite("任务树")
struct TaskTreeTests {
    private func task(
        _ dir: String,
        parent: String? = nil,
        createdAt: String? = "2026-11-01",
        archiveMonth: String? = nil
    ) -> SpecRuneTaskSummary {
        SpecRuneTaskSummary(
            dir: dir,
            title: dir,
            status: "completed",
            parent: parent,
            createdAt: createdAt,
            archived: archiveMonth != nil,
            archiveMonth: archiveMonth,
            path: "/repo/.specrune/tasks/\(dir)"
        )
    }

    @Test("子任务挂在父任务下并逐层缩进")
    func nestsChildren() {
        let rows = SpecRuneTaskTree.rows(
            [task("parent"), task("child", parent: "parent"), task("grandchild", parent: "child")],
            descending: true
        )

        #expect(rows.map(\.task.dir) == ["parent", "child", "grandchild"])
        #expect(rows.map(\.depth) == [0, 1, 2])
    }

    @Test("父任务不在同一集合时，子任务当顶层")
    func promotesOrphans() {
        // 跨月归档：父在某月、子在某月，同组内找不到父。
        let rows = SpecRuneTaskTree.rows(
            [task("child", parent: "missing-parent", archiveMonth: "2026-10")],
            descending: true
        )

        #expect(rows.map(\.task.dir) == ["child"])
        #expect(rows.map(\.depth) == [0])
    }

    @Test("父任务互相指向时不无限递归")
    func survivesParentCycle() {
        let rows = SpecRuneTaskTree.rows(
            [task("a", parent: "b"), task("b", parent: "a")],
            descending: true
        )

        // 两个都是「父在集合内」，因此都不是根；环里没有根，结果为空但不会崩。
        #expect(rows.isEmpty)
    }

    @Test("排序方向可切换")
    func sortsByDirection() {
        let items = [task("old", createdAt: "2026-10-01"), task("new", createdAt: "2026-11-01")]

        #expect(SpecRuneTaskTree.rows(items, descending: true).map(\.task.dir) == ["new", "old"])
        #expect(SpecRuneTaskTree.rows(items, descending: false).map(\.task.dir) == ["old", "new"])
    }

    @Test("归档按月分组并按月倒序")
    func groupsArchiveByMonth() {
        let months = SpecRuneTaskTree.archiveMonths(
            [
                task("a", archiveMonth: "2026-09"),
                task("b", archiveMonth: "2026-11"),
                task("c", archiveMonth: "2026-11"),
                task("d", archiveMonth: "2026-10"),
            ],
            descending: true
        )

        #expect(months.map(\.month) == ["2026-11", "2026-10", "2026-09"])
        #expect(months.first?.tasks.count == 2)
    }

    @Test("缺 archiveMonth 归到「未知」组")
    func groupsUnknownMonth() {
        let months = SpecRuneTaskTree.archiveMonths([task("a")], descending: true)
        #expect(months.map(\.month) == ["未知"])
    }

    @Test("空输入返回空")
    func handlesEmpty() {
        #expect(SpecRuneTaskTree.rows([], descending: true).isEmpty)
        #expect(SpecRuneTaskTree.archiveMonths([], descending: true).isEmpty)
    }
}
