package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Lucide
import kotlinx.coroutines.delay

@Composable
internal fun pairingBorder(): Color {
    val colors = LocalAAColors.current
    return if (colors.isDark) colors.subtle else Color(0xFFE7E6E2)
}

@Composable
internal fun PairingStepHeading(title: String, description: String) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, color = colors.ink, fontSize = 22.sp, lineHeight = 29.sp,
            fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        PairingBodyText(description)
    }
}

@Composable
internal fun PairingBodyText(text: String) {
    Text(text, color = LocalAAColors.current.muted, fontSize = 14.sp, lineHeight = 22.sp)
}

@Composable
internal fun PairingChoiceCard(icon: ImageVector, title: String, description: String, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(18.dp),
        color = colors.raisedSurface, border = BorderStroke(1.dp, pairingBorder())) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(icon, null, tint = colors.inkSoft, modifier = Modifier.size(21.dp))
                Text(title, color = colors.ink, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold)
            }
            PairingBodyText(description)
        }
    }
}

@Composable
internal fun PairingInstructionCard(title: String, description: String) {
    val colors = LocalAAColors.current
    Surface(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(18.dp),
        color = colors.raisedSurface, border = BorderStroke(1.dp, pairingBorder())) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, color = colors.ink, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold)
            PairingBodyText(description)
        }
    }
}

@Composable
internal fun PairingActionButton(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    loading: Boolean = false,
    secondary: Boolean = false,
    icon: ImageVector? = null,
) {
    val colors = LocalAAColors.current
    val surface = if (secondary) colors.raisedSurface else colors.primaryAction
    val ink = if (secondary) colors.ink else colors.onPrimaryAction
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
        shape = RoundedCornerShape(16.dp),
        border = if (secondary) BorderStroke(1.dp, pairingBorder()) else null,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = surface, contentColor = ink,
            disabledContainerColor = surface.copy(alpha = 0.4f), disabledContentColor = ink.copy(alpha = 0.6f)),
        elevation = null,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(17.dp), color = ink, strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(label, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (icon != null) {
            Spacer(Modifier.width(8.dp))
            Icon(icon, null, modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
internal fun PairingCodeBlock(code: String, onCopyError: () -> Unit) {
    val colors = LocalAAColors.current
    val clipboard = LocalClipboardManager.current
    var copied by remember(code) { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(2_000); copied = false } }
    Surface(modifier = Modifier.fillMaxWidth(), color = colors.subtle.copy(alpha = 0.45f),
        shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, pairingBorder())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SelectionContainer(Modifier.weight(1f).horizontalScroll(rememberScrollState()).padding(14.dp)) {
                Text(code, color = colors.ink, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    lineHeight = 19.sp, softWrap = false)
            }
            IconButton(onClick = {
                runCatching { clipboard.setText(AnnotatedString(code)) }
                    .onSuccess { copied = true }.onFailure { onCopyError() }
            }, modifier = Modifier.size(44.dp)) {
                Icon(if (copied) Lucide.Check else Lucide.Copy,
                    stringResource(if (copied) R.string.common_copied else R.string.device_pairing_copy_command),
                    tint = colors.muted, modifier = Modifier.size(19.dp))
            }
        }
    }
}

@Composable
internal fun PairingNameInput(value: String, enabled: Boolean, onChange: (String) -> Unit, onSubmit: () -> Unit) {
    val colors = LocalAAColors.current
    val focusRequester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val label = stringResource(R.string.device_pairing_name_label)
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, color = colors.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        BasicTextField(
            value = value, onValueChange = onChange, enabled = enabled, singleLine = true,
            modifier = Modifier.fillMaxWidth().height(54.dp).focusRequester(focusRequester)
                .onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label }
                .background(colors.raisedSurface, RoundedCornerShape(16.dp))
                .border(1.dp, if (focused) colors.inkSoft else pairingBorder(), RoundedCornerShape(16.dp))
                .padding(horizontal = 16.dp),
            textStyle = TextStyle(color = colors.ink, fontFamily = FontFamily.Monospace, fontSize = 15.sp),
            cursorBrush = SolidColor(colors.ink),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            decorationBox = { inner ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(stringResource(R.string.device_pairing_name_placeholder), color = colors.faint, fontSize = 15.sp)
                    inner()
                }
            },
        )
    }
}

@Composable
internal fun PairingCodeInput(value: String, enabled: Boolean, onChange: (String) -> Unit, onSubmit: () -> Unit) {
    val colors = LocalAAColors.current
    var focused by remember { mutableStateOf(false) }
    val label = stringResource(R.string.device_pairing_code_label)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, color = colors.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        BasicTextField(
            value = value, onValueChange = { onChange(it.filter { digit -> digit in '0'..'9' }.take(6)) },
            enabled = enabled, singleLine = true,
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label },
            textStyle = TextStyle(color = Color.Transparent, fontSize = 22.sp), cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (value.length == 6) onSubmit() }),
            decorationBox = { inner ->
                Box {
                    Row(Modifier.alpha(if (enabled) 1f else 0.45f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        repeat(6) { index ->
                            val active = focused && index == value.length.coerceAtMost(5)
                            Box(Modifier.weight(1f).height(54.dp)
                                .background(colors.raisedSurface, RoundedCornerShape(12.dp))
                                .border(1.dp, if (active) colors.inkSoft else pairingBorder(), RoundedCornerShape(12.dp)),
                                contentAlignment = Alignment.Center) {
                                Text(value.getOrNull(index)?.toString().orEmpty(), color = colors.ink,
                                    fontSize = 22.sp, fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center)
                                if (active && value.length < 6) Box(Modifier.width(1.dp).height(22.dp).background(colors.ink))
                            }
                        }
                    }
                    Box(Modifier.matchParentSize().alpha(0f), contentAlignment = Alignment.CenterStart) { inner() }
                }
            },
        )
    }
}

@Composable
internal fun PairingWaitingIndicator(label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = LocalAAColors.current.muted)
        PairingBodyText(label)
    }
}
