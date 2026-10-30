package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.composed
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics

/**
 * Tap handling for timeline headers that expand/collapse.
 *
 * `clickable` cancels a press when the pointer leaves the node bounds. The timeline
 * keeps streaming while the user reads it, so the list is often still scrolling
 * (auto-follow / anchor correction) when a header is tapped, and the row slides out
 * from under the finger before the up event arrives. That made expanding "reasoning"
 * or "command" cards feel unresponsive: the same tap worked whenever the list
 * happened to be idle.
 *
 * This detector observes the gesture in the initial pass but does not consume it:
 * a press becomes a tap as long as the finger itself did not travel past touch slop
 * and did not turn into a long press, regardless of how far the content moved.
 */
internal fun Modifier.timelineTap(label: String? = null, onTap: () -> Unit): Modifier = composed {
    val currentOnTap = rememberUpdatedState(onTap)
    val viewConfiguration = LocalViewConfiguration.current
    this.semantics(mergeDescendants = false) {
        role = Role.Button
        onClick(label = label) {
            currentOnTap.value()
            true
        }
    }.pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val pointerId = down.id
            var travel = 0f
            var previous = down.position
            var upTime = down.uptimeMillis
            var canceled = false
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == pointerId } ?: break
                if (change.pressed) {
                    travel += (change.position - previous).getDistance()
                    previous = change.position
                    if (travel > viewConfiguration.touchSlop) canceled = true
                } else {
                    upTime = change.uptimeMillis
                    break
                }
            }
            val longPress = upTime - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis
            if (!canceled && !longPress) currentOnTap.value()
        }
    }
}
