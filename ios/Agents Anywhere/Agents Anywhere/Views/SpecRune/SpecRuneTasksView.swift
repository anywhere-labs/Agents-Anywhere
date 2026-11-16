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
    /// 打开 app 侧栏（Duo 内屏双栏时是切换，外屏抽屉时是展开）。
    let onMenu: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Duo 横屏时系统把 toolbar 收编成右缘竖排；页面必须把 rail 按钮
    /// 经 ChatPageToolbar 注入，否则新会话/账号入口会消失。
    @Environment(\.chatRail) private var chatRail

    @State private var model: SpecRuneBoardModel?
    /// 导航栈路径（元素是任务 ref）。单栏 push 详情。
    @State private var taskPath: [String] = []
    /// 归档段默认折叠（与面板一致：进来先看活跃任务）。
    @State private var archiveExpanded = false
    /// 已展开的归档月份组。
    @State private var expandedMonths: Set<String> = []
    /// 排序方向：默认从晚到早。
    @State private var sortDescending = true

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
            await selectFirstProjectIfNeeded(board)
        }
        // dashboard 后到：项目列表变了要推给 Model，否则看板永远停在空列表。
        .onChange(of: projects) { _, newValue in
            guard let model else { return }
            model.updateProjects(newValue)
            Task {
                await model.probeProjects()
                await selectFirstProjectIfNeeded(model)
            }
        }
    }

    /// 还没有选中项目时，自动选第一个确认是 SpecRune 的项目。
    private func selectFirstProjectIfNeeded(_ model: SpecRuneBoardModel) async {
        guard model.selectedRepo == nil else { return }
        guard let first = model.deviceProjects.first(where: { model.specRuneRepos[$0.workspacePath] == true })
        else { return }
        await model.select(repo: first.workspacePath)
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
                // 直接显示当前项目的目录名：不依赖 deviceProjects 反查，
                // 后者与 selectedRepo 不同步时会退化成「选择项目」。
                Text(verbatim: model.selectedRepo.map { ($0 as NSString).lastPathComponent } ?? "选择项目")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                AppSymbol("chevron.down", size: 11)
            }
        }
    }

    // MARK: - 任务列

    @ViewBuilder
    private func taskColumn(_ model: SpecRuneBoardModel) -> some View {
        Group {
            if let repo = model.selectedRepo {
                switch model.listStates[repo] ?? .idle {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .failed(message):
                    ContentUnavailableView("无法读取任务", appSymbol: "exclamationmark.triangle",
                                           description: Text(verbatim: message))
                case let .loaded(list):
                    taskList(model, repo: repo, list: list)
                }
            } else {
                ContentUnavailableView("未选择项目", appSymbol: "sidebar.left",
                                       description: Text("用上方菜单选择一个 SpecRune 项目"))
            }
        }
        // 用 app 统一的页面工具栏：它负责把 rail 按钮送进 Duo 右缘竖排，
        // 并处理抽屉形态下导航栏被卡片位移重画的问题。
        // 标题固定「SpecRune」，当前项目在右侧菜单里显示——两者都写项目名会重复。
        .modifier(ChatPageToolbar(
            title: "SpecRune",
            onMenu: onMenu,
            railTrailing: chatRail.map { chatRailButtons($0) } ?? [],
            // 项目切换放页面尾部（右上角）。试过塞进 railTrailing，但
            // ChatRailButton 用 AnyView 包住，@Observable 追踪断掉，
            // 菜单会一直显示旧状态（实测停在「选择项目」）。
            pageTrailing: [AnyView(projectMenu(model))]
        ))
    }

    private func projectName(_ model: SpecRuneBoardModel, repo: String) -> String {
        model.deviceProjects.first { $0.workspacePath == repo }?.name ?? "任务"
    }

    private func taskList(_ model: SpecRuneBoardModel, repo: String, list: SpecRuneTaskList) -> some View {
        let activeRows = Self.treeRows(list.tasks, descending: sortDescending)
        let groups = Self.archiveGroups(list.archive, descending: sortDescending)
        return List {
            if list.tasks.isEmpty && list.archive.isEmpty {
                ContentUnavailableView("暂无任务", appSymbol: "checkmark.circle",
                                       description: Text("这个项目还没有 SpecRune 任务"))
            }
            if !list.tasks.isEmpty {
                Section {
                    ForEach(activeRows) { row in
                        NavigationLink(value: row.task.dir) {
                            SpecRuneTaskRow(task: row.task, depth: row.depth)
                        }
                    }
                } header: {
                    HStack(spacing: 8) {
                        Text("工作流 · \(list.tasks.count)")
                        Spacer()
                        Button {
                            sortDescending.toggle()
                        } label: {
                            HStack(spacing: 2) {
                                Text(sortDescending ? "从晚到早" : "从早到晚")
                                AppSymbol(sortDescending ? "chevron.down" : "chevron.up", size: 9)
                            }
                            .font(.caption)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if !groups.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $archiveExpanded) {
                        ForEach(groups) { group in
                            DisclosureGroup(isExpanded: monthBinding(group.month)) {
                                ForEach(Self.treeRows(group.tasks, descending: sortDescending)) { row in
                                    NavigationLink(value: row.task.dir) {
                                        SpecRuneTaskRow(task: row.task, depth: row.depth, isArchived: true)
                                    }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Text(verbatim: group.month)
                                    Spacer(minLength: 4)
                                    Text("\(group.tasks.count)")
                                        .font(.caption)
                                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                                }
                                .font(.subheadline)
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text("归档")
                            Spacer(minLength: 4)
                            Text("\(list.archive.count)")
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        }
                        .font(.subheadline.weight(.medium))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func monthBinding(_ month: String) -> Binding<Bool> {
        Binding(
            get: { expandedMonths.contains(month) },
            set: { open in
                if open { expandedMonths.insert(month) } else { expandedMonths.remove(month) }
            }
        )
    }

    // MARK: - 树与分组（对齐面板：子任务缩进、归档按月分组）

    /// 一行树：任务 + 缩进层级。
    struct TaskTreeRow: Identifiable {
        let task: SpecRuneTaskSummary
        let depth: Int
        var id: String { task.dir }
    }

    /// 归档月组。
    struct ArchiveGroup: Identifiable {
        let month: String
        let tasks: [SpecRuneTaskSummary]
        var id: String { month }
    }

    /// 按 `parent` 在**同一集合内**收树：父不在集合里就当顶层（跨月归档即如此）。
    nonisolated static func treeRows(_ tasks: [SpecRuneTaskSummary], descending: Bool) -> [TaskTreeRow] {
        let present = Set(tasks.map(\.dir))
        var childrenByParent: [String: [SpecRuneTaskSummary]] = [:]
        for task in tasks {
            guard let parent = task.parent, present.contains(parent) else { continue }
            childrenByParent[parent, default: []].append(task)
        }
        let byDate: (SpecRuneTaskSummary, SpecRuneTaskSummary) -> Bool = { lhs, rhs in
            let l = lhs.createdAt ?? ""
            let r = rhs.createdAt ?? ""
            return descending ? l > r : l < r
        }
        let roots = tasks
            .filter { task in
                guard let parent = task.parent else { return true }
                return !present.contains(parent)
            }
            .sorted(by: byDate)

        var rows: [TaskTreeRow] = []
        func append(_ task: SpecRuneTaskSummary, depth: Int) {
            rows.append(TaskTreeRow(task: task, depth: depth))
            for child in (childrenByParent[task.dir] ?? []).sorted(by: byDate) {
                append(child, depth: depth + 1)
            }
        }
        for root in roots { append(root, depth: 0) }
        return rows
    }

    /// 归档按月分组，月组自身按月份倒序/正序。
    nonisolated static func archiveGroups(_ archive: [SpecRuneTaskSummary], descending: Bool) -> [ArchiveGroup] {
        let grouped = Dictionary(grouping: archive) { $0.archiveMonth ?? "未知" }
        let months = grouped.keys.sorted { descending ? $0 > $1 : $0 < $1 }
        return months.map { ArchiveGroup(month: $0, tasks: grouped[$0] ?? []) }
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
    /// 子任务缩进层级（面板：每层 16pt）。
    var depth: Int = 0
    var isArchived: Bool = false
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
        .padding(.leading, CGFloat(depth) * 16)
    }
}

// MARK: - 详情

private struct SpecRuneTaskDetailView: View {
    let detail: SpecRuneTaskDetail
    let repo: String
    let model: SpecRuneBoardModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab: DetailTab = .overview
    /// 当前展开的规范路径（同一时刻只展开一条）。
    @State private var expandedSpec: String?

    /// 详情维度：概览 + 每种存在的产物文档，与 Mac 面板的标签条一致。
    enum DetailTab: Hashable {
        case overview
        case doc(SpecRuneDocKind)
    }

    private var summary: SpecRuneTaskSummary { detail.summary }

    private var availableDocs: [SpecRuneDocKind] {
        SpecRuneDocKind.allCases.filter { detail.docs[$0] != nil }
    }

    private var tabs: [DetailTab] {
        [.overview] + availableDocs.map(DetailTab.doc)
    }

    private func tabLabel(_ value: DetailTab) -> String {
        switch value {
        case .overview: "概览"
        case let .doc(kind): kind.label
        }
    }

    private var expandAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 1.0)
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch tab {
                    case .overview:
                        overview
                        if availableDocs.isEmpty {
                            Text("该任务还没有产物文档")
                                .font(.footnote)
                                .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        }
                    case let .doc(kind):
                        docBody(kind)
                    }
                }
                .padding(20)
                // 宽屏不拉伸正文，多余宽度留给外层结构。
                .frame(maxWidth: 700, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .navigationTitle(summary.title)
    }

    /// 标签条：横向滚动，选中的一项加底色（对应 Mac 面板的维度标签）。
    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(tabs, id: \.self) { value in
                    let isSelected = tab == value
                    Button {
                        withAnimation(expandAnimation) { tab = value }
                    } label: {
                        Text(tabLabel(value))
                            .font(.subheadline.weight(isSelected ? .semibold : .regular))
                            .foregroundStyle(isSelected ? Color.primary : AppTheme.secondaryText(colorScheme))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                isSelected ? AppTheme.groupedFill(colorScheme) : Color.clear,
                                in: .capsule
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    /// 单个文档维度：正文 + 截断提示。
    @ViewBuilder
    private func docBody(_ kind: SpecRuneDocKind) -> some View {
        if let doc = detail.docs[kind] {
            // 渲染 markdown（勾选项、标题、代码块），而不是显示源码。
            ChatMarkdownView(text: doc.content)
            if doc.truncated {
                Text("已截断：原文超过 1 MiB")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
            }
        } else {
            Text("该任务没有这份文档")
                .font(.footnote)
                .foregroundStyle(AppTheme.secondaryText(colorScheme))
        }
    }

    /// 概览：与 DSH 面板同颗粒度——进度 / 检查清单 / 上下文 / 关联。
    private var overview: some View {
        VStack(alignment: .leading, spacing: 20) {
            header

            if let progress = SpecRunePresentation.progress(summary) {
                sectionBlock(title: "进度 · \(progress.label)", trailing: "\(progress.done) / \(progress.total)") {
                    ProgressView(value: Double(progress.done), total: Double(progress.total))
                }
            }

            // 检查清单：恒显示，空态如实说明（面板同款）。
            let checks = SpecRunePresentation.checklist(from: detail)
            sectionBlock(
                title: "检查清单",
                trailing: checks.isEmpty ? "无" : "\(checks.filter(\.checked).count)/\(checks.count)"
            ) {
                if checks.isEmpty {
                    emptyNote("无检查清单（implement.md 无勾选项）")
                } else {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(checks.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                AppSymbol(item.checked ? "checkmark.square.fill" : "square", size: 14)
                                    .foregroundStyle(item.checked
                                        ? AppTheme.secondaryText(colorScheme)
                                        : AppTheme.secondaryText(colorScheme))
                                Text(verbatim: item.text)
                                    .font(.subheadline)
                                    .foregroundStyle(item.checked ? AppTheme.secondaryText(colorScheme) : .primary)
                                    .strikethrough(item.checked, color: AppTheme.secondaryText(colorScheme))
                            }
                        }
                    }
                }
            }

            // 上下文：文件名 chips，理由放 accessibility（面板用 tooltip）。
            sectionBlock(title: "上下文", trailing: "\(detail.context.count)") {
                if detail.context.isEmpty {
                    emptyNote("无上下文记录")
                } else {
                    FlowChips(items: detail.context)
                }
            }

            // 关联：规范引用 + 共享规范的任务。
            sectionBlock(title: "关联", trailing: nil) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("规范引用")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    if let refs = summary.specRefs, !refs.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(refs, id: \.self) { path in
                                specRow(path)
                            }
                        }
                    } else {
                        emptyNote("没有规范引用")
                    }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(SpecRunePresentation.statusLabel(summary.status))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(AppTheme.groupedFill(colorScheme), in: .capsule)
                if let priority = summary.priority {
                    SpecRunePriorityChip(priority: priority)
                }
                if summary.active == true {
                    Text("当前会话任务")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.14), in: .capsule)
                }
                Spacer()
            }
            HStack(spacing: 14) {
                if let assignee = summary.assignee, !assignee.isEmpty {
                    Label(assignee, appSymbol: "person.crop.circle")
                }
                if let created = summary.createdAt {
                    Label(created, appSymbol: "clock")
                }
                Text(verbatim: summary.dir)
                    .font(.caption.monospaced())
            }
            .font(.footnote)
            .foregroundStyle(AppTheme.secondaryText(colorScheme))
        }
    }

    /// 一个概览小节：标题 + 右侧计数 + 内容。
    private func sectionBlock<Content: View>(
        title: String,
        trailing: String?,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Text(verbatim: title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                if let trailing {
                    Text(verbatim: trailing)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                }
            }
            content()
        }
    }

    private func emptyNote(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.caption)
            .foregroundStyle(AppTheme.secondaryText(colorScheme))
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
                    ChatMarkdownView(text: file.content)
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

}

