# shellcheck shell=sh
# Sourced by cli/karyo and scripts/plugin/karyo-mcp.sh: find bun or uv, and fetch a pinned copy when the machine has
# none, so a fresh install needs no terminal (Claude Desktop, Cowork, a new laptop). docs/COWORK.md.
#
#   karyo_tool bun|uv   prints the executable's path; exit 1 (with a plain-words reason on stderr) when it can't
#
# Order: what is installed (PATH, then the usual homes), then a copy Karyo fetched before, then a fresh fetch of the
# version pinned below, checked against its SHA-256 before anything runs. Fetched tools live in Karyo's data dir
# (tools/<name>-<version>/), never in the project and never on the user's PATH. KARYO_NO_FETCH=1 turns fetching off.

KARYO_BUN_VERSION=1.4.2
KARYO_UV_VERSION=0.12.23

# The data dir, as scripts/karyo-runtime.ts dataDir() finds it: $KARYO_DATA, $CLAUDE_PLUGIN_DATA, the plugin cache
# layout (<plugins>/cache/<marketplace>/<plugin>/<version> -> <plugins>/data/<plugin>-<marketplace>), Karyo's home.
karyo_data_dir() {
  # a host that doesn't substitute ${CLAUDE_PLUGIN_DATA} in plugin.json passes it through literally: ignore that
  case "${KARYO_DATA:-}" in *'${'*) KARYO_DATA= ;; esac
  case "${CLAUDE_PLUGIN_DATA:-}" in *'${'*) CLAUDE_PLUGIN_DATA= ;; esac
  if [ -n "${KARYO_DATA:-}" ]; then echo "$KARYO_DATA"; return; fi
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then echo "$CLAUDE_PLUGIN_DATA"; return; fi
  _root="$1"
  _ver_dir=$(dirname "$_root"); _plugin=$(basename "$_ver_dir")
  _mkt_dir=$(dirname "$_ver_dir"); _mkt=$(basename "$_mkt_dir")
  _cache=$(dirname "$_mkt_dir"); _plugins=$(dirname "$_cache")
  if [ "$(basename "$_cache")" = cache ] && { [ -f "$_plugins/installed_plugins.json" ] || [ -f "$_plugins/known_marketplaces.json" ]; }; then
    echo "$_plugins/data/$(printf '%s@%s' "$_plugin" "$_mkt" | tr -c 'A-Za-z0-9_\n-' '-')"
    return
  fi
  echo "${KARYO_HOME:-$HOME/.adenine/karyo}/runtime"
}

_karyo_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
  fi
}

_karyo_get() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else python3 -c 'import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])' "$1" "$2"
  fi
}

_karyo_musl() { [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }

# Where to get the tool for this machine: one "<url> <sha256>" line per source, tried in order. bun comes from its
# GitHub release, else the same binary from the npm registry (a sandbox that allows package registries but not GitHub).
_karyo_sources() {
  _os=$(uname -s); _arch=$(uname -m)
  case "$_arch" in arm64) _arch=aarch64 ;; esac
  _gh_bun="https://github.com/oven-sh/bun/releases/download/bun-v$KARYO_BUN_VERSION"
  _npm_bun="https://registry.npmjs.org/@oven"
  _gh_uv="https://github.com/astral-sh/uv/releases/download/$KARYO_UV_VERSION"
  _m=; _karyo_musl && _m=musl
  case "$1:$_os:$_arch:$_m" in
    bun:Darwin:aarch64:*)
      echo "$_gh_bun/bun-darwin-aarch64.zip 90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"
      echo "$_npm_bun/bun-darwin-aarch64/-/bun-darwin-aarch64-$KARYO_BUN_VERSION.tgz a9df486eaf7e9db9bdebb1fa425e8c9809abd783b1c518d1dbc5096a53b861ed" ;;
    bun:Darwin:x86_64:*)
      echo "$_gh_bun/bun-darwin-x64-baseline.zip bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0"
      echo "$_npm_bun/bun-darwin-x64-baseline/-/bun-darwin-x64-baseline-$KARYO_BUN_VERSION.tgz 625b1f4fd5460fcd62ef8e4b672f181ef22bcdf4a15275eeac790c708add4950" ;;
    bun:Linux:aarch64:)
      echo "$_gh_bun/bun-linux-aarch64.zip 54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"
      echo "$_npm_bun/bun-linux-aarch64/-/bun-linux-aarch64-$KARYO_BUN_VERSION.tgz 9ab3970a19660b5cd089f17fb021d900e1ca1b988dafd461d66d0a0ff4d6eac4" ;;
    bun:Linux:aarch64:musl)
      echo "$_gh_bun/bun-linux-aarch64-musl.zip 71760b6c8ea30623b81a4907cb815d48e2ea266f2e73e751534a44a0607950df"
      echo "$_npm_bun/bun-linux-aarch64-musl/-/bun-linux-aarch64-musl-$KARYO_BUN_VERSION.tgz 47d82b8fac2fb24613ddf27d4b7a6da2c47cf966e4c03ce50792e4ce9cd8ae13" ;;
    bun:Linux:x86_64:)
      echo "$_gh_bun/bun-linux-x64-baseline.zip c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"
      echo "$_npm_bun/bun-linux-x64-baseline/-/bun-linux-x64-baseline-$KARYO_BUN_VERSION.tgz 129ae8dfaca565e8008735e3d6adae7515421c5b226d6f1f90c4bcb35803a647" ;;
    bun:Linux:x86_64:musl)
      echo "$_gh_bun/bun-linux-x64-musl-baseline.zip 76e1db84e98f22f78de0a87e309bfbbf297732847f9720db36750646c85c8c18"
      echo "$_npm_bun/bun-linux-x64-musl-baseline/-/bun-linux-x64-musl-baseline-$KARYO_BUN_VERSION.tgz 9c52c9f2daba8c597d414e994ed96b210e8e795deb8b169a9c086d48d752a34b" ;;
    uv:Darwin:aarch64:*)  echo "$_gh_uv/uv-aarch64-apple-darwin.tar.gz 50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544" ;;
    uv:Darwin:x86_64:*)   echo "$_gh_uv/uv-x86_64-apple-darwin.tar.gz 960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4" ;;
    uv:Linux:aarch64:)    echo "$_gh_uv/uv-aarch64-unknown-linux-gnu.tar.gz 6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f" ;;
    uv:Linux:aarch64:musl) echo "$_gh_uv/uv-aarch64-unknown-linux-musl.tar.gz b536543cc4d50661986b165c76ee8aa9056e4fa332edcd153ff2e98760f9359b" ;;
    uv:Linux:x86_64:)     echo "$_gh_uv/uv-x86_64-unknown-linux-gnu.tar.gz 9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6" ;;
    uv:Linux:x86_64:musl) echo "$_gh_uv/uv-x86_64-unknown-linux-musl.tar.gz 1cff8783850e794470aadb73f54b749542a511fc57b0ce6468b64bd3852e0ade" ;;
  esac
}

