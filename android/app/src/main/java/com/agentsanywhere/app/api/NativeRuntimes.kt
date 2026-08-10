package com.agentsanywhere.app.api

private val V2_NATIVE_RUNTIMES = setOf("codex", "claude")

internal fun String.isSupportedV2NativeRuntime(): Boolean {
    return this in V2_NATIVE_RUNTIMES
}

internal fun Iterable<String>.supportedV2NativeRuntimes(): List<String> {
    return asSequence()
        .filter(String::isSupportedV2NativeRuntime)
        .distinct()
        .sorted()
        .toList()
}
