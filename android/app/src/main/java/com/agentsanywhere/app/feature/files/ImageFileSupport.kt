package com.agentsanywhere.app.feature.files

const val MAX_WORKSPACE_IMAGES_PER_MESSAGE = 3

private val imageFileExtensions = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif")

fun isImageFileName(name: String): Boolean =
    name.substringAfterLast('.', "").lowercase() in imageFileExtensions

fun isImageFilePath(path: String): Boolean =
    isImageFileName(path.substringAfterLast('/').substringAfterLast('\\'))

/** Inline timeline thumbnails stay well below the file browser's download limit. */
const val MAX_INLINE_WORKSPACE_IMAGE_BYTES = 16L * 1024 * 1024
