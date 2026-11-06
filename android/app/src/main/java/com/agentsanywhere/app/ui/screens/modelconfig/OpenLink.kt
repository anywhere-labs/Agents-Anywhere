package com.agentsanywhere.app.ui.screens.modelconfig

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Opens the Tokens Anywhere link page. The link finishes in the browser; the app
 * learns the result from the next dashboard snapshot.
 */
internal fun openTokensLinkStart(context: Context, startUrl: String): Boolean = openExternalLink(context, startUrl)

/** Opens an http(s) page in a Custom Tab, or any browser; false when nothing can open it. */
internal fun openExternalLink(context: Context, url: String): Boolean {
    val uri = Uri.parse(url)
    if (uri.scheme != "https" && uri.scheme != "http") return false
    return try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
        true
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }
}
