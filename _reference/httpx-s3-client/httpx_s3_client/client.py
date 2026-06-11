from contextlib import contextmanager
import httpx

import xmltodict

from datetime import datetime
from typing import BinaryIO
import xmltodict
import mimetypes
import os
from .utils import COMMON_CONTENT_TYPES

from ._base import BaseS3Client
from .config import (
    S3Config,
    BucketLifecycleConfiguration,
    ListBucketsOutput,
    ListObjectsOutput,
    Bucket,
    S3Object,
)
from .exceptions import (
    S3ClientError,
    S3AuthError,
    S3ObjectNotFoundError,
    S3BucketNotFoundError,
)

from typing import Protocol, runtime_checkable


class S3Client(BaseS3Client[httpx.Client]):
    """
    Synchronous S3 client.
    """

    def __init__(self, config: S3Config):
        super().__init__(config, http_client=httpx.Client())

    def close(self):
        self.http_client.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    @staticmethod
    @contextmanager
    def _handle_errors():
        try:
            yield
        except httpx.HTTPStatusError as e:
            status_code = e.response.status_code
            if status_code in (403, 401):
                raise S3AuthError(f"Authentication failed: {e.response.text}") from e
            if status_code == 404:
                raise S3ObjectNotFoundError("Object not found.") from e
            raise S3ClientError(f"S3 operation failed: {e.response.text}") from e

    def put_object(
        self, bucket: str, key: str, data: bytes, content_type: str | None = None
    ) -> bool:
        """
        Upload an object to an S3 bucket from bytes.
        """
        url = self._build_url(bucket, key)
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type

        with self._handle_errors():
            response = self.http_client.put(url, content=data, headers=headers)
            response.raise_for_status()
        return True

    def get_object(self, bucket: str, key: str) -> bytes:
        """
        Retrieve an object from an S3 bucket.
        """
        url = self._build_url(bucket, key)
        with self._handle_errors():
            response = self.http_client.get(url)
            response.raise_for_status()
            return response.content

    def delete_object(self, bucket: str, key: str) -> bool:
        """
        Delete an object from an S3 bucket.
        Returns True if the object was deleted successfully.
        """
        url = self._build_url(bucket, key)
        with self._handle_errors():
            response = self.http_client.delete(url)
            response.raise_for_status()
        return True

    def put_bucket_lifecycle_configuration(
        self, bucket: str, lifecycle_config: "BucketLifecycleConfiguration"
    ) -> None:
        """
        Set the lifecycle configuration for a bucket.
        """
        url = self._build_url(bucket) + "?lifecycle"
        # Pydantic's model_dump_json will serialize the model to a JSON string.
        data = lifecycle_config.model_dump_json(by_alias=True)
        with self._handle_errors():
            response = self.http_client.put(url, content=data)
            response.raise_for_status()

    def get_bucket_lifecycle_configuration(
        self, bucket: str
    ) -> "BucketLifecycleConfiguration":
        """
        Get the lifecycle configuration for a bucket.
        """
        url = self._build_url(bucket) + "?lifecycle"
        with self._handle_errors():
            response = self.http_client.get(url)
            response.raise_for_status()
            return BucketLifecycleConfiguration.model_validate_json(response.content)

    def create_bucket(self, bucket: str, strict: bool = True) -> bool:
        """
        Create a new bucket.
        If strict is True, raises an error if the bucket already exists.
        If strict is False, does nothing if the bucket already exists.
        Returns True if the bucket was created successfully.
        """
        if not strict and self.head_bucket(bucket):
            return False

        url = self._build_url(bucket)
        with self._handle_errors():
            response = self.http_client.put(url)
            response.raise_for_status()
        return True

    def delete_bucket(self, bucket: str) -> bool:
        """
        Delete a bucket.
        Returns True if the bucket was deleted successfully.
        """
        url = self._build_url(bucket)
        with self._handle_errors():
            response = self.http_client.delete(url)
            response.raise_for_status()
        return True

    def list_buckets(self) -> list[Bucket]:
        """
        List all buckets.
        """
        url = self.base_url
        with self._handle_errors():
            response = self.http_client.get(url)
            response.raise_for_status()
            data = xmltodict.parse(response.content)
            result = data.get("ListAllMyBucketsResult", {})
            buckets_data = result.get("Buckets", {}).get("Bucket", [])
            if not isinstance(buckets_data, list):
                buckets_data = [buckets_data]
            res = ListBucketsOutput(Buckets=buckets_data)
            return res.buckets

    def head_bucket(self, bucket: str) -> bool:
        """
        Check if a bucket exists.
        Returns True if the bucket exists, otherwise returns False.
        """
        url = self._build_url(bucket)
        try:
            with self._handle_errors():
                response = self.http_client.head(url)
                response.raise_for_status()
                return True
        except S3ObjectNotFoundError:
            # For buckets, a 404 should be treated as "not found", not an error to be raised.
            return False

    def list_objects(self, bucket: str, prefix: str = "") -> list[S3Object]:
        """
        List objects in a bucket.
        """
        url = self._build_url(bucket)
        params = {"list-type": "2", "prefix": prefix}
        with self._handle_errors():
            response = self.http_client.get(url, params=params)
            response.raise_for_status()
            data = xmltodict.parse(response.content)
            result = data.get("ListBucketResult", {})
            contents = result.get("Contents", [])
            if not isinstance(contents, list):
                contents = [contents]
            res = ListObjectsOutput(Contents=contents)
            return res.contents

    @runtime_checkable
    class _Readable(Protocol):
        # 定义一个read方法，接收任意数量和类型的参数，返回bytes类型
        def read(self, *args, **kwargs) -> bytes: ...

    def upload_readable(
        self, bucket: str, key: str, data: _Readable, content_type: str | None = None
    ) -> bool:
        """
        Upload an object to an S3 bucket from a file-like object.
        Returns True if the object was uploaded successfully.
        """
        self.put_object(bucket, key, data.read(), content_type=content_type)
        return True

    def upload_file(
        self, bucket: str, key: str, file_path: str, content_type: str | None = None
    ) -> bool:
        """
        Upload a file to an S3 bucket.
        Returns True if the file was uploaded successfully.
        """
        if not content_type:
            _, ext = os.path.splitext(file_path)
            content_type = COMMON_CONTENT_TYPES.get(ext.lower())
            if not content_type:
                content_type, _ = mimetypes.guess_type(file_path)

        with open(file_path, "rb") as f:
            self.upload_readable(bucket, key, f, content_type=content_type)
        return True

    def download_file(self, bucket: str, key: str, file_path: str) -> bool:
        """
        Download an object from an S3 bucket to a file.
        Returns True if the file was downloaded successfully.
        """
        data = self.get_object(bucket, key)
        with open(file_path, "wb") as f:
            f.write(data)
        return True

    def head_object(self, bucket: str, key: str) -> S3Object:
        """
        Check if an object exists and get its metadata.
        Returns an S3Object object if the object exists, otherwise raises S3ObjectNotFoundError.
        """
        url = self._build_url(bucket, key)
        with self._handle_errors():
            response = self.http_client.head(url)
            response.raise_for_status()

            last_modified_str = response.headers["Last-Modified"]
            # Parse date string like 'Wed, 21 Oct 2015 07:28:00 GMT'
            last_modified = datetime.strptime(
                last_modified_str, "%a, %d %b %Y %H:%M:%S %Z"
            )

            return S3Object(
                Key=key,
                LastModified=last_modified,
                ETag=response.headers["ETag"].strip('"'),
                Size=int(response.headers["Content-Length"]),
            )

    def copy_object(
        self,
        source_bucket: str,
        source_key: str,
        dest_bucket: str,
        dest_key: str,
    ) -> bool:
        """
        Copy an object from a source to a destination.
        Returns True if the object was copied successfully.
        """
        url = self._build_url(dest_bucket, dest_key)
        copy_source = f"/{source_bucket}/{source_key}"
        headers = {"x-amz-copy-source": copy_source}
        with self._handle_errors():
            response = self.http_client.put(url, headers=headers)
            response.raise_for_status()
        return True
    def build_unassigned_url(self, bucket: str, key: str | None = None) -> str:
        """
        Build the unassigned URL for an S3 object.
        """
        return self._build_url(bucket, key)
