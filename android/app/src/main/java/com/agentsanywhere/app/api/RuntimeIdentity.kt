package com.agentsanywhere.app.api

private val RUNTIME_TYPE_PATTERN = Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
private val RUNTIME_INSTANCE_PATTERN = Regex("^rti_[A-Za-z0-9_-]{1,124}$")

internal fun String.isValidRuntimeType(): Boolean {
    return length in 1..64 && !startsWith("rti_") && RUNTIME_TYPE_PATTERN.matches(this)
}

internal fun String.isValidRuntimeInstanceId(runtimeType: String): Boolean {
    return this == runtimeType || (length <= 128 && RUNTIME_INSTANCE_PATTERN.matches(this))
}
