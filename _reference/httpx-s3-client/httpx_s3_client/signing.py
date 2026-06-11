import hashlib
import hmac
from datetime import datetime, timezone
from urllib.parse import quote, urlparse, urlencode

import httpx

from .config import S3Config
from typing import Generator


class AWSSigV4Auth(httpx.Auth):
    """
    AWS Signature V4 authentication for httpx.
    """

    def __init__(self, config: S3Config, service: str = "s3"):
        self.config = config
        self.service = service

    def auth_flow(
        self, request: httpx.Request
    ) -> Generator[httpx.Request, httpx.Response, None]:
        """
        The main authentication flow.
        """
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        region = self.config.region or "us-east-1"

        # Task 1: Create a Canonical Request
        payload_hash = self._get_payload_hash(request)
        request.headers["x-amz-content-sha256"] = payload_hash
        request.headers["x-amz-date"] = amz_date
        request.headers["host"] = urlparse(str(request.url)).netloc

        headers_to_sign = {
            key.lower(): value
            for key, value in request.headers.items()
            if key.lower().startswith("x-amz-") or key.lower() == "host"
        }

        signed_headers = sorted(headers_to_sign.keys())
        canonical_headers = "".join(
            f"{k}:{headers_to_sign[k]}\n" for k in signed_headers
        )
        canonical_request = self._get_canonical_request(
            request, signed_headers, canonical_headers, payload_hash
        )

        # Task 2: Create a String to Sign
        credential_scope = f"{datestamp}/{region}/{self.service}/aws4_request"
        string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"

        # Task 3: Calculate the Signature
        signing_key = self._get_signature_key(
            self.config.secret_key, datestamp, region, self.service
        )
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        # Task 4: Add Signing Information to the Request
        authorization_header = f"AWS4-HMAC-SHA256 Credential={self.config.access_key}/{credential_scope}, SignedHeaders={';'.join(signed_headers)}, Signature={signature}"
        request.headers["Authorization"] = authorization_header

        yield request

    def _get_payload_hash(self, request: httpx.Request) -> str:
        if "x-amz-content-sha256" in request.headers:
            return request.headers["x-amz-content-sha256"]
        if request.content:
            return hashlib.sha256(request.content).hexdigest()
        return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"  # SHA256 of empty string

    def _get_canonical_request(
        self,
        request: httpx.Request,
        signed_headers: list[str],
        canonical_headers: str,
        payload_hash: str,
    ) -> str:
        canonical_uri = quote(request.url.path, safe="/~")
        canonical_querystring = "&".join(sorted(request.url.query.decode().split("&")))

        return (
            f"{request.method}\n"
            f"{canonical_uri}\n"
            f"{canonical_querystring}\n"
            f"{canonical_headers}\n"
            f"{';'.join(signed_headers)}\n"
            f"{payload_hash}"
        )

    def _get_signature_key(
        self, key: str, date_stamp: str, region_name: str, service_name: str
    ) -> bytes:
        k_date = self._sign(f"AWS4{key}".encode("utf-8"), date_stamp)
        k_region = self._sign(k_date, region_name)
        k_service = self._sign(k_region, service_name)
        k_signing = self._sign(k_service, "aws4_request")
        return k_signing

    def _sign(self, key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    def sign_presigned_url(
        self, http_method: str, url: httpx.URL, expires_in: int
    ) -> str:
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        region = self.config.region or "us-east-1"

        credential_scope = f"{datestamp}/{region}/{self.service}/aws4_request"

        # For presigned URLs, only the host header is signed.
        # The host must include the port if it's non-standard.
        signed_headers = ["host"]
        canonical_headers = f"host:{url.netloc.decode()}\n"

        query_params = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{self.config.access_key}/{credential_scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(expires_in),
            "X-Amz-SignedHeaders": ";".join(signed_headers),
        }

        # Combine with existing query parameters
        all_query_params = query_params.copy()
        query_string = url.query.decode()
        if query_string:
            for pair in query_string.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    all_query_params[k] = v
                elif pair:
                    all_query_params[pair] = ""

        canonical_querystring = "&".join(
            f"{quote(k, safe='')}={quote(v, safe='')}"
            for k, v in sorted(all_query_params.items())
        )

        canonical_request = (
            f"{http_method}\n"
            f"{quote(url.path, safe='/~')}\n"
            f"{canonical_querystring}\n"
            f"{canonical_headers}\n"
            f"{';'.join(signed_headers)}\n"
            "UNSIGNED-PAYLOAD"
        )

        string_to_sign = (
            f"AWS4-HMAC-SHA256\n"
            f"{amz_date}\n"
            f"{credential_scope}\n"
            f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
        )

        signing_key = self._get_signature_key(
            self.config.secret_key, datestamp, region, self.service
        )
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        all_query_params["X-Amz-Signature"] = signature

        # Use urlencode with quote to ensure spaces are %20, not +.
        final_query_string = urlencode(all_query_params, quote_via=quote)
        return str(url.copy_with(query=final_query_string.encode()))
