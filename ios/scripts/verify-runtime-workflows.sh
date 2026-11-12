#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/aa-pi-ios-workflow.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT

python3 - "$repo_dir" "$probe_dir/clientcore.rsp" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1]) / 'ios/Agents Anywhere/Agents Anywhere'
paths = sorted(path for group in ['API', 'Network', 'Models', 'Domain', 'Business', 'Repositories']
               for path in (source / group).rglob('*.swift') if path.name != 'AccountAvatarProcessor.swift')
Path(sys.argv[2]).write_text('\n'.join(json.dumps(str(path), ensure_ascii=False) for path in paths) + '\n')
PY
xcrun swiftc -default-isolation MainActor -swift-version 5 \
  @"$probe_dir/clientcore.rsp" "$repo_dir/ios/scripts/verify-runtime-workflows.swift" \
  -o "$probe_dir/verify-runtime-workflows"
"$probe_dir/verify-runtime-workflows"
