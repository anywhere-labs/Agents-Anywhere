import SpecRuneKit
import SwiftUI

/// SpecRune「任务」屏。
///
/// 数据经 `SpecRuneKit` 从工作设备取：`shell/exec` 跑 CLI 拿摘要，
/// `fs/readText` 读文档正文。Connector 与 Server 均无改动。
///
/// 布局（swiftui-iphone-duo Tier 1）：
/// - `NavigationSplitView` 三栏，compact 自动合成单栈、regular（Duo 内屏）三栏；
/// - 不按设备/idiom/方向判定，宽度只来自容器；
/// - 详情正文 `maxWidth 700`，多余宽度给层级而非更长的行。
///
/// 动效（apple-design）：切换任务用 critically damped 弹簧，
/// `accessibilityReduceMotion` 时退化为无动画。
struct SpecRuneTasksView: View {
    let connectorId: V2ConnectorID
    /// 该设备上的全部项目；非 SpecRune 项目会在侧栏置灰。
    let projects: [V2Project]
    let api: any V2ConnectorAPIProtocol

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var model: SpecRuneBoardModel?
    /// 导航栈路径（元素是任务 ref）。单栏 push 详情。
    @State private var taskPath: [String] = []

    private var detailAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 1.0)
    }

    var body: some View {
        Group {
            if let model {
                board(model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            guard model == nil else { return }
            let transport = SpecRuneConnectorTransport(api: api, connectorId: connectorId)
            let board = SpecRuneBoardModel(client: SpecRuneClient(transport: transport), projects: projects)
            model = board
            await board.probeProjects()
            if let first = board.deviceProjects.first(where: { board.specRuneRepos[$0.workspacePath] == true }) {
                await board.select(repo: first.workspacePath)
            }
        }
    }

    // MARK: - 三栏

    private func board(_ model: SpecRuneBoardModel) -> some View {
        // 单栏 + push 详情：这个看板嵌在 app 的 detail 区域里，外面还有
        // 一条 app 侧栏。Duo 内屏横屏约 669pt，再并排两栏会把详情挤到不可见，
        // 所以列表与详情用导航栈串联，宽度全部留给当前页。
        NavigationStack(path: $taskPath) {
            taskColumn(model)
                .navigationDestination(for: String.self) { ref in
                    detailPage(model, ref: ref)
                }
        }
    }

    // MARK: - 项目切换（工具栏菜单）

    /// 项目切换器：列出该设备上的 SpecRune 项目，未启用的置灰。
    private func projectMenu(_ model: SpecRuneBoardModel) -> some View {
        Menu {
            ForEach(model.deviceProjects) { project in
                let enabled = model.specRuneRepos[project.workspacePath] == true
                Button {
                    taskPath.removeAll()
                    Task { await model.select(repo: project.workspacePath) }
                } label: {
                    if model.selectedRepo == project.workspacePath {
                        Label(project.name, appSymbol: "checkmark")
                    } else {
                        Text(verbatim: enabled ? project.name : "\(project.name)（未启用）")
                    }
                }
                .disabled(!enabled)
            }
        } label: {
            HStack(spacing: 4) {
                Text(verbatim: model.selectedRepo.flatMap { repo in
                    model.deviceProjects.first { $0.workspacePath == repo }?.name
                } ?? "选择项目")
                    .font(.subheadline.weight(.medium))
                AppSymbol("chevron.down", size: 11)
            }
        }
        .disabled(model.deviceProjects.isEmpty)
    }

    // MARK: - 任务列

    @ViewBuilder
    private func taskColumn(_ model: SpecRuneBoardModel) -> some View {
        if let repo = model.selectedRepo {
            switch model.listStates[repo] ?? .idle {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .navigationTitle(projectName(model, repo: repo))
            case let .failed(message):
                ContentUnavailableView("无法读取任务", appSymbol: "exclamationmark.triangle",
                                       description: Text(verbatim: message))
                    .navigationTitle(projectName(model, repo: repo))
            case let .loaded(list):
                taskList(model, repo: repo, list: list)
                    .navigationTitle(projectName(model, repo: repo))
                    .toolbar { ToolbarItem(placement: .principal) { projectMenu(model) } }
            }
        } else {
            ContentUnavailableView("未选择项目", appSymbol: "sidebar.left",
                                   description: Text("用上方菜单选择一个 SpecRune 项目"))
                .toolbar { ToolbarItem(placement: .principal) { projectMenu(model) } }
        }
    }

    private func projectName(_ model: SpecRuneBoardModel, repo: String) -> String {
        model.deviceProjects.first { $0.workspacePath == repo }?.name ?? "任务"
    }

    private func taskList(_ model: SpecRuneBoardModel, repo: String, list: SpecRuneTaskList) -> some View {
        List {
            let active = list.tasks.sorted(by: Self.newestFirst)
            let archived = list.archive.sorted(by: Self.newestFirst)
            if active.isEmpty && archived.isEmpty {
                ContentUnavailableView("暂无任务", appSymbol: "checkmark.circle",
                                       description: Text("这个项目还没有 SpecRune 任务"))
            }
            if !active.isEmpty {
                Section("进行中 · \(active.count)") {
                    ForEach(active) { task in
                        NavigationLink(value: task.dir) { SpecRuneTaskRow(task: task) }
                    }
                }
            }
            if !archived.isEmpty {
                Section("已归档 · \(archived.count)") {
                    ForEach(archived) { task in
                        NavigationLink(value: task.dir) { SpecRuneTaskRow(task: task) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// 新任务在前：有 createdAt 按日期倒序，否则保持 CLI 顺序。
    /// `nonisolated`：排序是纯函数，不该继承 View 的 MainActor 隔离，
    /// 否则在 `List` 的排序闭包里调用会触发 #ActorIsolatedCall 警告。
    private nonisolated static func newestFirst(_ lhs: SpecRuneTaskSummary, _ rhs: SpecRuneTaskSummary) -> Bool {
        (lhs.createdAt ?? "") > (rhs.createdAt ?? "")
    }

    // MARK: - 详情列

    @ViewBuilder
    private func detailPage(_ model: SpecRuneBoardModel, ref: String) -> some View {
        if let repo = model.selectedRepo {
            switch model.detail(repo: repo, ref: ref) {
            case .idle, .loading:
                // idle 与 loading 必须共用同一个视图树：分成两个分支时，
                // 状态从 idle 变 loading 会销毁 .task，请求被取消→回 idle→再触发，死循环。
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task(id: ref) { await model.loadDetail(repo: repo, ref: ref) }
            case let .failed(message):
                ContentUnavailableView("无法读取任务详情", appSymbol: "exclamationmark.triangle",
                                       description: Text(verbatim: message))
            case let .loaded(detail):
                SpecRuneTaskDetailView(detail: detail, repo: repo, model: model)
            }
        } else {
            ContentUnavailableView("未选择项目", appSymbol: "sidebar.left",
                                   description: Text("用上方菜单选择一个 SpecRune 项目"))
        }
    }
}

// MARK: - 任务行

private struct SpecRuneTaskRow: View {
    let task: SpecRuneTaskSummary
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Circle()
                    .fill(SpecRunePresentation.statusColor(task.status))
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(SpecRunePresentation.statusLabel(task.status))
                Text(verbatim: task.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let priority = task.priority {
                    SpecRunePriorityChip(priority: priority)
                }
            }
            HStack(spacing: 10) {
                if let progress = SpecRunePresentation.progress(task) {
                    SpecRuneProgressBar(done: progress.done, total: progress.total,
                                        tint: SpecRunePresentation.statusColor(task.status))
                        .frame(maxWidth: 100)
                    Text("\(progress.done)/\(progress.total) \(progress.label)")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        .lineLimit(1)
                }
                if let assignee = task.assignee, !assignee.isEmpty {
                    Label(assignee, appSymbol: "person.crop.circle")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let created = task.createdAt {
                    Text(verbatim: created)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

// MARK: - 详情

private struct SpecRuneTaskDetailView: View {
    let detail: SpecRuneTaskDetail
    let repo: String
    let model: SpecRuneBoardModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab: SpecRuneDocKind?
    /// 当前展开的规范路径（同一时刻只展开一条）。
    @State private var expandedSpec: String?

    private var summary: SpecRuneTaskSummary { detail.summary }

    private var availableDocs: [SpecRuneDocKind] {
        SpecRuneDocKind.allCases.filter { detail.docs[$0] != nil }
    }

    private var expandAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 1.0)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                overview
                if availableDocs.isEmpty {
                    Divider()
                    Text("该任务还没有产物文档")
                        .font(.footnote)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                } else {
                    Divider()
                    docTabs
                }
            }
            .padding(20)
            // Duo 宽屏：不拉伸正文，多余宽度留给三栏结构。
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .navigationTitle(summary.title)
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text(SpecRunePresentation.statusLabel(summary.status))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(AppTheme.groupedFill(colorScheme), in: .capsule)
                if let priority = summary.priority {
                    SpecRunePriorityChip(priority: priority)
                }
                Spacer()
                Text(verbatim: summary.dir)
                    .font(.caption.monospaced())
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
            }
            if let progress = SpecRunePresentation.progress(summary) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(progress.label).font(.subheadline.weight(.medium))
                        Spacer()
                        Text("\(progress.done) / \(progress.total)")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    }
                    ProgressView(value: Double(progress.done), total: Double(progress.total))
                }
            }
            HStack(spacing: 16) {
                if let assignee = summary.assignee, !assignee.isEmpty {
                    Label(assignee, appSymbol: "person.crop.circle")
                }
                if let created = summary.createdAt {
                    Label(created, appSymbol: "clock")
                }
            }
            .font(.footnote)
            .foregroundStyle(AppTheme.secondaryText(colorScheme))

            if let checklist = SpecRunePresentation.checklist(from: detail) {
                Divider()
                checklistSection(checklist)
            }
            if let refs = summary.specRefs, !refs.isEmpty {
                Divider()
                specSection(refs)
            }
        }
    }

    // MARK: - 规范引用

    private func specSection(_ refs: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("规范引用").font(.headline)
            ForEach(refs, id: \.self) { path in
                specRow(path)
            }
        }
    }

    private func specRow(_ path: String) -> some View {
        let isOpen = expandedSpec == path
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(expandAnimation) {
                    expandedSpec = isOpen ? nil : path
                }
                if !isOpen {
                    Task { await model.loadSpec(repo: repo, path: path) }
                }
            } label: {
                HStack(spacing: 6) {
                    AppSymbol(isOpen ? "chevron.down" : "chevron.right", size: 12)
                    Text(verbatim: name)
                        .font(.subheadline.monospaced())
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if isOpen {
                switch model.spec(repo: repo, path: path) {
                case .idle, .loading:
                    ProgressView().controlSize(.small)
                case let .failed(message):
                    Text(verbatim: message)
                        .font(.caption)
                        .foregroundStyle(.red)
                case let .loaded(file):
                    Text(verbatim: file.content)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if file.truncated {
                        Text("已截断：原文超过 1 MiB")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    }
                }
            }
        }
        .padding(.leading, 4)
    }

    private func checklistSection(_ items: [SpecRuneChecklistItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("验收清单").font(.headline)
                Spacer()
                Text("\(items.filter(\.checked).count)/\(items.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Label(item.text, appSymbol: item.checked ? "checkmark.square.fill" : "square")
                    .font(.subheadline)
                    .foregroundStyle(item.checked ? AppTheme.secondaryText(colorScheme) : .primary)
            }
        }
    }

    private var docTabs: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("文档", selection: Binding(
                get: { tab ?? availableDocs.first },
                set: { newValue in
                    withAnimation(expandAnimation) { tab = newValue }
                }
            )) {
                ForEach(availableDocs, id: \.self) { kind in
                    Text(kind.label).tag(Optional(kind))
                }
            }
            .pickerStyle(.segmented)

            if let current = tab ?? availableDocs.first, let doc = detail.docs[current] {
                Text(verbatim: doc.content)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if doc.truncated {
                    Text("已截断：原文超过 1 MiB")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                }
            }
        }
    }
}

