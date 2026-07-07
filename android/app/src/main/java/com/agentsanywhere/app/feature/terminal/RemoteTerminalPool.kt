package com.agentsanywhere.app.feature.terminal

class RemoteTerminalPool(
    private val terminalController: TerminalController,
) {
    private val controllers = linkedMapOf<String, RemoteTerminalController>()

    fun forSession(sessionId: String?): RemoteTerminalController {
        return controllerFor("session:${sessionId.orEmpty()}")
    }

    fun forDevice(deviceId: String?): RemoteTerminalController {
        return controllerFor("device:${deviceId.orEmpty()}")
    }

    fun disposeLocal() {
        controllers.values.forEach { it.disposeLocal() }
        controllers.clear()
    }

    private fun controllerFor(key: String): RemoteTerminalController {
        return controllers.getOrPut(key) { RemoteTerminalController(terminalController) }
    }
}
