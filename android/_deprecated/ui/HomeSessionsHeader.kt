// Retired: the session view now starts directly with its pinned/recent sections.
package com.agentsanywhere.app.ui.screens.home

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.CheckCheck
import com.composables.icons.lucide.Lucide
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

@Composable
internal fun HomeSessionsHeader(onMarkAllRead: suspend () -> Result<Unit>) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.home_sessions_title), color = LocalAAColors.current.muted)
        IconButton(enabled = !busy, onClick = {
            busy = true
            scope.launch {
                try {
                    onMarkAllRead().onFailure {
                        if (it is CancellationException) throw it
                        Toast.makeText(context, it.message, Toast.LENGTH_SHORT).show()
                    }
                } finally { busy = false }
            }
        }) {
            Icon(Lucide.CheckCheck, stringResource(R.string.home_mark_all_read), tint = LocalAAColors.current.muted)
        }
    }
}
