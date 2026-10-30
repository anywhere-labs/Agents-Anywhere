package com.agentsanywhere.app.feature.files

const val MAX_WORKSPACE_IMAGES_PER_MESSAGE = 3

private val imageFileExtensions = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif")

fun isImageFileName(name: String): Boolean =
    name.substringAfterLast('.', "").lowercase() in imageFileExtensions

fun isImageFilePath(path: String): Boolean =
    isImageFileName(path.substringAfterLast('/').substringAfterLast('\\'))
