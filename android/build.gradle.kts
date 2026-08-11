import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

abstract class LegacyRoutesTask : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceRoot: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val baselineFile: RegularFileProperty

    @get:Input
    abstract val checkBaseline: Property<Boolean>

    @TaskAction
    fun run() {
        val findings = scanRoutes()
        if (!checkBaseline.get()) {
            report(findings)
            return
        }

        val expected = baselineFile.get().asFile.readLines()
            .map(String::trim)
            .filter { line -> line.isNotEmpty() && !line.startsWith('#') }
            .onEach { line ->
                val parts = line.split('|')
                if (parts.size != 4 || parts.last().toIntOrNull() == null) {
                    throw GradleException("Invalid legacy route baseline entry: $line")
                }
            }
            .sorted()
        val actual = signatures(findings)
        if (expected != actual) {
            val added = actual.toSet() - expected.toSet()
            val resolved = expected.toSet() - actual.toSet()
            val detail = buildString {
                appendLine("Android legacy route baseline changed.")
                if (added.isNotEmpty()) {
                    appendLine("New or increased legacy routes:")
                    added.sorted().forEach { appendLine("  + $it") }
                }
                if (resolved.isNotEmpty()) {
                    appendLine("Resolved or reduced legacy routes (remove these baseline entries):")
                    resolved.sorted().forEach { appendLine("  - $it") }
                }
                append("Run ./gradlew reportLegacyRoutes for exact source locations.")
            }
            throw GradleException(detail)
        }
        logger.lifecycle("Android legacy route baseline is unchanged (${actual.size} groups).")
    }

    private fun scanRoutes(): List<LegacyRouteFinding> {
        val root = sourceRoot.get().asFile
        val rules = rules()
        return root.walkTopDown()
            .filter { file -> file.isFile && file.extension == "kt" }
            .sortedBy { file -> file.relativeTo(root).invariantSeparatorsPath }
            .flatMap { file ->
                val relativePath = "app/src/main/java/" + file.relativeTo(root).invariantSeparatorsPath
                file.readLines().asSequence().flatMapIndexed { index, line ->
                    ROUTE_LITERAL.findAll(line).flatMap { match ->
                        val route = match.groupValues[1]
                        val withoutNamespace = when {
                            route == "/api/v2" -> "/"
                            route.startsWith("/api/v2/") -> route.removePrefix("/api/v2")
                            else -> route
                        }
                        val segments = withoutNamespace.substringBefore('?').split('/')
                        rules.asSequence()
                            .filter { rule -> rule.matches(segments) }
                            .map { rule ->
                                LegacyRouteFinding(
                                    rule = rule,
                                    relativePath = relativePath,
                                    lineNumber = index + 1,
                                    route = route,
                                )
                            }
                    }
                }
            }
            .toList()
    }

    private fun report(findings: List<LegacyRouteFinding>) {
        if (findings.isEmpty()) {
            logger.lifecycle("No legacy Android routes found.")
            return
        }
        findings.forEach { finding ->
            logger.lifecycle(
                "${finding.rule.category}|${finding.rule.id}|" +
                    "${finding.relativePath}:${finding.lineNumber}|${finding.route}",
            )
        }
    }

    private fun signatures(findings: List<LegacyRouteFinding>): List<String> {
        return findings
            .groupingBy { finding ->
                "${finding.rule.category}|${finding.rule.id}|${finding.relativePath}"
            }
            .eachCount()
            .map { (key, count) -> "$key|$count" }
            .sorted()
    }

    private fun rules(): List<LegacyRouteRule> {
        return listOf(
            LegacyRouteRule("session", "session-meta-root") { segments ->
                segments.size == 3 && segments[1] == "sessions" && segments[2].firstOrNull() == '$'
            },
            LegacyRouteRule("session", "session-bulk-archive") { segments ->
                segments == listOf("", "sessions", "bulk-archive")
            },
            LegacyRouteRule("session", "session-state") { segments ->
                segments.size == 4 &&
                    segments[1] == "sessions" &&
                    segments[2].firstOrNull() == '$' &&
                    segments[3] == "state"
            },
            LegacyRouteRule("session", "session-runtime-settings") { segments ->
                segments.getOrNull(1) == "sessions" && "runtime-settings" in segments.drop(2)
            },
            LegacyRouteRule("session", "session-messages") { segments ->
                segments.getOrNull(1) == "sessions" && "messages" in segments.drop(2)
            },
            LegacyRouteRule("session", "session-interrupt") { segments ->
                segments.getOrNull(1) == "sessions" && "interrupt" in segments.drop(2)
            },
            LegacyRouteRule("notice", "approval-resolve") { segments ->
                segments.getOrNull(1) == "approvals" && segments.lastOrNull() == "resolve"
            },
            LegacyRouteRule("runtime", "connector-runtime-capabilities") { segments ->
                segments.getOrNull(1) == "connectors" && "runtime-capabilities" in segments.drop(2)
            },
            LegacyRouteRule("runtime", "connector-agent-settings") { segments ->
                segments.getOrNull(1) == "connectors" &&
                    "agents" in segments.drop(2) &&
                    segments.lastOrNull() == "settings"
            },
            LegacyRouteRule("runtime", "root-agent-route") { segments ->
                segments.getOrNull(1) == "agents"
            },
        )
    }

    private data class LegacyRouteRule(
        val category: String,
        val id: String,
        val matches: (List<String>) -> Boolean,
    )

    private data class LegacyRouteFinding(
        val rule: LegacyRouteRule,
        val relativePath: String,
        val lineNumber: Int,
        val route: String,
    )

    companion object {
        private val ROUTE_LITERAL = Regex("\"(/[^\"]*)\"")
    }
}

val legacyRouteSourceRoot = layout.projectDirectory.dir("app/src/main/java")
val legacyRouteBaseline = layout.projectDirectory.file("config/legacy-routes-baseline.txt")

val reportLegacyRoutes by tasks.registering(LegacyRoutesTask::class) {
    group = "verification"
    description = "Reports known pre-v2 Android API route usages."
    sourceRoot.set(legacyRouteSourceRoot)
    baselineFile.set(legacyRouteBaseline)
    checkBaseline.set(false)
}

val checkLegacyRoutes by tasks.registering(LegacyRoutesTask::class) {
    group = "verification"
    description = "Prevents Android legacy API route debt from growing beyond its baseline."
    sourceRoot.set(legacyRouteSourceRoot)
    baselineFile.set(legacyRouteBaseline)
    checkBaseline.set(true)
}
