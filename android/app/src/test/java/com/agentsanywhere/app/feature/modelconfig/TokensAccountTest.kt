package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.RemoteTokensUsage
import com.agentsanywhere.app.api.RemoteTokensUsageItem
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokensAccountTest {
    private fun profile(vararg offers: ModelOffer) = ModelProfile(
        id = "p",
        source = "tokens",
        name = "Tokens",
        originHost = "tokens.example",
        offers = offers.toList(),
        keyHint = null,
        strategyName = null,
        state = "active",
        etag = "1",
        updatedAt = null,
    )

    private fun model(id: String, name: String = id, vendor: String? = null) =
        TokensModel(id, name, vendor, contextWindow = null, maxOutputTokens = null, image = false)

    private fun row(date: String, model: String?, requests: Long, amount: String, input: Long = 0, output: Long = 0) =
        RemoteTokensUsageItem(date, model, requests, input, output, 0, 0, 0, amount)

    @Test
    fun eachModelAppearsOnceAcrossProtocols() {
        val models = tokensModels(
            profile(
                ModelOffer(
                    "openai_chat",
                    "https://t/v1",
                    listOf(
                        ModelSpec(id = "gpt-5", vendor = "openai", contextWindow = 400_000),
                        ModelSpec(id = "claude", name = "Claude", input = listOf("text", "image")),
                    ),
                ),
                ModelOffer(
                    "anthropic",
                    "https://t",
                    listOf(ModelSpec(id = "gpt-5", name = "GPT-5", maxOutputTokens = 128_000), ModelSpec(id = "claude", vendor = "anthropic")),
                ),
            ),
        )

        assertEquals(listOf("gpt-5", "claude"), models.map { it.id })
        assertEquals(TokensModel("gpt-5", "GPT-5", "openai", 400_000, 128_000, image = false), models[0])
        assertEquals(TokensModel("claude", "Claude", "anthropic", null, null, image = true), models[1])
    }

    @Test
    fun modelsGroupByMakerWithUnknownMakersLast() {
        assertEquals("Google", vendorLabel("Gemini"))
        assertEquals("Acme", vendorLabel("Acme"))
        assertNull(vendorLabel(null))
        val groups = vendorGroups(
            listOf(
                model("x"),
                model("ds", vendor = "deepseek"),
                model("acme", vendor = "Acme"),
                model("c", vendor = "anthropic"),
                model("g", vendor = "google"),
                model("g2", vendor = "gemini"),
            ),
        )
        assertEquals(listOf("Anthropic", "Google", "DeepSeek", "Acme", null), groups.map { it.label })
        assertEquals(listOf("g", "g2"), groups[1].models.map { it.id })
    }

    @Test
    fun tokenWindowsReadLikeModelSizes() {
        assertEquals("200K", formatTokenWindow(200_000))
        assertEquals("1M", formatTokenWindow(1_000_000))
        assertEquals("1.5M", formatTokenWindow(1_500_000))
        assertEquals("131.1K", formatTokenWindow(131_072))
        assertEquals("512", formatTokenWindow(512))
    }

    @Test
    fun preferencesKeepOnlyRealChanges() {
        val models = listOf(model("a", "Alpha"), model("b"))
        val draft = ModelPreferences(disabled = listOf("a", "gone"), names = mapOf("a" to " Alpha ", "b" to " Beta ", "gone" to "x", "c" to ""))
        val clean = cleanPreferences(draft, models)
        assertEquals(ModelPreferences(disabled = listOf("a"), names = mapOf("b" to "Beta")), clean)

        assertTrue(samePreferences(ModelPreferences(listOf("a", "b"), mapOf("a" to "A ")), ModelPreferences(listOf("b", "a"), mapOf("a" to "A", "b" to " "))))
        assertFalse(samePreferences(ModelPreferences(listOf("a")), ModelPreferences()))
        assertFalse(samePreferences(ModelPreferences(names = mapOf("a" to "A")), ModelPreferences(names = mapOf("a" to "B"))))
    }

    @Test
    fun changesCountEachModelOnce() {
        val before = ModelPreferences(disabled = listOf("a"), names = mapOf("b" to "B"))
        val after = ModelPreferences(disabled = listOf("c"), names = mapOf("a" to "A", "b" to "B"))
        // a: turned on and renamed (one change), c: turned off; b unchanged.
        assertEquals(2, changeCount(before, after))
        assertEquals(0, changeCount(before, before))
    }

    @Test
    fun draftEditsToggleAndRename() {
        val start = ModelPreferences()
        val off = start.withEnabled(listOf("a", "b"), on = false)
        assertEquals(listOf("a", "b"), off.disabled)
        assertEquals(listOf("b"), off.withEnabled(listOf("a"), on = true).disabled)
        val named = start.withName("a", "Fast")
        assertEquals(mapOf("a" to "Fast"), named.names)
        assertEquals(emptyMap<String, String>(), named.withName("a", null).names)

        val model = model("a", "Alpha")
        assertNull(renamedTo(model, "  "))
        assertNull(renamedTo(model, "Alpha "))
        assertEquals("Fast", renamedTo(model, " Fast "))
    }

    @Test
    fun amountsAddUpExactly() {
        assertEquals(1_155_000, amountUnits("115.5000"))
        assertEquals(1_155_000, amountUnits("115.5"))
        assertEquals(-50, amountUnits("-0.005"))
        assertEquals(0, amountUnits("abc"))
        assertEquals(0, amountUnits(null))
        assertEquals(3, amountUnits("0.0001") + amountUnits("0.0002"))

        assertEquals("¥115.50", formatYuan(1_155_000))
        assertEquals("¥1,234.57", formatYuan(12_345_678))
        assertEquals("¥0.0050", formatYuan(50))
        assertEquals("¥0.00", formatYuan(0))
        assertEquals("¥-0.0050", formatYuan(-50))
    }

    @Test
    fun countsReadShort() {
        assertEquals("12,345", formatCount(12_345))
        assertEquals("950", formatCompactCount(950))
        assertEquals("1.2K", formatCompactCount(1_234))
        assertEquals("3.4M", formatCompactCount(3_400_000))
        assertEquals("1M", formatCompactCount(999_960))
        assertEquals("08-03", shortDate("2026-08-03"))
    }

    @Test
    fun usageFillsQuietDaysAndRanksModels() {
        val usage = RemoteTokensUsage(
            from = "2026-11-01",
            to = "2026-11-04",
            items = listOf(
                row("2026-11-01", "gpt-5", 3, "0.1000", input = 100, output = 20),
                row("2026-11-03", "claude", 1, "0.2500", input = 50),
                row("2026-11-03", "gpt-5", 2, "0.0500", output = 10),
                row("2026-11-04", null, 1, "0.0001"),
            ),
        )
        val all = summarizeUsage(usage, null)
        assertEquals(4_001, all.cost)
        assertEquals(7, all.requests)
        assertEquals(180, all.tokens)
        assertEquals(
            listOf(DailyCost("2026-11-01", 1_000), DailyCost("2026-11-02", 0), DailyCost("2026-11-03", 3_000), DailyCost("2026-11-04", 1)),
            all.daily,
        )
        assertEquals(listOf("claude", "gpt-5", ""), all.models.map { it.model })
        assertEquals(ModelUsage("gpt-5", 5, 130, 1_500), all.models[1])

        val one = summarizeUsage(usage, "gpt-5")
        assertEquals(1_500, one.cost)
        assertEquals(4, one.daily.size)
        assertEquals(listOf("gpt-5"), one.models.map { it.model })
        assertEquals(listOf("claude", "gpt-5"), usageModelIds(usage))
    }

    @Test
    fun accountOpensOnModelsOnceConfigured() {
        assertEquals(TokensAccountTab.Models, initialTokensAccountTab(configured = true))
        assertEquals(TokensAccountTab.Devices, initialTokensAccountTab(configured = false))
    }
}
