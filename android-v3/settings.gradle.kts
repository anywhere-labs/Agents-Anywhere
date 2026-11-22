pluginManagement {
    repositories {
        google()
        mavenCentral()
        // Google's Maven Central mirror: repo.maven.apache.org intermittently resets TLS handshakes on some networks.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        // `./gradlew :meshcall:publishToMavenLocal` in meshcall-jvm, when no checkout is included below.
        mavenLocal()
    }
}

rootProject.name = "AAv3Android"
include(":core", ":app")

// MeshCall JVM SDK (io.github.t4wefan:meshcall, not on Maven Central yet), built from a checkout as an included build.
// Where the checkout is: MESHCALL_JVM_DIR, else `meshcall.jvm.dir` in local.properties, else a `meshcall` checkout
// next to this repository (../../meshcall/meshcall-jvm). Without one, the artifact comes from mavenLocal().
val localProperties = java.util.Properties().apply {
    val f = file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val meshcallDir = file(
    System.getenv("MESHCALL_JVM_DIR")?.takeIf { it.isNotBlank() }
        ?: localProperties.getProperty("meshcall.jvm.dir")
        ?: "../../meshcall/meshcall-jvm",
)
if (File(meshcallDir, "settings.gradle.kts").exists()) {
    includeBuild(meshcallDir)
} else {
    logger.lifecycle("MeshCall JVM checkout not found at $meshcallDir; resolving io.github.t4wefan:meshcall from mavenLocal()")
}
