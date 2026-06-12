from contextlib import contextmanager
from typing import TypeVar, Generic, Generator
from urllib.parse import urljoin

import httpx

from .config import S3Config
from .exceptions import S3ClientError, S3AuthError, S3ObjectNotFoundError
from .signing import AWSSigV4Auth

ClientType = TypeVar("ClientType", bound=httpx.Client | httpx.AsyncClient)


class BaseS3Client(Generic[ClientType]):
    """
    Base class for S3 clients.
    """

    def __init__(self, config: S3Config, http_client: ClientType):
        self.config = config
        self.http_client: ClientType = http_client
        self.http_client.auth = AWSSigV4Auth(config)

        if config.endpoint_url:
            self.base_url = config.endpoint_url
        elif self.config.region:
            self.base_url = f"https://s3.{self.config.region}.amazonaws.com"
        else:
            self.base_url = "https://s3.amazonaws.com"

    def _build_url(self, bucket: str, key: str | None = None) -> str:
        """
        Build the full URL for an S3 object.
        """
        if self.config.virtual_host_style:
            host = f"{bucket}.{self.base_url.split('://', 1)[-1]}"
            url = f"{self.base_url.split('://', 1)[0]}://{host}"
            return urljoin(url, key or "")

        path = f"/{bucket}/"
        if key:
            path = f"/{bucket}/{key.lstrip('/')}"
        return urljoin(self.base_url, path.lstrip("/"))

    def build_unassigned_url(self, bucket: str, key: str | None = None) -> str:
        """
        Build the unassigned URL for an S3 object.
        """
        return self._build_url(bucket, key)


    def generate_presigned_url(
        self, http_method: str, bucket: str, key: str, expires_in: int = 3600
    ) -> str:
        """
        Generate a presigned URL for an S3 object.
        """
        url_str = self._build_url(bucket, key)
        url = httpx.URL(url_str)

        # The auth object is an AWSSigV4Auth instance.
        auth_signer: AWSSigV4Auth = self.http_client.auth  # type: ignore
        return auth_signer.sign_presigned_url(
            http_method=http_method,
            url=url,
            expires_in=expires_in,
        )
