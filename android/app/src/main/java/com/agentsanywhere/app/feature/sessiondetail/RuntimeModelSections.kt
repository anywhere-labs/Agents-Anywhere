package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModelGroup

/** One rendered block of a model picker; [header] is null for a headerless section. */
internal data class RuntimeModelSection<T>(
    val header: String?,
    val items: List<T>,
)

/**
 * Splits model picker entries into provider sections, shared by the session runtime sheet and the
 * new-session dropdown.
 *
 * - Fewer than 2 distinct `group.id`s: a single headerless section in catalog order (today's rendering).
 * - Otherwise one section per group in first-appearance order of `group.id` (catalog order within a
 *   section, header from the first `displayName` seen for that id), then ungrouped entries in a final
 *   headerless section.
 */
internal fun <T> List<T>.sectionByModelGroup(
    groupOf: (T) -> RemoteRuntimeModelGroup?,
): List<RuntimeModelSection<T>> {
    if (isEmpty()) return emptyList()
    val headers = LinkedHashMap<String, String>()
    val grouped = LinkedHashMap<String, MutableList<T>>()
    val ungrouped = mutableListOf<T>()
    forEach { item ->
        val group = groupOf(item)
        if (group == null) {
            ungrouped += item
        } else {
            headers.putIfAbsent(group.id, group.displayName)
            grouped.getOrPut(group.id) { mutableListOf() } += item
        }
    }
    if (grouped.size < 2) return listOf(RuntimeModelSection(header = null, items = this))
    return grouped.map { (id, items) -> RuntimeModelSection(header = headers.getValue(id), items = items) } +
        listOfNotNull(ungrouped.takeIf { it.isNotEmpty() }?.let { RuntimeModelSection(header = null, items = it) })
}

/**
 * Row text inside [this] section. Under a provider header the row drops the provider the header
 * already shows; flat lists and the selected-model label keep the catalog name, which stays unique.
 */
internal fun RuntimeModelSection<*>.rowLabel(label: String, group: RemoteRuntimeModelGroup?): String =
    if (header != null) group?.itemDisplayName ?: label else label
