#!/bin/sh
# The karyo plugin's artifact hooks (hooks/hooks.json; docs/ARTIFACTS.md): `stop` or `session-start`.
# Near-zero cost where nothing is linked: without <project>/karyo/artifacts.json this exits before starting bun.
# Otherwise `karyo artifact hook <kind>` reads the hook's JSON on stdin and answers (or says nothing). A hook never
# fails the session: whatever goes wrong, this exits 0.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$dir/karyo/artifacts.json" ] || exit 0
here=$(cd "$(dirname "$0")" && pwd -P)
# A hook never downloads anything: on a machine where bun isn't set up yet (a fresh Claude Desktop or Cowork
# install), it stays silent rather than fetch bun inside a Stop hook.
KARYO_NO_FETCH=1 "$here/../../cli/karyo" artifact hook "${1:-stop}" --project "$dir"
exit 0
