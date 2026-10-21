package com.agentsanywhere.app.api

import java.time.Instant

data class PublicAnnouncement(
    val markdown: String,
    val publishedAt: String,
) {
    val publishedAtMillis: Long = announcementTimestamp(publishedAt)
}

internal fun announcementTimestamp(value: String?): Long =
    runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(0L)

class AnnouncementsApi(private val client: ApiClient = ApiClient()) {
    fun current(serverUrl: String): PublicAnnouncement? {
        val payload = client.getJson(serverUrl = serverUrl, path = "/announcement")
            .optJSONObject("announcement") ?: return null
        val announcement = PublicAnnouncement(
            markdown = payload.optString("markdown", ""),
            publishedAt = payload.optString("publishedAt", ""),
        )
        return announcement.takeIf { it.markdown.isNotBlank() && it.publishedAtMillis > 0L }
    }
}
