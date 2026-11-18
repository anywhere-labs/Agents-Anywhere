#!/usr/bin/env bash
set -euo pipefail

repository=git@github.com:anywhere-labs/codex-acp.git
revision=7a6bb6779a012af97b1c962bcb825a1195112f20
destination=${1:-}

if [[ "$destination" != /* ]]; then
  printf 'Usage: bash connector-ts/scripts/build-codex-acp.sh /absolute/path/to/new-checkout\n' >&2
  exit 2
fi

mkdir -- "$destination"
git -C "$destination" init --quiet
git -C "$destination" remote add origin "$repository"
git -C "$destination" fetch --no-tags --depth=1 origin "$revision"
git -C "$destination" checkout --quiet --detach FETCH_HEAD
if [[ "$(git -C "$destination" rev-parse HEAD)" != "$revision" ]]; then
  printf 'codex-acp checkout did not match %s\n' "$revision" >&2
  exit 1
fi

cd -- "$destination"
npm ci --no-audit --no-fund
npm run build
chmod +x dist/index.js
printf 'codex-acp %s built at %s/dist/index.js\n' "$revision" "$PWD"
