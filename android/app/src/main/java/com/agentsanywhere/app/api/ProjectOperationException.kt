package com.agentsanywhere.app.api

import androidx.annotation.StringRes

/** A project operation message resolved by the presentation layer in its current locale. */
class ProjectOperationException(@param:StringRes val messageRes: Int, val detail: String? = null) : IllegalStateException(detail)
