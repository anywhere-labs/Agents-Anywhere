package com.agentsanywhere.app.feature.sessiondetail

import android.content.Context
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.RemoteTimelineItem
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.toProtocolJson
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * What one session keeps on disk: the protocol documents as the Server sent
 * them plus this client's position. Runtime state, notices, catalogs and local
 * (unconfirmed) messages are live facts and are read again on every visit.
 */
data class PersistedSession(
    val session: RemoteSession,
    val items: List<RemoteTimelineItem>,
    val nextSeq: Int,
    val hasMore: Boolean,
    /** The realtime recovery cursor that matches [items]. */
    val eventCursor: String,
    val reading: SessionReadingPosition = SessionReadingPosition(),
)

/**
 * Session content on disk, below `noBackupFilesDir`, one directory per
 * server and account (hashed). All file work runs in order on one background
 * thread, so a deletion always wins over writes queued before it.
 *
 * Forgetting a scope (sign-out) bumps its epoch first: a write captured before
 * that, including one from a page closing after sign-out, is dropped.
 */
class SessionDiskStore(
    private val root: File,
    private val maxEntries: Int = 50,
    private val maxBytes: Long = 64L * 1024 * 1024,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "session-disk-cache").apply { isDaemon = true }
    }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val epochs = ConcurrentHashMap<String, Long>()
    private val forgetAll = AtomicLong(0)

    /** Changes whenever [scope] is forgotten; a write captured with an older epoch is dropped. */
    fun epoch(scope: String): String = "${forgetAll.get()}:${epochs[scope] ?: 0L}"

    fun write(scope: String, epoch: String, sessionId: String, record: PersistedSession) {
        if (epoch(scope) != epoch) return
        executor.execute {
            if (epoch(scope) != epoch) return@execute
            runCatching {
                val data = encode(scope, sessionId, record).toString().toByteArray(Charsets.UTF_8)
                if (data.size > maxBytes) return@runCatching
                val directory = scopeDirectory(scope).apply { mkdirs() }
                val target = File(directory, fileName(sessionId))
                val temporary = File(directory, "${target.name}.tmp")
                temporary.writeBytes(data)
                if (!temporary.renameTo(target)) {
                    target.delete()
                    if (!temporary.renameTo(target)) temporary.delete()
                }
                target.setLastModified(now())
                prune(directory)
            }
        }
    }

    /** The stored session, or null when missing, unreadable, from another version or another scope. */
    suspend fun read(scope: String, sessionId: String): PersistedSession? = withContext(dispatcher) {
        val file = File(scopeDirectory(scope), fileName(sessionId))
        if (!file.isFile) return@withContext null
        val record = runCatching { decode(scope, sessionId, JSONObject(file.readText())) }.getOrNull()
        if (record == null) file.delete() else file.setLastModified(now())
        record
    }

    fun delete(scope: String, sessionId: String) {
        executor.execute { File(scopeDirectory(scope), fileName(sessionId)).delete() }
    }

    /** Sign-out: removes this account's content; pages still open cannot write it back. */
    fun forget(scope: String) {
        epochs.merge(scope, 1L) { current, increment -> current + increment }
        executor.execute { scopeDirectory(scope).deleteRecursively() }
    }

    /** Signing in: removes every other server/account. */
    fun retainOnly(scope: String) {
        val keep = scopeDirectory(scope).name
        executor.execute {
            root.listFiles()?.filter { it.name != keep }?.forEach { it.deleteRecursively() }
        }
    }

    /** Waits until queued file work has finished (tests). */
    fun flush() {
        executor.submit {}.get(10, TimeUnit.SECONDS)
    }

    private fun prune(directory: File) {
        val files = directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }
            ?: return
        var total = 0L
        files.forEachIndexed { index, file ->
            total += file.length()
            if (index >= maxEntries || total > maxBytes) file.delete()
        }
    }

    private fun scopeDirectory(scope: String) = File(root, sha256(scope))

    private fun fileName(sessionId: String) = sha256(sessionId) + ".json"

    companion object {
        /** Bump when the stored shape changes: older records are ignored and overwritten, never migrated. */
        const val RECORD_VERSION = 1
        private const val DIRECTORY = "session-cache"

        @Volatile private var shared: SessionDiskStore? = null

        /** One store per process, so sign-out epochs outlive recreated screens and controllers. */
        fun shared(context: Context): SessionDiskStore = shared ?: synchronized(this) {
            shared ?: SessionDiskStore(File(context.applicationContext.noBackupFilesDir, DIRECTORY)).also { shared = it }
        }

        fun scopeFor(serverUrl: String, userId: String): String = JSONArray().put(serverUrl).put(userId).toString()

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

        internal fun encode(scope: String, sessionId: String, record: PersistedSession): JSONObject = JSONObject()
            .put("version", RECORD_VERSION)
            .put("scope", scope)
            .put("sessionId", sessionId)
            .put("session", record.session.toProtocolJson())
            .put("items", JSONArray().apply { record.items.forEach { put(it.toProtocolJson()) } })
            .put("nextSeq", record.nextSeq)
            .put("hasMore", record.hasMore)
            .put("eventCursor", record.eventCursor)
            .put(
                "reading",
                JSONObject()
                    .put("firstVisibleItemIndex", record.reading.firstVisibleItemIndex)
                    .put("firstVisibleItemScrollOffset", record.reading.firstVisibleItemScrollOffset)
                    .put("reading", JSONArray(record.reading.reading)),
            )

        internal fun decode(scope: String, sessionId: String, value: JSONObject): PersistedSession? {
            if (value.optInt("version") != RECORD_VERSION || value.optString("scope") != scope ||
                value.optString("sessionId") != sessionId
            ) return null
            val api = SessionsApi()
            val session = api.parseSession(value.getJSONObject("session"))
            if (session.id != sessionId) return null
            val items = value.getJSONArray("items").let { array ->
                List(array.length()) { index -> api.parseTimelineItem(array.getJSONObject(index)) }
            }
            val reading = value.optJSONObject("reading") ?: JSONObject()
            return PersistedSession(
                session = session,
                items = items,
                nextSeq = value.optInt("nextSeq", 0),
                hasMore = value.optBoolean("hasMore", false),
                eventCursor = value.optString("eventCursor", "seq:0"),
                reading = SessionReadingPosition(
                    firstVisibleItemIndex = reading.optInt("firstVisibleItemIndex", 0),
                    firstVisibleItemScrollOffset = reading.optInt("firstVisibleItemScrollOffset", 0),
                    reading = reading.optJSONArray("reading")?.let { array ->
                        List(array.length()) { index -> array.optString(index) }
                    }.orEmpty(),
                ),
            )
        }
    }
}
