#!/usr/bin/env python3
"""
Example usage of S3KV and AsyncS3KV with Pydantic models.

This example demonstrates how to use the S3 key-value store with automatic
data validation and serialization using Pydantic models.
"""

import asyncio
from pydantic import BaseModel, ValidationError, Field
from typing import List, Optional
from datetime import datetime

# Import from our package
from httpx_s3_client import S3KV, AsyncS3KV, S3Config


class User(BaseModel):
    """Example User model for demonstration."""
    
    name: str = Field(..., description="User's full name")
    email: str = Field(..., description="User's email address")
    age: Optional[int] = Field(default=None, description="User's age")
    is_active: bool = Field(default=True, description="Whether the user is active")
    created_at: datetime = Field(default_factory=datetime.now)
    tags: List[str] = Field(default_factory=list)


class Product(BaseModel):
    """Example Product model for demonstration."""
    
    name: str = Field(..., description="Product name")
    price: float = Field(..., ge=0, description="Product price (must be non-negative)")
    description: str = Field(default="", description="Product description")
    categories: List[str] = Field(default_factory=list)
    in_stock: bool = Field(default=True, description="Whether the product is in stock")


def sync_example():
    """Demonstrate synchronous S3KV usage."""
    print("=== Synchronous S3KV Example ===")
    
    # Configure S3 (replace with your actual credentials)
    config = S3Config(
        access_key="your-access-key",
        secret_key="your-secret-key", 
        region="us-east-1",
        # For MinIO or other S3-compatible services:
        # endpoint_url="http://localhost:9000"
    )
    
    # Create a key-value store for User models
    with S3KV(User, "example-users-bucket", config) as db:
        # Create and store a user
        user_alice = User(
            name="Alice Smith",
            email="alice@example.com",
            age=30,
            tags=["premium", "early-adopter"]
        )
        db.set("user:alice", user_alice)
        print(f"✅ Stored user: {user_alice.name}")
        
        # Retrieve the user
        retrieved_user = db.get("user:alice")
        if retrieved_user:
            print(f"✅ Retrieved user: {retrieved_user.name}")
            print(f"   Email: {retrieved_user.email}")
            print(f"   Age: {retrieved_user.age}")
            print(f"   Tags: {retrieved_user.tags}")
            print(f"   Created: {retrieved_user.created_at}")
            print(f"   JSON: {retrieved_user.model_dump_json(indent=2)}")
        
        # Demonstrate validation error
        print("\n--- Testing Validation ---")
        try:
            invalid_user = {"name": "Bob"}  # Missing required email field
            db.set("user:bob", invalid_user)
        except ValidationError as e:
            print("❌ Validation failed as expected:")
            print(f"   Error: {e}")
        
        # Test other operations
        print("\n--- Testing Other Operations ---")
        print(f"Exists 'user:alice': {db.exists('user:alice')}")
        print(f"Exists 'user:nonexistent': {db.exists('user:nonexistent')}")
        print(f"Keys with prefix 'user:': {db.keys('user:')}")
        
        # Clean up
        db.delete("user:alice")
        print(f"After deletion - exists 'user:alice': {db.exists('user:alice')}")


async def async_example():
    """Demonstrate asynchronous AsyncS3KV usage."""
    print("\n=== Asynchronous AsyncS3KV Example ===")
    
    # Configure S3 (replace with your actual credentials)
    config = S3Config(
        access_key="your-access-key",
        secret_key="your-secret-key",
        region="us-east-1",
    )
    
    db = AsyncS3KV(Product, "example-products-bucket", config)
    try:
        # Create and store products
        products = [
            Product(
                name="Laptop",
                price=999.99,
                description="High-performance gaming laptop",
                categories=["electronics", "computers"]
            ),
            Product(
                name="Mouse",
                price=29.99,
                categories=["electronics", "accessories"]
            ),
            Product(
                name="Keyboard",
                price=79.99,
                description="Mechanical keyboard",
                categories=["electronics", "accessories"],
                in_stock=False
            )
        ]
        
        for i, product in enumerate(products, 1):
            await db.set(f"product:{product.name.lower()}", product)
            print(f"✅ Stored product: {product.name} (${product.price})")
        
        # Retrieve and display products
        print("\n--- Retrieved Products ---")
        product_keys = await db.keys("product:")
        for key in product_keys:
            product = await db.get(key)
            if product:
                status = "🟢 In stock" if product.in_stock else "🔴 Out of stock"
                print(f"📦 {product.name}: ${product.price} - {status}")
                if product.description:
                    print(f"   Description: {product.description}")
                if product.categories:
                    print(f"   Categories: {', '.join(product.categories)}")
                print()
        
        # Test batch operations
        print("--- Batch Operations ---")
        total_products = len(await db.keys("product:"))
        print(f"Total products in store: {total_products}")
        
        # Clean up
        for key in product_keys:
            await db.delete(key)
        print("🧹 Cleaned up all products")
    finally:
        await db.close()


def advanced_example():
    """Demonstrate advanced features like key prefixes and error handling."""
    print("\n=== Advanced Features Example ===")
    
    config = S3Config(
        access_key="your-access-key",
        secret_key="your-secret-key",
        region="us-east-1",
    )
    
    # Use key prefix to organize data
    with S3KV(User, "advanced-bucket", config, key_prefix="app/v1/") as db:
        # Store users with different key patterns
        users = [
            ("admin:user1", User(name="Admin User", email="admin@example.com")),
            ("customer:user2", User(name="Customer User", email="customer@example.com")),
            ("staff:user3", User(name="Staff User", email="staff@example.com")),
        ]
        
        for key, user in users:
            db.set(key, user)
            print(f"✅ Stored {key}: {user.name}")
        
        # List keys by different prefixes
        print("\n--- Key Organization ---")
        print(f"All keys: {db.keys()}")
        print(f"Admin keys: {db.keys('admin:')}")
        print(f"Customer keys: {db.keys('customer:')}")
        print(f"Staff keys: {db.keys('staff:')}")
        
        # Clean up
        for key, _ in users:
            db.delete(key)


async def main():
    """Run all examples."""
    print("S3KV Examples")
    print("=" * 50)
    
    # Run synchronous example
    sync_example()
    
    # Run asynchronous example  
    await async_example()
    
    # Run advanced example
    advanced_example()
    
    print("\n" + "=" * 50)
    print("All examples completed! 🎉")
    print("\nNote: Replace 'your-access-key' and 'your-secret-key' with actual S3 credentials")
    print("to run these examples with a real S3 backend.")


if __name__ == "__main__":
    asyncio.run(main())