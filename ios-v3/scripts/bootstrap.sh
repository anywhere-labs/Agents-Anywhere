#!/usr/bin/env bash
# Link the MeshCall Swift SDK into ios-v3/Vendor/meshcall-swift.
#
# The SDK lives in a subdirectory of the meshcall repository (meshcall-swift/), so SwiftPM cannot
# resolve it from the repository's git URL; AAClientCore depends on it by local path instead.
# Lookup order:
#   1. $MESHCALL_SWIFT_PATH
#   2. <parent of the main Agents-Anywhere checkout>/meshcall/meshcall-swift (works from git worktrees too)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${MESHCALL_SWIFT_PATH:-}"
if [[ -z "$target" ]]; then
  common="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)"
  main_root="$(dirname "$common")"
  target="$(dirname "$main_root")/meshcall/meshcall-swift"
fi
if [[ ! -f "$target/Package.swift" ]]; then
  echo "MeshCall Swift SDK not found at $target" >&2
  echo "Clone https://github.com/t4wefan/meshcall (tag v0.4.0) next to Agents-Anywhere, or set MESHCALL_SWIFT_PATH." >&2
  exit 1
fi
mkdir -p "$here/Vendor"
ln -sfn "$target" "$here/Vendor/meshcall-swift"
echo "Vendor/meshcall-swift -> $target"
