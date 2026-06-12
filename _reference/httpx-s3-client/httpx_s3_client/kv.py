"""
S3 Key-Value Store with Pydantic integration.

This module provides a key-value store interface that uses S3 as the backend
storage and integrates with Pydantic models for data validation and serialization.
"""

from typing import TypeVar, Generic, Type, Optional, Any, Dict, List
from pydantic import BaseModel, ValidationError
import json

from .client import S3Client
from .aclient import AsyncS3Client
from .config import S3Config
from .exceptions import S3ClientError, S3ObjectNotFoundError

# Type variable for Pydantic models
ModelType = TypeVar("ModelType", bound=BaseModel)


class S3KV(Generic[ModelType]):
    """
    A key-value store that uses S3 as the backend and integrates with Pydantic models.
    
    This class provides a simple interface for storing and retrieving Pydantic models
    in S3, with automatic validation and serialization.
    
    Args:
        model: The Pydantic model class to use for data validation and serialization.
        bucket: The S3 bucket name to use for storage.
        config: S3 configuration for authentication and endpoint.
        key_prefix: Optional prefix to prepend to all keys.
        create_bucket: Whether to create the bucket if it doesn't exist. Defaults to True.
    
    Example:
        >>> from pydantic import BaseModel
        >>> from httpx_s3_client import S3KV, S3Config
        >>>
        >>> class User(BaseModel):
        ...     name: str
        ...     email: str
        ...     logins: int = 0
        >>>
        >>> config = S3Config(
        ...     access_key="your-access-key",
        ...     secret_key="your-secret-key",
        ...     region="us-east-1"
        ... )
        >>>
        >>> # Create a key-value store for User models
        >>> db = S3KV(User, "my-users-bucket", config)
        >>>
        >>> # Store a user
        >>> user = User(name="Alice", email="alice@example.com")
        >>> db.set("user:alice", user)
        >>>
        >>> # Retrieve the user
        >>> retrieved_user = db.get("user:alice")
        >>> print(retrieved_user.name)  # "Alice"
        >>>
        >>> # Try to store invalid data
        >>> try:
        ...     db.set("user:invalid", {"name": "Bob"})  # Missing email
        ... except ValidationError as e:
        ...     print("Validation failed!")
    """
    
    def __init__(
        self,
        model: Type[ModelType],
        bucket: str,
        config: S3Config,
        key_prefix: str = "",
        key_suffix: str = ".json",
        create_bucket: bool = True
    ) -> None:
        """
        Initialize the S3 key-value store.
        
        Args:
            model: The Pydantic model class for data validation.
            bucket: S3 bucket name for storage.
            config: S3 configuration.
            key_prefix: Prefix for all keys (e.g., "app/").
            create_bucket: Create bucket if it doesn't exist.
        """
        self.model = model
        self.bucket = bucket
        self.key_prefix = key_prefix
        self.key_suffix = key_suffix
        self._client = S3Client(config)
        
        # Create bucket if needed and requested
        if create_bucket:
            with self._client:
                if not self._client.head_bucket(bucket):
                    self._client.create_bucket(bucket, strict=False)
    
    def _get_full_key(self, key: str) -> str:
        """Get the full key with prefix."""
        return f"{self.key_prefix}{key}{self.key_suffix}"
    
    def set(self, key: str, value: ModelType | Dict[str, Any]) -> None:
        """
        Store a value in S3.
        
        Args:
            key: The key to store the value under.
            value: Either a Pydantic model instance or a dictionary that can be
                   validated against the model.
        
        Raises:
            ValidationError: If the value doesn't conform to the model schema.
            S3ClientError: If there's an error communicating with S3.
        """
        # Validate and convert to model instance
        if isinstance(value, dict):
            model_instance = self.model(**value)
        elif isinstance(value, self.model):
            model_instance = value
        else:
            raise TypeError(f"Value must be a dict or {self.model.__name__} instance")
        
        # Serialize to JSON
        json_data = model_instance.model_dump_json()
        
        # Store in S3
        full_key = self._get_full_key(key)
        with self._client:
            self._client.put_object(
                bucket=self.bucket,
                key=full_key,
                data=json_data.encode('utf-8'),
                content_type="application/json"
            )
    
    def get(self, key: str) -> Optional[ModelType]:
        """
        Retrieve a value from S3.
        
        Args:
            key: The key to retrieve.
        
        Returns:
            The deserialized model instance, or None if the key doesn't exist.
        
        Raises:
            ValidationError: If the stored data doesn't conform to the model schema.
            S3ClientError: If there's an error communicating with S3.
        """
        full_key = self._get_full_key(key)
        
        with self._client:
            try:
                data = self._client.get_object(self.bucket, full_key)
                json_str = data.decode('utf-8')
                return self.model.model_validate_json(json_str)
            except S3ObjectNotFoundError:
                return None
    
    def delete(self, key: str) -> bool:
        """
        Delete a value from S3.
        
        Args:
            key: The key to delete.
        
        Returns:
            True if the key was deleted, False if it didn't exist.
        """
        full_key = self._get_full_key(key)
        
        with self._client:
            try:
                self._client.delete_object(self.bucket, full_key)
                return True
            except S3ObjectNotFoundError:
                return False
    
    def exists(self, key: str) -> bool:
        """
        Check if a key exists in S3.
        
        Args:
            key: The key to check.
        
        Returns:
            True if the key exists, False otherwise.
        """
        full_key = self._get_full_key(key)
        
        with self._client:
            try:
                self._client.head_object(self.bucket, full_key)
                return True
            except S3ObjectNotFoundError:
                return False
    
    def keys(self, prefix: str = "") -> List[str]:
        """
        List all keys in the store, optionally filtered by prefix.
        
        Args:
            prefix: Optional prefix to filter keys.
        
        Returns:
            List of keys (without the configured key_prefix and key_suffix).
        """
        full_prefix = self.key_prefix
        
        with self._client:
            objects = self._client.list_objects(self.bucket, prefix=full_prefix)
            
            # Remove the key prefix and suffix from the returned keys
            keys = []
            for obj in objects:
                key = obj.key
                if self.key_prefix and key.startswith(self.key_prefix):
                    key = key[len(self.key_prefix):]
                if self.key_suffix and key.endswith(self.key_suffix):
                    key = key[:-len(self.key_suffix)]
                keys.append(key)
            
            return keys
    
    def close(self) -> None:
        """Close the underlying S3 client."""
        self._client.close()
    
    def __enter__(self) -> "S3KV[ModelType]":
        """Context manager entry."""
        return self
    
    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Context manager exit."""
        self.close()


class AsyncS3KV(Generic[ModelType]):
    """
    Asynchronous version of S3KV.
    
    This class provides the same interface as S3KV but with async methods.
    
    Example:
        >>> import asyncio
        >>> from pydantic import BaseModel
        >>> from httpx_s3_client import AsyncS3KV, S3Config
        >>>
        >>> class User(BaseModel):
        ...     name: str
        ...     email: str
        ...     logins: int = 0
        >>>
        >>> async def main():
        ...     config = S3Config(...)
        ...     db = AsyncS3KV(User, "my-bucket", config)
        ...     user = User(name="Alice", email="alice@example.com")
        ...     await db.set("user:alice", user)
        ...     retrieved = await db.get("user:alice")
        ...     print(retrieved.name)
        ...     await db.close()
        >>>
        >>> asyncio.run(main())
    """
    
    def __init__(
        self,
        model: Type[ModelType],
        bucket: str,
        config: S3Config,
        key_prefix: str = "",
        key_suffix: str = ".json",
        create_bucket: bool = True
    ) -> None:
        """
        Initialize the async S3 key-value store.
        
        Args:
            model: The Pydantic model class for data validation.
            bucket: S3 bucket name for storage.
            config: S3 configuration.
            key_prefix: Prefix for all keys.
            create_bucket: Create bucket if it doesn't exist.
        """
        self.model = model
        self.bucket = bucket
        self.key_prefix = key_prefix
        self.key_suffix = key_suffix
        self._client = AsyncS3Client(config)
        self._create_bucket = create_bucket
    
    async def _ensure_bucket_exists(self) -> None:
        """Ensure the bucket exists, creating it if needed."""
        if self._create_bucket:
            if not await self._client.head_bucket(self.bucket):
                await self._client.create_bucket(self.bucket, strict=False)
    
    def _get_full_key(self, key: str) -> str:
        """Get the full key with prefix."""
        return f"{self.key_prefix}{key}{self.key_suffix}"
    
    async def set(self, key: str, value: ModelType | Dict[str, Any]) -> None:
        """
        Store a value in S3 asynchronously.
        
        Args:
            key: The key to store the value under.
            value: Either a Pydantic model instance or a dictionary.
        
        Raises:
            ValidationError: If the value doesn't conform to the model schema.
            S3ClientError: If there's an error communicating with S3.
        """
        # Validate and convert to model instance
        if isinstance(value, dict):
            model_instance = self.model(**value)
        elif isinstance(value, self.model):
            model_instance = value
        else:
            raise TypeError(f"Value must be a dict or {self.model.__name__} instance")
        
        # Serialize to JSON
        json_data = model_instance.model_dump_json()
        
        # Store in S3
        full_key = self._get_full_key(key)
        await self._ensure_bucket_exists()
        await self._client.put_object(
            bucket=self.bucket,
            key=full_key,
            data=json_data.encode('utf-8'),
            content_type="application/json"
        )
    
    async def get(self, key: str) -> Optional[ModelType]:
        """
        Retrieve a value from S3 asynchronously.
        
        Args:
            key: The key to retrieve.
        
        Returns:
            The deserialized model instance, or None if the key doesn't exist.
        """
        full_key = self._get_full_key(key)
        
        await self._ensure_bucket_exists()
        try:
            data = await self._client.get_object(self.bucket, full_key)
            json_str = data.decode('utf-8')
            return self.model.model_validate_json(json_str)
        except S3ObjectNotFoundError:
            return None
    
    async def delete(self, key: str) -> bool:
        """
        Delete a value from S3 asynchronously.
        
        Args:
            key: The key to delete.
        
        Returns:
            True if the key was deleted, False if it didn't exist.
        """
        full_key = self._get_full_key(key)
        
        await self._ensure_bucket_exists()
        try:
            await self._client.delete_object(self.bucket, full_key)
            return True
        except S3ObjectNotFoundError:
            return False
    
    async def exists(self, key: str) -> bool:
        """
        Check if a key exists in S3 asynchronously.
        
        Args:
            key: The key to check.
        
        Returns:
            True if the key exists, False otherwise.
        """
        full_key = self._get_full_key(key)
        
        await self._ensure_bucket_exists()
        try:
            await self._client.head_object(self.bucket, full_key)
            return True
        except S3ObjectNotFoundError:
            return False
    
    async def keys(self, prefix: str = "") -> List[str]:
        """
        List all keys in the store asynchronously.
        
        Args:
            prefix: Optional prefix to filter keys.
        
        Returns:
            List of keys (without the configured key_prefix and key_suffix).
        """
        full_prefix = self.key_prefix
        
        await self._ensure_bucket_exists()
        objects = await self._client.list_objects(self.bucket, prefix=full_prefix)
        
        # Remove the key prefix and suffix from the returned keys
        keys = []
        for obj in objects:
            key = obj.key
            if self.key_prefix and key.startswith(self.key_prefix):
                key = key[len(self.key_prefix):]
            if self.key_suffix and key.endswith(self.key_suffix):
                key = key[:-len(self.key_suffix)]
            keys.append(key)
        
        return keys
    
    async def close(self) -> None:
        """Close the underlying async S3 client."""
        await self._client.close()