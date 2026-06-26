package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.delay

@Composable
internal fun ComposerVeil(
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val base = if (darkMode) Color(0xFF09090B) else Color(0xFFFDFCFB)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .height(184.dp)
            .background(
                Brush.verticalGradient(
                    0f to base.copy(alpha = 0f),
                    0.48f to base.copy(alpha = 0.72f),
                    1f to base.copy(alpha = 0.96f),
                ),
            ),
    )
}

@Composable
internal fun MessageComposer(
    darkMode: Boolean,
    draft: String,
    onDraftChange: (String) -> Unit,
    takeoverEnabled: Boolean,
    takeoverBusy: Boolean,
    inputEnabled: Boolean,
    canSend: Boolean,
    showInterrupt: Boolean,
    placeholder: String,
    attachments: List<PendingAttachment>,
    onToggleTakeover: () -> Unit,
    onPickPhoto: () -> Unit,
    onPickFile: () -> Unit,
    onOpenCamera: () -> Unit,
    onRemoveAttachment: (PendingAttachment) -> Unit,
    onPreviewAttachment: (PendingAttachment) -> Unit,
    onReadOnlyClick: () -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val surface = if (darkMode) Color(0xF218181B) else Color(0xF2FFFFFF)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFEFEDE9)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8A8984)
    val input = if (inputEnabled) {
        if (darkMode) Color(0xFFEDEDEF) else Color(0xFF252622)
    } else {
        muted
    }
    var showAttachMenu by remember { mutableStateOf(false) }
    var keepAttachMenuMounted by remember { mutableStateOf(false) }
    val menuOffset = with(LocalDensity.current) { IntOffset(14.dp.roundToPx(), (-34).dp.roundToPx()) }
    val textFieldMaxHeight = if (attachments.isEmpty()) 92.dp else 40.dp
    LaunchedEffect(showAttachMenu) {
        if (showAttachMenu) {
            keepAttachMenuMounted = true
        } else {
            delay(150)
            keepAttachMenuMounted = false
        }
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .padding(start = 14.dp, end = 14.dp, bottom = 24.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 104.dp, max = 218.dp)
                .shadow(28.dp, RoundedCornerShape(22.dp), ambientColor = Color(0x12000000), spotColor = Color(0x12000000))
                .clip(RoundedCornerShape(22.dp))
                .background(surface)
                .border(1.dp, border, RoundedCornerShape(22.dp))
                .then(if (inputEnabled) Modifier else Modifier.noRippleClickable(onClick = onReadOnlyClick))
                .padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (attachments.isNotEmpty()) {
                PendingAttachmentStrip(
                    attachments = attachments,
                    darkMode = darkMode,
                    onRemoveAttachment = onRemoveAttachment,
                    onPreviewAttachment = onPreviewAttachment,
                )
            }
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                enabled = inputEnabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 28.dp, max = textFieldMaxHeight),
                textStyle = TextStyle(
                    color = input,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 21.sp,
                ),
                cursorBrush = SolidColor(input),
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
                decorationBox = { innerTextField ->
                    Box(
                        modifier = Modifier.fillMaxWidth(),
                        contentAlignment = Alignment.TopStart,
                    ) {
                        if (draft.isEmpty()) {
                            Text(
                                text = placeholder,
                                color = muted,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 4,
                            )
                        }
                        innerTextField()
                    }
                },
            )
            ComposerActions(
                darkMode = darkMode,
                takeoverEnabled = takeoverEnabled,
                takeoverBusy = takeoverBusy,
                inputEnabled = inputEnabled,
                canSend = canSend,
                showInterrupt = showInterrupt,
                onToggleTakeover = onToggleTakeover,
                onOpenAttachMenu = { if (inputEnabled) showAttachMenu = true },
                onSend = onSend,
                onInterrupt = onInterrupt,
            )
        }
    }
    if (keepAttachMenuMounted) {
        Popup(
            alignment = Alignment.BottomStart,
            offset = menuOffset,
            onDismissRequest = { showAttachMenu = false },
        ) {
            AnimatedVisibility(
                visible = showAttachMenu,
                enter = fadeIn(tween(90)) + scaleIn(
                    animationSpec = tween(180, easing = FastOutSlowInEasing),
                    initialScale = 0.72f,
                    transformOrigin = TransformOrigin(0.06f, 0.96f),
                ),
                exit = fadeOut(tween(90)) + scaleOut(
                    animationSpec = tween(130, easing = FastOutSlowInEasing),
                    targetScale = 0.9f,
                    transformOrigin = TransformOrigin(0.06f, 0.96f),
                ),
            ) {
                AttachmentSourceMenu(
                    darkMode = darkMode,
                    onCamera = {
                        showAttachMenu = false
                        onOpenCamera()
                    },
                    onPhoto = {
                        showAttachMenu = false
                        onPickPhoto()
                    },
                    onFile = {
                        showAttachMenu = false
                        onPickFile()
                    },
                )
            }
        }
    }
}

