#!/usr/bin/env python3
"""
Simple test to verify the AsyncS3KV fix.
"""

import asyncio
from pydantic import BaseModel
from httpx_s3_client import AsyncS3KV, S3Config


class TestModel(BaseModel):
    name: str
    value: int


async def test_simple():
    """Simple test without actual S3 connection."""
    print("Testing AsyncS3KV initialization...")
    
    # Use dummy config
    config = S3Config(
        access_key="test",
        secret_key="test", 
        region="us-east-1",
    )
    
    try:
        # Just test initialization without context manager
        db = AsyncS3KV(TestModel, "test-bucket", config)
        print("✅ AsyncS3KV initialized successfully")
        
        # Test that we can call methods without the client being closed
        print("Testing _ensure_bucket_exists...")
        await db._ensure_bucket_exists()
        print("✅ _ensure_bucket_exists completed without error")
        
        # Close the client
        await db.close()
        print("✅ Client closed successfully")
        
    except Exception as e:
        print(f"❌ Error occurred: {e}")
        print(f"Error type: {type(e).__name__}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_simple())