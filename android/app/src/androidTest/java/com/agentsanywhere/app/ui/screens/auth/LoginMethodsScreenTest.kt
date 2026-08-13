package com.agentsanywhere.app.ui.screens.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LoginMethodsScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun loginHomeOnlyShowsServerAndQrEntries() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        composeRule.setContent {
            AgentsAnywhereTheme {
                LoginMethodsScreen(navigate = {})
            }
        }

        composeRule.onNodeWithText(context.getString(R.string.auth_enter_server)).assertIsDisplayed()
        composeRule.onNodeWithText(context.getString(R.string.auth_continue_qr)).assertIsDisplayed()
        composeRule.onNodeWithText("Continue with Password").assertDoesNotExist()
        composeRule.onNodeWithText("Continue with OAuth").assertDoesNotExist()
        composeRule.onNodeWithText("Create an account").assertDoesNotExist()
    }
}
