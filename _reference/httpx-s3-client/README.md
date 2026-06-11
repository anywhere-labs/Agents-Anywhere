# httpx-s3-client

一个基于 `httpx` 构建的模块化、同步和异步的 S3 客户端。

## 特性

-   **同步与异步:** 同时提供 `S3Client` 和 `AsyncS3Client`，使用灵活。
-   **全面的对象操作:** 支持对象的上传、下载、删除、列出、复制和检查存在性 (`head`)。
-   **全面的存储桶操作:** 支持存储桶的创建、删除、列出和检查存在性 (`head`)。
-   **文件 I/O:** 直接从本地文件上传和下载到本地文件，通过 `aiofiles` 支持非阻塞异步操作。
-   **高级功能:** 支持预签名 URL 和存储桶生命周期管理。
-   **类型安全:** 使用 `pydantic` 进行配置和结构化返回类型。
-   **健壮性:** 实现 AWS Signature V4，并提供详细的、针对 S3 的异常处理。

## 安装

```bash
uv add git+https://gitlab.t4wefan.pub/t4wefan/httpx-s3-client.git
```

## 用法

### 配置

```python
from httpx_s3_client import S3Config

config = S3Config(
    access_key="你的访问密钥",
    secret_key="你的秘密密钥",
    region="us-east-1",
    # endpoint_url 是可选的，用于兼容 S3 的服务，如 MinIO
    # endpoint_url="http://localhost:9000",
)
```

### 同步客户端示例

```python
from httpx_s3_client import S3Client

with S3Client(config) as client:
    # 存储桶
    client.create_bucket("my-bucket", strict=False)  # 幂等操作
    
    bucket_info = client.head_bucket("my-bucket")
    if bucket_info:
        print(f"存储桶 'my-bucket' 存在。创建日期: {bucket_info.CreationDate}")

    print(f"存储桶: {[b.Name for b in client.list_buckets().Buckets]}")

    # 对象
    client.upload_file("my-bucket", "my-key.txt", "/path/to/local/file.txt")
    
    # 从内存中的字节流上传
    import io
    in_memory_data = io.BytesIO(b"来自内存数据!")
    client.upload_readable("my-bucket", "my-in-memory-key.txt", in_memory_data)
    
    client.download_file("my-bucket", "my-key.txt", "/path/to/local/download.txt")
    
    obj_info = client.head_object("my-bucket", "my-key.txt")
    if obj_info:
        print(f"对象大小: {obj_info.Size}")

    print(f"对象: {[o.Key for o in client.list_objects('my-bucket').Contents]}")
    
    client.copy_object("my-bucket", "my-key.txt", "my-bucket", "my-key-copy.txt")
    client.delete_object("my-bucket", "my-key.txt")
    client.delete_object("my-bucket", "my-key-copy.txt")
    client.delete_bucket("my-bucket")
```

### 异步客户端示例

```python
import asyncio
from httpx_s3_client import AsyncS3Client

async def main():
    async with AsyncS3Client(config) as client:
        # 存储桶
        await client.create_bucket("my-async-bucket", strict=False)
        
        bucket_info = await client.head_bucket("my-async-bucket")
        if bucket_info:
            print(f"存储桶 'my-async-bucket' 存在。创建日期: {bucket_info.CreationDate}")
        
        # 对象
        await client.upload_file("my-async-bucket", "my-key.txt", "/path/to/local/file.txt")

        # 从异步生成器上传
        async def data_generator():
            yield b"你好 "
            yield b"来自 "
            yield b"异步生成器!"
        await client.upload_readable("my-async-bucket", "my-async-generator-key.txt", data_generator())

        await client.download_file("my-async-bucket", "my-key.txt", "/path/to/local/download.txt")
        
        obj_info = await client.head_object("my-async-bucket", "my-key.txt")
        if obj_info:
            print(f"对象大小: {obj_info.Size}")
            
        await client.delete_object("my-async-bucket", "my-key.txt")
        await client.delete_bucket("my-async-bucket")

if __name__ == "__main__":
    asyncio.run(main())

## S3 键值存储 (S3KV)

`httpx-s3-client` 还提供了一个与 Pydantic 集成的键值存储接口，可以自动进行数据验证和序列化。

### 同步键值存储示例

```python
from pydantic import BaseModel, ValidationError
from httpx_s3_client import S3KV, S3Config

class User(BaseModel):
    name: str
    email: str
    logins: int = 0

# 配置 S3
config = S3Config(
    access_key="你的访问密钥",
    secret_key="你的秘密密钥",
    region="us-east-1"
)

# 创建键值存储，绑定 User 模型
db = S3KV(User, "my-users-bucket", config)

# 设置一个合法的用户对象
user_charlie = User(name="Charlie", email="charlie@example.com")
db.set("user:charlie", user_charlie)

# 获取的数据会自动解析为 User 实例
retrieved_user = db.get("user:charlie")
print(retrieved_user.name)
# > Charlie
print(retrieved_user.model_dump_json())
# > {"name":"Charlie","email":"charlie@example.com","logins":0}

# 尝试插入非法数据将会抛出 ValidationError
try:
    invalid_user = {"name": "David"}  # 缺少 email 字段
    db.set("user:david", invalid_user)
except ValidationError as e:
    print("数据验证失败！")
    # > 数据验证失败！

# 其他操作
print(db.exists("user:charlie"))  # True
print(db.keys("user:"))           # ["user:charlie"]
db.delete("user:charlie")
print(db.exists("user:charlie"))  # False

db.close()
```

### 异步键值存储示例

```python
import asyncio
from pydantic import BaseModel
from httpx_s3_client import AsyncS3KV, S3Config

class Product(BaseModel):
    name: str
    price: float
    description: str = ""

async def main():
    config = S3Config(...)
    
    async with AsyncS3KV(Product, "products-bucket", config) as db:
        # 存储产品
        product = Product(name="Laptop", price=999.99, description="Gaming laptop")
        await db.set("product:laptop", product)
        
        # 检索产品
        retrieved = await db.get("product:laptop")
        print(f"产品: {retrieved.name}, 价格: ${retrieved.price}")
        
        # 检查存在性
        exists = await db.exists("product:laptop")
        print(f"产品存在: {exists}")
        
        # 列出所有产品键
        keys = await db.keys("product:")
        print(f"所有产品键: {keys}")

if __name__ == "__main__":
    asyncio.run(main())
```

### S3KV 特性

- **自动验证**: 使用 Pydantic 模型自动验证数据
- **类型安全**: 完整的类型注解和编辑器支持
- **JSON 序列化**: 自动将模型序列化为 JSON 存储
- **前缀支持**: 支持键前缀，便于组织数据
- **错误处理**: 详细的错误信息和异常处理
- **同步和异步**: 同时提供同步和异步版本

## 开发

### 安装开发依赖

```bash
uv sync
```

### 运行测试

```bash
uv run pytest
```