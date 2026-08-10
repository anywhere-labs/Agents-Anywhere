package com.agentsanywhere.app.api

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesApiTest {
    @Test
    fun runtimeRequestsUseV2RoutesAndExactBodies() {
        val runtime = runtimeJson("codex")
        val responses = ArrayDeque(
            listOf(
                listJson(runtime, runtimeJson("acp")),
                listJson(runtime),
                runtime,
                runtime,
                runtime,
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = DevicesApi()

            api.listDeviceRuntimes(serverUrl, "token", "connector one")
            api.discoverDeviceRuntimes(serverUrl, "token", "connector one")
            api.putDeviceRuntimeConfig(
                serverUrl = serverUrl,
                authorizationToken = "token",
                deviceId = "connector one",
                runtime = "codex",
                config = mapOf(
                    "executablePath" to "/opt/codex",
                    "environment" to mapOf("HTTP_PROXY" to "http://proxy", "OLD" to null),
                ),
            )
            api.setDeviceRuntimeActive(serverUrl, "token", "connector one", "codex", true)
            api.deleteDeviceRuntimeConfig(serverUrl, "token", "connector one", "codex")

            assertEquals(5, requests.size)
            assertRequest(requests[0], "GET", "/api/v2/connectors/connector%20one/runtimes", "")
            assertRequest(requests[1], "POST", "/api/v2/connectors/connector%20one/runtimes/discover", "")
            assertEquals("PUT", requests[2].method)
            assertEquals("/api/v2/connectors/connector%20one/runtimes/codex/config", requests[2].path)
            val config = JSONObject(requests[2].body).getJSONObject("config")
            assertEquals("/opt/codex", config.getString("executablePath"))
            assertEquals("http://proxy", config.getJSONObject("environment").getString("HTTP_PROXY"))
            assertTrue(config.getJSONObject("environment").isNull("OLD"))
            assertEquals("PUT", requests[3].method)
            assertEquals("/api/v2/connectors/connector%20one/runtimes/codex/active", requests[3].path)
            assertTrue(JSONObject(requests[3].body).getBoolean("active"))
            assertRequest(
                requests[4],
                "DELETE",
                "/api/v2/connectors/connector%20one/runtimes/codex/config",
                "",
            )
            requests.forEach { assertEquals("Bearer token", it.authorization) }
        }
    }

    @Test
    fun runtimeResponseMapsAllFieldsAndFiltersUnsupportedProviders() {
        val codex = runtimeJson("codex")
        val unknownClaude = runtimeJson("claude", status = "future-status")
        withJsonServer(ArrayDeque(listOf(listJson(codex, runtimeJson("acp"), unknownClaude)))) { serverUrl, _ ->
            val result = DevicesApi().listDeviceRuntimes(serverUrl, "token", "connector one")

            assertEquals("connector one", result.connectorId)
            assertEquals(listOf("codex", "claude"), result.runtimes.map { it.runtimeId })
            assertEquals("2026-08-10T00:00:00Z", result.serverTime)
            val runtime = result.runtimes.first()
            assertEquals("native", runtime.runtimeType)
            assertEquals("Codex", runtime.displayName)
            assertTrue(runtime.present)
            assertTrue(runtime.configured)
            assertFalse(runtime.active)
            assertEquals(RemoteDeviceRuntimeStatus.Available, runtime.status)
            assertEquals(true, runtime.discovery["available"])
            assertEquals("object", runtime.schema?.get("type"))
            assertEquals(listOf("environment"), runtime.uiSchema["order"])
            assertEquals(emptyMap<String, Any?>(), runtime.config)
            assertNull(runtime.error)
            assertEquals("2026-08-10T00:00:00Z", runtime.lastDiscoveredAt)
            assertEquals(RemoteDeviceRuntimeStatus.Unknown, result.runtimes.last().status)
        }
    }

    @Test
    fun runtimeCapabilityAndCatalogRequestsUseEncodedV2Routes() {
        val responses = ArrayDeque(
            listOf(
                capabilitiesJson(),
                modelCatalogJson(),
                permissionCatalogJson(),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = DevicesApi()

            api.getDeviceRuntimeCapabilities(serverUrl, "token", "connector/one", "claude code")
            api.getDeviceRuntimeModelCatalog(serverUrl, "token", "connector/one", "claude code")
            api.getDeviceRuntimePermissionCatalog(serverUrl, "token", "connector/one", "claude code")

            assertEquals(3, requests.size)
            assertRequest(
                requests[0],
                "GET",
                "/api/v2/connectors/connector%2Fone/runtimes/claude%20code/capabilities",
                "",
            )
            assertRequest(
                requests[1],
                "GET",
                "/api/v2/connectors/connector%2Fone/runtimes/claude%20code/catalogs/model",
                "",
            )
            assertRequest(
                requests[2],
                "GET",
                "/api/v2/connectors/connector%2Fone/runtimes/claude%20code/catalogs/permission",
                "",
            )
            requests.forEach { assertEquals("Bearer token", it.authorization) }
        }
    }

    @Test
    fun runtimeCapabilityAndCatalogResponsesMapCompleteProtocolData() {
        val responses = ArrayDeque(
            listOf(
                capabilitiesJson(),
                modelCatalogJson(),
                permissionCatalogJson(),
            ),
        )
        withJsonServer(responses) { serverUrl, _ ->
            val api = DevicesApi()
            val capabilities = api.getDeviceRuntimeCapabilities(serverUrl, "token", "connector", "codex")
            val models = api.getDeviceRuntimeModelCatalog(serverUrl, "token", "connector", "codex")
            val permissions = api.getDeviceRuntimePermissionCatalog(serverUrl, "token", "connector", "codex")

            assertEquals("connector", capabilities.connectorId)
            assertEquals(42L, capabilities.capabilitySet.revision)
            assertEquals(2, capabilities.capabilitySet.capabilities.size)
            val modelCapability = capabilities.capabilitySet.capabilities.first()
            assertEquals("catalog.model", modelCapability.capabilityId)
            assertEquals("2", modelCapability.version)
            assertEquals("runtime", modelCapability.scope)
            assertEquals("codex", modelCapability.runtime)
            assertNull(modelCapability.sessionId)
            assertTrue(modelCapability.usable)
            assertEquals(200, modelCapability.parameters["limit"])
            val unknownCapability = capabilities.capabilitySet.capabilities.last()
            assertEquals("future.capability", unknownCapability.capabilityId)
            assertFalse(unknownCapability.usable)
            assertEquals("not ready", unknownCapability.unavailableReason)

            assertEquals("codex", models.catalog.runtime)
            assertEquals(7L, models.catalog.revision)
            assertEquals(1, models.catalog.models.size)
            val model = models.catalog.models.single()
            assertEquals("gpt-5.6", model.id)
            assertNull(model.selectionId)
            assertTrue(model.default)
            assertEquals("model.label", (model.metadata["i18n"] as Map<*, *>)["labelKey"])
            val reasoning = model.reasoningItems.single()
            assertEquals("high", reasoning.id)
            assertEquals("model:gpt-5.6:high", reasoning.selectionId)
            assertEquals("gpt-5.6-high", reasoning.fullModelId)

            assertEquals("codex", permissions.catalog.runtime)
            assertEquals(9L, permissions.catalog.revision)
            val permission = permissions.catalog.permissions.single()
            assertEquals("workspace-write", permission.id)
            assertEquals("permission:workspace-write", permission.selectionId)
            assertTrue(permission.default)
            assertEquals("permission.label", permission.metadata["labelKey"])
            assertEquals("2026-08-10T00:00:02Z", permissions.serverTime)
        }
    }

    @Test
    fun emptyCatalogsAndMissingOptionalFieldsRemainParseable() {
        val capabilities = JSONObject()
            .put("capabilitySet", JSONObject().put("futureField", true))
            .put("unknownTopLevel", "ignored")
            .toString()
        val models = JSONObject()
            .put("catalog", JSONObject().put("models", emptyList<Any>()).put("futureField", true))
            .toString()
        val permissions = JSONObject()
            .put("catalog", JSONObject().put("permissions", emptyList<Any>()))
            .toString()
        withJsonServer(ArrayDeque(listOf(capabilities, models, permissions))) { serverUrl, _ ->
            val api = DevicesApi()

            val capabilityResult = api.getDeviceRuntimeCapabilities(serverUrl, "token", "fallback", "codex")
            val modelResult = api.getDeviceRuntimeModelCatalog(serverUrl, "token", "fallback", "codex")
            val permissionResult = api.getDeviceRuntimePermissionCatalog(serverUrl, "token", "fallback", "codex")

            assertEquals("fallback", capabilityResult.connectorId)
            assertEquals(0L, capabilityResult.capabilitySet.revision)
            assertTrue(capabilityResult.capabilitySet.capabilities.isEmpty())
            assertTrue(modelResult.catalog.models.isEmpty())
            assertTrue(permissionResult.catalog.permissions.isEmpty())
            assertNull(modelResult.serverTime)
        }
    }

    private fun assertRequest(request: RecordedRequest, method: String, path: String, body: String) {
        assertEquals(method, request.method)
        assertEquals(path, request.path)
        assertEquals(body, request.body)
    }

    private fun runtimeJson(runtime: String, status: String = "available"): String {
        val displayName = when (runtime) {
            "codex" -> "Codex"
            "claude" -> "Claude Code"
            else -> runtime.uppercase()
        }
        return JSONObject()
            .put("connectorId", "connector one")
            .put("runtimeId", runtime)
            .put("runtimeType", "native")
            .put("displayName", displayName)
            .put("present", true)
            .put("configured", true)
            .put("active", false)
            .put("status", status)
            .put("discovery", JSONObject().put("available", true))
            .put("schema", JSONObject().put("type", "object"))
            .put("uiSchema", JSONObject().put("order", listOf("environment")))
            .put("config", JSONObject())
            .put("error", JSONObject.NULL)
            .put("lastDiscoveredAt", "2026-08-10T00:00:00Z")
            .put("updatedAt", "2026-08-10T00:00:01Z")
            .toString()
    }

    private fun listJson(vararg runtimes: String): String {
        return JSONObject()
            .put("connectorId", "connector one")
            .put("runtimes", runtimes.map(::JSONObject))
            .put("serverTime", "2026-08-10T00:00:00Z")
            .toString()
    }

    private fun capabilitiesJson(): String {
        val model = JSONObject()
            .put("capabilityId", "catalog.model")
            .put("version", "2")
            .put("scope", "runtime")
            .put("runtime", "codex")
            .put("sessionId", JSONObject.NULL)
            .put("supported", true)
            .put("available", true)
            .put("allowed", true)
            .put("unavailableReason", JSONObject.NULL)
            .put("parameters", JSONObject().put("limit", 200))
            .put("futureField", "ignored")
        val unknown = JSONObject()
            .put("capabilityId", "future.capability")
            .put("supported", true)
            .put("available", false)
            .put("allowed", true)
            .put("unavailableReason", "not ready")
        return JSONObject()
            .put("connectorId", "connector")
            .put(
                "capabilitySet",
                JSONObject().put("revision", 42).put("capabilities", listOf(model, unknown)),
            )
            .put("serverTime", "2026-08-10T00:00:00Z")
            .toString()
    }

    private fun modelCatalogJson(): String {
        val reasoning = JSONObject()
            .put("id", "high")
            .put("selectionId", "model:gpt-5.6:high")
            .put("fullModelId", "gpt-5.6-high")
            .put("displayName", "High")
            .put("description", "More reasoning")
            .put("default", true)
            .put("metadata", JSONObject().put("future", true))
        val model = JSONObject()
            .put("id", "gpt-5.6")
            .put("selectionId", JSONObject.NULL)
            .put("displayName", "GPT-5.6")
            .put("description", "Frontier model")
            .put("default", true)
            .put("reasoningItems", listOf(reasoning))
            .put("metadata", JSONObject().put("i18n", JSONObject().put("labelKey", "model.label")))
        return JSONObject()
            .put(
                "catalog",
                JSONObject().put("runtime", "codex").put("revision", 7).put("models", listOf(model)),
            )
            .put("serverTime", "2026-08-10T00:00:01Z")
            .toString()
    }

    private fun permissionCatalogJson(): String {
        val permission = JSONObject()
            .put("id", "workspace-write")
            .put("selectionId", "permission:workspace-write")
            .put("displayName", "Workspace write")
            .put("description", "Allow workspace edits")
            .put("default", true)
            .put("metadata", JSONObject().put("labelKey", "permission.label"))
        return JSONObject()
            .put(
                "catalog",
                JSONObject()
                    .put("runtime", "codex")
                    .put("revision", 9)
                    .put("permissions", listOf(permission)),
            )
            .put("serverTime", "2026-08-10T00:00:02Z")
            .toString()
    }

    private fun withJsonServer(
        responses: ArrayDeque<String>,
        block: (String, List<RecordedRequest>) -> Unit,
    ) {
        TestJsonServer(responses).use { server ->
            block(server.url, server.requests)
        }
    }

    private data class RecordedRequest(
        val method: String,
        val path: String,
        val body: String,
        val authorization: String?,
    )

    private class TestJsonServer(
        private val responses: ArrayDeque<String>,
    ) : Closeable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val url = "http://127.0.0.1:${socket.localPort}"
        private var failure: Throwable? = null
        private val worker = thread(name = "devices-api-test-server") {
            runCatching {
                repeat(responses.size) {
                    socket.accept().use { client ->
                        val input = BufferedInputStream(client.getInputStream())
                        val headers = readHeaderBlock(input)
                        val lines = headers.split("\r\n")
                        val requestLine = lines.first().split(' ')
                        val headerValues = lines.drop(1)
                            .mapNotNull { line ->
                                val separator = line.indexOf(':')
                                if (separator <= 0) null else {
                                    line.substring(0, separator).trim().lowercase() to
                                        line.substring(separator + 1).trim()
                                }
                            }
                            .toMap()
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
                            body = body.copyOf(offset).toString(Charsets.UTF_8),
                            authorization = headerValues["authorization"],
                        )
                        val response = responses.removeFirst().toByteArray()
                        client.getOutputStream().use { output ->
                            output.write(
                                (
                                    "HTTP/1.1 200 OK\r\n" +
                                        "Content-Type: application/json\r\n" +
                                        "Content-Length: ${response.size}\r\n" +
                                        "Connection: close\r\n\r\n"
                                ).toByteArray(),
                            )
                            output.write(response)
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
