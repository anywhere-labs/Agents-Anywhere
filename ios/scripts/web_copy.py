"""Sync reviewed iOS copy from the Web catalogs, without app/runtime dependencies.

The map records semantic matches, not fuzzy text matches. Native-only copy (for
example iOS permissions and uncertain offline writes) remains in the iOS catalog.
Run `python3 ios/scripts/web_copy.py --write` after reviewing a Web copy change.
"""

import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "ios/Agents Anywhere/Agents Anywhere/Resources/Localization/Localizable.xcstrings"
MAP = Path(__file__).with_name("web-copy-map.json")
LANGUAGES = {"en": "en.json", "zh-Hans": "zh-CN.json"}
SHARED_PREFIXES = (
    "dashboard.device.runtimeConfigFields.",
    "dashboard.device.runtimeConfigComponents.",
    "dashboard.new.permissionModes.",
)


def flatten(value, prefix=""):
    for key, item in value.items():
        name = f"{prefix}.{key}" if prefix else key
        if isinstance(item, dict):
            yield from flatten(item, name)
        elif isinstance(item, str):
            yield name, item


def localization(value, arguments=None, plural=None):
    arguments = arguments or {}

    def unit(text):
        # Swift interpolation follows argument order; Web translations may
        # reorder named arguments. Explicit positions keep both languages safe.
        for position, (name, kind) in enumerate(arguments.items(), 1):
            specifier = f"%{position}${kind}" if len(arguments) > 1 else f"%{kind}"
            text = text.replace("{" + name + "}", specifier)
        if "{" in text or "}" in text:
            raise ValueError(f"Unmapped Web arguments or unsupported ICU message: {text!r}")
        return {"stringUnit": {"state": "translated", "value": text}}

    if not plural:
        return unit(value)
    if arguments != {plural: "lld"}:
        raise ValueError("Plural copy requires one Int argument")
    match = re.fullmatch(r"\{" + re.escape(plural) + r",\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\s*\}", value)
    # Chinese often uses a simple count while English needs plural branches.
    variants = dict(zip(("one", "other"), match.groups())) if match else {"one": value, "other": value}
    return {"variations": {"plural": {
        name: unit(text.replace("#", "{" + plural + "}")) for name, text in variants.items()
    }}}


def expected_copy():
    web = {language: dict(flatten(json.loads((ROOT / "web-next/messages" / filename).read_text())))
           for language, filename in LANGUAGES.items()}
    mappings = json.loads(MAP.read_text())["strings"]
    for key, value in web["en"].items():
        if key.startswith(SHARED_PREFIXES) and "{" not in value:
            mappings.setdefault(key, key)
    expected = {}
    for key, mapping in mappings.items():
        spec = {"source": mapping} if isinstance(mapping, str) else mapping
        source = spec["source"]
        expected[key] = {
            "comment": f"Shared with Web: {source}. Sync with ios/scripts/web_copy.py.",
            "extractionState": "manual",
            "localizations": {language: localization(strings[source], spec.get("arguments"), spec.get("plural"))
                              for language, strings in web.items()},
        }
    return expected


def copy_errors(catalog, expected):
    for key, entry in expected.items():
        for language, value in entry["localizations"].items():
            if catalog.get(key, {}).get("localizations", {}).get(language) != value:
                yield f"{language}: copy differs from Web: {key!r} ({entry['comment']})"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Update only the reviewed shared copy")
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text())
    expected = expected_copy()
    if args.write:
        catalog["strings"].update(expected)
        catalog["strings"] = dict(sorted(catalog["strings"].items()))
        CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    errors = list(copy_errors(catalog["strings"], expected))
    if errors:
        print("\n".join(errors))
        return 1
    print(f"{'Synced' if args.write else 'Validated'} {len(expected)} shared Web messages in English and Simplified Chinese.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