# Fetch the pinned tool into <data>/tools/<name>-<version>/ and print its path.
_karyo_fetch() { # name root
  _name=$1
  if [ "$_name" = bun ]; then _ver=$KARYO_BUN_VERSION; else _ver=$KARYO_UV_VERSION; fi
  _dest="$(karyo_data_dir "$2")/tools/$_name-$_ver"
  [ -x "$_dest/$_name" ] && { echo "$_dest/$_name"; return 0; }
  [ "${KARYO_NO_FETCH:-}" = 1 ] && return 1
  _srcs=$(_karyo_sources "$_name")
  if [ -z "$_srcs" ]; then echo "karyo: no $_name download for this machine ($(uname -s) $(uname -m))" >&2; return 1; fi
  echo "karyo: setting up $_name $_ver for Karyo (a one-time download, about a minute; nothing else on this computer changes)…" >&2
  mkdir -p "$_dest" || return 1
  _tmp=$(mktemp -d "$_dest/.fetch.XXXXXX") || return 1
  _ok=
  # one source per line: "<url> <sha256>"
  _old_ifs=$IFS; IFS='
'
  for _src in $_srcs; do
    IFS=$_old_ifs
    _url=${_src% *}; _sum=${_src#* }; _file=$(basename "$_url")
    # KARYO_TOOLS_NO_GITHUB=1: act as a network that blocks GitHub (tests of the npm-registry fallback)
    case "${KARYO_TOOLS_NO_GITHUB:-}:$_url" in 1:https://github.com/*) continue ;; esac
    if ! _karyo_get "$_url" "$_tmp/$_file" 2>/dev/null; then
      echo "karyo: couldn't download $_url" >&2; continue
    fi
    _got=$(_karyo_sha256 "$_tmp/$_file")
    if [ "$_got" != "$_sum" ]; then
      echo "karyo: $_url didn't match its pinned SHA-256 (got $_got); not using it" >&2; rm -f "$_tmp/$_file"; continue
    fi
    case "$_file" in
      *.zip) (cd "$_tmp" && { unzip -q "$_file" 2>/dev/null || python3 -m zipfile -e "$_file" .; }) ;;
      *.tar.gz|*.tgz) tar -xzf "$_tmp/$_file" -C "$_tmp" ;;
    esac
    _bin=$(find "$_tmp" -type f -name "$_name" | head -1)
    if [ -n "$_bin" ]; then _ok=1; break; fi
    echo "karyo: $_url had no $_name in it" >&2
  done
  IFS=$_old_ifs
  if [ -z "$_ok" ]; then
    echo "karyo: couldn't set up $_name: no internet here, or the network blocks the downloads above" >&2
    rm -rf "$_tmp"; return 1
  fi
  chmod +x "$_bin" && mv "$_bin" "$_dest/$_name.new" && mv "$_dest/$_name.new" "$_dest/$_name"
  rm -rf "$_tmp"
  echo "$_dest/$_name"
}

karyo_tool() { # name root
  _found=
  # KARYO_TOOLS_FETCHED_ONLY=1 ignores installed copies (tests of the fetch path; see dev/scripts/plugin/cowork-sim.sh)
  [ "${KARYO_TOOLS_FETCHED_ONLY:-}" = 1 ] || _found=$(command -v "$1" 2>/dev/null)
  if [ -z "$_found" ] && [ "${KARYO_TOOLS_FETCHED_ONLY:-}" != 1 ]; then
    case "$1" in
      bun) _homes="$HOME/.bun/bin/bun /opt/homebrew/bin/bun /usr/local/bin/bun" ;;
      uv) _homes="$HOME/.local/bin/uv $HOME/.cargo/bin/uv /opt/homebrew/bin/uv /usr/local/bin/uv" ;;
    esac
    for _c in $_homes; do [ -x "$_c" ] && { _found=$_c; break; }; done
  fi
  [ -n "$_found" ] && { echo "$_found"; return 0; }
  _karyo_fetch "$1" "$2"
}
