package dev.agentsanywhere.v3poc.model

import kotlinx.serialization.json.JsonObject

/**
 * `--es stress "items:3000,chars:3000,hz:30,parallel:3,snapshot:0,lines:2000,difflines:300,approve:40"`: the same spec
 * and the same content mix as the iOS PoC's `StressConfig` / `StressContent` (Model/StressContent.swift).
 */
data class StressConfig(
    var items: Int = 3000,
    var chars: Int = 3000,
    var hz: Double = 30.0,
    var parallel: Int = 3,
    var snapshot: Int = 0,
    var lines: Int = 2000,
    var diffLines: Int = 300,
    /** One approval every n items (0: none). */
    var approveEvery: Int = 40,
    /** Text growth, characters per second per item. */
    var cps: Double = 1500.0,
    /** Terminal / file growth, lines per second per item. */
    var lps: Double = 150.0,
) {
    val summary: Workspace.Session
        get() = Workspace.Session(
            id = SESSION_ID, title = "压力测试：长会话高频推送", agent = "codex", device_id = "dev-mbp",
            cwd = "~/code/github/Agents-Anywhere", state = "running", unread = false, pinned = true, updated_at = "2026-11-17T10:00:00Z",
        )

    companion object {
        const val SESSION_ID = "s-stress"

        fun parse(spec: String?): StressConfig? {
            if (spec.isNullOrBlank()) return null
            val c = StressConfig()
            for (pair in spec.split(",")) {
                val kv = pair.split(":", limit = 2)
                val v = kv.getOrNull(1)?.toDoubleOrNull() ?: continue
                when (kv[0].trim()) {
                    "items" -> c.items = v.toInt()
                    "chars" -> c.chars = v.toInt()
                    "hz" -> c.hz = maxOf(0.5, v)
                    "parallel" -> c.parallel = maxOf(1, v.toInt())
                    "snapshot" -> c.snapshot = v.toInt()
                    "lines" -> c.lines = v.toInt()
                    "difflines" -> c.diffLines = v.toInt()
                    "approve" -> c.approveEvery = v.toInt()
                    "cps" -> c.cps = v
                    "lps" -> c.lps = v
                }
            }
            return c
        }
    }
}

/** Deterministic jitter (the iOS `SeededGenerator`, splitmix64). */
class SeededRandom(seed: Long) {
    private var state = seed
    fun next(): Long {
        state += -0x61c8864680b583ebL
        var z = state
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }
    fun nextInt(bound: Int): Int = ((next() ushr 1) % bound).toInt()
    fun nextDouble(from: Double, until: Double): Double = from + (next() ushr 11).toDouble() / (1L shl 53).toDouble() * (until - from)
}

/** Deterministic content for the stress session. Every item is built whole up front; the feed then reveals it. */
class StressContent(private val config: StressConfig, seed: Long = 0x5EED) {
    private val rng = SeededRandom(seed)

    sealed class Step {
        /** parts[0].text grows. */
        data class Text(val message: JsonObject) : Step()
        /** parts[0].output (a string) grows; `pending` asks for approval first. */
        data class Tool(val message: JsonObject, val pending: Boolean) : Step()
        /** Pushed whole (plan update, edit with diffs, subagent part, user message). */
        data class Whole(val message: JsonObject) : Step()

        val finished: JsonObject get() = when (this) { is Text -> message; is Tool -> message; is Whole -> message }
    }

    private fun sentence(count: Int) = (0 until count).joinToString(" ") { WORDS[rng.nextInt(WORDS.size)] } + "。"

    private fun markdown(chars: Int, index: Int): String {
        val out = StringBuilder("## 第 $index 段分析\n\n")
        var block = 0
        while (out.length < chars) {
            when (block % 9) {
                0 -> out.append(sentence(24)).append(" 包含 `inline_code_$block` 和 **加粗** 以及 *斜体*。\n\n")
                1 -> out.append((1..6).joinToString("\n") { "- 第 $it 点：" + sentence(10) }).append("\n\n")
                2 -> {
                    val lang = listOf("swift", "typescript", "python", "go", "rust", "sql")[index % 6]
                    out.append("```$lang\n").append((0 until 40).joinToString("\n") { codeLine(lang, it) }).append("\n```\n\n")
                }
                3 -> {
                    out.append("| 列 A | 列 B | 列 C | 列 D | 列 E | 列 F | 列 G | 列 H |\n|---|---|---|---|---|---|---|---|\n")
                    out.append((0 until 12).joinToString("\n") { r -> "| r$r " + (0 until 7).joinToString("") { "| 单元格内容 $r-$it 比较长一些" } + " |" }).append("\n\n")
                }
                4 -> out.append("> ").append(sentence(30)).append("\n> ").append(sentence(12)).append("\n\n")
                5 -> out.append("### 小节 $block\n\n1. ").append(sentence(8)).append("\n2. ").append(sentence(9)).append("\n3. ").append(sentence(7)).append("\n\n")
                6 -> out.append(if (index % 5 == 0) "$$\n\\sum_{i=0}^{n} x_i^2 = \\int_0^1 f(t)\\,dt\n$$\n\n" else sentence(20) + "\n\n")
                7 -> out.append(if (index % 7 == 0) "```mermaid\ngraph TD\n  A[watch] --> B[snapshot]\n  B --> C[message]\n  C --> D[render]\n```\n\n" else sentence(16) + "\n\n")
                else -> out.append(sentence(40)).append("\n\n")
            }
            block++
        }
        return out.toString()
    }

