#!/usr/bin/env bash
# Runs the WebdriverIO suite several times in a row against already built binaries.
# usage: scripts/e2e.sh <external|embedded> [runs] [normal|incognito]
#   external - release build driven by tauri-driver and the OS webview driver (Linux, Windows)
#   embedded - debug build with the `e2e` feature, WebDriver server inside the app (all platforms)
#   incognito - the app creates its window in incognito mode (PROBE_INCOGNITO=1), same binaries
set -uo pipefail
driver=${1:?usage: e2e.sh <external|embedded> [runs] [normal|incognito]}
runs=${2:-${E2E_RUNS:-5}}
mode=${3:-normal}
suffix=""
export PROBE_INCOGNITO=0
if [ "$mode" = incognito ]; then
  suffix=_incognito
  export PROBE_INCOGNITO=1
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
