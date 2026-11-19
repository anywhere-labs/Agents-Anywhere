#!/bin/sh
set -eu

vendor_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
checkout="$vendor_dir/sdk"
revision=ce14d60743c2c6d5c2d504da02748de271ed8769

if [ ! -d "$checkout/.git" ]; then
    git init --quiet "$checkout"
fi
if [ "$(git -C "$checkout" rev-parse --verify HEAD 2>/dev/null || true)" != "$revision" ]; then
    git -C "$checkout" fetch --quiet --depth=1 https://github.com/t4wefan/meshcall.git "$revision"
    git -C "$checkout" checkout --quiet --detach "$revision"
fi
git -C "$checkout" diff --quiet HEAD
