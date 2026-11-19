plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * Copies the shared renderer bundle (built by v3poc/web into the iOS PoC) and the fixtures into generated assets:
 * assets/renderer/renderer.html and assets/fixtures/<name>.json. Nothing is checked in twice.
 */
val pocRoot: File = rootDir.parentFile
val pocAssets = layout.buildDirectory.dir("generated/pocAssets")
val copyPocAssets = tasks.register<Sync>("copyPocAssets") {
    into(pocAssets)
    from(File(pocRoot, "ios/AAv3PoC/Renderer/renderer.html")) { into("renderer") }
    from(File(pocRoot, "fixtures")) { include("*.json"); into("fixtures") }
}

android {
    namespace = "dev.agentsanywhere.v3poc"
    compileSdk {
        // backdrop 2.0.1 and Compose 1.12 require compileSdk 37; the app still targets 36.
        version = release(37)
    }

    defaultConfig {
        applicationId = "dev.agentsanywhere.v3poc"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-poc"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    androidResources {
        // The 16 MB renderer is read once per WebView load: no inflating.
        noCompress += listOf("html")
    }

    sourceSets.getByName("main").assets.directories.add(pocAssets.get().asFile.path)
}

tasks.named("preBuild") { dependsOn(copyPocAssets) }

dependencies {
    implementation("io.github.t4wefan:meshcall:0.3.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.87")
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    // Sheets use Android's own design (ModalBottomSheet); the rest of the UI is the app's own design system.
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.metrics:metrics-performance:1.0.0")
    // Kyant backdrop: records the thread (WebView in a hardware layer) for blurred / refracting glass; it brings
    // io.github.kyant0:shapes (declared explicitly: it is not on backdrop's API surface), whose continuous-curvature rounded rectangles match SwiftUI's `.continuous` corners.
    implementation("io.github.kyant0:backdrop:2.0.1")
    implementation("io.github.kyant0:shapes:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
