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
    Terminal("Terminal"),
    Files("Files"),
    DeviceDetail("Device Detail"),
    SessionDetail("Session"),
}