    /** The steps of one turn, after its user message. */
    fun turn(turnIndex: Int, userId: String, approve: () -> Boolean): List<Step> {
        fun id(n: Int) = "m-st$turnIndex-$n"
        fun assistant(n: Int, part: JsonObject) = jsObj(
            "id" to id(n), "role" to "assistant", "turn_id" to userId, "created_at" to "2026-11-17T10:00:00Z", "done" to true, "parts" to listOf(part),
        )
        val steps = ArrayList<Step>()
        var n = 0
        fun next(): Int { n += 1; return n }
        steps += Step.Text(assistant(next(), jsObj("type" to "thinking", "text" to sentence(60) + "\n\n" + sentence(80))))
        val planId = next()
        val entries = (0 until 5).map { "步骤 ${it + 1}：" + listOf("读取相关代码", "修改同步逻辑", "补充测试", "跑测试", "整理结论")[it] }
        fun plan(doneCount: Int, final: Boolean) = assistant(planId, jsObj("type" to "plan", "entries" to entries.mapIndexed { i, text ->
            jsObj("content" to text, "status" to if (i < doneCount) "completed" else if (i == doneCount) "in_progress" else "pending")
        })).with("done" to final)
        steps += Step.Whole(plan(0, false))
        val kinds = listOf("execute", "read", "text", "search", "edit", "execute-fail", "text", "subagent")
        for ((k, kind) in kinds.withIndex()) {
            val callId = "call-st$turnIndex-$k"
            when (kind) {
                "execute", "execute-fail" -> {
                    val failed = kind == "execute-fail"
                    val output = (0 until (if (failed) config.lines / 4 else config.lines)).joinToString("\n") { terminalLine(it + k * 7) } +
                        (if (failed) "\nError: process exited with code 1" else "")
                    val command = if (failed) "uv run pytest tests/ -q -x" else "cargo test --workspace -- --nocapture"
                    steps += Step.Tool(assistant(next(), jsObj("type" to "tool", "id" to callId, "title" to command, "kind" to "execute",
                        "status" to if (failed) "failed" else "completed", "input" to jsObj("command" to command), "output" to output)), approve())
                }
                "read" -> {
                    val path = "server/agent_server/services/module_${turnIndex % 40}.py"
                    steps += Step.Tool(assistant(next(), jsObj("type" to "tool", "id" to callId, "title" to "Read $path", "kind" to "read",
                        "status" to "completed", "input" to jsObj("path" to path), "output" to fileLines(config.lines / 2, turnIndex),
                        "locations" to listOf(jsObj("path" to path, "line" to 1)))), false)
                }
                "search" -> {
                    val output = (0 until 200).joinToString("\n") { "services/module_${it % 40}.py:${it * 3 + 1}: state.unread = state.latest_seq > $it" }
                    steps += Step.Tool(assistant(next(), jsObj("type" to "tool", "id" to callId, "title" to "rg -n \"unread\" server/", "kind" to "search",
                        "status" to "completed", "input" to jsObj("pattern" to "unread"), "output" to output)), false)
                }
                "edit" -> {
                    val path = "server/agent_server/services/module_${turnIndex % 40}.py"
                    steps += Step.Whole(assistant(next(), jsObj("type" to "tool", "id" to callId, "title" to "Edit $path", "kind" to "edit",
                        "status" to "completed", "input" to jsObj("path" to path),
                        "diffs" to listOf(jsObj("path" to path, "old_text" to fileLines(config.diffLines, turnIndex), "new_text" to fileLines(config.diffLines, turnIndex + 1))))))
                    steps += Step.Whole(plan(2, false))
                }
                "subagent" -> {
                    val partId = "sub-st$turnIndex"
                    val sub = assistant(next(), jsObj("type" to "subagent", "id" to partId, "title" to "检查其他调用方", "description" to "在代码库里找出所有写未读状态的地方",
                        "agent_type" to "explore", "status" to "running", "started_at" to "2026-11-17T10:00:00Z", "tool_count" to 4, "parts" to emptyList<Any>())).with("done" to false)
                    steps += Step.Whole(sub)
                    for (s in 0 until 4) {
                        val child = assistant(next(), if (s % 2 == 0)
                            jsObj("type" to "tool", "id" to "$callId-$s", "title" to "Read services/module_$s.py", "kind" to "read", "status" to "completed", "output" to fileLines(80, s))
                        else jsObj("type" to "text", "text" to sentence(40))).with("subagent_id" to partId)
                        steps += if (s % 2 == 0) Step.Tool(child, false) else Step.Text(child)
                    }
                    steps += Step.Whole(sub.with("done" to true, "parts" to listOf(jsObj("type" to "subagent", "id" to partId, "title" to "检查其他调用方",
                        "agent_type" to "explore", "status" to "completed", "started_at" to "2026-11-17T10:00:00Z", "ended_at" to "2026-11-17T10:00:09Z",
                        "tool_count" to 4, "parts" to emptyList<Any>(), "result" to sentence(30)))))
                }
                else -> steps += Step.Text(assistant(next(), jsObj("type" to "text", "text" to markdown(config.chars, turnIndex * 10 + k))))
            }
        }
        steps += Step.Whole(plan(5, true))
        return steps
    }

