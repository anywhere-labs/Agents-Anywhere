class ContentTypes:
    # Text
    TEXT = "text/plain"
    HTML = "text/html"
    CSS = "text/css"
    JAVASCRIPT = "application/javascript"
    JSON = "application/json"
    XML = "application/xml"

    # Images
    JPEG = "image/jpeg"
    PNG = "image/png"
    GIF = "image/gif"
    SVG = "image/svg+xml"
    WEBP = "image/webp"

    # Documents
    PDF = "application/pdf"
    DOC = "application/msword"
    DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    XLS = "application/vnd.ms-excel"
    XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    PPT = "application/vnd.ms-powerpoint"
    PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

    # Audio/Video
    MP3 = "audio/mpeg"
    MP4 = "video/mp4"
    WEBM = "video/webm"

    # Archives
    ZIP = "application/zip"
    GZIP = "application/gzip"

    # Binary
    BINARY = "application/octet-stream"


COMMON_CONTENT_TYPES = {
    # Text
    ".txt": ContentTypes.TEXT,
    ".html": ContentTypes.HTML,
    ".css": ContentTypes.CSS,
    ".js": ContentTypes.JAVASCRIPT,
    ".json": ContentTypes.JSON,
    ".xml": ContentTypes.XML,

    # Images
    ".jpg": ContentTypes.JPEG,
    ".jpeg": ContentTypes.JPEG,
    ".png": ContentTypes.PNG,
    ".gif": ContentTypes.GIF,
    ".svg": ContentTypes.SVG,
    ".webp": ContentTypes.WEBP,

    # Documents
    ".pdf": ContentTypes.PDF,
    ".doc": ContentTypes.DOC,
    ".docx": ContentTypes.DOCX,
    ".xls": ContentTypes.XLS,
    ".xlsx": ContentTypes.XLSX,
    ".ppt": ContentTypes.PPT,
    ".pptx": ContentTypes.PPTX,

    # Audio/Video
    ".mp3": ContentTypes.MP3,
    ".mp4": ContentTypes.MP4,
    ".webm": ContentTypes.WEBM,

    # Archives
    ".zip": ContentTypes.ZIP,
    ".gz": ContentTypes.GZIP,

    # Binary
    ".bin": ContentTypes.BINARY,
}