// MARK: - 展示派生（UI 语义，不进 SpecRuneKit）

private enum SpecRunePresentation {
    static func statusLabel(_ status: String) -> String {
        switch status {
        case "planning": "规划中"
        case "in_progress": "进行中"
        case "completed": "已完成"
        case "blocked": "受阻"
        default: status
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "planning": .secondary.opacity(0.6)
        case "in_progress": .blue
        case "completed": .green
        case "blocked": .orange
        default: .secondary
        }
    }

    /// 进度：有子任务用子任务，否则用 implement 清单（与面板同口径）。
    static func progress(_ task: SpecRuneTaskSummary) -> (done: Int, total: Int, label: String)? {
        let childTotal = task.children?.count ?? 0
        if childTotal > 0 {
            return (task.childDone ?? 0, childTotal, "子任务")
        }
        let implTotal = task.implTotal ?? 0
        if implTotal > 0 {
            return (task.implDone ?? 0, implTotal, "实施清单")
        }
        return nil
    }

    /// 从 implement.md 解析 `- [ ]` 勾选项（与面板 parseChecklist 同规则）。
    static func checklist(from detail: SpecRuneTaskDetail) -> [SpecRuneChecklistItem]? {
        guard let markdown = detail.docs[.implement]?.content else { return nil }
        var items: [SpecRuneChecklistItem] = []
        var inFence = false
        for line in markdown.replacingOccurrences(of: "\r", with: "").split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inFence.toggle()
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("- [") || trimmed.hasPrefix("* [") || trimmed.hasPrefix("+ [") {
                guard trimmed.count > 5 else { continue }
                let checkedChar = trimmed[trimmed.index(trimmed.startIndex, offsetBy: 3)]
                let checked = checkedChar == "x" || checkedChar == "X"
                let text = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                items.append(SpecRuneChecklistItem(checked: checked, text: text))
            } else if !inFence, !items.isEmpty, line.hasPrefix("  "), !trimmed.isEmpty {
                // 续行并入上一条，与面板行为一致。
                let last = items.removeLast()
                items.append(SpecRuneChecklistItem(checked: last.checked, text: last.text + " " + trimmed))
            }
        }
        return items.isEmpty ? nil : items
    }
}

struct SpecRuneChecklistItem {
    let checked: Bool
    let text: String
}

private struct SpecRunePriorityChip: View {
    let priority: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Text(verbatim: priority)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(
                priority == "P0" ? Color.red.opacity(0.16) : AppTheme.groupedFill(colorScheme),
                in: .rect(cornerRadius: 5)
            )
            .foregroundStyle(priority == "P0" ? Color.red : AppTheme.secondaryText(colorScheme))
    }
}

private struct SpecRuneProgressBar: View {
    let done: Int
    let total: Int
    let tint: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(AppTheme.groupedFill(colorScheme))
                Capsule().fill(tint.opacity(0.7))
                    .frame(width: geo.size.width * ratio)
            }
        }
        .frame(height: 4)
    }

    private var ratio: CGFloat {
        guard total > 0 else { return 0 }
        return min(1, CGFloat(done) / CGFloat(total))
    }
}
