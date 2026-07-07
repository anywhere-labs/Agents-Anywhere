package com.agentsanywhere.app.feature.terminal

import android.util.Log

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
        Log.d(LOG_TAG, "pool dispose controllers=${controllers.size}")
        controllers.values.forEach { it.disposeLocal() }
        controllers.clear()
    }

    private fun controllerFor(key: String): RemoteTerminalController {
        val existing = controllers[key]
        if (existing != null) {
            Log.d(LOG_TAG, "pool reuse key=$key ctrl=${existing.debugId} controllers=${controllers.size}")
            return existing
        }
        val created = RemoteTerminalController(terminalController)
        controllers[key] = created
        Log.d(LOG_TAG, "pool create key=$key ctrl=${created.debugId} controllers=${controllers.size}")
        return created
    }

    private companion object {
        private const val LOG_TAG = "AATerminalSwitch"
    }
}
