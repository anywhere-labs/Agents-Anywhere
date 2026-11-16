import Foundation

/// SpecRune 看板的取数层。
///
/// 只用官方 Server **既有**的两条能力，因此 Connector 与 Server 都无需改动：
/// - shell 跑 `specrune task list/show --json` 拿结构化摘要；
/// - 读文本文件拿任务目录下的文档正文与 `.runtime/sessions/*.json`。
///
/// 文档正文单独读而不是让 CLI 输出，是因为 `shell.exec` 的 stdout 上限
/// 64 000 字符——长文档会把 JSON 截断。
///
/// 错误语义：文件不存在返回 nil（文档可选），**其它错误照常抛出**——
/// 否则离线会被误判成「该项目未启用 SpecRune」。
public nonisolated struct SpecRuneClient: Sendable {
    private let transport: any SpecRuneTransport

    /// CLI 不在 PATH 时的回退路径（面板装到中立目录的形态）。
    private static let fallbackCLIPath = "$HOME/.dsh/specrune/bin/specrune"

    public init(transport: any SpecRuneTransport) {
        self.transport = transport
    }

    // MARK: - 项目判定

    /// 目标目录是否是 SpecRune 项目（存在 `.specrune/workflow.md`）。
    ///
    /// 会抛出连接错误——调用方据此区分「不是项目」与「读不到」。
    public func isSpecRuneProject(repo: String) async throws -> Bool {
        try await readText(repo: repo, path: ".specrune/workflow.md") != nil
    }

    // MARK: - 任务

    /// 已知的任务状态。分批拉取时按它遍历。
    private static let knownStatuses = ["planning", "in_progress", "completed", "blocked", "canceled"]

    /// 任务列表（活跃 + 归档）。
    ///
    /// 一次 `task list --json --all` 能拿全，但 `shell.exec` 的 stdout 上限
    /// 是 64 000 字符——任务多的项目会被截断成非法 JSON。所以截断时退化为
    /// 「按状态分批」，每批各自独立、互不影响，合并后去重。
    public func listTasks(repo: String) async throws -> SpecRuneTaskList {
        do {
            return try await fetchTaskList(repo: repo, arguments: ["task", "list", "--json", "--all"])
        } catch SpecRuneError.truncated {
            let merged = await fetchTaskListByStatus(repo: repo)
            // 分批也一条都没拿到才报错；只要拿到部分就先展示。
            if merged.tasks.isEmpty && merged.archive.isEmpty {
                throw SpecRuneError.truncated
            }
            return merged
        }
    }

    /// 执行一次 `task list` 并解码。
    private func fetchTaskList(repo: String, arguments: [String]) async throws -> SpecRuneTaskList {
        let output = try await runCLI(repo: repo, arguments: arguments)
        guard let data = output.data(using: .utf8) else {
            throw SpecRuneError.badOutput("输出不是 UTF-8")
        }
        do {
            return try JSONDecoder().decode(SpecRuneTaskList.self, from: data)
        } catch {
            throw SpecRuneError.badOutput(String(describing: error).prefix(200).description)
        }
    }

    /// 按状态分批拉取并合并（截断时的回退路径）。
    ///
    /// 单批失败/截断只丢这一批，不让整张列表失败——这是「任务过多」时
    /// 至少还能看到大部分任务的关键。
    private func fetchTaskListByStatus(repo: String) async -> SpecRuneTaskList {
        var tasks: [SpecRuneTaskSummary] = []
        var archive: [SpecRuneTaskSummary] = []
        var seenActive = Set<String>()
        var seenArchived = Set<String>()

        for status in Self.knownStatuses {
            guard let part = try? await fetchTaskList(
                repo: repo,
                arguments: ["task", "list", "--json", "--all", "--status", status]
            ) else { continue }
            for task in part.tasks where seenActive.insert(task.dir).inserted {
                tasks.append(task)
            }
            for task in part.archive where seenArchived.insert(task.dir).inserted {
                archive.append(task)
            }
        }
        return SpecRuneTaskList(tasks: tasks, archive: archive)
    }

    /// 任务详情：CLI 摘要 + 各产物文档正文（只取存在的）。
    public func taskDetail(repo: String, ref: String) async throws -> SpecRuneTaskDetail {
        let output = try await runCLI(repo: repo, arguments: ["task", "show", ref, "--json"])
        guard let data = output.data(using: .utf8) else {
            throw SpecRuneError.badOutput("输出不是 UTF-8")
        }
        let summary: SpecRuneTaskSummary
        do {
            summary = try JSONDecoder().decode(SpecRuneTaskSummary.self, from: data)
        } catch {
            throw SpecRuneError.badOutput(String(describing: error).prefix(200).description)
        }

        // 归档任务在 `.specrune/tasks/archive/<月>/<dir>/`，不能只用 dir 拼路径。
        let taskDir = relativeTaskDirectory(repo: repo, summary: summary)

        // 先按 CLI 的 has* 标志决定读哪些：不存在的文档根本不该发请求——
        // Connector 缺文件时抛 FileNotFoundError，Server 会包成 502，逐个盲读
        // 会让任意任务在 record/research 处失败。
        var docs: [SpecRuneDocKind: SpecRuneDoc] = [:]
        let declared: [(SpecRuneDocKind, Bool?)] = [
            (.prd, summary.hasPrd),
            (.design, summary.hasDesign),
            (.implement, summary.hasImplement),
        ]
        for (kind, present) in declared where present == true {
            if let file = try await readText(repo: repo, path: "\(taskDir)/\(kind.fileName)") {
                docs[kind] = SpecRuneDoc(content: file.content, truncated: file.truncated)
            }
        }
        // record / research / review 没有 has 标志，只能试读；缺失属于常态，容错即可。
        for kind in [SpecRuneDocKind.record, .research, .review] {
            if let file = try? await readText(repo: repo, path: "\(taskDir)/\(kind.fileName)") {
                docs[kind] = SpecRuneDoc(content: file.content, truncated: file.truncated)
            }
        }
        // 上下文清单：两份 jsonl 合并，与面板概览「上下文」同源。
        var context: [SpecRuneContextRow] = []
        for name in ["implement.jsonl", "check.jsonl"] {
            if let file = try? await readText(repo: repo, path: "\(taskDir)/\(name)") {
                context.append(contentsOf: Self.parseContextRows(file.content))
            }
        }
        return SpecRuneTaskDetail(summary: summary, docs: docs, context: context)
    }

    // MARK: - 规范

    /// 读一条规范正文（`specRefs` 里的相对路径）。文件不存在返回 nil。
    public func readSpec(repo: String, path: String) async throws -> SpecRuneTextFile? {
        try await readText(repo: repo, path: path)
    }

    // MARK: - 会话关联

    /// 该会话当前绑定的任务；无关联返回 nil。
    ///
    /// DSH 把关联写在 `.specrune/.runtime/sessions/dsh_<sanitized>.json` 的
    /// `current_task`（相对仓库根的路径）。键规则与面板 `readSessionTask` 一致。
    /// 这是旁路信息，读失败按「无关联」处理，不打断会话页。
    public func sessionTask(repo: String, sessionId: String) async -> SpecRuneSessionTask? {
        let key = "dsh_" + sanitizeSessionId(sessionId)
        let raw: SpecRuneTextFile?
        do {
            raw = try await readText(repo: repo, path: ".specrune/.runtime/sessions/\(key).json")
        } catch {
            return nil
        }
        guard let text = raw?.content,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let current = (object["current_task"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !current.isEmpty
        else {
            return nil
        }
        let ref = current.split(separator: "/").last.map(String.init) ?? ""
        guard !ref.isEmpty else { return nil }
        return SpecRuneSessionTask(taskRef: ref, title: nil, createdAt: nil)
    }

    // MARK: - 底层调用

    /// 在 repo 根下跑一条 specrune 命令，返回 stdout。
    private func runCLI(repo: String, arguments: [String]) async throws -> String {
        let args = arguments.joined(separator: " ")
        if let output = try await exec(repo: repo, command: "specrune \(args)") {
            return output
        }
        // PATH 上没有 specrune 时回退到中立目录；仍失败才认定未安装。
        if let output = try await exec(repo: repo, command: "\(Self.fallbackCLIPath) \(args)") {
            return output
        }
        throw SpecRuneError.cliMissing
    }

    /// 执行一次 shell；CLI 不存在返回 nil（交给上层回退）。
    private func exec(repo: String, command: String) async throws -> String? {
        let result: SpecRuneShellResult
        do {
            result = try await transport.shell(repo: repo, command: command)
        } catch let error as SpecRuneError {
            throw error
        } catch is CancellationError {
            // 视图切换导致的取消不是「连不上设备」，别包装成 offline。
            throw CancellationError()
        } catch {
            throw SpecRuneError.offline(String(describing: error).prefix(200).description)
        }

        if result.timedOut {
            throw SpecRuneError.cliFailed("执行超时")
        }
        if result.exitCode != 0 {
            let failure = SpecRuneFailureClassifier.classify(
                exitCode: result.exitCode,
                stderr: result.stderr,
                truncated: false
            )
            // 只有「命令不存在」才值得回退到另一条路径重试。
            if case .cliMissing = failure { return nil }
            throw failure
        }
        if result.stdoutTruncated {
            throw SpecRuneError.truncated
        }
        return result.stdout
    }

    /// 读仓库内文本文件；不存在返回 nil，连接错误抛出。
    private func readText(repo: String, path: String) async throws -> SpecRuneTextFile? {
        try await transport.readText(repo: repo, path: path)
    }

    /// 解析 jsonl 上下文清单：坏行跳过，`_example` 标记成示例行。
    private static func parseContextRows(_ text: String) -> [SpecRuneContextRow] {
        var rows: [SpecRuneContextRow] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if object["_example"] != nil {
                rows.append(SpecRuneContextRow(file: "", reason: "", example: true))
                continue
            }
            let file = ((object["file"] as? String) ?? (object["path"] as? String) ?? "")
                .trimmingCharacters(in: .whitespaces)
            guard !file.isEmpty else { continue }
            let reason = ((object["reason"] as? String) ?? (object["description"] as? String) ?? "")
                .trimmingCharacters(in: .whitespaces)
            rows.append(SpecRuneContextRow(file: file, reason: reason, example: false))
        }
        return rows
    }

    /// 把 CLI 给的绝对任务目录换成相对 repo 的路径。
    private func relativeTaskDirectory(repo: String, summary: SpecRuneTaskSummary) -> String {
        let root = repo.hasSuffix("/") ? String(repo.dropLast()) : repo
        if summary.path.hasPrefix(root + "/") {
            return String(summary.path.dropFirst(root.count + 1))
        }
        // 兜底：绝对路径对不上时按归档月份推断，再退回活跃目录。
        if let month = summary.archiveMonth, !month.isEmpty {
            return ".specrune/tasks/archive/\(month)/\(summary.dir)"
        }
        return ".specrune/tasks/\(summary.dir)"
    }

    /// 与面板 `readSessionTask` 相同的键清洗规则。
    private func sanitizeSessionId(_ value: String) -> String {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        var out = ""
        for character in value {
            out.append(allowed.contains(character) ? character : "_")
        }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "._-"))
    }
}
