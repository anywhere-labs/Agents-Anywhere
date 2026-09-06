package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.CheckGlyph
import com.agentsanywhere.app.ui.designsystem.CloseGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil

@Composable
internal fun NewSessionHeader(
    title: String,
    editing: Boolean,
    darkMode: Boolean,
    focusRequester: FocusRequester,
    onTitleChange: (String) -> Unit,
    onSubmitTitle: () -> Unit,
    onClose: () -> Unit,
    onEditToggle: () -> Unit,
) {
    val colors = LocalAAColors.current
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)
    var titleField by remember { mutableStateOf(title.textFieldValueAtEnd()) }

    LaunchedEffect(editing) {
        if (editing) {
            titleField = title.textFieldValueAtEnd()
        }
    }

    LaunchedEffect(title, editing) {
        if (!editing && titleField.text != title) {
            titleField = title.textFieldValueAtEnd()
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderCircleButton(darkMode = darkMode, onClick = onClose) {
            CloseGlyph(color = iconColor, sizeDp = 17)
        }
        if (editing) {
            Column(
                modifier = Modifier.width(210.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                BasicTextField(
                    value = titleField,
                    onValueChange = {
                        titleField = it
                        onTitleChange(it.text)
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                    textStyle = TextStyle(
                        color = colors.ink,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.SansSerif,
                        textAlign = TextAlign.Center,
                    ),
                    cursorBrush = SolidColor(colors.ink),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { onSubmitTitle() }),
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.Center) {
                            inner()
                        }
                    },
                )
                Box(
                    modifier = Modifier
                        .width(142.dp)
                        .height(1.5.dp)
                        .clip(CircleShape)
                        .background(if (darkMode) Color(0xFF71717A) else Color(0xFFBDBDBD)),
                )
            }
        } else {
            Text(
                text = title,
                color = colors.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 24.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 16.dp),
            )
        }
        HeaderCircleButton(darkMode = darkMode, onClick = onEditToggle) {
            if (editing) {
                CheckGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF333333))
            } else {
                Icon(
                    imageVector = Lucide.Pencil,
                    contentDescription = null,
                    tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun HeaderCircleButton(
    darkMode: Boolean,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(if (darkMode) LocalAAColors.current.subtle else Color.White)
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

private fun String.textFieldValueAtEnd(): TextFieldValue {
    return TextFieldValue(text = this, selection = TextRange(length))
}
