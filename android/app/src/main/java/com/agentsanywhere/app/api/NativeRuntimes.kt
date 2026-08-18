package com.agentsanywhere.app.api

private val V2_NATIVE_RUNTIME_ORDER = listOf("codex", "claude", "dsh")
private val V2_NATIVE_RUNTIMES = V2_NATIVE_RUNTIME_ORDER.toSet()

internal fun String.isSupportedV2NativeRuntime(): Boolean {
    return this in V2_NATIVE_RUNTIMES
}

internal fun Iterable<String>.supportedV2NativeRuntimes(): List<String> {
    return asSequence()
        .filter(String::isSupportedV2NativeRuntime)
        .distinct()
        .sortedBy(V2_NATIVE_RUNTIME_ORDER::indexOf)
        .toList()
}
