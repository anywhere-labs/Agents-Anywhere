package com.agentsanywhere.app.feature.devices

import java.net.URI

enum class DevicePairingStep {
    ConnectionMethod, DesktopInstall, CliConfirm, Name, CliMethod, Command, PairCode;

    fun previous(): DevicePairingStep = when (this) {
        Command, PairCode -> CliMethod
        CliMethod -> Name
        else -> ConnectionMethod
    }
}

fun devicePairingCommand(serverUrl: String): String {
    val address = runCatching {
        val uri = URI(serverUrl)
        if (uri.scheme.equals("https", ignoreCase = true) && uri.host != null) {
            uri.host + if (uri.port >= 0 && uri.port != 443) ":${uri.port}" else ""
        } else serverUrl
    }.getOrDefault(serverUrl)
    return "uvx anywhere-cli pair ${quotePairingArgument(address)}"
}

fun deviceTokenCommand(credential: DeviceSetupCredential): String = listOf(
    "uvx anywhere-cli start",
    "--server-url ${quotePairingArgument(credential.serverUrl)}",
    "--connector-id ${quotePairingArgument(credential.device.id)}",
    "--connector-token ${quotePairingArgument(credential.connectorToken)}",
).joinToString(" ")

private fun quotePairingArgument(value: String): String {
    if (value.matches(Regex("^[A-Za-z0-9_./:=@%+-]+$"))) return value
    return "'" + value.replace("'", "'\\''") + "'"
}

fun randomPairingDeviceName(): String {
    val adjectives = listOf(
        "amber", "azure", "brisk", "calm", "clear", "clever", "copper", "crisp", "deft", "eager",
        "fair", "fleet", "fresh", "gentle", "golden", "happy", "honest", "jade", "keen", "lively",
        "lucky", "lunar", "mellow", "nimble", "noble", "opal", "quiet", "rapid", "silver", "smart",
        "solar", "steady", "swift", "tidy", "vivid", "warm", "witty", "zesty", "bright", "cosmic",
    )
    val nouns = listOf(
        "acorn", "anchor", "badger", "bamboo", "beacon", "birch", "brook", "cedar", "clover", "comet",
        "condor", "cove", "falcon", "finch", "fjord", "forest", "garden", "grove", "harbor", "heron",
        "island", "juniper", "lagoon", "lantern", "maple", "meadow", "meteor", "nebula", "otter", "phoenix",
        "quartz", "raven", "ridge", "river", "rocket", "sequoia", "sparrow", "summit", "willow", "zephyr",
    )
    return "${adjectives.random()}-${nouns.random()}"
}
