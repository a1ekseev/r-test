#!/usr/bin/env bash
# Runs the WebdriverIO suite several times in a row against already built binaries.
# usage: scripts/e2e.sh <external|embedded> [runs] [normal|incognito|hardened]
#   external - release build driven by tauri-driver and the OS webview driver (Linux, Windows)
#   embedded - debug build with the `e2e` feature, WebDriver server inside the app (all platforms)
#   incognito - the app creates its window in incognito mode (PROBE_INCOGNITO=1), same binaries
#   hardened  - incognito, plus a webview data directory of its own, no form suggestions, and crash
#               dumps deleted at start and at exit (the WebView2 settings; same binaries)
set -uo pipefail
driver=${1:?usage: e2e.sh <external|embedded> [runs] [normal|incognito|hardened]}
runs=${2:-${E2E_RUNS:-5}}
mode=${3:-normal}
suffix=""
export PROBE_INCOGNITO=0
if [ "$mode" = incognito ]; then
  suffix=_incognito
  export PROBE_INCOGNITO=1
fi

if [ "$mode" = hardened ]; then
  suffix=_hardened
  export PROBE_INCOGNITO=1 PROBE_AUTOFILL=0 PROBE_CLEAN_CRASHPAD=1
fi

# pwd -W gives a native path under Git Bash on Windows
root=$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })
exe=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) exe=.exe ;; esac
profile=release
[ "$driver" = embedded ] && profile=debug

export E2E_DRIVER=$driver
export APP_BIN="$root/target/$profile/probe-app$exe"
export SERVER_BIN="$root/target/debug/probe-server$exe"
if [ "$mode" = hardened ]; then
  PROBE_DATA_DIR="$root/target/probe-hardened-data"
  # WebView2 takes its data folder as a native path
  if command -v cygpath >/dev/null; then PROBE_DATA_DIR=$(cygpath -w "$PROBE_DATA_DIR"); fi
  export PROBE_DATA_DIR
fi

passed=0
for run in $(seq "$runs"); do
  echo "::group::E2E $driver ($mode window), run $run of $runs"
  if (cd "$root/ui" && E2E_RUN=$run$suffix bash "$root/scripts/gui.sh" pnpm e2e); then
    passed=$((passed + 1))
  fi
  echo "::endgroup::"
done

echo "E2E $driver ($mode window): $passed of $runs runs passed"
if [ -n "${NOTES_DIR:-}" ]; then
  echo "$passed of $runs runs passed" >"$NOTES_DIR/e2e_$driver$suffix"
fi
[ "$passed" -eq "$runs" ]
