package dev.agentsanywhere.v3poc.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.TextFieldValue
import dev.agentsanywhere.v3poc.DebugLaunch
import dev.agentsanywhere.v3poc.design.MenuRequest

/** UI-only state of the shell: drawer, sheets, menus and the composer draft. */
class UiState {
    var drawerOpen by mutableStateOf(DebugLaunch.drawerOpen)
    var optionsSheet by mutableStateOf(false)
    /** Pairing / account placeholders: title and message. */
    var demoSheet by mutableStateOf<Pair<String, String>?>(null)
    var accountSheet by mutableStateOf(false)
    var workspaceSheet by mutableStateOf(false)
    var menu by mutableStateOf<MenuRequest?>(null)
    var draft by mutableStateOf(TextFieldValue(""))
    var composerFocused by mutableStateOf(false)
    /** Ask the composer to take (true) or drop (false) focus. */
    var focusRequest by mutableStateOf<Boolean?>(null)

    val anySheet: Boolean get() = optionsSheet || demoSheet != null || accountSheet || workspaceSheet
}
