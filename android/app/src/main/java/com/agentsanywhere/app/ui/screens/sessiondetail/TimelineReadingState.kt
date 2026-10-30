package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.TextLayoutResult
import kotlinx.coroutines.channels.Channel
import kotlin.math.abs

internal val LocalTimelineReading = staticCompositionLocalOf<TimelineReadingState?> { null }
internal val LocalReadingMessage = staticCompositionLocalOf { "" }
internal val LocalReadingPart = staticCompositionLocalOf { "body" }

/** Session-owned UI state. Layout callbacks only observe; one coroutine owns scroll corrections. */
@Stable
internal class TimelineReadingState {
    val expanded = mutableStateMapOf<String, Boolean>()
    val groupMembers = mutableStateMapOf<String, Boolean>()
    val selectionReaders = mutableMapOf<String, () -> Boolean>()
    val codePositions = mutableMapOf<String, Pair<Int, Int>>()
    val changes = Channel<Unit>(Channel.CONFLATED)
    var following by mutableStateOf(true)
        private set
    var touching = false
    var selecting = false
    var towardsLatest = false
    private var anchor: Anchor? = null
    private var viewport = Rect.Zero
    private var viewportWidth = 0f
    private val regions = linkedMapOf<String, Region>()
    private var owners = emptyMap<String, Pair<Int, String>>()
    private var correcting = false

    private data class Region(
        val bounds: Rect,
        val layout: TextLayoutResult? = null,
        val text: String = "",
        val row: String,
    )
    private data class Anchor(val key: String, val row: String, val offset: Int, val context: String, val y: Float)

    fun invalidate() { changes.trySend(Unit) }

    fun items(items: List<TimelineRenderItem>, firstIndex: Int) {
        val next = buildMap {
            items.asReversed().forEachIndexed { index, item ->
                val header = when (item) {
                    is TimelineRenderItem.ToolRun -> "group:tools:${item.messages.first().id}"
                    is TimelineRenderItem.Reconnect -> "group:reconnect:${item.messages.first().id}"
                    is TimelineRenderItem.AgentCalls -> "group:agent-calls:${item.messages.first().id}"
                    is TimelineRenderItem.Single -> "message:${item.message.id}"
                }
                item.messages.forEach { put(it.id, (firstIndex + index) to header) }
            }
        }
        if (owners != next) { owners = next; invalidate() }
    }

    fun viewport(bounds: Rect) {
        if (viewportWidth != 0f && abs(viewportWidth - bounds.width) > 1f) anchor = null
        viewportWidth = bounds.width
        viewport = bounds
        invalidate()
    }

    fun observe(key: String, row: String, coordinates: LayoutCoordinates, layout: TextLayoutResult? = null, text: String = "") {
        if (!coordinates.isAttached) return
        val next = Region(Rect(coordinates.positionInWindow(), coordinates.size.toSize()), layout, text, row)
        if (regions[key] != next) {
            regions[key] = next
            invalidate()
        }
    }

    fun remove(key: String) { regions.remove(key); invalidate() }

    fun groupExpanded(kind: String, members: List<String>): Boolean {
        val explicit = members.mapNotNull { groupMembers["$kind:$it"] }
        return if (explicit.isNotEmpty()) explicit.any { it } else members.any { expanded[it] == true }
    }

    fun toggleGroup(kind: String, members: List<String>, header: String) {
        pauseAt(header)
        val next = !groupExpanded(kind, members)
        members.forEach { groupMembers["$kind:$it"] = next }
    }

    fun toggle(message: String, header: String, default: Boolean = false) {
        pauseAt(header)
        val next = !(expanded[message] ?: default)
        expanded[message] = next
        if (next) groupMembers.keys.filter { it.endsWith(":$message") }.forEach { groupMembers[it] = true }
    }

    fun pauseAt(key: String? = null) {
        following = false
        anchor = key?.let { k -> regions[k]?.let { Anchor(k, it.row, -1, "", it.bounds.top) } }
            ?: capture()
        invalidate()
    }

    fun gesture(delta: Float) {
        if (delta == 0f) return
        following = false
        towardsLatest = delta < 0f // reverseLayout: upward finger motion approaches latest.
        anchor = null
        invalidate()
    }

    fun release() {
        following = true
        towardsLatest = false
        anchor = null
        invalidate()
    }

    private fun capture(): Anchor? {
        val visible = regions.entries.filter { (_, r) -> r.bounds.bottom > viewport.top && r.bounds.top < viewport.bottom &&
            r.bounds.right > viewport.left && r.bounds.left < viewport.right }
        val candidate = visible.filter { it.value.layout != null }
            .minByOrNull { (_, r) -> abs(r.bounds.top.coerceAtLeast(viewport.top) - viewport.top) }
            ?: visible.filter { !it.key.startsWith("message:") }.minByOrNull { abs(it.value.bounds.top - viewport.top) }
            ?: visible.minByOrNull { abs(it.value.bounds.top - viewport.top) }
            ?: return null
        val (key, region) = candidate
        val layout = region.layout
        val offset = if (layout != null && layout.lineCount > 0) {
            layout.getLineStart(layout.getLineForVerticalPosition((viewport.top - region.bounds.top).coerceAtLeast(0f)))
        } else -1
        val localY = if (layout != null && offset >= 0) layout.getLineTop(layout.getLineForOffset(offset.coerceAtMost(region.text.length))) else 0f
        return Anchor(key, region.row, offset, if (offset >= 0) region.text.drop(offset).take(40) else "", region.bounds.top + localY)
    }

