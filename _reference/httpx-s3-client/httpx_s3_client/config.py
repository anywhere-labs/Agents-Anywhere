from typing import Optional
from pydantic import BaseModel, Field


from datetime import datetime
from typing import List, Literal


class LifecycleRuleFilter(BaseModel):
    prefix: str = Field(..., alias="Prefix")


class LifecycleRuleTransition(BaseModel):
    days: int = Field(..., alias="Days")
    storage_class: str = Field(..., alias="StorageClass")


class LifecycleRule(BaseModel):
    id: str = Field(..., alias="ID")
    status: Literal["Enabled", "Disabled"] = Field(..., alias="Status")
    filter: LifecycleRuleFilter = Field(..., alias="Filter")
    transition: List[LifecycleRuleTransition] = Field(..., alias="Transition")


class BucketLifecycleConfiguration(BaseModel):
    rules: List[LifecycleRule] = Field(..., alias="Rule")


class Bucket(BaseModel):
    name: str = Field(..., alias="Name")
    creation_date: datetime = Field(..., alias="CreationDate")


class ListBucketsOutput(BaseModel):
    buckets: List[Bucket] = Field(..., alias="Buckets")


class S3Object(BaseModel):
    key: str = Field(..., alias="Key")
    last_modified: datetime = Field(..., alias="LastModified")
    e_tag: str = Field(..., alias="ETag")
    size: int = Field(..., alias="Size")


class ListObjectsOutput(BaseModel):
    contents: List[S3Object] = Field([], alias="Contents")


class S3Config(BaseModel):
    """
    S3 client configuration.
    """

    access_key: str = Field(..., description="AWS access key ID.")
    secret_key: str = Field(..., description="AWS secret access key.")
    region: str = Field(default="", description="AWS region.")
    endpoint_url: Optional[str] = Field(default=None, description="S3 endpoint URL.")
    virtual_host_style: bool = Field(
        default=False, description="Use virtual host style for bucket addressing."
    )
