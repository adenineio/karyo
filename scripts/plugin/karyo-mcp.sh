#!/bin/sh
# Launch the Karyo MCP server (integrations/mcp) for the Claude Code plugin (.mcp.json). Its Python env lives in the
# plugin's data dir ($KARYO_DATA/venv/mcp), never in the plugin folder or the user's project; uv creates it on first
# start from integrations/mcp/uv.lock (--frozen: exactly the locked versions).
here=$(cd "$(dirname "$0")/../.." && pwd -P)
uv=$(command -v uv 2>/dev/null)
for c in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
  [ -n "$uv" ] && break
  [ -x "$c" ] && uv="$c"
done
if [ -z "$uv" ]; then
  echo "karyo-mcp: needs uv, which isn't installed: curl -LsSf https://astral.sh/uv/install.sh | sh  (https://docs.astral.sh/uv/)" >&2
  exit 127
fi
data="${KARYO_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.adenine/karyo/runtime}}"
export UV_PROJECT_ENVIRONMENT="$data/venv/mcp"
export PYTHONPYCACHEPREFIX="$data/pycache"   # bytecode out of the plugin folder
export PYTHONPATH="$here/integrations/mcp${PYTHONPATH:+:$PYTHONPATH}"
export KARYO_BIN="${KARYO_BIN:-$here/cli/karyo.ts}"
# deps only (the package itself is imported from the plugin folder via PYTHONPATH, so nothing is built there)
"$uv" sync --quiet --frozen --no-install-project --project "$here/integrations/mcp" >&2 || exit $?
exec "$uv" run --quiet --frozen --no-sync --project "$here/integrations/mcp" python -m karyo_mcp
