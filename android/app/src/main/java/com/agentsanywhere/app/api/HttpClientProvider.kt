package com.agentsanywhere.app.api

import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * One shared OkHttp stack for everything that talks to the server.
 *
 * Before this existed the app created throw-away clients in a few places (terminal
 * websocket handshake, update check, attachments), so every subsystem kept its own
 * connection pool and TLS session cache and cold connections were re-negotiated over
 * and over. A single client keeps HTTP/2 multiplexing, the connection pool and the
 * TLS sessions warm across screens.
 */
object HttpClientProvider {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .connectionPool(ConnectionPool(5, 5, TimeUnit.MINUTES))
            .retryOnConnectionFailure(true)
            .build()
    }

    /**
     * Uploads can legitimately take minutes on a slow mobile uplink, so the write
     * timeout is disabled and only the read timeout guards the response. The client
     * is separate from [client] so a stalled upload cannot occupy the shared pool.
     */
    val uploadClient: OkHttpClient by lazy {
        client.newBuilder()
            .writeTimeout(0, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()
    }
}
