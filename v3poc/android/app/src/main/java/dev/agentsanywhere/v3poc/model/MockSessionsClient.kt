package dev.agentsanywhere.v3poc.model

import dev.agentsanywhere.v3poc.bridge.StressMetrics
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.UUID
import kotlin.coroutines.resume

/**
 * Stands in for the computer: replays fixtures/session-demo.json with real timing (script semantics documented at the
 * top of v3poc/fixtures/build.py) and synthesizes small sessions for the rest of workspace.json. The state lives here,
 * not on the phone; the app only sees what `watch` sends. Runs on the main thread.
 */
class MockSessionsClient(
    private val workspace: Workspace,
    private val demo: JsonObject?,
    private val stress: StressConfig?,
) : SessionsClient {
    private inner class Source(var state: SessionState) {
        val watchers = LinkedHashMap<Int, (JsonObject) -> Unit>()
        var task: Job? = null
        var scriptStarted = false
        val waiters = HashMap<String, CancellableContinuation<Unit>>()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val sources = HashMap<String, Source>()
    private val rng = SeededRandom(0xA4)
    private var watcherIds = 0
    private var stressPrefilledTurns = 0

    private val accountName: String get() = demo["account"]["name"].str ?: workspace.account.name
    private val demoSessionId: String? get() = demo["snapshot"]["session"]["id"].str

    init {
        for (summary in workspace.sessions) sources[summary.id] = Source(makeState(summary))
    }

    // SessionsClient

    override fun watch(id: String): Flow<JsonObject> = callbackFlow {
        val source = sources[id]
        if (source == null) { close(); return@callbackFlow }
        val token = ++watcherIds
        source.watchers[token] = { trySend(it) }
        trySend(source.state.snapshot)
        if (id == StressConfig.SESSION_ID && !source.scriptStarted && stress != null) {
            source.scriptStarted = true
            source.task = scope.launch { runStress(stress, source) }
        }
        // The demo's script starts the first time anyone watches it and keeps running on the computer afterwards.
        val steps = demo["script"].arr
        if (id == demoSessionId && !source.scriptStarted && steps != null) {
            source.scriptStarted = true
            source.task = scope.launch {
                play(steps, source) { it }
                source.task = null
            }
        }
        awaitClose { source.watchers.remove(token) }
    }.buffer(Channel.UNLIMITED)

    override suspend fun listMessages(id: String, beforeSeq: Int?, limit: Int): Pair<List<JsonElement>, Boolean> {
        val source = sources[id] ?: throw SessionsClientException("会话不存在：$id")
        // The fixtures start at seq 0: there is nothing older to page in.
        val older = source.state.messages.filter { (it["seq"].int ?: 0) < (beforeSeq ?: Int.MAX_VALUE) }.takeLast(limit)
        return older to false
    }

    override suspend fun send(id: String, clientMsgId: String, content: String): String {
        val source = sources[id] ?: throw SessionsClientException("会话不存在：$id")
        source.state.messages.firstOrNull { it["client_msg_id"].str == clientMsgId }?.let { return it["id"].str ?: "" }
        val token = token()
        val userId = "m-u-$token"
        var user = jsObj("id" to userId, "role" to "user", "client_msg_id" to clientMsgId, "created_at" to Clock.nowIso(), "done" to true,
            "rewindable" to true, "parts" to listOf(jsObj("type" to "text", "text" to content)))
        if (source.task != null) {
            // Running: `control.steer` is native, so the message joins the current turn and no new reply starts.
            user = user.with("steered" to true)
            push(jsObj("type" to "message", "message" to user), source)
            return userId
        }
        push(jsObj("type" to "message", "message" to user), source)
        val reply = demo["reply"].arr ?: return userId
        source.task = scope.launch {
            play(reply, source) { it.replace("\$TURN", userId).replace("\$X", token) }
            source.task = null
        }
        return userId
    }

    override suspend fun answer(id: String, requestId: String, optionId: String) {
        val source = sources[id] ?: throw SessionsClientException("会话不存在：$id")
        val pending = source.state.control["pending"].arr.orEmpty().toMutableList()
        val position = pending.indexOfFirst { it["request_id"].str == requestId }
        if (position < 0) throw SessionsClientException("这个请求已经处理过了")
        val request = pending.removeAt(position)
        val answered = source.state.control["answered"].arr.orEmpty() + jsObj("request_id" to requestId, "by" to accountName,
            "device" to DEVICE_NAME, "option_id" to optionId, "at" to Clock.nowIso())
        push(jsObj("type" to "control", "control" to source.state.control.with("pending" to pending, "answered" to answered)), source)

        val waiter = source.waiters.remove(requestId)
        if (waiter != null) {
            waiter.resume(Unit)
        } else if (source.task == null) {
            // Synthesized sessions have no script: settle the waiting tool call and go idle.
            source.task = scope.launch {
                settleSynthesizedApproval(request, optionId, source)
                source.task = null
            }
        }
    }

    override suspend fun stop(id: String) {
        val source = sources[id] ?: throw SessionsClientException("会话不存在：$id")
        source.task?.cancel()
        source.task = null
        source.waiters.values.forEach { if (it.isActive) it.resume(Unit) }
        source.waiters.clear()
        for (message in source.state.unfinishedMessages) {
            var m = message.with("done" to true, "interrupted" to true)
            val part = message["parts"][0].obj
            if (part != null && part["type"].str == "tool") m = m.with("parts" to listOf(part.with("status" to "failed")))
            push(jsObj("type" to "message", "message" to m), source)
        }
        push(jsObj("type" to "control", "control" to source.state.control.with("state" to "idle", "pending" to emptyList<Any>())), source)
    }

    override suspend fun setConfig(id: String, configId: String, value: String): JsonObject {
        val source = sources[id] ?: throw SessionsClientException("会话不存在：$id")
        val session = source.state.session.with("config" to source.state.session["config"].arr.orEmpty().map { o ->
            if (o["id"].str == configId) (o as JsonObject).with("current" to value) else o
        })
        push(jsObj("type" to "session", "session" to session), source)
        return session
    }

    // Replay

    private fun push(event: JsonObject, source: Source) {
        val applied = source.state.apply(event, assignSeq = true, stamp = true)
        for (w in source.watchers.values.toList()) w(applied)
    }

    private suspend fun play(steps: List<JsonElement>, source: Source, substitute: (String) -> String) {
        for (raw in steps) {
            val step = raw.mapStrings(substitute)
            val wait = step["wait"].double ?: 0.0
            if (wait > 0) delay(wait.toLong())
            val event = step["event"].obj
            val stream = step["stream"].obj
            if (event != null) {
                var e = event
                // A real Connector pushes the whole control: answers the replayer recorded stay in every later one.
                val control = event["control"].obj
                if (event["type"].str == "control" && control != null) {
                    val answered = control["answered"].arr.orEmpty()
                    val known = answered.mapNotNull { it["request_id"].str }.toSet()
                    val merged = answered + source.state.control["answered"].arr.orEmpty().filter { it["request_id"].str !in known }
                    e = event.with("control" to control.with("answered" to merged))
                }
                push(e, source)
            } else if (stream != null && stream["message"].obj != null) {
                stream(stream["message"].obj!!, stream["cps"].double ?: 60.0, stream["interval"].double ?: 333.0, source)
            } else if (step["until"].str == "answer") {
                val requestId = step["request_id"].str ?: continue
                val stillPending = source.state.control["pending"].arr.orEmpty().any { it["request_id"].str == requestId }
                if (stillPending) suspendCancellableCoroutine<Unit> { source.waiters[requestId] = it }
            }
        }
    }

    /** Pushes the whole item every `interval` ms while its text grows at `cps`; the last push is the item as given. */
    private suspend fun stream(message: JsonObject, cps: Double, interval: Double, source: Source) {
        val part = message["parts"][0].obj
        if (part == null) { push(jsObj("type" to "message", "message" to message), source); return }
        val isTool = part["type"].str == "tool"
        val field = if (isTool) "output" else "text"
        val full = part[field].str ?: ""
        val perPush = maxOf(1.0, cps * interval / 1000)
        var shown = 0.0
        while (true) {
            shown += perPush * rng.nextDouble(0.7, 1.3)
            if (shown.toInt() >= full.length) break
            var partial = part.with(field to full.substring(0, shown.toInt()))
            if (isTool) partial = partial.with("status" to "in_progress")
            push(jsObj("type" to "message", "message" to message.with("parts" to listOf(partial), "done" to false)), source)
            delay(interval.toLong())
        }
        push(jsObj("type" to "message", "message" to message), source)
    }

    private suspend fun settleSynthesizedApproval(request: JsonElement, optionId: String, source: Source) {
        val rejected = optionId.startsWith("reject")
        val messageId = request["message_id"].str
        val message = messageId?.let { source.state.message(it) }
        val part = message["parts"][0].obj
        if (message != null && part != null) {
            val settled = part.with("status" to if (rejected) "failed" else "completed", "output" to if (rejected) "已拒绝" else "Everything up-to-date")
            push(jsObj("type" to "message", "message" to message.with("parts" to listOf(settled), "done" to true)), source)
        }
        delay(400)
        val turn = source.state.messages.lastOrNull { it["role"].str == "user" }?.get("id").str ?: "m-s-u1"
        val text = if (rejected) "好的，先不执行这一步。" else "已推送。这个会话是合成的演示数据，到这里就结束了。"
        stream(jsObj("id" to "m-s-${token()}", "role" to "assistant", "turn_id" to turn, "created_at" to Clock.nowIso(), "done" to true,
            "parts" to listOf(jsObj("type" to "text", "text" to text))), 50.0, 333.0, source)
        push(jsObj("type" to "control", "control" to source.state.control.with("state" to "idle")), source)
    }

    // Sessions

    private fun makeState(summary: Workspace.Session): SessionState {
        if (summary.id == StressConfig.SESSION_ID && stress != null) return stressSnapshot(stress, summary)
        val snapshot = demo["snapshot"].obj
        if (snapshot != null && snapshot["session"]["id"].str == summary.id) SessionState.from(snapshot)?.let { return it }
        return synthesize(summary)
    }

    /** One user item and one assistant text item based on the title. A "waiting" summary also gets a pending command. */
    private fun synthesize(summary: Workspace.Session): SessionState {
        val device = workspace.devices.firstOrNull { it.id == summary.device_id }
        val session = jsObj("id" to summary.id, "title" to summary.title, "agent" to summary.agent,
            "device" to jsObj("id" to summary.device_id, "name" to (device?.name ?: summary.device_id)),
            "cwd" to summary.cwd, "created_at" to summary.updated_at, "updated_at" to summary.updated_at, "message_count" to 2,
            "config" to config(summary.agent))
        val created = Clock.nowIso()
        val messages = mutableListOf<JsonElement>(
            jsObj("id" to "m-s-u1", "role" to "user", "created_at" to created, "seq" to 0, "done" to true, "rewindable" to true,
                "parts" to listOf(jsObj("type" to "text", "text" to "帮我处理一下：${summary.title}"))),
            jsObj("id" to "m-s-a1", "role" to "assistant", "turn_id" to "m-s-u1", "created_at" to created, "seq" to 1, "done" to true,
                "parts" to listOf(jsObj("type" to "text", "text" to "好的。关于「${summary.title}」，我先看了相关代码和最近的提交，整理如下：\n\n- **现状**：这部分逻辑分散在两个模块里，各自维护一份状态。\n- **建议**：先补一组覆盖边界情况的测试，再分两步合并。\n\n需要我继续吗？"))),
        )
        var control = jsObj("state" to when (summary.state) { "waiting" -> "running"; "error" -> "error"; else -> "idle" },
            "steer" to "native", "pending" to emptyList<Any>(), "queued" to emptyList<Any>(), "answered" to emptyList<Any>())
        if (summary.state == "error") control = control.with("error" to "设备断开，任务中止。")
        if (summary.state == "waiting") {
            val command = "git push origin HEAD"
            messages += jsObj("id" to "m-s-a2", "role" to "assistant", "turn_id" to "m-s-u1", "created_at" to created, "seq" to 2, "done" to false,
                "parts" to listOf(jsObj("type" to "tool", "id" to "call-s1", "title" to command, "kind" to "execute", "status" to "pending",
                    "input" to jsObj("command" to command))))
            control = control.with("pending" to listOf(jsObj("request_id" to "req-s1", "message_id" to "m-s-a2", "tool_call_id" to "call-s1",
                "title" to command, "options" to APPROVAL_OPTIONS)))
        }
        return SessionState(session, messages, control, false)
    }

    private fun config(agent: String): List<JsonObject> {
        val models = if (agent == "codex") listOf(jsObj("value" to "gpt-5.5-codex", "name" to "GPT-5.5 Codex"), jsObj("value" to "gpt-5.5", "name" to "GPT-5.5"))
        else listOf(jsObj("value" to "opus", "name" to "Claude Opus"), jsObj("value" to "sonnet", "name" to "Claude Sonnet"))
        return listOf(
            jsObj("id" to "model", "name" to "模型", "category" to "model", "current" to models[0]["value"], "options" to models),
            jsObj("id" to "mode", "name" to "权限", "category" to "mode", "current" to "on-request", "options" to listOf(
                jsObj("value" to "read-only", "name" to "只读"), jsObj("value" to "on-request", "name" to "按需批准"), jsObj("value" to "full-access", "name" to "完全访问"))),
        )
    }

    // Stress (--es stress …)

    private fun stressSession(summary: Workspace.Session) = jsObj("id" to summary.id, "title" to summary.title, "agent" to summary.agent,
        "device" to jsObj("id" to "dev-mbp", "name" to "t4wefan 的 MacBook Pro"), "cwd" to summary.cwd, "branch" to "stress/long-session",
        "created_at" to summary.updated_at, "updated_at" to summary.updated_at, "message_count" to 0, "config" to config("codex"))

    /** `snapshot:n`: n finished items (whole turns) already in the session when it is opened. */
    private fun stressSnapshot(config: StressConfig, summary: Workspace.Session): SessionState {
        val state = SessionState(stressSession(summary), emptyList(), jsObj("state" to "running", "steer" to "native",
            "pending" to emptyList<Any>(), "queued" to emptyList<Any>(), "answered" to emptyList<Any>()), false)
        val content = StressContent(config, 0xF111)
        var turn = 0
        while (state.messages.size < config.snapshot) {
            val user = content.user(turn)
            state.apply(jsObj("type" to "message", "message" to user), assignSeq = true, stamp = true)
            for (step in content.turn(turn, user["id"].str ?: "") { false }) {
                state.apply(jsObj("type" to "message", "message" to step.finished), assignSeq = true, stamp = true)
            }
            turn++
        }
        stressPrefilledTurns = turn
        return state
    }

    private class Growing(val message: JsonObject, val field: String, val full: String, val perTick: Double, val isTool: Boolean, var requestId: String?) {
        var shown = 0.0
    }

    /**
     * Reveals stress turns until `items` items are finished: `parallel` items grow at once and each is pushed whole
     * `hz` times a second. Approvals wait for an answer (auto_approve_seconds answers them) while the others keep growing.
     */
    private suspend fun runStress(config: StressConfig, source: Source) {
        val content = StressContent(config)
        var turn = stressPrefilledTurns
        val queue = ArrayDeque<StressContent.Step>()
        val growing = ArrayList<Growing>()
        var finished = 0
        var stepCount = 0
        val interval = 1.0 / config.hz
        val started = System.currentTimeMillis()
        StressMetrics.log(mapOf("k" to "feed", "what" to "start", "hz" to config.hz, "parallel" to config.parallel, "chars" to config.chars,
            "lines" to config.lines, "prefilled" to source.state.messages.size))
        var lastReport = System.currentTimeMillis()
        var pushed = 0
        fun pushCounted(event: JsonObject) { push(event, source); pushed++ }
        fun setPending(change: (MutableList<JsonElement>) -> Unit) {
            val pending = source.state.control["pending"].arr.orEmpty().toMutableList()
            change(pending)
            pushCounted(jsObj("type" to "control", "control" to source.state.control.with("pending" to pending, "state" to "running")))
        }
        while (finished < config.items && scope.isActive) {
            while (growing.size < config.parallel) {
                if (queue.isEmpty()) {
                    val user = content.user(turn)
                    pushCounted(jsObj("type" to "message", "message" to user))
                    finished++
                    queue.addAll(content.turn(turn, user["id"].str ?: "") {
                        stepCount++
                        config.approveEvery > 0 && stepCount % config.approveEvery == 0
                    })
                    turn++
                }
                when (val step = queue.removeFirst()) {
                    is StressContent.Step.Whole -> {
                        pushCounted(jsObj("type" to "message", "message" to step.message))
                        if (step.message["done"].bool == true) finished++
                    }
                    is StressContent.Step.Text -> growing += Growing(step.message, "text", step.message["parts"][0]["text"].str ?: "", config.cps * interval, false, null)
                    is StressContent.Step.Tool -> {
                        val part = step.message["parts"][0].obj
                        val messageId = step.message["id"].str
                        var requestId: String? = null
                        if (step.pending && part != null && messageId != null) {
                            requestId = "req-$messageId"
                            pushCounted(jsObj("type" to "message", "message" to step.message.with(
                                "parts" to listOf(part.with("status" to "pending", "output" to null)), "done" to false)))
                            setPending { it += jsObj("request_id" to requestId, "message_id" to messageId, "tool_call_id" to part["id"],
                                "title" to part["title"], "options" to APPROVAL_OPTIONS) }
                        }
                        growing += Growing(step.message, "output", part?.get("output").str ?: "", config.lps * 70 * interval, true, requestId)
                    }
                }
            }
            val pendingIds = source.state.control["pending"].arr.orEmpty().mapNotNull { it["request_id"].str }.toSet()
            for (item in growing) {
                val request = item.requestId
                if (request != null) {
                    if (request in pendingIds) continue
                    item.requestId = null
                }
                item.shown += item.perTick * rng.nextDouble(0.8, 1.2)
                if (item.shown.toInt() < item.full.length) {
                    var part = (item.message["parts"][0].obj ?: JsonObject(emptyMap())).with(item.field to item.full.substring(0, item.shown.toInt()))
                    if (item.isTool) part = part.with("status" to "in_progress")
                    pushCounted(jsObj("type" to "message", "message" to item.message.with("parts" to listOf(part), "done" to false)))
                } else {
                    pushCounted(jsObj("type" to "message", "message" to item.message))
                    finished++
                }
            }
            growing.removeAll { it.requestId == null && it.shown.toInt() >= it.full.length }
            if (System.currentTimeMillis() - lastReport >= 5000) {
                StressMetrics.log(mapOf("k" to "feed", "finished" to finished, "items" to source.state.messages.size, "pushes" to pushed, "growing" to growing.size))
                lastReport = System.currentTimeMillis()
                pushed = 0
            }
            delay((interval * 1000).toLong())
        }
        push(jsObj("type" to "control", "control" to source.state.control.with("state" to "idle")), source)
        StressMetrics.log(mapOf("k" to "feed", "what" to "done", "finished" to finished, "feedSeconds" to (System.currentTimeMillis() - started) / 1000))
    }

    companion object {
        const val DEVICE_NAME = "Android"
        val APPROVAL_OPTIONS = listOf(
            jsObj("id" to "allow", "name" to "允许", "kind" to "allow_once"),
            jsObj("id" to "always", "name" to "本会话都允许", "kind" to "allow_always"),
            jsObj("id" to "reject", "name" to "拒绝", "kind" to "reject_once"),
        )

        fun token() = UUID.randomUUID().toString().take(6).lowercase()
    }
}
