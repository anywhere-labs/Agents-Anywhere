#!/usr/bin/env bash
# Xcode build phase: copy the shared web-v3 render bundle into the app when it has been built.
#
#   ../web-v3/embed/dist/aa-render.html  →  <app>/aa-render.html
#
# Without it the app loads the bundled placeholder (AgentsAnywhere/Resources/aa-render-placeholder.html), which
# implements the same `aa.render/2` bridge with plain-text rendering. Set AA_RENDER_BUNDLE to use another file.
set -euo pipefail
src="${AA_RENDER_BUNDLE:-${SRCROOT}/../web-v3/embed/dist/aa-render.html}"
dst="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/aa-render.html"
mkdir -p "$(dirname "$dst")"
if [[ -f "$src" ]]; then
  cp "$src" "$dst"
  echo "aa-render: using $src"
else
  rm -f "$dst"
  echo "aa-render: $src not built yet; the placeholder renderer is used"
fi
