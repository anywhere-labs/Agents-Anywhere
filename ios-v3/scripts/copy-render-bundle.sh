#!/usr/bin/env bash
# Xcode build phase: put the shared web-v3 render bundle (`aa.render/2`, web-v3/embed) into the app.
#
#   ../web-v3/embed/dist/aa-render.html  →  <app>/aa-render.html
#
# - AA_RENDER_BUNDLE=<file>     use that file instead (e.g. a bundle built in another checkout).
# - AA_BUILD_RENDER_BUNDLE=1    run `corepack yarn embed:build` in ../web-v3 first (needs Node and its dependencies;
#                               off by default to keep Xcode builds fast and offline).
# Without a bundle the app loads the bundled placeholder (AgentsAnywhere/Resources/aa-render-placeholder.html), which
# speaks the same bridge with plain-text rendering, so the app works before the bundle is built.
set -euo pipefail
web="${SRCROOT}/../web-v3"
if [[ "${AA_BUILD_RENDER_BUNDLE:-}" == 1 && -z "${AA_RENDER_BUNDLE:-}" && -d "$web/embed" ]]; then
  (cd "$web" && corepack yarn embed:build)
fi
src="${AA_RENDER_BUNDLE:-$web/embed/dist/aa-render.html}"
dst="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/aa-render.html"
mkdir -p "$(dirname "$dst")"
if [[ -f "$src" ]]; then
  cp "$src" "$dst"
  echo "aa-render: using $src"
else
  rm -f "$dst"
  echo "aa-render: $src not built; the placeholder renderer is used"
fi
