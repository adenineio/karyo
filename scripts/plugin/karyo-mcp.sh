#!/bin/sh
# Launch the Karyo MCP server (integrations/mcp) for the plugin (plugin.json "mcpServers"): what Claude Code, Claude
# Desktop and Cowork start. Its Python env lives in the plugin's data dir ($KARYO_DATA/venv/mcp), never in the plugin
# folder or the user's project; uv creates it on first start from integrations/mcp/uv.lock (--frozen: exactly the
# locked versions). Without uv on the machine, a pinned uv is fetched once into the data dir (scripts/plugin/tools.sh),
# and uv fetches a Python 3.12+ if there is none: a fresh machine needs no terminal step.
here=$(cd "$(dirname "$0")/../.." && pwd -P)
. "$here/scripts/plugin/tools.sh"
data=$(karyo_data_dir "$here")
uv=$(karyo_tool uv "$here")
if [ -z "$uv" ]; then
  echo "karyo-mcp: needs uv, which isn't installed and couldn't be set up automatically: curl -LsSf https://astral.sh/uv/install.sh | sh  (https://docs.astral.sh/uv/)" >&2
  exit 127
fi
case "$uv" in
  "$data"/*) # Karyo's own uv: keep its Python and cache in the data dir too
    export UV_PYTHON_INSTALL_DIR="$data/python" UV_CACHE_DIR="$data/uv-cache" ;;
esac
export KARYO_DATA="$data"
export UV_PROJECT_ENVIRONMENT="$data/venv/mcp"
export PYTHONPYCACHEPREFIX="$data/pycache"   # bytecode out of the plugin folder
export PYTHONPATH="$here/integrations/mcp${PYTHONPATH:+:$PYTHONPATH}"
export KARYO_BIN="${KARYO_BIN:-$here/cli/karyo}"   # the wrapper: it finds (or fetches) bun
[ -f "$data/venv/mcp/pyvenv.cfg" ] || echo "karyo-mcp: first start: setting up the server's Python env in $data/venv/mcp (once)…" >&2
# deps only (the package itself is imported from the plugin folder via PYTHONPATH, so nothing is built there)
"$uv" sync --quiet --frozen --no-install-project --project "$here/integrations/mcp" >&2 || exit $?
exec "$uv" run --quiet --frozen --no-sync --project "$here/integrations/mcp" python -m karyo_mcp