    /** The person's message that starts a turn; every third one carries an image and a file. */
    fun user(turnIndex: Int): JsonObject {
        val parts = mutableListOf<Any>(jsObj("type" to "text", "text" to "第 $turnIndex 轮：继续，把剩下的步骤做完，顺便把测试补齐。"))
        if (turnIndex % 3 == 0) {
            parts += jsObj("type" to "image", "path" to "/tmp/shot-$turnIndex.png", "name" to "截图-$turnIndex.png", "mime" to "image/png", "size" to 182_000)
            parts += jsObj("type" to "file", "path" to "/tmp/log-$turnIndex.txt", "name" to "日志-$turnIndex.txt", "mime" to "text/plain", "size" to 48_000)
        }
        return jsObj("id" to "m-st$turnIndex-u", "role" to "user", "created_at" to "2026-11-17T10:00:00Z", "done" to true, "rewindable" to true, "parts" to parts)
    }

    companion object {
        val WORDS = listOf("会话", "同步", "渲染", "整条替换", "推送", "连接器", "审批", "快照", "缓存", "WebView", "React", "Markdown",
            "Timeline", "seq", "control", "watch", "队列", "回压", "增量", "高亮", "虚拟化", "布局", "滚动", "内存")

        fun codeLine(lang: String, n: Int) = when (lang) {
            "swift" -> "    let value$n = try await client.watch(id: \"s-$n\").first { \$0.type == .snapshot } // $n"
            "typescript" -> "  const item$n: Message = { id: `m-$n`, seq: $n, done: false, parts: [{ type: 'text', text: '' }] }"
            "python" -> "    result_$n = await store.get(session_id=\"s-$n\", limit=${n * 3})  # noqa: E501"
            "go" -> "\tif err := router.Forward(ctx, frame$n); err != nil { return fmt.Errorf(\"forward %d: %w\", $n, err) }"
            "rust" -> "    let frame_$n = codec.decode(&mut buf).map_err(|e| Error::Frame($n, e))?;"
            else -> "SELECT id, seq, payload FROM items WHERE session_id = 's-$n' AND seq > $n ORDER BY seq LIMIT 100;"
        }

        fun terminalLine(n: Int) = when (n % 5) {
            0 -> "tests/test_module_${n / 5}.py::test_case_$n PASSED                                    [${n % 100}%]"
            1 -> "  Compiling crate-$n v0.${n % 10}.${n % 7} (/srv/build/crate-$n)"
            2 -> "2026-11-17T10:%02d:00Z INFO  router: forwarded frame seq=$n bytes=${n * 37 % 9000}".format(n % 60)
            3 -> "\u001B[32mok\u001B[0m   step $n: applied migration v2_${n % 50} in ${n % 300}ms"
            else -> "warning: unused variable `tmp_$n` --> src/lib.rs:$n:${n % 80}"
        }

        fun fileLines(count: Int, offset: Int) = (0 until count).joinToString("\n") {
            "${offset + it + 1}\t" + codeLine(listOf("python", "swift", "typescript")[it % 3], offset + it)
        }
    }
}
