package com.agentsanywhere.app.ui.screens.profile

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.config.AppConfig
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Archive
import com.composables.icons.lucide.ChevronsUpDown
import com.composables.icons.lucide.Globe
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Moon
import com.composables.icons.lucide.PackageCheck
import com.composables.icons.lucide.Server
import kotlinx.coroutines.launch

private enum class ProfileDetailPage { None, Account, Language, Updates }

@Composable
private fun ProfileDetailPage.titleLabel(): String = when (this) {
    ProfileDetailPage.Account -> stringResource(R.string.profile_account)
    ProfileDetailPage.Language -> stringResource(R.string.profile_language)
    ProfileDetailPage.Updates -> stringResource(R.string.profile_updates)
    ProfileDetailPage.None -> ""
}

@Composable
fun ProfileSettingsDrawer(
    open: Boolean,
    userId: String,
    role: String,
    serverUrl: String,
    appearanceMode: String,
    languageMode: String,
    sidebarViewMode: String,
    appUpdateViewModel: AppUpdateViewModel,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onSidebarViewModeChange: (String) -> Unit,
    onLoadAccount: suspend () -> Result<AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<AuthMeResponse>,
    onClearAvatar: suspend () -> Result<AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onOpenArchivedSessions: () -> Unit,
    onSignOut: () -> Unit,
    onClose: () -> Unit,
    onNotice: (String, Boolean) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var account by remember(userId, role) {
        mutableStateOf(
            AuthMeResponse(
                userId = userId,
                role = role.ifBlank { "member" },
                disabled = false,
                avatar = null,
                serverTime = "",
            ),
        )
    }
    var avatarBusy by remember { mutableStateOf(false) }
    var detailPage by remember { mutableStateOf(ProfileDetailPage.None) }
    var appearanceMenuOpen by remember { mutableStateOf(false) }
    var sidebarViewMenuOpen by remember { mutableStateOf(false) }
    var passwordOpen by remember { mutableStateOf(false) }
    var signOutOpen by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri == null || avatarBusy) return@rememberLauncherForActivityResult
        scope.launch {
            avatarBusy = true
            runCatching { context.avatarDataUrl(uri) }
                .getOrNull()
                ?.let { dataUrl ->
                    onUpdateAvatar(dataUrl)
                        .onSuccess {
                            account = it
                            onNotice(context.getString(R.string.profile_avatar_updated), false)
                        }
                        .onFailure { error ->
                            onNotice(error.message ?: context.getString(R.string.profile_avatar_update_failed), true)
                        }
                }
                ?: onNotice(context.getString(R.string.profile_avatar_read_failed), true)
            avatarBusy = false
        }
    }

    BackHandler(enabled = open) {
        if (detailPage != ProfileDetailPage.None) detailPage = ProfileDetailPage.None else onClose()
    }

    LaunchedEffect(open) {
        if (!open) {
            detailPage = ProfileDetailPage.None
            appearanceMenuOpen = false
            sidebarViewMenuOpen = false
            return@LaunchedEffect
        }
        appUpdateViewModel.checkForUpdate(showPrompt = false)
        onLoadAccount()
            .onSuccess { account = it }
            .onFailure { onNotice(it.message ?: context.getString(R.string.profile_account_load_failed), true) }
    }

    AnimatedVisibility(
        visible = open,
        enter = slideInHorizontally(initialOffsetX = { -it }) + fadeIn(),
        exit = slideOutHorizontally(targetOffsetX = { -it }) + fadeOut(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(profilePageBackground(colors)),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .padding(horizontal = 18.dp),
                contentPadding = PaddingValues(top = 0.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (detailPage != ProfileDetailPage.None) {
                    item("account-detail-header") {
                        ProfileHeader(title = detailPage.titleLabel(), onClose = { detailPage = ProfileDetailPage.None })
                    }
                    when (detailPage) {
                        ProfileDetailPage.Account -> item("account-detail") {
                            AccountDetailPage(
                                account = account,
                                avatarBusy = avatarBusy,
                                onChangeAvatar = {
                                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                                onChangePassword = { passwordOpen = true },
                                onSignOut = { signOutOpen = true },
                            )
                        }
                        ProfileDetailPage.Language -> item("language-detail") {
                            LanguageDetailPage(
                                selectedMode = languageMode,
                                onSelect = onLanguageModeChange,
                            )
                        }
                        ProfileDetailPage.Updates -> item("updates-detail") {
                            UpdateDetailPage(
                                state = appUpdateViewModel.state,
                                onUpdate = appUpdateViewModel::downloadUpdate,
                                onCancelDownload = appUpdateViewModel::cancelDownload,
                            )
                        }
                        ProfileDetailPage.None -> Unit
                    }
                } else {
                    item("header") {
                        ProfileHeader(title = stringResource(R.string.profile_settings), onClose = onClose)
                    }
                    item("identity") {
                        IdentityCard(
                            account = account,
                            serviceLabel = if (
                                AppConfig.OFFICIAL_WEB_LOGIN_URL.isNotBlank() &&
                                serverUrl.trimEnd('/') == AppConfig.OFFICIAL_WEB_LOGIN_URL.trimEnd('/')
                            ) {
                                stringResource(R.string.profile_official_service)
                            } else {
                                stringResource(R.string.profile_self_hosted)
                            },
                            onClick = { detailPage = ProfileDetailPage.Account },
                        )
                    }
                    item("appearance") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.Moon,
                                title = stringResource(R.string.profile_appearance),
                                trailing = appearanceMode.labelForAppearance(),
                                trailingIcon = Lucide.ChevronsUpDown,
                                showChevron = false,
                                onClick = { appearanceMenuOpen = true },
                            )
                            AppearancePopup(
                                open = appearanceMenuOpen,
                                selectedMode = appearanceMode,
                                onSelect = {
                                    onAppearanceModeChange(it)
                                    appearanceMenuOpen = false
                                },
                                onDismiss = { appearanceMenuOpen = false },
                            )
                        }
                    }
                    item("language") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.Globe,
                                title = stringResource(R.string.profile_language),
                                trailing = languageMode.labelForLanguage(),
                                onClick = { detailPage = ProfileDetailPage.Language },
                            )
                        }
                    }
                    item("sidebar-view") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.ListIcon,
                                title = stringResource(R.string.profile_sidebar_display),
                                trailing = sidebarViewMode.labelForSidebarView(),
                                trailingIcon = Lucide.ChevronsUpDown,
                                showChevron = false,
                                onClick = { sidebarViewMenuOpen = true },
                            )
                            SidebarViewPopup(
                                open = sidebarViewMenuOpen,
                                selectedMode = sidebarViewMode,
                                onSelect = {
                                    onSidebarViewModeChange(it)
                                    sidebarViewMenuOpen = false
                                },
                                onDismiss = { sidebarViewMenuOpen = false },
                            )
                        }
                    }
                    item("version") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.PackageCheck,
                                title = stringResource(R.string.profile_version),
                                trailing = "v${context.appVersionName()}",
                                showChevron = false,
                            )
                            ProfileDivider()
                            ProfileRow(
                                icon = Lucide.Server,
                                title = stringResource(R.string.profile_check_updates),
                                trailingTag = if (appUpdateViewModel.state.release != null) {
                                    stringResource(R.string.update_new_version_badge)
                                } else {
                                    null
                                },
                                onClick = { detailPage = ProfileDetailPage.Updates },
                            )
                        }
                    }
                    item("archived-sessions") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.Archive,
                                title = stringResource(R.string.profile_archived_sessions),
                                onClick = {
                                    onClose()
                                    onOpenArchivedSessions()
                                },
                            )
                        }
                    }
                    item("sign-out") {
                        SignOutCard(onClick = { signOutOpen = true })
                    }
                }
            }
        }
    }

    if (passwordOpen) {
        ChangePasswordDialog(
            onDismiss = { passwordOpen = false },
            onSave = { password ->
                onChangePassword(password)
                    .onSuccess {
                        passwordOpen = false
                        onNotice(context.getString(R.string.profile_password_updated), false)
                    }
                    .onFailure { onNotice(it.message ?: context.getString(R.string.profile_password_update_failed), true) }
            },
        )
    }

    if (signOutOpen) {
        ConfirmSignOutDialog(
            onDismiss = { signOutOpen = false },
            onConfirm = {
                signOutOpen = false
                onSignOut()
            },
        )
    }
}
