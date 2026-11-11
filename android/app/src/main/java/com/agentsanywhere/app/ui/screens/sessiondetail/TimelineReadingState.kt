package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyListItemInfo
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

/**
 * Session-owned UI state. Layout callbacks observe; one coroutine owns scroll corrections, except
 * that positioned callbacks restore the anchor before a frame is drawn ([placed]).
 */
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
    var returningToLatest = false
    private var anchor by mutableStateOf<Anchor?>(null)
    private var lazyBounds = Rect.Zero
    private var viewport = Rect.Zero
    private var viewportWidth = 0f
    private val regions = linkedMapOf<String, Region>()
    private var owners by mutableStateOf(emptyMap<String, Pair<Int, String>>())
    private var hasMoreHistory = false
    private var correcting = false
    private var list: LazyListState? = null
    /** Far (upper) edge of each visible row, measured from the list's start, as of the last check. */
    private var rowTops = emptyMap<Any, Int>()
    private var itemSpans = emptyMap<Any, ItemSpan>()
    private var pendingProbe: LayoutCoordinates? = null
    private var pendingProbeBaseY = 0f
    private var pendingUnplacedShift = 0f

    val needsOlder: Boolean
        get() = !following && owners.isNotEmpty() && anchor?.let { it.row !in owners } == true

    private data class ItemSpan(val offset: Int, val size: Int) {
        val top: Int get() = offset + size
    }

    private data class Region(
        val bounds: Rect,
        val layout: TextLayoutResult? = null,
        val text: String = "",
        val row: String,
        val coordinates: LayoutCoordinates? = null,
    ) {
        fun liveBounds(shift: Float = 0f): Rect {
            val attached = coordinates?.takeIf { it.isAttached }
                ?: return if (shift == 0f) bounds else bounds.translate(0f, shift)
            val pos = attached.positionInWindow()
            return Rect(pos.copy(y = pos.y + shift), attached.size.toSize())
        }
    }
    private data class Anchor(val key: String, val row: String, val offset: Int, val context: String, val y: Float)

    fun invalidate() { changes.trySend(Unit) }

    fun items(items: List<TimelineRenderItem>, firstIndex: Int, hasMore: Boolean) {
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
        if (owners != next || hasMoreHistory != hasMore) {
            owners = next
            hasMoreHistory = hasMore
            invalidate()
        }
    }

    fun viewport(lazyBounds: Rect, readingBounds: Rect) {
        if (viewportWidth != 0f && abs(viewportWidth - readingBounds.width) > 1f) {
            rowTops = emptyMap()
            itemSpans = emptyMap()
            clearPendingShift()
        }
        viewportWidth = readingBounds.width
        this.lazyBounds = lazyBounds
        viewport = readingBounds
        invalidate()
    }

    fun observe(key: String, row: String, coordinates: LayoutCoordinates, layout: TextLayoutResult? = null, text: String = "") {
        if (!coordinates.isAttached) return
        val next = Region(Rect(coordinates.positionInWindow(), coordinates.size.toSize()), layout, text, row, coordinates)
        if (regions[key] != next) {
            regions[key] = next
            invalidate()
        }
    }

    fun remove(key: String) { regions.remove(key); invalidate() }

    fun attach(list: LazyListState) {
        this.list = list
    }

    fun detach(list: LazyListState) {
        if (this.list === list) {
            this.list = null
            clearPendingShift()
        }
    }

    /** A region's positioned callback ran: this frame is laid out but not drawn. Never call it while measuring. */
    fun placed() = holdInFrame()

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
        val shift = currentUnplacedShift()
        anchor = key?.let { k ->
            regions[k]?.takeIf { it.coordinates?.isAttached != false }
                ?.let { Anchor(k, it.row, -1, "", it.liveBounds(shift).top - viewport.top) }
        } ?: capture()
        invalidate()
    }

    fun gesture(delta: Float) {
        if (delta == 0f) return
        clearPendingShift()
        following = false
        towardsLatest = delta < 0f // reverseLayout: upward finger motion approaches latest.
        anchor = null
        invalidate()
    }

    fun release() {
        clearPendingShift()
        following = true
        towardsLatest = false
        anchor = null
        invalidate()
    }

    private fun capture(): Anchor? {
        val shift = currentUnplacedShift()
        val visible = regions.entries.mapNotNull { (k, r) ->
            if (r.coordinates?.isAttached == false) return@mapNotNull null
            val b = r.liveBounds(shift)
            if (b.bottom > viewport.top && b.top < viewport.bottom &&
                b.right > viewport.left && b.left < viewport.right
            ) k to (r to b) else null
        }
        val candidate = visible.filter { it.second.first.layout != null }
            .minByOrNull { (_, pair) -> abs(pair.second.top.coerceAtLeast(viewport.top) - viewport.top) }
            ?: visible.filter { !it.first.startsWith("message:") }.minByOrNull { abs(it.second.second.top - viewport.top) }
            ?: visible.minByOrNull { abs(it.second.second.top - viewport.top) }
            ?: return null
        val (key, pair) = candidate
        val (region, bounds) = pair
        val layout = region.layout
        val offset = if (layout != null && layout.lineCount > 0) {
            layout.getLineStart(layout.getLineForVerticalPosition((viewport.top - bounds.top).coerceAtLeast(0f)))
        } else -1
        val localY = if (layout != null && offset >= 0) layout.getLineTop(layout.getLineForOffset(offset.coerceAtMost(region.text.length))) else 0f
        return Anchor(key, region.row, offset, if (offset >= 0) region.text.drop(offset).take(40) else "", bounds.top + localY - viewport.top)
    }

    /** Called after a layout frame, never from a placement callback. */
    suspend fun settle(list: LazyListState) {
        if (correcting || returningToLatest || viewport == Rect.Zero) return
        if (touching || selecting || selectionReaders.values.any { it() } || list.isScrollInProgress) {
            if (!correcting) anchor = null
            if (!following && towardsLatest && !touching && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) {
                release()
            }
            return
        }
        if (!following && towardsLatest && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) release()
        if (following) {
            if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) {
                correcting = true
                try {
                    clearPendingShift()
                    list.scrollToItem(0)
                } finally {
                    correcting = false
                    snapshotItems(list.layoutInfo.visibleItemsInfo)
                }
            }
            return
        }
        val held = anchor ?: capture().also { anchor = it } ?: return
        val shift = currentUnplacedShift()
        val region = regions[held.key]?.takeIf { it.coordinates?.isAttached != false }
        if (region == null) {
            val owner = owners[held.row]
            // Keep the saved identity while the existing history pager materializes it.
            if (owner == null && (hasMoreHistory || owners.isEmpty())) return
            if (owner != null && list.layoutInfo.visibleItemsInfo.none { it.index == owner.first }) {
                // Regrouping changes the outer lazy key. Materialize the same logical
                // message before restoring its descendant coordinate, instead of
                // adopting whichever neighbouring row LazyColumn chose as fallback.
                correcting = true
                try {
                    clearPendingShift()
                    list.scrollToItem(owner.first)
                } finally {
                    correcting = false
                    snapshotItems(list.layoutInfo.visibleItemsInfo)
                }
                invalidate()
                return
            }
            val fallbackKey = listOf("header:${held.row}", owner?.second?.takeUnless { it.startsWith("message:") })
                .filterNotNull().firstOrNull { it != held.key && regions[it]?.coordinates?.isAttached != false && regions.containsKey(it) }
            val fallback = fallbackKey?.let(regions::get)
            anchor = if (fallback != null) Anchor(fallbackKey, held.row, -1, "", held.y) else capture()
            invalidate()
            return
        }
        val delta = held.y - anchoredLineY(held, region, region.liveBounds(shift).top)
        if (abs(delta) <= 1f) return
        correcting = true
        val consumed = try {
            clearPendingShift()
            list.scrollBy(delta)
        } finally {
            correcting = false
            snapshotItems(list.layoutInfo.visibleItemsInfo)
        }
        // A list boundary cannot satisfy an arbitrary coordinate. Rebase instead of retrying forever.
        if (abs(consumed - delta) > 1f) anchor = capture()
    }

    /**
     * In a reversed list a growing row keeps its bottom edge, so streamed text pushes the line being
     * read upward. [settle] runs a frame later, which showed that displaced frame on every update;
     * during touch drag or inertial fling [settle] does not run at all, so growth below the reading
     * edge must also be compensated synchronously via [LazyListState.dispatchRawDelta] without
     * cancelling the user's active scroll mutation.
     */
    private fun holdInFrame() {
        val list = list ?: return
        val layoutInfo = list.layoutInfo
        val visible = layoutInfo.visibleItemsInfo
        val previousTops = rowTops
        val previousSpans = itemSpans
        snapshotItems(visible)

        if (correcting || returningToLatest || following || viewport == Rect.Zero || visible.isEmpty()) return
        if (towardsLatest && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) {
            if (!touching) release()
            return
        }

        val activelyScrolling = touching || selecting || selectionReaders.values.any { it() } || list.isScrollInProgress
        val shift = currentUnplacedShift()
        val held = if (activelyScrolling) null else anchor

        val delta = if (held != null) {
            val region = regions[held.key]
            val coordinates = region?.coordinates?.takeIf { it.isAttached }
            val row = owners[held.row]?.first
            if (region != null && coordinates != null && row != null && visible.any { it.index == row }) {
                held.y - anchoredLineY(held, region, coordinates.positionInWindow().y + shift)
            } else if (row != null) {
                // The growth pushed the anchored row out of the viewport, where it keeps reporting its
                // last placement. Rows are stacked on the far edge of the nearest row below them, so
                // the anchored row moved exactly as far as that edge did.
                val below = visible.lastOrNull { it.index < row && it.key in previousTops }
                below?.let { (rowTops.getValue(it.key) - previousTops.getValue(it.key)).toFloat() }
                    ?: visibleSpanGrowth(visible, previousSpans, layoutInfo.viewportEndOffset)
            } else {
                visibleSpanGrowth(visible, previousSpans, layoutInfo.viewportEndOffset)
            }
        } else {
            visibleSpanGrowth(visible, previousSpans, layoutInfo.viewportEndOffset)
        }
        if (abs(delta) <= 1f) return

        val probe = regions.values.firstNotNullOfOrNull { r ->
            r.coordinates?.takeIf { it.isAttached && owners[r.row]?.first?.let { idx -> visible.any { it.index == idx } } == true }
        }
        val probeBeforeY = probe?.positionInWindow()?.y
        correcting = true
        val consumed = try {
            list.dispatchRawDelta(delta)
        } finally {
            correcting = false
            snapshotItems(list.layoutInfo.visibleItemsInfo)
        }
        if (probe != null && probeBeforeY != null && abs(consumed) > 0.5f) {
            val probeAfterY = probe.takeIf { it.isAttached }?.positionInWindow()?.y
            if (probeAfterY != null && abs(probeAfterY - probeBeforeY) <= 0.5f) {
                pendingProbe = probe
                pendingProbeBaseY = probeAfterY
                pendingUnplacedShift = shift + consumed
            } else {
                clearPendingShift()
            }
        }
    }

    private fun snapshotItems(visible: List<LazyListItemInfo>) {
        rowTops = visible.associate { it.key to it.offset + it.size }
        itemSpans = visible.associate { it.key to ItemSpan(it.offset, it.size) }
    }

    /**
     * Stack height change between the bottommost and topmost shared items at or below the reading
     * top line. User scroll shifts all item offsets by the same delta and cancels out, isolating
     * content growth/shrinkage and item insertions/removals in between.
     */
    private fun visibleSpanGrowth(
        visible: List<LazyListItemInfo>,
        previous: Map<Any, ItemSpan>,
        viewportEndOffset: Int,
    ): Float {
        if (previous.isEmpty()) return 0f
        val topInset = (viewport.top - lazyBounds.top).coerceAtLeast(0f)
        val readingTopFromStart = viewportEndOffset - topInset
        val shared = visible.filter { it.offset < readingTopFromStart && it.key in previous }
        if (shared.isEmpty()) return 0f
        val bottom = shared.first()
        val top = shared.last()
        val prevBottom = previous.getValue(bottom.key)
        val prevTop = previous.getValue(top.key)
        return ((top.offset + top.size - bottom.offset) - (prevTop.top - prevBottom.offset)).toFloat()
    }

    private fun currentUnplacedShift(): Float {
        val probe = pendingProbe?.takeIf { it.isAttached } ?: run {
            clearPendingShift()
            return 0f
        }
        if (abs(probe.positionInWindow().y - pendingProbeBaseY) > 0.5f) {
            clearPendingShift()
            return 0f
        }
        return pendingUnplacedShift
    }

    private fun clearPendingShift() {
        pendingProbe = null
        pendingProbeBaseY = 0f
        pendingUnplacedShift = 0f
    }

    private fun anchoredLineY(held: Anchor, region: Region, top: Float): Float {
        var offset = held.offset
        if (offset >= 0 && held.context.isNotEmpty() && !region.text.drop(offset).startsWith(held.context)) {
            val found = region.text.indexOf(held.context)
            if (found >= 0) offset = found
        }
        val layout = region.layout
        val localY = if (offset >= 0 && layout != null && layout.lineCount > 0) {
            layout.getLineTop(layout.getLineForOffset(offset.coerceIn(0, region.text.length)))
        } else 0f
        return top + localY - viewport.top
    }

    companion object {
        val Saver = listSaver<TimelineReadingState, String>(
            save = { state ->
                val held = state.anchor ?: if (!state.following) state.capture() else null
                listOf("following:${state.following}") + state.expanded.map { "e:${it.key}:${it.value}" } + state.groupMembers.map { "g:${it.key}:${it.value}" } +
                    state.codePositions.map { "c:${it.key}:${it.value.first}:${it.value.second}" } +
                    held?.let { listOf("a:key:${it.key}", "a:row:${it.row}", "a:offset:${it.offset}", "a:context:${it.context}", "a:y:${it.y}") }.orEmpty()
            },
            restore = { saved -> TimelineReadingState().apply {
                saved.forEach { entry ->
                    if (entry.startsWith("a:")) return@forEach
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
                val fields = saved.filter { it.startsWith("a:") }.associate {
                    val field = it.substring(2)
                    field.substringBefore(':') to field.substringAfter(':')
                }
                val key = fields["key"]
                val row = fields["row"]
                val offset = fields["offset"]?.toIntOrNull()
                val y = fields["y"]?.toFloatOrNull()?.takeIf { it.isFinite() }
                if (!following && key != null && row != null && offset != null && y != null) {
                    anchor = Anchor(key, row, offset, fields["context"].orEmpty(), y)
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
    onGloballyPositioned { state?.observe(key, row, it); state?.placed() }
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
    fun positioned(value: LayoutCoordinates) { coordinates = value; publish(); state?.placed() }
    // onTextLayout runs during measurement, where the list cannot be scrolled.
    fun laidOut(value: TextLayoutResult) { layout = value; publish() }
    private fun publish() { coordinates?.let { state?.observe(key, row, it, layout, text) } }
}
