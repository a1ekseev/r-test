#!/usr/bin/env bash
# Writes the job summary table and reports how many required checks did not succeed.
# Input: $RESULTS, one check per line as "id|label|outcome"; outcome is a step outcome
# (success, failure, cancelled, skipped) or "n/a" for a check that does not apply to this platform.
# Optional notes: files named after the check id in $NOTES_DIR; versions in $NOTES_DIR/versions.
set -uo pipefail
out=${GITHUB_STEP_SUMMARY:-/dev/stdout}
notes=${NOTES_DIR:-/nonexistent}
failed=0

{
  echo "### ${JOB_NAME:-probe}"
  echo
  echo "| Check | Result | Notes |"
  echo "|---|---|---|"
  while IFS='|' read -r id label outcome; do
    [ -n "$id" ] || continue
    case "$outcome" in
      success) mark="pass" ;;
      n/a) mark="n/a" ;;
      *)
        mark="FAIL ($outcome)"
        failed=$((failed + 1))
        ;;
    esac
    note=""
    [ -f "$notes/$id" ] && note=$(tr '\n' ' ' <"$notes/$id")
    echo "| $label | $mark | $note |"
  done <<<"${RESULTS:-}"
  echo
  if [ -f "$notes/versions" ]; then
    echo "| Component | Version |"
    echo "|---|---|"
    sed 's/^\([^=]*\)=\(.*\)$/| \1 | \2 |/' "$notes/versions"
  fi
} >>"$out"

echo "checks not passed: $failed"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "failed=$failed" >>"$GITHUB_OUTPUT"
fi
