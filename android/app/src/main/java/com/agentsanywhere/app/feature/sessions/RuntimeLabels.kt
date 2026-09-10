package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.runtimeTypeLabel

fun String.runtimeLabel(): String {
    return runtimeTypeLabel()
}
