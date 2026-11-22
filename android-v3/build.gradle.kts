plugins {
    id("com.android.application") version "9.5.1" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin); this pins the Kotlin version it uses to match the plugins below.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jetbrains.kotlin.jvm") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
}