    /** Called after a layout frame, never from a placement callback. */
    suspend fun settle(list: LazyListState) {
        if (correcting || viewport == Rect.Zero) return
        if (touching || selecting || selectionReaders.values.any { it() } || list.isScrollInProgress) {
            if (!correcting) anchor = null
            return
        }
        if (!following && towardsLatest && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) release()
        if (following) {
            if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) {
                correcting = true
                try { list.scrollToItem(0) } finally { correcting = false }
            }
            return
        }
        val held = anchor ?: capture().also { anchor = it } ?: return
        val region = regions[held.key]
        if (region == null) {
            val owner = owners[held.row]
            if (owner != null && list.layoutInfo.visibleItemsInfo.none { it.index == owner.first }) {
                // Regrouping changes the outer lazy key. Materialize the same logical
                // message before restoring its descendant coordinate, instead of
                // adopting whichever neighbouring row LazyColumn chose as fallback.
                correcting = true
                try { list.scrollToItem(owner.first) } finally { correcting = false }
                invalidate()
                return
            }
            val fallbackKey = listOf("header:${held.row}", "message:${held.row}", owner?.second)
                .filterNotNull().firstOrNull { it != held.key && regions.containsKey(it) }
            val fallback = fallbackKey?.let(regions::get)
            anchor = if (fallback != null) Anchor(fallbackKey, held.row, -1, "", held.y) else capture()
            invalidate()
            return
        }
        var offset = held.offset
        if (offset >= 0 && held.context.isNotEmpty() && !region.text.drop(offset).startsWith(held.context)) {
            val found = region.text.indexOf(held.context)
            if (found >= 0) offset = found
        }
        val layout = region.layout
        val localY = if (offset >= 0 && layout != null && layout.lineCount > 0) {
            layout.getLineTop(layout.getLineForOffset(offset.coerceIn(0, region.text.length)))
        } else 0f
        val delta = held.y - (region.bounds.top + localY)
        if (abs(delta) <= 1f) return
        correcting = true
        val consumed = try { list.scrollBy(delta) } finally { correcting = false }
        // A list boundary cannot satisfy an arbitrary coordinate. Rebase instead of retrying forever.
        if (abs(consumed - delta) > 1f) anchor = capture()
    }

    companion object {
        val Saver = listSaver<TimelineReadingState, String>(
            save = { state ->
                listOf("following:${state.following}") + state.expanded.map { "e:${it.key}:${it.value}" } + state.groupMembers.map { "g:${it.key}:${it.value}" } +
                    state.codePositions.map { "c:${it.key}:${it.value.first}:${it.value.second}" }
            },
            restore = { saved -> TimelineReadingState().apply {
                saved.forEach { entry ->
                    if (entry.startsWith("following:")) { following = entry.substringAfter(':').toBoolean(); return@forEach }
                    if (entry.startsWith("c:")) {
                        val yIndex = entry.lastIndexOf(':')
                        val xIndex = entry.lastIndexOf(':', yIndex - 1)
                        codePositions[entry.substring(2, xIndex)] = entry.substring(xIndex + 1, yIndex).toInt() to entry.substring(yIndex + 1).toInt()
                        return@forEach
                    }
                    val key = entry.substring(2, entry.lastIndexOf(':'))
                    val value = entry.substringAfterLast(':').toBoolean()
                    if (entry.startsWith("e:")) expanded[key] = value else groupMembers[key] = value
                }
            } },
        )
    }
}

@Composable
internal fun ReadingMessage(id: String, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReadingMessage provides id, LocalReadingPart provides "body") {
        Column(Modifier.fillMaxWidth().readingRegion("message:$id"), content = { content() })
    }
}

internal fun Modifier.readingRegion(key: String): Modifier = composed {
    val state = LocalTimelineReading.current
    val row = LocalReadingMessage.current
    DisposableEffect(state, key) { onDispose { state?.remove(key) } }
    onGloballyPositioned { state?.observe(key, row, it) }
}

/** Register the actual visible text line, not the height of its growing Markdown parent. */
@Composable
internal fun ReadingTextAnchor(text: String): ReadingTextRegistration {
    val state = LocalTimelineReading.current
    val row = LocalReadingMessage.current
    val part = LocalReadingPart.current
    val key = "text:$row:$part"
    val registration = androidx.compose.runtime.remember(state, key) { ReadingTextRegistration(state, key, row) }
    registration.text = text
    DisposableEffect(registration) { onDispose { state?.remove(key) } }
    return registration
}

internal class ReadingTextRegistration(private val state: TimelineReadingState?, private val key: String, private val row: String) {
    var text: String = ""
    private var coordinates: LayoutCoordinates? = null
    private var layout: TextLayoutResult? = null
    fun positioned(value: LayoutCoordinates) { coordinates = value; publish() }
    fun laidOut(value: TextLayoutResult) { layout = value; publish() }
    private fun publish() { coordinates?.let { state?.observe(key, row, it, layout, text) } }
}
