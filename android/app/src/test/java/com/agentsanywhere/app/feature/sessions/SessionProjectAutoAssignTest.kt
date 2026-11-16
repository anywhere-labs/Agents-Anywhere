package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 加密模式按解出的工作目录归属项目：路径规范化、最长前缀、每次运行最多一次、失败静默。 */
class SessionProjectAutoAssignTest {
    private fun project(id: String, path: String, connectorId: String = "dev_1") = AgentProject(
        id = id,
        userId = "user",
        connectorId = connectorId,
        name = id,
        workspacePath = path,
        pinned = false,
        pinnedAt = null,
        activeSessionCount = 0,
        lastActivityAt = null,
        createdAt = "",
        updatedAt = "",
    )

    private fun session(
        id: String,
        cwd: String?,
        projectId: String? = null,
        encrypted: Boolean = true,
        cwdLocked: Boolean = false,
        connectorId: String = "dev_1",
    ) = AgentSession(
        id = id,
        connectorId = connectorId,
        projectId = projectId,
        deviceName = "Laptop",
        title = "Task",
        summary = "",
        cwd = cwd,
        workspaceLabel = "",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = SessionStatus.Idle,
        statusLabel = "",
        updatedAtLabel = "",
        metaLabel = "",
        pinned = false,
        archived = false,
        unread = false,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = "",
        updatedSeq = 0,
        encryptedDisplay = encrypted,
        cwdLocked = cwdLocked,
    )

    @Test
    fun normalizesWhitespaceTrailingSeparatorsAndWindowsCase() {
        assertEquals(NormalizedWorkspacePath("/a/b", false), normalizeWorkspacePath("  /a/b/ "))
        assertEquals(NormalizedWorkspacePath("/", false), normalizeWorkspacePath("/"))
        assertEquals(NormalizedWorkspacePath("c:\\users\\me", true), normalizeWorkspacePath("C:\\Users\\Me\\"))
        assertEquals(NormalizedWorkspacePath("c:\\users\\me", true), normalizeWorkspacePath("c:/users/me/"))
        assertEquals(NormalizedWorkspacePath("c:", true), normalizeWorkspacePath("C:\\"))
        // POSIX paths keep their case; only the `X:\` form is a Windows path.
        assertEquals(NormalizedWorkspacePath("/Users/Me", false), normalizeWorkspacePath("/Users/Me"))
        assertEquals(NormalizedWorkspacePath("Repo/Sub", false), normalizeWorkspacePath("Repo/Sub/"))
        assertNull(normalizeWorkspacePath("   "))
        assertNull(normalizeWorkspacePath(null))
    }

    @Test
    fun exactMatchWinsThenTheLongestSegmentPrefix() {
        val projects = listOf(
            project("root", "/work"),
            project("app", "/work/app/"),
            project("deep", "/work/app/packages"),
            project("sibling", "/work/ap"),
            project("other-device", "/work/app/packages/web", connectorId = "dev_2"),
        )
        assertEquals("app", matchProjectForCwd("dev_1", "/work/app", projects)?.id)
        assertEquals("deep", matchProjectForCwd("dev_1", "/work/app/packages/web/src", projects)?.id)
        assertEquals("app", matchProjectForCwd("dev_1", "/work/app/src", projects)?.id)
        // `/work/ap` is not a parent of `/work/apple`, `/work` is.
        assertEquals("root", matchProjectForCwd("dev_1", "/work/apple", projects)?.id)
        assertNull(matchProjectForCwd("dev_1", "/elsewhere", projects))
        assertNull(matchProjectForCwd("dev_1", "/workspace", projects))
        // Only the session's own device counts.
        assertNull(matchProjectForCwd("dev_3", "/work/app", projects))
        assertEquals("other-device", matchProjectForCwd("dev_2", "/work/app/packages/web", projects)?.id)
    }

    @Test
    fun windowsPathsMatchIgnoringCase() {
        val projects = listOf(project("repo", "C:\\Users\\Me\\Repo"), project("drive", "D:\\"))
        assertEquals("repo", matchProjectForCwd("dev_1", "c:\\users\\me\\repo", projects)?.id)
        assertEquals("repo", matchProjectForCwd("dev_1", "C:\\USERS\\ME\\REPO\\src\\", projects)?.id)
        assertNull(matchProjectForCwd("dev_1", "C:\\Users\\Me\\Repository", projects))
        assertEquals("drive", matchProjectForCwd("dev_1", "d:\\tmp", projects)?.id)
        // POSIX paths stay case-sensitive.
        assertNull(matchProjectForCwd("dev_1", "/Work/App", listOf(project("app", "/work/app"))))
        assertEquals("root", matchProjectForCwd("dev_1", "/anything", listOf(project("root", "/")))?.id)
    }

    @Test
    fun onlyUnplacedSessionsWithADecryptedCwdAreAssigned() {
        val projects = listOf(project("app", "/work/app"))
        val assigner = SessionProjectAutoAssigner(assign = { _, _ -> error("unused") }, attempted = mutableSetOf())
        val pending = assigner.pending(
            listOf(
                session("ok", "/work/app/src"),
                session("placed", "/work/app", projectId = "p"),
                session("plain-mode", "/work/app", encrypted = false),
                session("locked", null, cwdLocked = true),
                session("no-cwd", null),
                session("no-match", "/elsewhere"),
            ),
            projects,
        )
        assertEquals(listOf("ok" to "app"), pending.map { (s, p) -> s.id to p.id })
    }

    @Test
    fun eachSessionIsTriedOncePerRunAndFailuresAreSilent() = runBlocking {
        val projects = listOf(project("app", "/work/app"), project("lib", "/work/lib"))
        val calls = mutableListOf<Pair<String, String>>()
        val logs = mutableListOf<String>()
        val attempted = mutableSetOf<String>()
        val assigner = SessionProjectAutoAssigner(
            assign = { sessionId, projectId ->
                calls += sessionId to projectId
                when (sessionId) {
                    "gone" -> Result.failure(ApiException("missing", 404, errorCode = "project_not_found"))
                    "moved" -> throw ApiException("mismatch", 422, errorCode = "project_workspace_mismatch")
                    else -> Result.success(session(sessionId, "/work/app", projectId = projectId))
                }
            },
            attempted = attempted,
            log = { logs += it },
        )
        val sessions = listOf(session("ok", "/work/app"), session("gone", "/work/lib/x"), session("moved", "/work/app/y"))

        val updated = assigner.run(sessions, projects)
        assertEquals(listOf("ok"), updated.map { it.id })
        assertEquals("app", updated.single().projectId)
        assertEquals(listOf("ok" to "app", "gone" to "lib", "moved" to "app"), calls)
        assertEquals(2, logs.size)

        // The same sessions (still unplaced in a stale list) are not tried again in this run.
        assertTrue(assigner.run(sessions, projects).isEmpty())
        assertTrue(assigner.pending(sessions, projects).isEmpty())
        assertEquals(3, calls.size)

        // A session with no matching project is not marked; it is tried once a project appears.
        val later = session("later", "/work/new")
        assertTrue(assigner.run(listOf(later), projects).isEmpty())
        assertEquals(3, calls.size)
        assertEquals(listOf("later"), assigner.run(listOf(later), projects + project("new", "/work/new")).map { it.id })

        assigner.reset()
        assertEquals(3, assigner.pending(sessions, projects).size)
    }
}
