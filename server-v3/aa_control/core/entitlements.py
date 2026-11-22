from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

EntitlementValue = str | int | float | bool
EntitlementMap = dict[str, EntitlementValue]

ENTITLEMENT_MAX_DEVICES = "aa.max_devices"
ENTITLEMENT_DRIVE_QUOTA_MB = "aa.drive_quota_mb"
ENTITLEMENT_DRIVE_TTL_DAYS = "aa.drive_ttl_days"
ENTITLEMENT_DRIVE_MAX_FILE_MB = "aa.drive_max_file_mb"


def sanitize_entitlements(raw: Mapping[str, Any] | None) -> EntitlementMap:
    """Keep only flat primitive claim values (str, finite int/float, bool)."""
    if not isinstance(raw, Mapping):
        return {}
    result: EntitlementMap = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        cleaned_key = key.strip()
        if not cleaned_key or len(cleaned_key) > 128:
            continue
        if isinstance(value, bool):
            result[cleaned_key] = value
        elif isinstance(value, int):
            result[cleaned_key] = value
        elif isinstance(value, float):
            if math.isfinite(value):
                result[cleaned_key] = value
        elif isinstance(value, str):
            result[cleaned_key] = value
    return result


def merge_entitlements(
    defaults: Mapping[str, Any] | None,
    overrides: Mapping[str, Any] | None,
) -> EntitlementMap:
    """Merge baseline default entitlements with token-provided overrides."""
    merged = sanitize_entitlements(defaults)
    merged.update(sanitize_entitlements(overrides))
    return merged


@dataclass(frozen=True)
class EntitlementSet:
    """Typed accessor over generic key-value entitlement claims."""

    values: EntitlementMap = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any] | None) -> EntitlementSet:
        return cls(values=sanitize_entitlements(raw))

    def get_int(self, key: str) -> int | None:
        value = self.values.get(key)
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float) and math.isfinite(value) and value.is_integer():
            return int(value)
        return None

    def get_bool(self, key: str) -> bool | None:
        value = self.values.get(key)
        return value if isinstance(value, bool) else None

    def get_str(self, key: str) -> str | None:
        value = self.values.get(key)
        return value if isinstance(value, str) else None

    def limit_or_none(self, key: str) -> int | None:
        """Return a non-negative quota limit, or None when absent or unlimited (< 0)."""
        raw = self.get_int(key)
        if raw is None or raw < 0:
            return None
        return raw

    def is_unlimited(self, key: str) -> bool:
        raw = self.get_int(key)
        return raw is not None and raw < 0

    def max_devices(self) -> int | None:
        return self.limit_or_none(ENTITLEMENT_MAX_DEVICES)

    def drive_quota_mb(self) -> int | None:
        return self.limit_or_none(ENTITLEMENT_DRIVE_QUOTA_MB)

    def drive_ttl_days(self) -> int | None:
        return self.limit_or_none(ENTITLEMENT_DRIVE_TTL_DAYS)

    def drive_max_file_mb(self) -> int | None:
        return self.limit_or_none(ENTITLEMENT_DRIVE_MAX_FILE_MB)

    def to_dict(self) -> EntitlementMap:
        return dict(self.values)
