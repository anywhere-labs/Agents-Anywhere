package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.RemoteTokensUsage
import com.agentsanywhere.app.api.RemoteTokensUsageItem
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.LocalDate
import java.util.Locale
import kotlin.math.abs

// The linked Tokens Anywhere account: its models, the names runtimes see and what it has spent.

enum class TokensAccountTab { Models, Usage }

data class TokensModel(
    val id: String,
    /** The name Tokens Anywhere gives it, or its ID. */
    val originalName: String,
    val vendor: String?,
    val contextWindow: Long?,
    val maxOutputTokens: Long?,
    val image: Boolean,
)

/** Each model once, across the protocols the profile offers it on. */
fun tokensModels(profile: ModelProfile): List<TokensModel> {
    val byId = LinkedHashMap<String, TokensModel>()
    for (offer in profile.offers) {
        for (spec in offer.models) {
            val known = byId[spec.id]
            val knownName = known?.originalName?.takeIf { it != known.id }
            byId[spec.id] = TokensModel(
                id = spec.id,
                originalName = knownName ?: spec.name?.takeIf { it.isNotEmpty() } ?: spec.id,
                vendor = known?.vendor ?: spec.vendor,
                contextWindow = known?.contextWindow ?: spec.contextWindow,
                maxOutputTokens = known?.maxOutputTokens ?: spec.maxOutputTokens,
                image = known?.image == true || "image" in spec.input,
            )
        }
    }
    return byId.values.toList()
}

private val VENDOR_LABELS = linkedMapOf(
    "anthropic" to "Anthropic",
    "openai" to "OpenAI",
    "google" to "Google",
    "gemini" to "Google",
    "deepseek" to "DeepSeek",
    "moonshot" to "Moonshot",
    "moonshotai" to "Moonshot",
    "qwen" to "Qwen",
    "alibaba" to "Qwen",
    "zhipu" to "Zhipu",
    "z-ai" to "Zhipu",
    "xai" to "xAI",
    "minimax" to "MiniMax",
    "mistral" to "Mistral",
)

fun vendorLabel(vendor: String?): String? {
    if (vendor.isNullOrEmpty()) return null
    return VENDOR_LABELS[vendor.lowercase(Locale.ROOT)] ?: vendor
}

/** Models from one maker; [label] is null for models with no maker. */
data class VendorGroup(val key: String, val label: String?, val models: List<TokensModel>)

/** Models by maker, the best known first; models with no maker come last. */
fun vendorGroups(models: List<TokensModel>): List<VendorGroup> {
    val groups = LinkedHashMap<String, Pair<String?, MutableList<TokensModel>>>()
    for (model in models) {
        val label = vendorLabel(model.vendor)
        groups.getOrPut(label.orEmpty()) { label to mutableListOf() }.second.add(model)
    }
    val order = VENDOR_LABELS.values.toList()
    fun rank(label: String?): Int = when {
        label == null -> Int.MAX_VALUE
        label in order -> order.indexOf(label)
        else -> order.size
    }
    return groups.map { (key, value) -> VendorGroup(key, value.first, value.second) }
        .sortedWith(compareBy<VendorGroup> { rank(it.label) }.thenBy { it.label.orEmpty().lowercase(Locale.ROOT) })
}

/** A token count the way model sizes are said: 200K, 1M, 1.5M. */
fun formatTokenWindow(value: Long): String = when {
    value >= 1_000_000 -> "${oneDecimal(value, 1_000_000)}M"
    value >= 1_000 -> "${oneDecimal(value, 1_000)}K"
    else -> value.toString()
}

private fun oneDecimal(value: Long, unit: Long): String =
    BigDecimal.valueOf(value)
        .divide(BigDecimal.valueOf(unit))
        .setScale(1, RoundingMode.HALF_UP)
        .stripTrailingZeros()
        .toPlainString()

private fun sameSet(a: List<String>, b: List<String>): Boolean = a.size == b.size && (a + b).toSet().size == a.size

fun samePreferences(a: ModelPreferences, b: ModelPreferences): Boolean {
    fun names(value: ModelPreferences) = value.names.filterValues { it.isNotBlank() }
    val left = names(a)
    val right = names(b)
    return sameSet(a.disabled, b.disabled) &&
        left.size == right.size &&
        left.all { (id, name) -> b.names[id]?.trim() == name.trim() }
}

/** Preferences as saved: only names that differ from the model's own, only models still offered. */
fun cleanPreferences(preferences: ModelPreferences, models: List<TokensModel>): ModelPreferences {
    val byId = models.associateBy { it.id }
    val names = LinkedHashMap<String, String>()
    for ((id, raw) in preferences.names) {
        val name = raw.trim()
        val model = byId[id] ?: continue
        if (name.isNotEmpty() && name != model.originalName) names[id] = name
    }
    return ModelPreferences(
        disabled = preferences.disabled.filter { it in byId },
        names = names,
    )
}

/** How many models a save would change: turned on or off, or named differently. */
fun changeCount(before: ModelPreferences, after: ModelPreferences): Int {
    val ids = before.disabled + after.disabled + before.names.keys + after.names.keys
    return ids.toSet().count { id ->
        (id in before.disabled) != (id in after.disabled) || before.names[id].orEmpty() != after.names[id].orEmpty()
    }
}

/** Turns [ids] on or off. */
fun ModelPreferences.withEnabled(ids: List<String>, on: Boolean): ModelPreferences {
    val off = LinkedHashSet(disabled)
    if (on) off.removeAll(ids.toSet()) else off.addAll(ids)
    return copy(disabled = off.toList())
}

