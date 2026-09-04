package com.agentsanywhere.app.ui.screens.home

object HomeSidebarViewMode {
    const val Project = "project"
    const val Session = "session"

    fun normalize(value: String?): String = when (value) {
        Session -> Session
        else -> Project
    }
}
