"""Run the production workflow coordinator on the JVM with controlled API/storage ports.
Requires Android's Kotlin/JSON/coroutines dependencies already in the Gradle cache.
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path

repository = Path(__file__).resolve().parents[2]
cache = Path.home() / ".gradle/caches/modules-2/files-2.1"
kotlin = re.search(
    r'^kotlin = "([^"]+)"',
    (repository / "android/gradle/libs.versions.toml").read_text(),
    re.MULTILINE,
).group(1)


def jar(group, artifact, version=None):
    root = cache / group / artifact
    paths = sorted((root / version if version else root).rglob("*.jar"))
    return str(
        next(p for p in paths if not any(x in p.name for x in ["-sources", "-javadoc"]))
    )


stdlib = jar("org.jetbrains.kotlin", "kotlin-stdlib", kotlin)
coroutines = jar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0")
annotations = jar("org.jetbrains", "annotations", "13.0")
compiler = [
    jar("org.jetbrains.kotlin", "kotlin-compiler-embeddable", kotlin),
    stdlib,
    coroutines,
    annotations,
    jar("org.jetbrains.kotlin", "kotlin-script-runtime", kotlin),
    jar("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    jar("org.jetbrains.intellij.deps", "trove4j"),
]
libs = [stdlib, coroutines, annotations, jar("org.json", "json", "20240303")]
SOURCES = {
    "Api.kt": '''package com.agentsanywhere.app.api
import org.json.JSONObject
class RuntimeWorkflowApi { var reads=0
fun post(server:String,token:String,path:String,body:JSONObject)=JSONObject("""{"id":"create","kind":"creation","sessionId":"session","state":{"phase":"accepted","messageAccepted":true}}""")
fun get(server:String,token:String,kind:String,id:String):JSONObject {reads++;return post(server,token,kind,JSONObject())}
}''',
    "Auth.kt": """package com.agentsanywhere.app.feature.auth
interface AuthSessionReader {fun readServerUrl():String;fun readUserId():String;fun readAccessToken():String}""",
    "Storage.kt": """package com.agentsanywhere.app.feature.sessions
class RuntimeWorkflowReferenceStore {
private val ids=mutableMapOf<String,MutableSet<String>>()
fun read(server:String,user:String)=ids[user]?.toSet().orEmpty()
fun remember(server:String,user:String,id:String,remove:Boolean=false){val values=ids.getOrPut(user){mutableSetOf()};if(remove)values.remove(id)else values.add(id)}
}
class NewSessionModelCatalog""",
    "Main.kt": """import com.agentsanywhere.app.api.RuntimeWorkflowApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.*
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.*
import org.json.JSONObject
fun main()=runBlocking {
    val api=RuntimeWorkflowApi();val refs=RuntimeWorkflowReferenceStore()
    val auth=object:AuthSessionReader {
        var user="user"
        override fun readServerUrl()="http://fixture"
        override fun readUserId()=user
        override fun readAccessToken()="fixture"
    }
    val coordinator=RuntimeWorkflowCoordinator(api,auth,refs)
    suspend fun create()=coordinator.run("creations",JSONObject().put("createOperationId","create")){it.optBoolean("messageAccepted")}
    create()
    check(refs.read("http://fixture","user").contains("create"))
    try { coordinator.bindAcceptedCreation {_,_,_->throw java.io.IOException("controlled metadata failure")};error("failure lost") }
    catch(_:java.io.IOException){}
    check(refs.read("http://fixture","user").contains("create"))
    check(coordinator.operation.value?.getJSONObject("state")?.getBoolean("messageAccepted")==true)
    coordinator.clear();coordinator.restore();coordinator.refresh()
    check(api.reads==2);check(refs.read("http://fixture","user").contains("create"))
    try {coordinator.bindAcceptedCreation {_,_,_->AgentSession("wrong")};error("wrong binding accepted")}
    catch(_:IllegalStateException){}
    check(refs.read("http://fixture","user").contains("create"))
    check(coordinator.bindAcceptedCreation {_,_,_->AgentSession("session")}.id=="session")
    check(refs.read("http://fixture","user").isEmpty());check(coordinator.operation.value==null)
    create()
    val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
    val old=async {runCatching {coordinator.bindAcceptedCreation {_,_,_->entered.complete(Unit);release.await();AgentSession("session")}}}
    entered.await();auth.user="next";coordinator.clear();create();release.complete(Unit)
    check(old.await().isFailure)
    check(refs.read("http://fixture","user").contains("create"))
    check(refs.read("http://fixture","next").contains("create"))
    check(coordinator.operation.value?.getString("id")=="create")
    println("Actual Android Coordinator: metadata failure/restore/identity mismatch retain references; successful binding clears them; old-account completion is fenced: passed")
}""",
    "Session.kt": """package com.agentsanywhere.app.model
data class AgentSession(val id:String)""",
}

with tempfile.TemporaryDirectory(prefix="aa-pi-android-binding-") as directory:
    root = Path(directory)
    files = []
    for name, source in SOURCES.items():
        path = root / name
        path.write_text(source)
        files.append(str(path))
    production = (
        repository
        / "android/app/src/main/java/com/agentsanywhere/app/feature/sessions/RuntimeWorkflowCoordinator.kt"
    )
    output = root / "probe.jar"
    compiled = subprocess.run(
        [
            "java",
            "-cp",
            os.pathsep.join(compiler),
            "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
            "-no-stdlib",
            "-no-reflect",
            "-jvm-target",
            "17",
            "-classpath",
            os.pathsep.join(libs),
            *files,
            str(production),
            "-d",
            str(output),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if compiled.returncode:
        raise RuntimeError(compiled.stderr)
    subprocess.run(
        ["java", "-cp", os.pathsep.join([str(output), *libs]), "MainKt"], check=True
    )
