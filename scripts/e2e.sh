#!/usr/bin/env bash
# Runs the WebdriverIO suite several times in a row against already built binaries.
# usage: scripts/e2e.sh <external|embedded> [runs]
#   external - release build driven by tauri-driver and the OS webview driver (Linux, Windows)
#   embedded - debug build with the `e2e` feature, WebDriver server inside the app (all platforms)
set -uo pipefail
driver=${1:?usage: e2e.sh <external|embedded> [runs]}
runs=${2:-${E2E_RUNS:-5}}

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
  echo "::group::E2E $driver, run $run of $runs"
  if (cd "$root/ui" && E2E_RUN=$run bash "$root/scripts/gui.sh" pnpm e2e); then
    passed=$((passed + 1))
  fi
  echo "::endgroup::"
done

echo "E2E $driver: $passed of $runs runs passed"
if [ -n "${NOTES_DIR:-}" ]; then
  echo "$passed of $runs runs passed" >"$NOTES_DIR/e2e_$driver"
fi
[ "$passed" -eq "$runs" ]
