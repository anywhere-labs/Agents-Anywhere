"""Validate iOS catalogs and, optionally, Xcode's extracted source strings.

Uses only the Python standard library and never launches an app or simulator.
"""

import argparse
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "ios/Agents Anywhere/Agents Anywhere"
LANGUAGES = ("en", "zh-Hans")
SHARED_PREFIXES = (
    "dashboard.device.runtimeConfigFields.",
    "dashboard.device.runtimeConfigComponents.",
    "dashboard.new.permissionModes.",
)
PRINTF = re.compile(r"%(?:(\d+)\$)?[-+#0 ']*(?:\d+)?(?:\.\d+)?(hh|ll|h|l|z|t|j|L)?([@diuoxXfFeEgGaAcCsSp])")


def placeholders(value):
    arguments = {}
    implicit_index = 1
    for match in PRINTF.finditer(value.replace("%%", "")):
        position = int(match[1]) if match[1] else implicit_index
        if not match[1]:
            implicit_index += 1
        kind = (match[2] or "") + match[3]
        if position in arguments and arguments[position] != kind:
            raise ValueError(f"Inconsistent argument {position}: {value!r}")
        arguments[position] = kind
    return arguments


def string_units(value):
    if isinstance(value, dict):
        if "stringUnit" in value:
            yield value["stringUnit"]
        for key, item in value.items():
            if key != "stringUnit":
                yield from string_units(item)


def flatten(value, prefix=""):
    for key, item in value.items():
        name = f"{prefix}.{key}" if prefix else key
        if isinstance(item, dict):
            yield from flatten(item, name)
        elif isinstance(item, str):
            yield name, item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--derived-data", type=Path, help="DerivedData from a successful iOS build; also verifies source coverage")
    args = parser.parse_args()
    errors = []
    catalogs = {}
    for path in sorted((APP / "Resources/Localization").glob("*.xcstrings")):
        catalog = json.loads(path.read_text())
        catalogs[path.stem] = catalog["strings"]
        if catalog.get("sourceLanguage") != "en":
            errors.append(f"{path.name}: source language must match Web (en)")
        for key, entry in catalog["strings"].items():
            for language in LANGUAGES:
                local = entry.get("localizations", {}).get(language, {})
                units = list(string_units(local))
                if not units:
                    errors.append(f"{path.name}: {language} translation missing for {key!r}")
                for unit in units:
                    value = unit.get("value", "")
                    if unit.get("state") != "translated" or (key.strip() and not value.strip()):
                        errors.append(f"{language}: unfinished translation for {key!r}")
                    if path.stem == "Localizable" and placeholders(key) != placeholders(value):
                        errors.append(f"{language}: argument order/type mismatch for {key!r}: {value!r}")

    localizable = catalogs.get("Localizable", {})
    web = {}
    for language, filename in (("en", "en.json"), ("zh-Hans", "zh-CN.json")):
        web[language] = dict(flatten(json.loads((ROOT / "web-next/messages" / filename).read_text())))
    for key, english in web["en"].items():
        if not key.startswith(SHARED_PREFIXES) or "{" in english:
            continue
        for language in LANGUAGES:
            actual = localizable.get(key, {}).get("localizations", {}).get(language, {}).get("stringUnit", {}).get("value")
            if actual != web[language].get(key):
                errors.append(f"{language}: runtime metadata copy differs from Web: {key}")

    plural_keys = (
        "%lld projects", "%lld workspaces", "%lld sessions", "%lld 个问题", "%lld 次子 Agent 调用",
        "%lld 次工具调用", "%lld 段思考", "Attach no more than %lld files.", "连接重试 · %lld 次",
    )
    for key in plural_keys:
        plural = localizable.get(key, {}).get("localizations", {}).get("en", {}).get("variations", {}).get("plural", {})
        if not {"one", "other"} <= plural.keys():
            errors.append(f"English plural rules missing for {key!r}")
    for key in ("NSCameraUsageDescription", "NSLocalNetworkUsageDescription"):
        if key not in catalogs.get("InfoPlist", {}):
            errors.append(f"Permission dialog translation missing: {key}")
    project = (APP.parent / "Agents Anywhere.xcodeproj/project.pbxproj").read_text()
    if '"zh-Hans"' not in project:
        errors.append("Xcode does not declare Simplified Chinese as a known region")

    extracted = set()
    sources = set()
    if args.derived_data:
        for path in args.derived_data.glob("Build/Intermediates.noindex/Agents Anywhere.build/**/*.stringsdata"):
            data = json.loads(path.read_text())
            source = Path(data["source"])
            # Ignore removed files and package/build-generated sources.
            if not source.is_file() or not source.is_relative_to(APP):
                continue
            sources.add(source)
            extracted.update(item["key"] for item in data.get("tables", {}).get("Localizable", []))
        if not sources:
            errors.append("No app stringsdata found; run an unsigned iOS build first")
        for key in sorted(extracted - localizable.keys()):
            errors.append(f"Compiled source has no catalog entry: {key!r}")
        absent = set(APP.rglob("*.swift")) - sources
        if absent:
            errors.append(f"Build has not extracted {len(absent)} app files; rebuild before checking coverage")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    total = sum(len(entries) for entries in catalogs.values())
    print(f"Validated {total} catalog entries in English and Simplified Chinese, placeholders, plural rules, permissions and Web metadata.")
    if args.derived_data:
        print(f"All {len(extracted)} extracted keys from {len(sources)} active Swift files are covered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
