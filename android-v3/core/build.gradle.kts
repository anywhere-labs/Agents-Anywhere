import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    api("io.github.t4wefan:meshcall:0.4.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    api("com.squareup.okhttp3:okhttp:5.5.1")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver3:5.5.1")
}

tasks.test {
    useJUnitPlatform()
    // Shared cross-client fixtures (contracts/aa-v3/1.0/fixtures).
    systemProperty("aa.contracts", rootDir.resolve("../contracts/aa-v3/1.0").absolutePath)
    // LiveStackTest runs only when AA_V3_CONTROL_URL points at a running stack.
    listOf("AA_V3_CONTROL_URL", "AA_V3_EMAIL", "AA_V3_PASSWORD", "AA_V3_AGENT").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
    testLogging {
        events("failed", "skipped")
        showStandardStreams = System.getenv("AA_V3_CONTROL_URL") != null
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
