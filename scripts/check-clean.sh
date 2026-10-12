#!/usr/bin/env bash
# Repository hygiene check: fails if any tracked file, tracked file name or commit message of this
# branch matches a deny pattern, or if a tracked text file contains non-ASCII characters.
# The patterns are kept outside the repository.
#
# usage: scripts/check-clean.sh <deny-patterns-file> [allow-patterns-file] [base-ref]
#   deny file:  one case-insensitive extended regex per line; blank lines and # comments ignored
#   allow file: extended regexes matched against whole report lines ("path:line:text");
#               a matching line is an accepted exception
#   base-ref:   commits in base-ref..HEAD have their messages checked (default: main)
set -uo pipefail
deny=${1:?usage: check-clean.sh <deny-patterns-file> [allow-patterns-file] [base-ref]}
allow=${2:-}
base=${3:-main}
cd "$(git rev-parse --show-toplevel)" || exit 2

patterns=$(mktemp)
allowed=$(mktemp)
trap 'rm -f "$patterns" "$allowed"' EXIT
grep -v -E '^[[:space:]]*(#|$)' "$deny" >"$patterns"
[ -s "$patterns" ] || { echo "no patterns in $deny"; exit 2; }
if [ -n "$allow" ]; then grep -v -E '^[[:space:]]*(#|$)' "$allow" >"$allowed"; fi

# drops accepted exceptions; prints the rest
unaccepted() {
  if [ -s "$allowed" ]; then grep -v -E -f "$allowed"; else cat; fi
}

status=0
report() {
  local title=$1 hits
  hits=$(unaccepted)
  if [ -n "$hits" ]; then
    echo "== $title"
    echo "$hits"
    status=1
  fi
}

# process substitution, not a pipe: report must set $status in this shell
report "tracked file contents" < <(git grep -n -I -i -E -f "$patterns" -- .)
report "tracked file names" < <(git ls-files | grep -n -i -E -f "$patterns")
report "commit messages and authors ($base..HEAD)" < <(git log --format='%h %an <%ae>%n%B' "$base..HEAD" | grep -n -i -E -f "$patterns")
report "non-ASCII characters in tracked text files" < <(LC_ALL=C git grep -n -I -e '[^[:print:][:space:]]' -- .)

files=$(git ls-files | wc -l | tr -d ' ')
commits=$(git rev-list --count "$base..HEAD")
if [ "$status" -eq 0 ]; then
  echo "clean: $files tracked files, $commits commit(s) in $base..HEAD, $(wc -l <"$patterns" | tr -d ' ') patterns"
else
  echo "NOT CLEAN"
fi
exit "$status"
