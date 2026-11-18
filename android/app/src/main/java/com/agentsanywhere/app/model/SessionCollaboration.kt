package com.agentsanywhere.app.model

/** Protocol 1.2 `SessionOrigin`: the session was created by the Agent of [bySessionId]. */
data class SessionOrigin(
    val bySessionId: String,
    val byDeviceId: String? = null,
    val depth: Int = 1,
)

/** Protocol 1.2 `SupervisionEdge`: [supervisorSessionId] watches [targetSessionId]. */
data class SupervisionEdge(
    val supervisionId: String,
    val supervisorSessionId: String,
    val targetSessionId: String,
    val state: SupervisionState,
    /** Null when the Server sends a creator this client does not know. */
    val createdBy: SupervisionCreator?,
)

enum class SupervisionState(val wireValue: String) {
    Active("active"),
    Paused("paused"),
    Ended("ended"),
    ;

    companion object {
        fun fromWire(value: String?): SupervisionState? = entries.firstOrNull { it.wireValue == value }
    }
}

enum class SupervisionCreator(val wireValue: String) {
    Human("human"),
    Agent("agent"),
    ;

    companion object {
        fun fromWire(value: String?): SupervisionCreator? = entries.firstOrNull { it.wireValue == value }
    }
}
