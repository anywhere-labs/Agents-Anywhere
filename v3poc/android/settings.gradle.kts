pluginManagement {
    repositories {
        google()
        mavenCentral()
        // Google's Maven Central mirror: repo.maven.apache.org intermittently resets TLS handshakes here.
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
    }
}

rootProject.name = "AAv3PoC"
include(":app")
includeBuild("../../vendor/meshcall/sdk/meshcall-jvm")
