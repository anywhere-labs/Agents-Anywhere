package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.RemoteRuntimeType
import com.agentsanywhere.app.api.RemoteRuntimeTypeList
import com.agentsanywhere.app.model.runtimeTypeLabel
import java.text.Normalizer
import java.util.Locale

/** A type the device can add; [DeviceRuntime] is an instance that already exists on it. */
data class DeviceRuntimeType(
    val connectorId: String,
    val type: String,
    val displayName: String,
    val description: String? = null,
    val present: Boolean,
    val available: Boolean = true,
    val reason: String? = null,
    val recommended: Boolean = false,
    val recommendationRank: Int? = null,
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?> = emptyMap(),
    val defaults: Map<String, Any?> = emptyMap(),
    /** "single" or "multiple"; anything else cannot be added. */
    val instancePolicy: String = "single",
    val maxInstances: Int? = 1,
) {
    /** Fields a new named instance must fill in, such as its own data directory. */
    val namedInstanceRequiredFields: List<String>
        get() = namedInstanceRequiredFields(schema, uiSchema)
}

/** Fields the Server requires of an instance whose ID is not its type. */
internal fun DeviceRuntime.configRequiredFields(): List<String> =
    if (isDefaultInstance) emptyList() else namedInstanceRequiredFields(schema, uiSchema)

private fun namedInstanceRequiredFields(schema: Map<String, Any?>?, uiSchema: Map<String, Any?>): List<String> {
    val properties = schema?.get("properties") as? Map<*, *> ?: return emptyList()
    return (uiSchema["requiredForNamedInstance"] as? List<*>).orEmpty()
        .filterIsInstance<String>()
        .filter { it.isNotEmpty() && it in properties }
        .distinct()
}

/** Types and instances of one device, read together so every add decision uses one snapshot. */
data class DeviceAgentInventory(
    val connectorId: String,
    val types: List<DeviceRuntimeType> = emptyList(),
    val runtimes: List<DeviceRuntime> = emptyList(),
) {
    /** Instances of a type the Connector no longer reports still need a type to be edited. */
    val knownTypes: List<DeviceRuntimeType> by lazy {
        val reported = types.associateBy(DeviceRuntimeType::type)
        val legacy = runtimes
            .filter { it.type !in reported }
            .distinctBy(DeviceRuntime::type)
            .map(DeviceRuntime::legacyType)
        (reported.values + legacy).sortedWith(runtimeTypeComparator)
    }

    val configuredRuntimes: List<DeviceRuntime>
        get() = runtimes.filter(DeviceRuntime::configured).sortedWith(deviceRuntimeComparator)

    val addableTypes: List<DeviceRuntimeType>
        get() = knownTypes.filter(::canAdd)

    val hasConfiguredRuntime: Boolean
        get() = runtimes.any(DeviceRuntime::configured)

    fun type(runtime: DeviceRuntime): DeviceRuntimeType? = knownTypes.firstOrNull { it.type == runtime.type }

    /** A cleared instance keeps its identity and history and can be configured again. */
    fun reconfigurableInstance(type: DeviceRuntimeType): DeviceRuntime? =
        runtimes.firstOrNull { it.type == type.type && !it.configured }

    fun canAdd(type: DeviceRuntimeType): Boolean {
        if (!type.present || type.schema == null) return false
        if (reconfigurableInstance(type) != null) return true
        val count = runtimes.count { it.type == type.type }
        return when (type.instancePolicy) {
            "single" -> count < 1
            "multiple" -> type.maxInstances?.let { count < it } ?: true
            else -> false
        }
    }

    /**
     * Name, identity and starting values for adding [type]. It continues the instance an
     * earlier attempt named [continuing] created, else reuses a cleared instance.
     */
    fun addPlan(type: DeviceRuntimeType, continuing: String? = null): DeviceRuntimeAddPlan {
        val leftover = continuing?.let { name ->
            runtimes.firstOrNull { it.type == type.type && runtimeNameKey(it.name) == runtimeNameKey(name) }
        }
        val existing = leftover ?: reconfigurableInstance(type)
        val others = runtimes.filter { it.id != existing?.id }
        val previousName = existing?.name?.trim()?.takeIf {
            it.isNotEmpty() && (existing == leftover ||
                (!it.equals(type.displayName, ignoreCase = true) && !it.equals(type.type, ignoreCase = true)))
        }
        return DeviceRuntimeAddPlan(
            runtimeId = existing?.id,
            name = previousName ?: suggestedRuntimeName(type, others),
            reservedNames = others.mapTo(mutableSetOf()) { runtimeNameKey(it.name) },
            config = existing?.config ?: type.defaults,
            requiredFields = if (existing?.isDefaultInstance == true) emptyList() else type.namedInstanceRequiredFields,
        )
    }
}

data class DeviceRuntimeAddPlan(
    /** A cleared instance to configure again instead of creating another one. */
    val runtimeId: String?,
    val name: String,
    /** [runtimeNameKey]s already used on the device. */
    val reservedNames: Set<String>,
    val config: Map<String, Any?>,
    val requiredFields: List<String>,
) {
    fun nameTaken(name: String): Boolean = runtimeNameKey(name) in reservedNames
}

/** The display form the Server stores: NFKC, trimmed, with runs of whitespace collapsed. */
internal fun normalizedRuntimeName(name: String): String =
    Normalizer.normalize(name, Normalizer.Form.NFKC).trim().replace(whitespace, " ")

/** Names are unique on a device under this key, as the Server compares them. */
internal fun runtimeNameKey(name: String): String = normalizedRuntimeName(name).lowercase(Locale.ROOT)

private val whitespace = Regex("\\s+")

internal fun suggestedRuntimeName(type: DeviceRuntimeType, runtimes: List<DeviceRuntime>): String {
    val base = if (type.type == "dsh") "DSH" else type.displayName
    val names = runtimes.mapTo(mutableSetOf()) { runtimeNameKey(it.name) }
    if (runtimeNameKey(base) !in names) return base
    var suffix = 2
    while (runtimeNameKey("$base $suffix") in names) suffix += 1
    return "$base $suffix"
}

internal fun RemoteRuntimeTypeList.toDeviceRuntimeTypes(): List<DeviceRuntimeType> =
    runtimeTypes.map(RemoteRuntimeType::toDeviceRuntimeType)

internal fun RemoteRuntimeType.toDeviceRuntimeType(): DeviceRuntimeType = DeviceRuntimeType(
    connectorId = connectorId,
    type = runtimeType,
    displayName = displayName,
    description = description,
    present = present,
    available = available,
    reason = reason,
    recommended = recommended,
    recommendationRank = recommendationRank,
    schema = schema,
    uiSchema = uiSchema,
    defaults = defaults,
    instancePolicy = instancePolicy,
    maxInstances = maxInstances,
)

/** A type rebuilt from a known instance is a supported type: its availability never derives from the instance. */
private fun DeviceRuntime.legacyType(): DeviceRuntimeType = DeviceRuntimeType(
    connectorId = connectorId,
    type = type,
    displayName = typeDisplayName ?: type.runtimeTypeLabel(),
    present = present,
    schema = schema,
    uiSchema = uiSchema,
    defaults = defaults,
)

private val runtimeTypeComparator = compareBy<DeviceRuntimeType>(
    { !it.recommended },
    { it.recommendationRank ?: Int.MAX_VALUE },
    { it.displayName.lowercase() },
    { it.type },
)
