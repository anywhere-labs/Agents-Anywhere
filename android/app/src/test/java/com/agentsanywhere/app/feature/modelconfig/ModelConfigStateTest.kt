package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ChannelRuntime
import com.agentsanywhere.app.model.ChannelSwitch
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelConnectionCapability
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec
import com.agentsanywhere.app.model.TokensLink
import com.agentsanywhere.app.model.TokensLinkStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelConfigStateTest {
    private val capability = ModelConnectionCapability(
        maturity = "experimental",
        configField = "modelGateway",
        modelsField = null,
        protocols = listOf("openai_chat"),
        modes = emptyList(),
        modeField = null,
        scope = "instance",
        catalogAuto = false,
        catalogManual = true,
        apply = "restart",
    )

    private fun runtime(
        id: String,
        type: String = id,
        connectorId: String = "dev",
        connection: ModelConnectionCapability? = capability,
        maturity: String? = null,
        status: ModelConnectionStatus? = null,
    ) = DeviceRuntime(
        connectorId = connectorId,
        id = id,
        type = type,
        displayName = id,
        present = true,
        configured = true,
        active = true,
        status = DeviceRuntimeStatus.Running,
        discovery = emptyMap(),
        schema = null,
        uiSchema = emptyMap(),
        config = null,
        error = null,
        lastDiscoveredAt = null,
        updatedAt = null,
        maturity = maturity,
        modelConnection = connection,
        modelConnectionStatus = status,
    )

    private fun item(
        id: String,
        state: String,
        connectorId: String = "dev",
        override: String? = null,
        desired: String? = "tokens",
        actual: String? = "native",
    ) = ChannelRuntime(
        connectorId = connectorId,
        runtimeId = id,
        override = override,
        desired = desired,
        actual = actual,
        state = state,
        step = null,
        reason = null,
        message = null,
        updatedAt = null,
    )

    private fun channel(vararg runtimes: ChannelRuntime, switch: String? = null, current: String = "tokens") =
        ModelChannelState(
            channel = current,
            revision = 3,
            switch = switch?.let { ChannelSwitch(3, it, null, null) },
            runtimes = runtimes.toList(),
        )

    private fun profile(source: String = "manual", state: String = "active", id: String = "p") = ModelProfile(
        id = id,
        source = source,
        name = "P",
        originHost = "gate.example",
        offers = listOf(
            ModelOffer("openai_chat", "https://gate.example/v1", listOf(ModelSpec("a"), ModelSpec("b"))),
            ModelOffer("anthropic", "https://gate.example", listOf(ModelSpec("a"))),
        ),
        keyHint = null,
        strategyName = null,
        state = state,
        etag = "1",
        updatedAt = null,
    )

    @Test
    fun stableRuntimesShowNoMaturityBadge() {
        assertEquals(RuntimeMaturityBadge.Beta, runtimeMaturityBadge("beta"))
        assertEquals(RuntimeMaturityBadge.Experimental, runtimeMaturityBadge("experimental"))
        assertNull(runtimeMaturityBadge("stable"))
        assertNull(runtimeMaturityBadge(null))
        assertNull(runtimeMaturityBadge("future"))
    }

    @Test
    fun channelStateTones() {
        assertEquals(ModelStatusTone.Ok, channelStateTone("applied"))
        listOf("pending", "waiting_online", "switching", "restoring").forEach {
            assertEquals(ModelStatusTone.Progress, channelStateTone(it))
        }
        assertEquals(ModelStatusTone.Warning, channelStateTone("restored"))
        assertEquals(ModelStatusTone.Error, channelStateTone("failed"))
        assertEquals(ModelStatusTone.Neutral, channelStateTone("unsupported"))
        assertEquals(ModelStatusTone.Neutral, channelStateTone("future"))
    }

    @Test
    fun channelOptionsOfferAnywhereOnlyOnceLinked() {
        val manual = profile(id = "mpr_1")
        val detached = profile(id = "mpr_2", state = "detached")
        val tokensProfile = profile(source = "tokens", id = "mpr_t")
        fun overview(linked: Boolean, available: Boolean = true) = ModelConfigOverview(
            secretConfigured = true,
            profiles = listOf(tokensProfile, manual, detached),
            assignments = emptyList(),
            tokens = TokensLinkStatus(
                available = available,
                tokensUrl = null,
                secretConfigured = true,
                link = TokensLink(if (linked) "linked" else "reauth_required", null, "a", null, null, null, false),
            ),
        )

        assertEquals(listOf("native", "mpr_1"), overview(linked = false).channelOptions().map { it.id })
        assertEquals(listOf("native", "mpr_1"), overview(linked = true, available = false).channelOptions().map { it.id })
        val options = overview(linked = true).channelOptions()
        assertEquals(listOf("native", "tokens", "mpr_1"), options.map { it.id })
        assertEquals(listOf(ChannelKind.Native, ChannelKind.Tokens, ChannelKind.Manual), options.map { it.kind })
        assertEquals("mpr_t", options[1].profile?.id)
        assertEquals(ChannelKind.Manual, channelKind("mpr_9"))
    }

    @Test
    fun runningProgressCountsFinishedRuntimesAndWaitingReasons() {
        val progress = channel(
            item("a", "applied", actual = "tokens"),
            item("b", "pending"),
            item("c", "waiting_online"),
            item("d", "switching"),
            item("e", "restored"),
            item("f", "unsupported"),
            switch = "running",
        ).progress()

        assertEquals(ChannelPhase.Running, progress.phase)
        assertEquals(5, progress.total)
        assertEquals(2, progress.finished)
        assertEquals(1, progress.applied)
        assertEquals(1, progress.restored)
        assertEquals(1, progress.waitingOnline)
    }

    @Test
    fun progressPhaseFollowsTheServerThenTheRuntimes() {
        assertEquals(ChannelPhase.Done, channel(item("a", "applied"), switch = "done").progress().phase)
        val attention = channel(item("a", "applied"), item("b", "restored"), item("c", "failed"), switch = "attention").progress()
        assertEquals(ChannelPhase.Attention, attention.phase)
        assertEquals(1, attention.restored)
        assertEquals(1, attention.failed)
        // Never switched, or a switch state this client does not know.
        assertEquals(ChannelPhase.Done, channel(item("a", "applied")).progress().phase)
        assertEquals(ChannelPhase.Running, channel(item("a", "pending"), switch = "later").progress().phase)
        assertEquals(ChannelPhase.Attention, channel(item("a", "failed")).progress().phase)
        assertEquals(ChannelPhase.Idle, channel(item("a", "unsupported")).progress().phase)
        assertEquals(0, channel().progress().total)
    }

    @Test
    fun channelUseCoversCurrentOverridesDesiredAndActual() {
        val state = channel(
            item("a", "applied", override = "mpr_1", desired = "mpr_1", actual = "mpr_1"),
            item("b", "switching", desired = "tokens", actual = "mpr_2"),
            current = "tokens",
        )
        assertTrue(state.uses("tokens"))
        assertTrue(state.uses("mpr_1"))
        assertTrue(state.uses("mpr_2"))
        assertFalse(state.uses("mpr_3"))
        assertFalse((null as ModelChannelState?).uses("tokens"))
        assertTrue(state.updating("tokens"))
        assertFalse(state.updating("mpr_1"))
    }

    @Test
    fun channelRowsGroupByDeviceWithUnsupportedLast() {
        val global = capability.copy(scope = "native_global")
        val state = channel(
            item("pi", "applied", connectorId = "laptop"),
            item("codex", "unsupported", connectorId = "desk"),
            item("claude", "pending", connectorId = "desk"),
            item("dsh", "failed", connectorId = "laptop"),
            item("gone", "pending", connectorId = "unknown"),
            item("own", "unsupported", connectorId = "laptop"),
        )
        val groups = channelGroups(
            state = state,
            runtimes = listOf(
                runtime("pi", connectorId = "laptop", maturity = "beta"),
                runtime("codex", connectorId = "desk", connection = null),
                runtime("claude", connectorId = "desk", connection = global),
                runtime("dsh", connectorId = "laptop"),
                runtime("own", connectorId = "laptop", connection = global),
            ),
            devices = listOf(AgentDevice("desk", "Desk", online = true), AgentDevice("laptop", "Laptop", online = false)),
        )

        assertEquals(listOf("desk", "laptop", "unknown"), groups.devices.map { it.connectorId })
        assertEquals(listOf("Desk", "Laptop", "unknown"), groups.devices.map { it.deviceName })
        assertEquals(listOf("pi", "dsh"), groups.devices[1].rows.map { it.item.runtimeId })
        assertEquals(listOf("codex", "own"), groups.unsupported.map { it.item.runtimeId })

        val claude = groups.devices[0].rows.single()
        assertFalse(claude.canRetry)
        assertTrue(claude.canOverride)
        assertTrue(claude.needsNativeGlobalConfirmation("tokens"))
        assertTrue(claude.needsNativeGlobalConfirmation("mpr_1"))
        assertFalse(claude.needsNativeGlobalConfirmation("native"))
        assertFalse(claude.needsNativeGlobalConfirmation(null))

        val (pi, dsh) = groups.devices[1].rows
        assertEquals("experimental", pi.maturity)
        assertFalse(pi.needsNativeGlobalConfirmation("tokens"))
        assertTrue(dsh.canRetry)
        assertFalse(groups.unsupported[0].canOverride)
        assertTrue(groups.unsupported[1].canOverride)
        // A runtime the snapshot does not list still shows, by its ID, without channel choices.
        val gone = groups.devices[2].rows.single()
        assertEquals("gone", gone.name)
        assertFalse(gone.canOverride)
    }

    @Test
    fun modelIdsAreSplitByLinesOrCommasAndDeduplicated() {
        assertEquals(listOf("gpt-5", "claude", "qwen"), parseModelIds(" gpt-5\nclaude, qwen,,\ngpt-5 \n"))
        assertTrue(parseModelIds("  \n ,").isEmpty())
    }

    @Test
    fun automaticProfileNeedsANameKeyAndHttpAddress() {
        val empty = ManualProfileDraft()
        assertFalse(empty.manual)
        assertFalse(empty.valid)
        val draft = empty.copy(name = "Gate", apiKey = "sk-1", baseUrl = " https://gate.example/v1 ")
        assertTrue(draft.valid)
        assertFalse(draft.copy(baseUrl = "gate.example").valid)
        assertFalse(draft.copy(apiKey = " ").valid)
        assertFalse(draft.copy(name = "").valid)
    }

    @Test
    fun switchingToManualFillsEachProtocolsAddressFromTheEnteredOne() {
        val manual = ManualProfileDraft(name = "Gate", apiKey = "sk-1", baseUrl = " https://gate.example/v1/ ").toManual()
        assertTrue(manual.manual)
        assertEquals(listOf("openai_chat"), manual.chosenProtocols)
        assertEquals("https://gate.example/v1", manual.offers.getValue("openai_responses").baseUrl)
        assertEquals("https://gate.example/v1", manual.offers.getValue("openai_chat").baseUrl)
        assertEquals("https://gate.example", manual.offers.getValue("anthropic").baseUrl)
        assertTrue(manual.valid)

        assertEquals("https://gate.example/anthropic", protocolBaseUrl("anthropic", "https://gate.example/anthropic/"))
        assertEquals("https://gate.example/api", protocolBaseUrl("anthropic", "https://gate.example/api/v1"))
        assertEquals("https://gate.example/api/v1", protocolBaseUrl("openai_chat", "https://gate.example/api/v1/"))
    }

    @Test
    fun manualProfileNeedsANameKeyAndHttpAddressForEveryChosenProtocol() {
        val empty = ManualProfileDraft(manual = true)
        assertEquals(listOf("openai_chat"), empty.chosenProtocols)
        assertFalse(empty.valid)

        val draft = empty.copy(name = "Gate", apiKey = "sk-1")
            .withOffer("openai_chat") { it.copy(baseUrl = " https://gate.example/v1 ", models = "a\nb") }
        assertTrue(draft.valid)
        assertFalse(draft.withOffer("anthropic") { it.copy(enabled = true, baseUrl = "gate.example") }.valid)

        val offer = draft.toOffers().single()
        assertEquals("https://gate.example/v1", offer.baseUrl)
        assertEquals(listOf("a", "b"), offer.models.map { it.id })
    }

    @Test
    fun profileModelCountAndDeletion() {
        assertEquals(2, profile().modelCount())
        assertTrue(profile().canDelete(usedBy = 0))
        assertFalse(profile().canDelete(usedBy = 1))
        assertFalse(profile().canDelete(usedBy = 0, inChannel = true))
        assertFalse(profile(source = "tokens").canDelete(usedBy = 0))
        assertTrue(profile(source = "tokens", state = "detached").canDelete(usedBy = 0))
    }
}