// MARK: - 展示派生（UI 语义，不进 SpecRuneKit）

private enum SpecRunePresentation {
    static func statusLabel(_ status: String) -> String {
        switch status {
        case "planning": "规划中"
        case "in_progress": "进行中"
        case "completed": "已完成"
        case "blocked": "受阻"
        case "canceled": "已取消"
        default: status
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "planning": .secondary.opacity(0.6)
        case "in_progress": .blue
        case "completed": .green
        case "blocked": .orange
        case "canceled": .secondary
        default: .secondary
        }
    }

    /// 从 implement.md 解析 `- [ ]` 勾选项（与面板 parseChecklist 同规则）。
    static func checklist(from detail: SpecRuneTaskDetail) -> [SpecRuneChecklistItem] {
        guard let markdown = detail.docs[.implement]?.content else { return [] }
        var items: [SpecRuneChecklistItem] = []
        var inFence = false
        for line in markdown.replacingOccurrences(of: "\r", with: "").split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                inFence.toggle()
                continue
            }
            if trimmed.hasPrefix("- [") || trimmed.hasPrefix("* [") || trimmed.hasPrefix("+ [") {
                guard trimmed.count > 5 else { continue }
                let markIndex = trimmed.index(trimmed.startIndex, offsetBy: 3)
                let checked = trimmed[markIndex] == "x" || trimmed[markIndex] == "X"
                let text = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                items.append(SpecRuneChecklistItem(checked: checked, text: text))
            } else if !inFence, !items.isEmpty, line.hasPrefix("  "), !trimmed.isEmpty {
                let last = items.removeLast()
                items.append(SpecRuneChecklistItem(checked: last.checked, text: last.text + " " + trimmed))
            }
        }
        return items
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
}

struct SpecRuneChecklistItem {
    let checked: Bool
    let text: String
}

/// 上下文 chips：横向换行铺开（面板同款的文件名 chip）。
private struct FlowChips: View {
    let items: [SpecRuneContextRow]
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // 用自适应网格代替手写换行：宽度变了自动重排。
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 6, alignment: .leading)],
                  alignment: .leading, spacing: 6) {
            ForEach(items) { row in
                Text(verbatim: row.example ? "（示例）" : (row.file as NSString).lastPathComponent)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(AppTheme.groupedFill(colorScheme), in: .rect(cornerRadius: 6))
                    .accessibilityLabel(Text(verbatim: row.reason.isEmpty ? row.file : "\(row.file)：\(row.reason)"))
            }
        }
    }
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
