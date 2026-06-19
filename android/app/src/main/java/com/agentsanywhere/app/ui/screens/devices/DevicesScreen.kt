package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.feature.devices.DevicesState
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAColor
import com.agentsanywhere.app.ui.designsystem.PlaceholderScreen

@Composable
fun DevicesScreen(
    navigate: (AppDestination) -> Unit,
    state: DevicesState = DevicesState(),
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Devices", color = AAColor.Ink, fontSize = 29.sp, fontWeight = FontWeight.Bold)
        if (state.devices.isEmpty()) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                PlaceholderScreen(
                    title = "No Devices",
                    subtitle = "Paired connectors will appear here after the API is connected.",
                )
            }
        } else {
            state.devices.forEach { device ->
                Text(
                    text = "${device.name} · ${device.subtitle}",
                    color = AAColor.Muted,
                    fontSize = 15.sp,
                )
            }
        }
    }
}
