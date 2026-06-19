package com.agentsanywhere.app.ui.screens.sessions

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.SessionsEmptyKind
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.MoreGlyph
import com.agentsanywhere.app.ui.designsystem.PlusGlyph
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.valentinilk.shimmer.shimmer

@Composable
internal fun PullRefreshErrorNotice(message: String) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
    ) {
        item(key = "error") {
            AuthErrorNotice(
                message = message,
                modifier = Modifier.padding(top = 10.dp),
            )
        }
        item(key = "pull-space") {
            Spacer(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp),
            )
        }
    }
}

@Composable
internal fun PullRefreshEmptyState(
    kind: SessionsEmptyKind?,
    onAction: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
    ) {
        item(key = "empty") {
            SessionsEmptyState(
                kind = kind,
                onAction = onAction,
                modifier = Modifier.fillParentMaxSize(),
            )
        }
    }
}

@Composable
internal fun PullRefreshFilteredEmptyState(
    onClearFilters: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
    ) {
        item(key = "filtered-empty") {
            Column(
                modifier = Modifier
                    .fillParentMaxSize()
                    .padding(horizontal = 18.dp, vertical = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "No matching sessions.",
                    color = LocalAAColors.current.ink,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "Try another agent, device, or workspace.",
                    color = LocalAAColors.current.muted,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(18.dp))
                Box(
                    modifier = Modifier
                        .height(44.dp)
                        .clip(CircleShape)
                        .background(LocalAAColors.current.primaryAction)
                        .noRippleClickable(onClick = onClearFilters)
                        .padding(horizontal = 18.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "Clear filters",
                        color = LocalAAColors.current.onPrimaryAction,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}


@Composable
internal fun LoadingState() {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val baseColor = if (darkMode) Color(0xFF1E1E22) else Color(0xFFEDEBE6)

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .shimmer()
            .padding(top = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(key = "loading-label") {
            SkeletonLine(
                modifier = Modifier
                    .padding(horizontal = 24.dp)
                    .width(84.dp)
                    .height(16.dp),
                baseColor = baseColor,
                shape = CircleShape,
            )
        }
        items(6, key = { "loading-session-$it" }) { index ->
            SessionRowSkeleton(
                index = index,
                baseColor = baseColor,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }
        item(key = "loading-bottom-space") {
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
internal fun SessionRowSkeleton(
    index: Int,
    baseColor: Color,
    modifier: Modifier = Modifier,
) {
    val titleWidth = listOf(0.78f, 0.62f, 0.84f, 0.70f, 0.58f, 0.76f)[index % 6]
    val summaryWidth = listOf(0.92f, 0.84f, 0.74f, 0.88f, 0.80f, 0.68f)[index % 6]
    val metaWidth = listOf(0.50f, 0.42f, 0.56f, 0.46f, 0.38f, 0.52f)[index % 6]

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(82.dp),
    ) {
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth(titleWidth)
                .height(20.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(8.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 34.dp)
                .fillMaxWidth(summaryWidth)
                .height(15.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 62.dp)
                .fillMaxWidth(metaWidth)
                .height(13.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
    }
}

@Composable
private fun SkeletonLine(
    modifier: Modifier,
    baseColor: Color,
    shape: androidx.compose.ui.graphics.Shape,
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(baseColor),
    )
}

@Composable
private fun SessionsEmptyState(
    kind: SessionsEmptyKind?,
    onAction: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val noDevice = kind == SessionsEmptyKind.NoDevice

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(
                if (noDevice) {
                    R.drawable.ic_sessions_empty_no_device
                } else {
                    R.drawable.ic_sessions_empty
                },
            ),
            contentDescription = null,
            modifier = Modifier.size(width = 188.dp, height = 156.dp),
            contentScale = ContentScale.Fit,
        )
        Spacer(Modifier.height(22.dp))
        Column(
            modifier = Modifier.width(294.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = if (noDevice) {
                    "Pair a device first, so your first session has somewhere to land."
                } else {
                    "A fresh workspace is waiting for its first spark."
                },
                color = if (colors.canvas == Color(0xFF09090B)) colors.ink else Color(0xFF3F403C),
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 21.4.sp,
                textAlign = TextAlign.Center,
            )
            EmptyActionButton(
                label = if (noDevice) "Pair a new device" else "Create a new session",
                noDevice = noDevice,
                onClick = onAction,
            )
        }
    }
}

@Composable
private fun EmptyActionButton(
    label: String,
    noDevice: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .height(44.dp)
            .shadow(18.dp, CircleShape, ambientColor = Color(0x18000000), spotColor = Color(0x18000000))
            .clip(CircleShape)
            .background(colors.primaryAction)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (noDevice) {
            DeviceMiniGlyph(color = colors.onPrimaryAction)
        } else {
            PlusGlyph(color = colors.onPrimaryAction)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = label,
            color = colors.onPrimaryAction,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun DeviceMiniGlyph(color: Color) {
    Canvas(modifier = Modifier.size(17.dp)) {
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.15f, size.height * 0.18f),
            size = androidx.compose.ui.geometry.Size(size.width * 0.70f, size.height * 0.48f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.5.dp.toPx(), 2.5.dp.toPx()),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.7.dp.toPx(), cap = StrokeCap.Round),
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.50f, size.height * 0.66f),
            end = Offset(size.width * 0.50f, size.height * 0.80f),
            strokeWidth = 1.7.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.34f, size.height * 0.82f),
            end = Offset(size.width * 0.66f, size.height * 0.82f),
            strokeWidth = 1.7.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

@Composable
internal fun SectionLabel(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .height(24.dp)
            .noRippleClickable {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(start = 0.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = label,
            color = colors.faint,
            fontSize = 15.1.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 18.sp,
            letterSpacing = 0.sp,
        )
        ChevronDown(
            color = colors.faint.copy(alpha = 0.95f),
            modifier = Modifier
                .size(width = 8.dp, height = 6.dp)
                .offset(y = 1.dp),
            strokeWidthDp = 1.5f,
            expanded = expanded,
        )
    }
}

@Composable
internal fun SessionRow(
    session: AgentSession,
    onClick: () -> Unit,
    onMoreClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val titleColor = if (darkMode) Color(0xFFDADADF) else Color(0xFF343436)
    val summaryColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF747474)
    val metaColor = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A8A8)
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(82.dp)
            .background(colors.canvas)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
    ) {
        Text(
            text = session.title,
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth()
                .padding(start = 24.dp, end = 82.dp),
            color = titleColor,
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 23.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = session.summary,
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 32.dp)
                .fillMaxWidth()
                .padding(start = 24.dp, end = 82.dp),
            color = summaryColor,
            fontSize = 15.1.sp,
            lineHeight = 18.2.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = session.metaLabel,
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 62.dp)
                .fillMaxWidth()
                .padding(start = 24.dp, end = 82.dp),
            color = metaColor,
            fontSize = 13.sp,
            lineHeight = 15.6.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        Text(
            text = session.updatedAtLabel,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset(x = (-24).dp, y = 1.dp),
            color = metaColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .offset(x = (-24).dp)
                .size(width = 24.dp, height = 26.dp),
            contentAlignment = Alignment.Center,
        ) {
            SessionMoreButton(
                iconColor = metaColor,
                onClick = onMoreClick,
            )
        }
    }
}

@Composable
private fun SessionMoreButton(
    iconColor: Color,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.90f else 1f,
        label = "session-more-scale",
    )
    val surfaceAlpha by animateFloatAsState(
        targetValue = if (pressed) 0.10f else 0f,
        label = "session-more-surface-alpha",
    )

    Box(
        modifier = Modifier
            .size(36.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(CircleShape)
            .background(
                if (darkMode) {
                    Color.White.copy(alpha = surfaceAlpha)
                } else {
                    Color.Black.copy(alpha = surfaceAlpha)
                },
            )
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        MoreGlyph(color = iconColor)
    }
}


@Composable
internal fun ChevronDown(
    color: Color,
    modifier: Modifier = Modifier,
    strokeWidthDp: Float = 1.5f,
    expanded: Boolean = true,
) {
    Canvas(modifier = modifier) {
        if (expanded) {
            drawLine(
                color = color,
                start = Offset(size.width * 0.12f, size.height * 0.22f),
                end = Offset(size.width * 0.50f, size.height * 0.78f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
            drawLine(
                color = color,
                start = Offset(size.width * 0.50f, size.height * 0.78f),
                end = Offset(size.width * 0.88f, size.height * 0.22f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
        } else {
            drawLine(
                color = color,
                start = Offset(size.width * 0.22f, size.height * 0.12f),
                end = Offset(size.width * 0.78f, size.height * 0.50f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
            drawLine(
                color = color,
                start = Offset(size.width * 0.78f, size.height * 0.50f),
                end = Offset(size.width * 0.22f, size.height * 0.88f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
        }
    }
}
