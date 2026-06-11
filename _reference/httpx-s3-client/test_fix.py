#!/usr/bin/env python3
"""
Test script to verify the AsyncS3KV fix.
"""

import asyncio
from pydantic import BaseModel
from httpx_s3_client import AsyncS3KV, S3Config


class TestModel(BaseModel):
    name: str
    value: int


async def test_async_kv():
    """Test the AsyncS3KV with the fix."""
    print("Testing AsyncS3KV fix...")
    
    # Use dummy config for testing
    config = S3Config(
        access_key="test",
        secret_key="test", 
        region="us-east-1",
        endpoint_url="http://localhost:9000"  # Assuming MinIO or similar
    )
    
    try:
        async with AsyncS3KV(TestModel, "test-bucket", config) as db:
            print("✅ AsyncS3KV context manager entered successfully")
            
            # Test setting a value
            test_obj = TestModel(name="test", value=42)
            await db.set("test-key", test_obj)
            print("✅ Set operation completed successfully")
            
            # Test getting a value
            retrieved = await db.get("test-key")
            if retrieved:
                print(f"✅ Get operation completed successfully: {retrieved}")
            else:
                print("❌ Get operation failed - object not found")
                
    except Exception as e:
        print(f"❌ Error occurred: {e}")
        print(f"Error type: {type(e).__name__}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_async_kv())