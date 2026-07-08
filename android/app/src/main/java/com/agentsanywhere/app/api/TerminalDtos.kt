package com.agentsanywhere.app.api

data class RemoteTerminal(
    val terminalId: String,
    val sessionId: String,
    val label: String,
    val cwd: String,
    val cols: Int,
    val rows: Int,
    val purpose: String,
    val pid: Int?,
    val status: String,
    val exitCode: Int?,
    val scrollbackBytes: Long,
    val scrollbackSeq: Int,
)
