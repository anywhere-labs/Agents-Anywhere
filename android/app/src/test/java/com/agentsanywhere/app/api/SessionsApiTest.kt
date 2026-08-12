package com.agentsanywhere.app.api

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionsApiTest {
    @Test
    fun createAndStartUsesSingleV2RequestWithCompleteBodyAndResponse() {
        val response = JSONObject(sessionResponse("created-session"))
            .put(
                "attachments",
                listOf(
                    JSONObject()
                        .put("fileId", "stored-file")
                        .put("name", "notes.txt")
                        .put("mediaType", "text/plain")
                        .put("size", 5)
                        .put("sha256", "stored-sha"),
                ),
            )
            .toString()
        withJsonServer(ArrayDeque(listOf(TestResponse(body = response)))) { serverUrl, requests ->
            val created = SessionsApi().createAndStartSession(
                serverUrl = serverUrl,
                authorizationToken = "token",
                request = RemoteSessionCreateAndStartRequest(
                    connectorId = "connector/one",
                    runtime = "codex",
                    title = "Task title",
                    cwd = "/workspace",
                    content = "First message",
                    selections = mapOf("model" to "model-selection", "permission" to "permission-selection"),
                    attachments = listOf(
                        RemoteInlineAttachmentRef(
                            fileId = "client-file",
                            name = "notes.txt",
                            mediaType = "text/plain",
                            size = 5,
                            sha256 = "abc123",
                            contentBase64 = "aGVsbG8=",
                        ),
                    ),
                    clientMessageId = "client-message-1",
                ),
            )

            val request = requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/v2/sessions/create-and-start", request.path)
            assertEquals("Bearer token", request.authorization)
            val body = JSONObject(request.body)
            assertEquals("connector/one", body.getString("connectorId"))
            assertEquals("codex", body.getString("runtime"))
            assertEquals("Task title", body.getString("title"))
            assertEquals("/workspace", body.getString("cwd"))
            assertEquals("First message", body.getString("content"))
            assertEquals("model-selection", body.getJSONObject("selections").getString("model"))
            assertEquals("permission-selection", body.getJSONObject("selections").getString("permission"))
            assertEquals("client-message-1", body.getString("clientMessageId"))
            val attachment = body.getJSONArray("attachments").getJSONObject(0)
            assertEquals("client-file", attachment.getString("fileId"))
            assertEquals("notes.txt", attachment.getString("name"))
            assertEquals("text/plain", attachment.getString("mediaType"))
            assertEquals(5L, attachment.getLong("size"))
            assertEquals("abc123", attachment.getString("sha256"))
            assertEquals("aGVsbG8=", attachment.getString("contentBase64"))

            assertEquals("created-session", created.session.id)
        }
    }

    @Test
    fun createAndStartOmitsOptionalFieldsForMinimalBody() {
        withJsonServer(ArrayDeque(listOf(TestResponse(body = sessionResponse("created"))))) { serverUrl, requests ->
            SessionsApi().createAndStartSession(
                serverUrl = serverUrl,
                authorizationToken = "token",
                request = RemoteSessionCreateAndStartRequest(
                    connectorId = "connector",
                    runtime = "claude",
                    title = null,
                    cwd = null,
                    content = "",
                    selections = emptyMap(),
                    attachments = emptyList(),
                    clientMessageId = null,
                ),
            )

            val body = JSONObject(requests.single().body)
            assertEquals(setOf("connectorId", "runtime", "content"), body.keys().asSequence().toSet())
            assertEquals("", body.getString("content"))
        }
    }

    @Test
    fun metaAndBulkRequestsUseV2RoutesAndAuthoritativeResponses() {
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = sessionResponse("session/one", updatedSeq = 10)),
                TestResponse(body = sessionResponse("session/one", updatedSeq = 11)),
                TestResponse(body = bulkResponse(listOf("one", "two"), notFound = listOf("missing"))),
                TestResponse(body = bulkResponse(listOf("two", "one"))),
                TestResponse(body = bulkResponse(listOf("one", "two"))),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()

            val meta = api.getSessionMeta(serverUrl, "token", "session/one")
            val patched = api.patchSession(
                serverUrl = serverUrl,
                authorizationToken = "token",
                sessionId = "session/one",
                title = "  Exact title  ",
                pinned = true,
                archived = false,
            )
            val archived = api.archiveSessions(serverUrl, "token", listOf("one", "two"))
            val unarchived = api.unarchiveSessions(serverUrl, "token", listOf("two", "one"))
            val read = api.markSessionsRead(serverUrl, "token", listOf("one", "two"))

            assertRequest(requests[0], "GET", "/api/v2/sessions/session%2Fone/meta", "")
            assertEquals("PATCH", requests[1].method)
            assertEquals("/api/v2/sessions/session%2Fone/meta", requests[1].path)
            val patchBody = JSONObject(requests[1].body)
            assertEquals("  Exact title  ", patchBody.getString("title"))
            assertTrue(patchBody.getBoolean("pinned"))
            assertFalse(patchBody.getBoolean("archived"))
            assertRequest(requests[2], "POST", "/api/v2/sessions/archive", "[\"one\",\"two\"]")
            assertRequest(requests[3], "POST", "/api/v2/sessions/unarchive", "[\"two\",\"one\"]")
            assertRequest(requests[4], "POST", "/api/v2/sessions/read", "[\"one\",\"two\"]")
            requests.forEach { assertEquals("Bearer token", it.authorization) }

            assertEquals(10, meta.session.updatedSeq)
            assertEquals("2026-08-10T00:00:00Z", meta.serverTime)
            assertEquals(11, patched.session.updatedSeq)
            assertEquals(listOf("one", "two"), archived.sessions.map { it.id })
            assertEquals(listOf("missing"), archived.notFound)
            assertEquals(listOf("two", "one"), unarchived.sessions.map { it.id })
            assertEquals(listOf("one", "two"), read.sessions.map { it.id })
        }
    }

    @Test
    fun sessionViewKeepsV2MetaFieldsAndIgnoresUnknownFields() {
        withJsonServer(ArrayDeque(listOf(TestResponse(body = sessionResponse("session"))))) { serverUrl, _ ->
            val session = SessionsApi().getSessionMeta(serverUrl, "token", "session").session

            assertEquals("connector", session.connectorId)
            assertEquals("2026-08-09T00:00:00Z", session.pinnedAt)
            assertEquals("2026-08-08T00:00:00Z", session.archivedAt)
            assertEquals(7, session.lastReadSeq)
            assertEquals(9, session.lastItemOrderSeq)
            assertEquals("codex", session.runtime)
        }
    }

    @Test
    fun takeoverAndConnectorArchiveAllRemainOnV2Paths() {
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = sessionResponse("session one")),
                TestResponse(body = sessionResponse("session one")),
                TestResponse(body = archiveAllResponse("session one")),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()

            api.enableTakeover(serverUrl, "token", "session one")
            api.disableTakeover(serverUrl, "token", "session one")
            val sessions = api.archiveAllDeviceSessions(
                serverUrl = serverUrl,
                authorizationToken = "token",
                deviceId = "connector/one",
                archived = true,
                scope = "active",
            )

            assertRequest(requests[0], "POST", "/api/v2/sessions/session%20one/takeover", "{}")
            assertRequest(requests[1], "DELETE", "/api/v2/sessions/session%20one/takeover", "")
            assertEquals("POST", requests[2].method)
            assertEquals("/api/v2/connectors/connector%2Fone/sessions/archive-all", requests[2].path)
            assertEquals(true, JSONObject(requests[2].body).getBoolean("archived"))
            assertEquals("active", JSONObject(requests[2].body).getString("scope"))
            assertEquals(listOf("session one"), sessions.map { it.id })
        }
    }

    @Test
    fun singleReadRequiresItsSessionInTheBulkResponse() {
        withJsonServer(ArrayDeque(listOf(TestResponse(body = bulkResponse(listOf("different")))))) { serverUrl, requests ->
            val error = assertThrows(IllegalStateException::class.java) {
                SessionsApi().markSessionRead(serverUrl, "token", "expected")
            }

            assertEquals("Session read response did not include this session.", error.message)
            assertRequest(requests.single(), "POST", "/api/v2/sessions/read", "[\"expected\"]")
        }
    }

    @Test
    fun detailReadsUseV2OwnedRoutesAndParseCompleteResponses() {
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = timelineResponse(hasMore = false)),
                TestResponse(body = timelineResponse(hasMore = false)),
                TestResponse(body = snapshotResponse()),
                TestResponse(body = runtimeStateResponse("future_status")),
                TestResponse(body = capabilitiesResponse()),
                TestResponse(body = noticesResponse()),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()

            val history = api.getSessionTimelineHistory(
                serverUrl,
                "token",
                "session/one",
                beforeOrderSeq = 41,
                limit = 20,
            )
            val changes = api.getSessionTimelineChanges(
                serverUrl,
                "token",
                "session/one",
                afterSeq = 11,
                limit = 30,
            )
            val snapshot = api.getSessionSnapshot(serverUrl, "token", "session/one", limit = 50)
            val runtime = api.getSessionRuntimeState(serverUrl, "token", "session/one")
            val capabilities = api.getSessionRuntimeCapabilities(serverUrl, "token", "session/one")
            val notices = api.getSessionRuntimeNotices(serverUrl, "token", "session/one")

            assertEquals(
                "/api/v2/sessions/session%2Fone/timeline?mode=history&beforeOrderSeq=41&limit=20",
                requests[0].target,
            )
            assertEquals(
                "/api/v2/sessions/session%2Fone/timeline?mode=changes&afterSeq=11&limit=30",
                requests[1].target,
            )
            assertEquals("/api/v2/sessions/session%2Fone/snapshot?limit=50", requests[2].target)
            assertEquals("/api/v2/sessions/session%2Fone/runtime/state", requests[3].target)
            assertEquals("/api/v2/sessions/session%2Fone/runtime/capabilities", requests[4].target)
            assertEquals("/api/v2/sessions/session%2Fone/runtime/notices", requests[5].target)
            requests.forEach {
                assertEquals("GET", it.method)
                assertEquals("Bearer token", it.authorization)
                assertEquals("", it.body)
                assertEquals(1, Regex("/api/v2").findAll(it.target).count())
            }

            assertEquals("session/one", history.sessionId)
            assertEquals(3, history.items.single().revision)
            assertEquals("2026-08-10T00:00:02Z", history.items.single().updatedAt)
            assertFalse(history.hasMore)
            assertEquals(12, changes.nextSeq)

            assertEquals("future_status", snapshot.state?.status)
            assertEquals("model-selection", snapshot.state?.selections?.get("model"))
            assertNull(snapshot.state?.selections?.get("permission"))
            assertEquals(4L, snapshot.effectiveCapabilities.revision)
            assertEquals("future.capability", snapshot.effectiveCapabilities.capabilities.last().capabilityId)
            assertEquals("notice-1", snapshot.notices.single().noticeId)
            assertEquals("seq:12", snapshot.eventCursor)

            assertEquals("future_status", runtime.state.status)
            assertEquals(4L, capabilities.capabilitySet.revision)
            assertTrue(capabilities.capabilitySet.capabilities.first().usable)
            assertEquals(2, notices.notices.single().revision)
            assertTrue(notices.notices.single().responseRequired)
        }
    }

    @Test
    fun runtimeActionsCatalogsCommandsAndNoticeResponseUseExactV2Contracts() {
        val selectionResponse = JSONObject()
            .put("ok", true)
            .put("state", JSONObject(runtimeStateResponse("idle")).getJSONObject("state"))
            .put("connectorResult", JSONObject().put("accepted", true))
            .put("serverTime", "2026-08-10T00:00:10Z")
            .toString()
        val commandListResponse = JSONObject()
            .put(
                "commands",
                listOf(
                    JSONObject()
                        .put("id", "compact")
                        .put("title", "Compact context")
                        .put("description", "Reduce context")
                        .put("aliases", listOf("shrink"))
                        .put("category", "context")
                        .put("scope", "session")
                        .put("enabled", false)
                        .put("disabledReason", "runtime_busy")
                        .put("acceptsArgs", true)
                        .put("argsSchema", JSONObject().put("type", "array"))
                        .put("metadata", JSONObject().put("future", true))
                        .put("futureField", true),
                ),
            )
            .put("serverTime", "2026-08-10T00:00:11Z")
            .toString()
        val commandResponse = JSONObject()
            .put("command", "compact")
            .put("ok", true)
            .put("code", JSONObject.NULL)
            .put("message", "accepted")
            .put("result", JSONObject().put("operationId", "op-1"))
            .put("serverTime", "2026-08-10T00:00:12Z")
            .toString()
        val rpcResponse = JSONObject()
            .put("ok", true)
            .put("result", JSONObject().put("accepted", true))
            .toString()
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = modelCatalogResponse()),
                TestResponse(body = permissionCatalogResponse()),
                TestResponse(body = selectionResponse),
                TestResponse(body = commandListResponse),
                TestResponse(body = commandResponse),
                TestResponse(body = rpcResponse),
                TestResponse(body = rpcResponse),
                TestResponse(body = rpcResponse),
                TestResponse(body = rpcResponse),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()
            val model = api.getSessionRuntimeModelCatalog(serverUrl, "token", "session/one")
            val permission = api.getSessionRuntimePermissionCatalog(serverUrl, "token", "session/one")
            val selection = api.patchSessionRuntimeSelections(
                serverUrl,
                "token",
                "session/one",
                linkedMapOf("model" to "model-reasoning", "permission" to null, "future" to "kept"),
            )
            val commands = api.getSessionRuntimeCommands(serverUrl, "token", "session/one")
            val command = api.executeSessionRuntimeCommand(
                serverUrl,
                "token",
                "session/one",
                command = "compact",
                args = listOf("now"),
                raw = "/compact now",
            )
            val message = api.sendSessionMessage(
                serverUrl,
                "token",
                "session/one",
                content = "message",
                clientMessageId = "client-message",
                attachments = listOf(RemoteAttachmentRef("file/one")),
            )
            val steer = api.steerSession(
                serverUrl,
                "token",
                "session/one",
                content = "steer",
                clientMessageId = "client-steer",
            )
            api.interruptSession(serverUrl, "token", "session/one")
            api.respondRuntimeNotice(
                serverUrl,
                "token",
                "session/one",
                "notice/one",
                "approve",
                mapOf("reason" to "safe", "count" to 2),
            )

            assertRequest(requests[0], "GET", "/api/v2/sessions/session%2Fone/runtime/catalogs/model", "")
            assertRequest(requests[1], "GET", "/api/v2/sessions/session%2Fone/runtime/catalogs/permission", "")
            assertEquals("PATCH", requests[2].method)
            assertEquals("/api/v2/sessions/session%2Fone/runtime/selections", requests[2].path)
            val selections = JSONObject(requests[2].body).getJSONObject("selections")
            assertEquals("model-reasoning", selections.getString("model"))
            assertTrue(selections.isNull("permission"))
            assertEquals("kept", selections.getString("future"))
            assertRequest(requests[3], "GET", "/api/v2/sessions/session%2Fone/runtime/commands", "")
            assertEquals("POST", requests[4].method)
            assertEquals("/api/v2/sessions/session%2Fone/runtime/commands", requests[4].path)
            val commandBody = JSONObject(requests[4].body)
            assertEquals("compact", commandBody.getString("command"))
            assertEquals(listOf("now"), commandBody.getJSONArray("args").toStringList())
            assertEquals("/compact now", commandBody.getString("raw"))
            assertEquals("/api/v2/sessions/session%2Fone/runtime/messages", requests[5].path)
            val messageBody = JSONObject(requests[5].body)
            assertEquals(setOf("content", "clientMessageId", "attachments"), messageBody.keys().asSequence().toSet())
            assertEquals("file/one", messageBody.getJSONArray("attachments").getJSONObject(0).getString("fileId"))
            assertRequest(
                requests[6],
                "POST",
                "/api/v2/sessions/session%2Fone/runtime/steer",
                "{\"content\":\"steer\",\"clientMessageId\":\"client-steer\"}",
            )
            assertRequest(requests[7], "POST", "/api/v2/sessions/session%2Fone/runtime/interrupt", "{}")
            assertEquals("POST", requests[8].method)
            assertEquals(
                "/api/v2/sessions/session%2Fone/runtime/notices/notice%2Fone/respond",
                requests[8].path,
            )
            val noticeBody = JSONObject(requests[8].body)
            assertEquals("approve", noticeBody.getString("actionId"))
            assertEquals("safe", noticeBody.getJSONObject("input").getString("reason"))
            assertEquals(2, noticeBody.getJSONObject("input").getInt("count"))
            requests.forEach {
                assertEquals("Bearer token", it.authorization)
                assertEquals(1, Regex("/api/v2").findAll(it.target).count())
            }

            assertEquals("model-reasoning", model.catalog.models.single().reasoningItems.single().selectionId)
            assertEquals("permission-selection", permission.catalog.permissions.single().selectionId)
            assertTrue(selection.ok)
            assertNull(selection.state?.selections?.get("permission"))
            assertEquals("compact", commands.commands.single().id)
            assertFalse(commands.commands.single().enabled)
            assertEquals(listOf("shrink"), commands.commands.single().aliases)
            assertTrue(command.ok)
            assertEquals("op-1", (command.result as JSONObject).getString("operationId"))
            assertTrue(message.ok)
            assertNull(message.errorCode)
            assertNull(message.errorMessage)
            assertTrue(steer.ok)
        }
    }

    @Test
    fun rpcFailurePreservesServerErrorForControllerHandling() {
        val response = JSONObject()
            .put("ok", false)
            .put(
                "error",
                JSONObject()
                    .put("code", "notice_not_found")
                    .put("message", "Notice was already resolved."),
            )
            .toString()
        withJsonServer(ArrayDeque(listOf(TestResponse(body = response)))) { serverUrl, _ ->
            val result = SessionsApi().respondRuntimeNotice(
                serverUrl = serverUrl,
                authorizationToken = "token",
                sessionId = "session",
                noticeId = "notice",
                actionId = "approve",
            )

            assertFalse(result.ok)
            assertEquals("notice_not_found", result.errorCode)
            assertEquals("Notice was already resolved.", result.errorMessage)
        }
    }

    @Test
    fun attachmentOnlyMessageUsesEmptyContentAndFileIdRefsOnly() {
        val rpcResponse = JSONObject()
            .put("ok", true)
            .put("result", JSONObject().put("accepted", true))
            .toString()
        withJsonServer(ArrayDeque(listOf(TestResponse(body = rpcResponse)))) { serverUrl, requests ->
            SessionsApi().sendSessionMessage(
                serverUrl = serverUrl,
                authorizationToken = "token",
                sessionId = "session/one",
                content = "",
                clientMessageId = "client-attachment",
                attachments = listOf(RemoteAttachmentRef("file/one")),
            )

            val body = JSONObject(requests.single().body)
            assertEquals("", body.getString("content"))
            assertEquals("client-attachment", body.getString("clientMessageId"))
            val attachment = body.getJSONArray("attachments").getJSONObject(0)
            assertEquals(setOf("fileId"), attachment.keys().asSequence().toSet())
            assertEquals("file/one", attachment.getString("fileId"))
        }
    }

    @Test
    fun attachmentDownloadUsesAuthAndRejectsCorruptSizeOrSha256() {
        val bytes = "downloaded".toByteArray()
        val sha256 = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte) }
        fun response(size: Long = bytes.size.toLong(), digest: String = sha256): String = JSONObject()
            .put("fileId", "file/one")
            .put("sessionId", "session/one")
            .put("path", "")
            .put("name", "file.txt")
            .put("size", size)
            .put("sha256", digest)
            .put("contentBase64", Base64.getEncoder().encodeToString(bytes))
            .put("createdAt", "now")
            .put("serverTime", "now")
            .toString()

        withJsonServer(ArrayDeque(listOf(TestResponse(body = response())))) { serverUrl, requests ->
            val downloaded = SessionsApi().downloadSessionAttachment(
                serverUrl,
                "token",
                "session/one",
                "file/one",
            )
            assertEquals(bytes.toList(), downloaded.bytes.toList())
            assertEquals(sha256, downloaded.sha256)
            assertRequest(
                requests.single(),
                "GET",
                "/api/v2/sessions/session%2Fone/attachments/file%2Fone",
                "",
            )
            assertEquals("Bearer token", requests.single().authorization)
        }
        withJsonServer(ArrayDeque(listOf(TestResponse(body = response(size = 999))))) { serverUrl, _ ->
            val error = assertThrows(AttachmentTransferException::class.java) {
                SessionsApi().downloadSessionAttachment(serverUrl, "token", "session", "file")
            }
            assertEquals(AttachmentTransferFailure.SizeMismatch, error.failure)
        }
        withJsonServer(ArrayDeque(listOf(TestResponse(body = response(digest = "0".repeat(64)))))) { serverUrl, _ ->
            val error = assertThrows(AttachmentTransferException::class.java) {
                SessionsApi().downloadSessionAttachment(serverUrl, "token", "session", "file")
            }
            assertEquals(AttachmentTransferFailure.Sha256Mismatch, error.failure)
        }
    }

    @Test
    fun authNotFoundValidationAndNetworkFailuresRemainErrors() {
        listOf(401, 404, 422).forEach { status ->
            withJsonServer(
                ArrayDeque(listOf(TestResponse(status = status, body = "{\"detail\":\"failure $status\"}"))),
            ) { serverUrl, _ ->
                val error = assertThrows(ApiException::class.java) {
                    SessionsApi().getSessionMeta(serverUrl, "token", "session")
                }
                assertEquals(status, error.statusCode)
                assertEquals("failure $status", error.message)
            }
        }

        val unavailablePort = ServerSocket(0).use { it.localPort }
        val error = assertThrows(ApiException::class.java) {
            SessionsApi().getSessionMeta("http://127.0.0.1:$unavailablePort", "token", "session")
        }
        assertNull(error.statusCode)

        val invalidUrl = assertThrows(ApiException::class.java) {
            SessionsApi().getSessionMeta("not a server URL", "token", "session")
        }
        assertEquals("The server URL is invalid.", invalidUrl.message)
        assertNull(invalidUrl.statusCode)
    }

    private fun sessionResponse(id: String, updatedSeq: Int = 12): String {
        val session = JSONObject()
            .put("id", id)
            .put("connectorId", "connector")
            .put("connectorStatus", "online")
            .put("runtime", "codex")
            .put("externalSessionId", JSONObject.NULL)
            .put("title", "Title")
            .put("cwd", "/workspace")
            .put("status", "idle")
            .put("takeover", false)
            .put("pinned", true)
            .put("pinnedAt", "2026-08-09T00:00:00Z")
            .put("archived", true)
            .put("archivedAt", "2026-08-08T00:00:00Z")
            .put("unread", false)
            .put("lastReadSeq", 7)
            .put("lastSyncedAt", "2026-08-07T00:00:00Z")
            .put("sourceObservedAt", "2026-08-07T00:00:00Z")
            .put("lastActivityAt", "2026-08-07T00:00:00Z")
            .put("lastItemAt", "2026-08-07T00:00:00Z")
            .put("lastItemOrderSeq", 9)
            .put("sortAt", "2026-08-07T00:00:00Z")
            .put("updatedSeq", updatedSeq)
            .put("futureField", true)
        return JSONObject()
            .put("session", session)
            .put("serverTime", "2026-08-10T00:00:00Z")
            .put("futureTopLevel", true)
            .toString()
    }

    private fun bulkResponse(ids: List<String>, notFound: List<String> = emptyList()): String {
        return JSONObject()
            .put("sessions", ids.map { JSONObject(sessionResponse(it)).getJSONObject("session") })
            .put("notFound", notFound)
            .put("serverTime", "2026-08-10T00:00:01Z")
            .toString()
    }

    private fun archiveAllResponse(id: String): String {
        return JSONObject()
            .put("sessions", listOf(JSONObject(sessionResponse(id)).getJSONObject("session")))
            .put("affected", 1)
            .put("serverTime", "2026-08-10T00:00:02Z")
            .toString()
    }

    private fun timelineResponse(hasMore: Boolean): String {
        return JSONObject()
            .put("sessionId", "session/one")
            .put("items", listOf(timelineItem()))
            .put("nextSeq", 12)
            .put("hasMore", hasMore)
            .put("serverTime", "2026-08-10T00:00:03Z")
            .put("futureField", true)
            .toString()
    }

    private fun snapshotResponse(): String {
        return JSONObject()
            .put("session", JSONObject(sessionResponse("session/one")).getJSONObject("session"))
            .put("state", JSONObject(runtimeStateResponse("future_status")).getJSONObject("state"))
            .put(
                "timeline",
                JSONObject()
                    .put("items", listOf(timelineItem()))
                    .put("nextSeq", 12)
                    .put("hasMore", true),
            )
            .put("approvals", emptyList<Any>())
            .put("notices", JSONObject(noticesResponse()).getJSONArray("notices"))
            .put("effectiveCapabilities", JSONObject(capabilitiesResponse()).getJSONObject("capabilitySet"))
            .put("runtimeCapabilities", JSONObject(capabilitiesResponse()).getJSONObject("capabilitySet"))
            .put(
                "catalogs",
                JSONObject()
                    .put(
                        "model",
                        JSONObject()
                            .put("runtime", "codex")
                            .put("revision", 7)
                            .put(
                                "models",
                                listOf(
                                    JSONObject()
                                        .put("id", "model")
                                        .put("selectionId", "model-selection")
                                        .put("displayName", "Model")
                                        .put("default", true)
                                        .put("reasoningItems", emptyList<Any>())
                                        .put("metadata", JSONObject()),
                                ),
                            ),
                    )
                    .put(
                        "permission",
                        JSONObject()
                            .put("runtime", "codex")
                            .put("revision", 8)
                            .put(
                                "permissions",
                                listOf(
                                    JSONObject()
                                        .put("id", "permission")
                                        .put("selectionId", "permission-selection")
                                        .put("displayName", "Permission")
                                        .put("default", true)
                                        .put("metadata", JSONObject()),
                                ),
                            ),
                    )
                    .put("futureCatalog", JSONObject().put("revision", 99)),
            )
            .put("eventCursor", "seq:12")
            .put("serverTime", "2026-08-10T00:00:04Z")
            .put("futureField", true)
            .toString()
    }

    private fun runtimeStateResponse(status: String): String {
        return JSONObject()
            .put(
                "state",
                JSONObject()
                    .put("sessionId", "session/one")
                    .put("runtime", "codex")
                    .put("externalSessionId", JSONObject.NULL)
                    .put("status", status)
                    .put(
                        "selections",
                        JSONObject().put("model", "model-selection").put("permission", JSONObject.NULL),
                    )
                    .put("statusReason", "server reason")
                    .put("error", JSONObject().put("code", "future"))
                    .put("metadata", JSONObject().put("source", "connector"))
                    .put("updatedSeq", 12)
                    .put("createdAt", "2026-08-10T00:00:00Z")
                    .put("updatedAt", "2026-08-10T00:00:02Z")
                    .put("futureField", true),
            )
            .put("serverTime", "2026-08-10T00:00:04Z")
            .toString()
    }

    private fun capabilitiesResponse(): String {
        return JSONObject()
            .put("connectorId", "connector")
            .put(
                "capabilitySet",
                JSONObject()
                    .put("revision", 4)
                    .put(
                        "capabilities",
                        listOf(
                            JSONObject()
                                .put("capabilityId", "session.send_message")
                                .put("version", "1")
                                .put("scope", "session")
                                .put("runtime", "codex")
                                .put("sessionId", "session/one")
                                .put("supported", true)
                                .put("available", true)
                                .put("allowed", true)
                                .put("parameters", JSONObject()),
                            JSONObject()
                                .put("capabilityId", "future.capability")
                                .put("supported", true)
                                .put("available", false)
                                .put("allowed", true)
                                .put("unavailableReason", "future")
                                .put("futureField", true),
                        ),
                    ),
            )
            .put("serverTime", "2026-08-10T00:00:04Z")
            .toString()
    }

    private fun noticesResponse(): String {
        return JSONObject()
            .put(
                "notices",
                listOf(
                    JSONObject()
                        .put("noticeId", "notice-1")
                        .put("type", "interaction")
                        .put("sessionId", "session/one")
                        .put("source", JSONObject().put("runtime", "codex"))
                        .put("title", "Approve")
                        .put("message", "Continue?")
                        .put("severity", "warning")
                        .put("status", "open")
                        .put("interactionType", "approval")
                        .put("blocking", JSONObject().put("scope", "session").put("targetId", "session/one"))
                        .put("responseRequired", true)
                        .put(
                            "actions",
                            listOf(
                                JSONObject()
                                    .put("actionId", "approve")
                                    .put("label", "Approve")
                                    .put("style", "primary")
                                    .put(
                                        "input",
                                        JSONObject()
                                            .put("required", true)
                                            .put(
                                                "schema",
                                                JSONObject()
                                                    .put("type", "object")
                                                    .put(
                                                        "properties",
                                                        JSONObject().put(
                                                            "reason",
                                                            JSONObject().put("type", "string"),
                                                        ),
                                                    )
                                                    .put("required", listOf("reason")),
                                            ),
                                    )
                                    .put("futureAction", true),
                            ),
                        )
                        .put("context", JSONObject().put("path", "/workspace"))
                        .put("metadata", JSONObject().put("future", true))
                        .put("revision", 2)
                        .put("updatedSeq", 13)
                        .put("createdAt", "2026-08-10T00:00:01Z")
                        .put("updatedAt", "2026-08-10T00:00:02Z")
                        .put("futureField", true),
                ),
            )
            .put("serverTime", "2026-08-10T00:00:05Z")
            .toString()
    }

    private fun modelCatalogResponse(): String {
        return JSONObject()
            .put(
                "catalog",
                JSONObject()
                    .put("runtime", "codex")
                    .put("revision", 8)
                    .put(
                        "models",
                        listOf(
                            JSONObject()
                                .put("id", "model")
                                .put("selectionId", "model-selection")
                                .put("displayName", "Model")
                                .put("description", "Model description")
                                .put("default", true)
                                .put(
                                    "reasoningItems",
                                    listOf(
                                        JSONObject()
                                            .put("id", "high")
                                            .put("selectionId", "model-reasoning")
                                            .put("displayName", "High")
                                            .put("default", true)
                                            .put("metadata", JSONObject()),
                                    ),
                                )
                                .put("metadata", JSONObject()),
                        ),
                    ),
            )
            .put("serverTime", "2026-08-10T00:00:08Z")
            .toString()
    }

    private fun permissionCatalogResponse(): String {
        return JSONObject()
            .put(
                "catalog",
                JSONObject()
                    .put("runtime", "codex")
                    .put("revision", 9)
                    .put(
                        "permissions",
                        listOf(
                            JSONObject()
                                .put("id", "permission")
                                .put("selectionId", "permission-selection")
                                .put("displayName", "Permission")
                                .put("default", true)
                                .put("metadata", JSONObject()),
                        ),
                    ),
            )
            .put("serverTime", "2026-08-10T00:00:09Z")
            .toString()
    }

    private fun timelineItem(): JSONObject {
        return JSONObject()
            .put("id", "item-1")
            .put("sessionId", "session/one")
            .put("type", "message")
            .put("status", "done")
            .put("role", "assistant")
            .put("content", JSONObject().put("text", "Hello"))
            .put("source", JSONObject().put("runtime", "codex"))
            .put("orderSeq", 40)
            .put("revision", 3)
            .put("updatedSeq", 9)
            .put("createdAt", "2026-08-10T00:00:01Z")
            .put("updatedAt", "2026-08-10T00:00:02Z")
            .put("futureField", true)
    }

    private fun assertRequest(request: RecordedRequest, method: String, path: String, body: String) {
        assertEquals(method, request.method)
        assertEquals(path, request.path)
        assertEquals(body, request.body)
    }

    private fun withJsonServer(
        responses: ArrayDeque<TestResponse>,
        block: (String, List<RecordedRequest>) -> Unit,
    ) {
        TestJsonServer(responses).use { server -> block(server.url, server.requests) }
    }

    private data class TestResponse(
        val status: Int = 200,
        val body: String,
    )

    private data class RecordedRequest(
        val method: String,
        val path: String,
        val target: String,
        val body: String,
        val authorization: String?,
    )

    private class TestJsonServer(
        private val responses: ArrayDeque<TestResponse>,
    ) : Closeable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val url = "http://127.0.0.1:${socket.localPort}"
        private var failure: Throwable? = null
        private val worker = thread(name = "sessions-api-test-server") {
            runCatching {
                repeat(responses.size) {
                    socket.accept().use { client ->
                        val input = BufferedInputStream(client.getInputStream())
                        val headers = readHeaderBlock(input)
                        val lines = headers.split("\r\n")
                        val requestLine = lines.first().split(' ')
                        val headerValues = lines.drop(1).mapNotNull { line ->
                            val separator = line.indexOf(':')
                            if (separator <= 0) null else {
                                line.substring(0, separator).trim().lowercase() to
                                    line.substring(separator + 1).trim()
                            }
                        }.toMap()
                        val contentLength = headerValues["content-length"]?.toIntOrNull() ?: 0
                        val body = ByteArray(contentLength)
                        var offset = 0
                        while (offset < body.size) {
                            val read = input.read(body, offset, body.size - offset)
                            if (read < 0) break
                            offset += read
                        }
                        requests += RecordedRequest(
                            method = requestLine[0],
                            path = requestLine[1].substringBefore('?'),
                            target = requestLine[1],
                            body = body.copyOf(offset).toString(Charsets.UTF_8),
                            authorization = headerValues["authorization"],
                        )
                        val response = responses.removeFirst()
                        val responseBytes = response.body.toByteArray()
                        val reason = if (response.status in 200..299) "OK" else "Error"
                        client.getOutputStream().use { output ->
                            output.write(
                                (
                                    "HTTP/1.1 ${response.status} $reason\r\n" +
                                        "Content-Type: application/json\r\n" +
                                        "Content-Length: ${responseBytes.size}\r\n" +
                                        "Connection: close\r\n\r\n"
                                ).toByteArray(),
                            )
                            output.write(responseBytes)
                        }
                    }
                }
            }.onFailure { failure = it }
        }

        override fun close() {
            worker.join(5_000)
            socket.close()
            failure?.let { throw AssertionError("Test HTTP server failed", it) }
            assertFalse("Test HTTP server did not finish", worker.isAlive)
        }

        private fun readHeaderBlock(input: BufferedInputStream): String {
            val output = ByteArrayOutputStream()
            var matched = 0
            while (matched < 4) {
                val value = input.read()
                if (value < 0) break
                output.write(value)
                matched = when {
                    matched == 0 && value == '\r'.code -> 1
                    matched == 1 && value == '\n'.code -> 2
                    matched == 2 && value == '\r'.code -> 3
                    matched == 3 && value == '\n'.code -> 4
                    value == '\r'.code -> 1
                    else -> 0
                }
            }
            return output.toString(Charsets.UTF_8.name()).removeSuffix("\r\n\r\n")
        }
    }
}
