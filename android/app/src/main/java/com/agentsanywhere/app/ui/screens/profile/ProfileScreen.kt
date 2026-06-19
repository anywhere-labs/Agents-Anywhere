package com.agentsanywhere.app.ui.screens.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAColor

@Composable
fun ProfileScreen(navigate: (AppDestination) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Profile", color = AAColor.Ink, fontSize = 29.sp, fontWeight = FontWeight.Bold)
        Text("Account, team, server URL, and notification surfaces.", color = AAColor.Muted, fontSize = 15.sp)
    }
}
