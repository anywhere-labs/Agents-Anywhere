plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * The shared web-v3 render bundle (web-v3/embed, `aa.render/2`, built into one HTML file) is copied into the APK's
 * assets as `render/aa-render.html` when it has been built (`../web-v3/embed/dist/aa-render.html`). Without it the app
 * ships `render/placeholder.html` (src/main/assets), a minimal page that speaks the same bridge and draws plain text.
 */
val webV3: File = rootDir.resolve("../web-v3")
// `-Paa.renderBundle=/path/to/aa-render.html` uses a bundle built elsewhere (another checkout of web-v3).
val renderBundle: File = providers.gradleProperty("aa.renderBundle").orNull?.let { file(it) } ?: webV3.resolve("embed/dist/aa-render.html")
val renderAssets = layout.buildDirectory.dir("generated/renderAssets")

// `-Paa.buildRenderBundle=true` (or `aa.buildRenderBundle=true` in gradle.properties) builds the bundle first with
// `corepack yarn embed:build` (needs web-v3's dependencies installed: `cd web-v3 && corepack yarn install`).
val buildRenderBundle = tasks.register<Exec>("buildRenderBundle") {
    description = "Builds web-v3/embed/dist/aa-render.html (corepack yarn embed:build)."
    workingDir = webV3
    commandLine("corepack", "yarn", "embed:build")
    onlyIf { webV3.resolve("package.json").exists() }
}
val copyRenderBundle = tasks.register<Sync>("copyRenderBundle") {
    description = "Copies web-v3/embed/dist/aa-render.html into the app's assets when it exists."
    if (providers.gradleProperty("aa.buildRenderBundle").orNull == "true") dependsOn(buildRenderBundle)
    into(renderAssets)
    from(renderBundle.parentFile) {
        include(renderBundle.name)
        rename { "aa-render.html" }
        into("render")
    }
}

android {
    namespace = "dev.agentsanywhere.v3"
    compileSdk {
        // backdrop 2.0.1 and Compose 1.12 require compileSdk 37; the app targets 36.
        version = release(37)
    }

    defaultConfig {
        applicationId = "dev.agentsanywhere.v3"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "3.0.0-alpha.1"
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
        // The render bundle is a few MB and read once per WebView load: no inflating.
        noCompress += listOf("html")
    }

    packaging {
        resources.excludes += listOf("META-INF/versions/*/org/bouncycastle/**", "META-INF/{AL2.0,LGPL2.1}")
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    sourceSets.getByName("main").assets.directories.add(renderAssets.get().asFile.path)
}

tasks.named("preBuild") { dependsOn(copyRenderBundle) }

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-process:2.11.0")
    implementation("androidx.webkit:webkit:1.18.0")
    // Kyant backdrop: blurred / refracting glass over the WebView (recorded in a hardware layer); `shapes` gives the
    // continuous-curvature rounded rectangles that match SwiftUI's `.continuous` corners.
    implementation("io.github.kyant0:backdrop:2.0.1")
    implementation("io.github.kyant0:shapes:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    // Pairing QR codes: CameraX preview + ML Kit barcode scanning (bundled model, works without Play services).
    val camerax = "1.6.2"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
