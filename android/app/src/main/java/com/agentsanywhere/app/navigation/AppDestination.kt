package com.agentsanywhere.app.navigation

enum class AppDestination(val title: String) {
    LoginMethods("Login"),
    ServerSetup("Server"),
    PasswordLogin("Password"),
    CreateAccount("Create Account"),
    OAuthSetup("OAuth Setup"),
    OAuthLinkExisting("OAuth Link"),
    OAuthRegistrationClosed("Registration Closed"),
    OAuthCreateAccount("OAuth Create Account"),
    OAuthRegistrationClosedError("OAuth Registration Error"),
    QrLogin("QR Login"),
    QrWaiting("Waiting"),
    Sessions("Sessions"),
    NewSession("New Session"),
    Devices("Devices"),
    DeviceDetail("Device Detail"),
    Profile("Profile"),
    SessionDetail("Session"),
}

enum class AppTab(
    val title: String,
    val destination: AppDestination,
) {
    Sessions("Sessions", AppDestination.Sessions),
    Devices("Devices", AppDestination.Devices),
    Profile("Profile", AppDestination.Profile),
}

fun AppDestination.selectedTab(): AppTab? = when (this) {
    AppDestination.Sessions,
    AppDestination.NewSession,
    AppDestination.SessionDetail -> AppTab.Sessions

    AppDestination.Devices,
    AppDestination.DeviceDetail -> AppTab.Devices
    AppDestination.Profile -> AppTab.Profile
    else -> null
}