@Composable
private fun PendingAttachmentStrip(
    attachments: List<PendingAttachment>,
    darkMode: Boolean,
    onRemoveAttachment: (PendingAttachment) -> Unit,
    onPreviewAttachment: (PendingAttachment) -> Unit,
) {
    val scrollState = rememberScrollState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(96.dp)
            .horizontalScroll(scrollState),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        attachments.forEach { attachment ->
            PendingAttachmentCard(
                attachment = attachment,
                darkMode = darkMode,
                onRemove = { onRemoveAttachment(attachment) },
                onPreview = { onPreviewAttachment(attachment) },
            )
        }
    }
}

@Composable
private fun PendingAttachmentCard(
    attachment: PendingAttachment,
    darkMode: Boolean,
    onRemove: () -> Unit,
    onPreview: () -> Unit,
) {
    if (attachment.isImage) {
        PendingImageAttachmentCard(
            attachment = attachment,
            onRemove = onRemove,
            onPreview = onPreview,
        )
    } else {
        PendingFileAttachmentCard(
            attachment = attachment,
            darkMode = darkMode,
            onRemove = onRemove,
        )
    }
}

@Composable
private fun PendingImageAttachmentCard(
    attachment: PendingAttachment,
    onRemove: () -> Unit,
    onPreview: () -> Unit,
) {
    Box(
        modifier = Modifier
            .width(116.dp)
            .height(92.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(Color(0xFF18181B))
            .noRippleClickable(onClick = onPreview),
    ) {
        PendingAttachmentImage(
            attachment = attachment,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop,
        )
        AttachmentUploadOverlay(
            state = attachment.uploadState,
            onRemove = onRemove,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun PendingFileAttachmentCard(
    attachment: PendingAttachment,
    darkMode: Boolean,
    onRemove: () -> Unit,
) {
    val surface = if (darkMode) Color(0xFF27272A) else Color(0xFFF1F0ED)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF242522)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val iconRes = if (darkMode) R.drawable.ic_attachment_file_white else R.drawable.ic_attachment_file_black
    Box(
        modifier = Modifier
            .width(174.dp)
            .height(92.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(surface),
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(14.dp))
                .background(if (darkMode) Color(0xFF18181B) else Color.White.copy(alpha = 0.86f)),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(iconRes),
                    contentDescription = stringResource(R.string.session_attachment_file),
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                Text(
                    text = attachment.name,
                    color = text,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    lineHeight = 15.sp,
                )
                Text(
                    text = formatBytes(attachment.size),
                    color = muted,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
            }
        }
        AttachmentUploadOverlay(
            state = attachment.uploadState,
            onRemove = onRemove,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun AttachmentUploadOverlay(
    state: AttachmentUploadState,
    onRemove: () -> Unit,
    modifier: Modifier,
) {
    when (state) {
        AttachmentUploadState.Uploading -> Box(
            modifier = modifier.background(Color.Black.copy(alpha = 0.28f)),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(38.dp),
                color = Color.White,
                strokeWidth = 5.dp,
            )
        }
        AttachmentUploadState.Uploaded,
        AttachmentUploadState.Failed -> Box(modifier = modifier) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(Color(0xD9262628))
                    .border(1.dp, Color(0x22FFFFFF), CircleShape)
                    .noRippleClickable(onClick = onRemove),
                contentAlignment = Alignment.Center,
            ) {
                XGlyph(Color.White, sizeDp = 22)
            }
        }
    }
}

@Composable
private fun ComposerActions(
    darkMode: Boolean,
    takeoverEnabled: Boolean,
    takeoverBusy: Boolean,
    inputEnabled: Boolean,
    canSend: Boolean,
    showInterrupt: Boolean,
    onToggleTakeover: () -> Unit,
    onOpenAttachMenu: () -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
) {
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color.Transparent
    val icon = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF2D2E2B)
    val label = when {
        takeoverEnabled && darkMode -> Color(0xFFEDEDEF)
        takeoverEnabled -> Color(0xFF2F302D)
        darkMode -> Color(0xFFA1A1AA)
        else -> Color(0xFF3A3935)
    }
    val canPressSend = canSend || showInterrupt
    val sendSurface = when {
        showInterrupt && darkMode -> Color.White
        showInterrupt -> Color(0xFF09090B)
        canSend && darkMode -> Color(0xFFFAFAFA)
        canSend -> Color(0xFF2B2B2B)
        darkMode -> Color(0xFF3F3F46)
        else -> Color(0xFFE2E0DC)
    }
    val sendIcon = when {
        showInterrupt && darkMode -> Color(0xFF09090B)
        showInterrupt -> Color.White
        canSend && darkMode -> Color(0xFF09090B)
        canSend -> Color.White
        darkMode -> Color(0xFF71717A)
        else -> Color(0xFFA7A5A0)
    }

    val plusModifier = if (darkMode) {
        Modifier.size(30.dp)
    } else {
        Modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
    }
    val takeoverModifier = if (darkMode) {
        Modifier.height(28.dp)
    } else {
        Modifier
            .height(28.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .padding(start = 4.dp, end = 9.dp)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(34.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = plusModifier.then(if (inputEnabled) Modifier.noRippleClickable(onClick = onOpenAttachMenu) else Modifier),
                contentAlignment = Alignment.Center,
            ) {
                PlusMiniGlyph(icon)
            }
            Row(
                modifier = takeoverModifier.then(
                    if (!takeoverBusy) Modifier.noRippleClickable(onClick = onToggleTakeover) else Modifier,
                ),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TakeoverSwitch(darkMode = darkMode, enabled = takeoverEnabled)
                Text(
                    text = stringResource(R.string.session_takeover),
                    color = label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
            }
        }
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(sendSurface)
                .then(
                    if (canPressSend) {
                        Modifier.noRippleClickable(onClick = if (showInterrupt) onInterrupt else onSend)
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (showInterrupt) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(sendIcon),
                )
            } else {
                ArrowUpGlyph(sendIcon)
            }
        }
    }
}

@Composable
private fun AttachmentSourceMenu(
    darkMode: Boolean,
    onCamera: () -> Unit,
    onPhoto: () -> Unit,
    onFile: () -> Unit,
) {
    val surface = if (darkMode) Color(0xFF202023) else Color.White
    val border = if (darkMode) Color(0xFF38383C) else Color(0xFFEFEDE9)
    val shadow = if (darkMode) Color(0x80000000) else Color(0x1A000000)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF2F302D)
    val iconSurface = if (darkMode) Color(0xFF3A3A3D) else Color(0xFFF1F1EF)
    val cameraIcon = if (darkMode) R.drawable.ic_attachment_camera_white else R.drawable.ic_attachment_camera_black
    val photoIcon = if (darkMode) R.drawable.ic_attachment_photo_white else R.drawable.ic_attachment_photo_black
    val fileIcon = if (darkMode) R.drawable.ic_attachment_file_white else R.drawable.ic_attachment_file_black
    Column(
        modifier = Modifier
            .width(270.dp)
            .height(190.dp)
            .shadow(34.dp, RoundedCornerShape(24.dp), ambientColor = shadow, spotColor = shadow)
            .clip(RoundedCornerShape(24.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(24.dp))
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AttachmentSourceRow(
            label = stringResource(R.string.session_attachment_camera),
            iconRes = cameraIcon,
            iconSurface = iconSurface,
            text = text,
            onClick = onCamera,
        )
        AttachmentSourceRow(
            label = stringResource(R.string.session_attachment_photos),
            iconRes = photoIcon,
            iconSurface = iconSurface,
            text = text,
            onClick = onPhoto,
        )
        AttachmentSourceRow(
            label = stringResource(R.string.session_attachment_file),
            iconRes = fileIcon,
            iconSurface = iconSurface,
            text = text,
            onClick = onFile,
        )
    }
}

@Composable
private fun AttachmentSourceRow(
    label: String,
    iconRes: Int,
    iconSurface: Color,
    text: Color,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .noRippleClickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(CircleShape)
                .background(iconSurface),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                painter = painterResource(iconRes),
                contentDescription = label,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            text = label,
            color = text,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun TakeoverSwitch(darkMode: Boolean, enabled: Boolean) {
    val track = when {
        enabled && darkMode -> Color(0xFF52525B)
        enabled -> Color(0xFF2F302D)
        darkMode -> Color(0xFF303033)
        else -> Color(0xFFD8D6D1)
    }
    val knob = if (darkMode || enabled) Color.White else Color(0xFFFDFCFB)
    Box(
        modifier = Modifier
            .width(30.dp)
            .height(18.dp)
            .clip(CircleShape)
            .background(track)
            .padding(3.dp),
        contentAlignment = if (enabled) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .clip(CircleShape)
                .background(knob),
        )
    }
}
