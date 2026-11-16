import Foundation
import Observation
import SpecRuneKit

/// 看板的数据与状态。
///
/// 每个项目、每份详情各自一份加载状态：某个项目读失败不该让整屏空白，
/// 也不该在切换项目时把别处已加载的内容清掉。
@MainActor
@Observable
final class SpecRuneBoardModel {
    /// 单项加载状态。
    enum Load<Value> {
        case idle
        case loading
        case loaded(Value)
        case failed(String)

        var value: Value? {
            if case let .loaded(value) = self { return value }
            return nil
        }

        var isLoading: Bool {
            if case .loading = self { return true }
            return false
        }

        var failure: String? {
            if case let .failed(message) = self { return message }
            return nil
        }
    }

    private let client: SpecRuneClient
    /// 该设备上的项目（来自 Server 的 project 列表）。
    /// 必须可变：Model 在 `.task` 里只建一次，而父视图的项目列表会随
    /// dashboard 加载完成而更新，用 `let` 会永远停在最初的空数组。
    private(set) var projects: [V2Project]

    /// 选中项目的 workspace 路径。
    var selectedRepo: String?
    /// repo -> 是否 SpecRune 项目。nil 表示尚未探测。
    private(set) var specRuneRepos: [String: Bool] = [:]
    /// repo -> 探测失败原因（区分「未启用」与「读不到」）。
    private(set) var probeFailures: [String: String] = [:]
    /// "repo|path" -> 规范正文。
    private(set) var specStates: [String: Load<SpecRuneTextFile>] = [:]
    /// repo -> 任务列表。
    private(set) var listStates: [String: Load<SpecRuneTaskList>] = [:]
    /// "repo|ref" -> 任务详情。
    private(set) var detailStates: [String: Load<SpecRuneTaskDetail>] = [:]

    init(client: SpecRuneClient, projects: [V2Project]) {
        self.client = client
        self.projects = projects
    }

    /// 父视图传入新项目列表时同步（并清掉已消失项目的缓存状态）。
    func updateProjects(_ newValue: [V2Project]) {
        guard projects != newValue else { return }
        projects = newValue
        let paths = Set(newValue.map(\.workspacePath))
        specRuneRepos = specRuneRepos.filter { paths.contains($0.key) }
        probeFailures = probeFailures.filter { paths.contains($0.key) }
        if let repo = selectedRepo, !paths.contains(repo) {
            selectedRepo = nil
        }
    }

    /// 只保留本设备上的项目，并按名称排序。
    var deviceProjects: [V2Project] {
        projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// 探测哪些项目是 SpecRune 项目（每个项目只探测一次）。
    func probeProjects() async {
        for project in deviceProjects {
            let path = project.workspacePath
            guard specRuneRepos[path] == nil, probeFailures[path] == nil else { continue }
            do {
                specRuneRepos[path] = try await client.isSpecRuneProject(repo: path)
            } catch let error as SpecRuneError {
                probeFailures[path] = error.message
            } catch {
                probeFailures[path] = String(describing: error).prefix(200).description
            }
        }
    }

    /// 读一条规范正文（详情页「规范引用」展开时调用）。
    func loadSpec(repo: String, path: String) async {
        let key = "\(repo)|\(path)"
        if case .loaded = specStates[key] { return }
        specStates[key] = .loading
        do {
            if let file = try await client.readSpec(repo: repo, path: path) {
                specStates[key] = .loaded(file)
            } else {
                specStates[key] = .failed("规范文件不存在")
            }
        } catch let error as SpecRuneError {
            specStates[key] = .failed(error.message)
        } catch {
            specStates[key] = .failed(String(describing: error).prefix(200).description)
        }
    }

    func spec(repo: String, path: String) -> Load<SpecRuneTextFile> {
        specStates["\(repo)|\(path)"] ?? .idle
    }

    /// 选中项目并加载其任务列表（已加载过则不重复请求）。
    func select(repo: String) async {
        selectedRepo = repo
        if case .loaded = listStates[repo] { return }
        await loadTasks(repo: repo)
    }

    /// 加载任务列表。
    func loadTasks(repo: String) async {
        listStates[repo] = .loading
        do {
            let list = try await client.listTasks(repo: repo)
            listStates[repo] = .loaded(list)
        } catch let error as SpecRuneError {
            listStates[repo] = .failed(error.message)
        } catch {
            listStates[repo] = .failed(String(describing: error).prefix(200).description)
        }
    }

    /// 加载任务详情（摘要 + 文档）。
    func loadDetail(repo: String, ref: String) async {
        let key = detailKey(repo: repo, ref: ref)
        if case .loaded = detailStates[key] { return }
        if case .loading = detailStates[key] { return }
        detailStates[key] = .loading
        do {
            let detail = try await client.taskDetail(repo: repo, ref: ref)
            detailStates[key] = .loaded(detail)
        } catch is CancellationError {
            // 导航动画/页面切换会取消在途请求；回到 idle，下次进入再拉。
            detailStates[key] = .idle
        } catch let error as SpecRuneError {
            detailStates[key] = .failed(error.message)
        } catch {
            detailStates[key] = .failed(String(describing: error).prefix(200).description)
        }
    }

    func detail(repo: String, ref: String) -> Load<SpecRuneTaskDetail> {
        detailStates[detailKey(repo: repo, ref: ref)] ?? .idle
    }

    private func detailKey(repo: String, ref: String) -> String {
        "\(repo)|\(ref)"
    }
}
