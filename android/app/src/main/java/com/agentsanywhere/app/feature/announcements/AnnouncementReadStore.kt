package com.agentsanywhere.app.feature.announcements

import android.content.Context
import com.agentsanywhere.app.api.PublicAnnouncement
import com.agentsanywhere.app.api.announcementTimestamp

internal class AnnouncementReadStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "announcement-read",
        Context.MODE_PRIVATE,
    )

    fun isUnread(serverUrl: String, announcement: PublicAnnouncement): Boolean =
        announcement.markdown.isNotBlank() && announcement.publishedAtMillis > readTimestamp(serverUrl)

    fun markRead(serverUrl: String, announcement: PublicAnnouncement) {
        if (!isUnread(serverUrl, announcement)) return
        preferences.edit().putString(serverUrl, announcement.publishedAt).apply()
    }

    private fun readTimestamp(serverUrl: String): Long =
        announcementTimestamp(preferences.getString(serverUrl, null))
}
