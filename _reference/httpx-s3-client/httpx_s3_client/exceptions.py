class S3ClientError(Exception):
    """Base exception for s3 client."""


class S3AuthError(S3ClientError):
    """Raised when authentication fails."""


class S3ObjectNotFoundError(S3ClientError):
    """Raised when an object is not found."""


class S3BucketNotFoundError(S3ClientError):
    """Raised when an bucket is not found."""