/** Shows [id] as [name]; null goes back to the model's own name. */
fun ModelPreferences.withName(id: String, name: String?): ModelPreferences =
    copy(names = if (name.isNullOrEmpty()) names - id else names + (id to name))

/** The name a rename field leaves: null when it is empty or the model's own. */
fun renamedTo(model: TokensModel, input: String): String? =
    input.trim().takeIf { it.isNotEmpty() && it != model.originalName }

/**
 * Amounts in ten-thousandths of a yuan. Tokens Anywhere sends decimal strings
 * with four places; adding them as integers keeps sums exact.
 */
fun amountUnits(value: String?): Long {
    val match = AMOUNT.matchEntire(value.orEmpty().trim()) ?: return 0
    val (sign, whole, fraction) = match.destructured
    val units = (whole.toLongOrNull() ?: return 0) * 10_000 + fraction.padEnd(4, '0').toLong()
    return if (sign.isNotEmpty()) -units else units
}

private val AMOUNT = Regex("""^(-)?(\d+)(?:\.(\d{1,4}))?$""")

/** Yuan with two places, or four when two would show a small cost as nothing. */
fun formatYuan(units: Long): String {
    val digits = if (units != 0L && abs(units) < 100) 4 else 2
    val yuan = BigDecimal.valueOf(units, 4).setScale(digits, RoundingMode.HALF_UP)
    val pattern = if (digits == 4) "#,##0.0000" else "#,##0.00"
    return "¥" + DecimalFormat(pattern, DecimalFormatSymbols(Locale.US)).format(yuan)
}

/** A whole number with thousands separators: 12,345. */
fun formatCount(value: Long): String = DecimalFormat("#,##0", DecimalFormatSymbols(Locale.US)).format(value)

/** A large count in short form: 950, 1.2K, 3.4M, 2B. */
fun formatCompactCount(value: Long): String {
    if (abs(value) < 1_000) return formatCount(value)
    val suffixes = listOf("K" to 1_000L, "M" to 1_000_000L, "B" to 1_000_000_000L, "T" to 1_000_000_000_000L)
    var index = suffixes.indexOfLast { abs(value) >= it.second }
    var rounded = BigDecimal.valueOf(value).divide(BigDecimal.valueOf(suffixes[index].second)).setScale(1, RoundingMode.HALF_UP)
    if (rounded.abs() >= BigDecimal.valueOf(1_000) && index < suffixes.lastIndex) {
        index += 1
        rounded = BigDecimal.valueOf(value).divide(BigDecimal.valueOf(suffixes[index].second)).setScale(1, RoundingMode.HALF_UP)
    }
    return rounded.stripTrailingZeros().toPlainString() + suffixes[index].first
}

/** `MM-dd` for a `yyyy-MM-dd` date; anything else as it is. */
fun shortDate(date: String): String = if (DATE.matches(date)) date.substring(5) else date

private val DATE = Regex("""^\d{4}-\d{2}-\d{2}$""")

data class DailyCost(val date: String, val cost: Long)

data class ModelUsage(val model: String, val requests: Long, val tokens: Long, val cost: Long)

/** Costs are in ten-thousandths of a yuan; see [amountUnits]. */
data class UsageSummary(
    val cost: Long,
    val requests: Long,
    val tokens: Long,
    val daily: List<DailyCost>,
    val models: List<ModelUsage>,
)

private fun RemoteTokensUsageItem.tokens(): Long =
    inputTokens + outputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens

private fun datesBetween(from: String, to: String): List<String> {
    val start = runCatching { LocalDate.parse(from) }.getOrNull() ?: return emptyList()
    val end = runCatching { LocalDate.parse(to) }.getOrNull() ?: return emptyList()
    val dates = mutableListOf<String>()
    var day = start
    while (!day.isAfter(end) && dates.size < 400) {
        dates += day.toString()
        day = day.plusDays(1)
    }
    return dates
}

/** Totals, cost per day (every day, quiet ones as zero) and per model, most spent first. */
fun summarizeUsage(usage: RemoteTokensUsage, model: String?): UsageSummary {
    val rows = usage.items.filter { model == null || it.model == model }
    val perDay = LinkedHashMap<String, Long>()
    datesBetween(usage.from, usage.to).forEach { perDay[it] = 0 }
    val perModel = LinkedHashMap<String, ModelUsage>()
    var cost = 0L
    var requests = 0L
    var tokens = 0L
    for (row in rows) {
        val units = amountUnits(row.amountCharged)
        cost += units
        requests += row.requests
        tokens += row.tokens()
        perDay[row.date] = (perDay[row.date] ?: 0) + units
        val key = row.model.orEmpty()
        val entry = perModel[key] ?: ModelUsage(key, 0, 0, 0)
        perModel[key] = entry.copy(
            requests = entry.requests + row.requests,
            tokens = entry.tokens + row.tokens(),
            cost = entry.cost + units,
        )
    }
    return UsageSummary(
        cost = cost,
        requests = requests,
        tokens = tokens,
        daily = perDay.map { (date, units) -> DailyCost(date, units) },
        models = perModel.values.sortedWith(compareByDescending<ModelUsage> { it.cost }.thenByDescending { it.requests }),
    )
}

/** Models that appear in the usage, for the filter. */
fun usageModelIds(usage: RemoteTokensUsage): List<String> =
    usage.items.mapNotNull { it.model?.takeIf(String::isNotEmpty) }.distinct().sorted()
