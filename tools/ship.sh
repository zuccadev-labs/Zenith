#!/usr/bin/env bash
# Push, then run the full CI on exactly that commit and wait for its verdict.
#
#   tools/ship.sh                 # push the current branch
#   tools/ship.sh origin main     # same arguments as `git push`
#   git config alias.ship '!tools/ship.sh'   # optional: `git ship`
#
# In this organisation's private repositories a push does not start GitHub Actions (only manual dispatch does), and
# the free plan has no branch protection. This closes the gap without paying: the .githooks/pre-push gate runs
# before the push, and this dispatches ci.yml for the pushed commit and fails if the CI fails.
set -euo pipefail

git push "$@"

branch="$(git rev-parse --abbrev-ref HEAD)"
sha="$(git rev-parse HEAD)"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

gh workflow run ci.yml -R "$repo" --ref "$branch"
echo "CI dispatched for $branch at ${sha:0:7}; waiting for the run to appear…"

run=""
for _ in $(seq 1 30); do
  run="$(gh run list -R "$repo" --workflow ci.yml --branch "$branch" --event workflow_dispatch -L 10 \
    --json databaseId,headSha --jq "[.[] | select(.headSha == \"$sha\")][0].databaseId // empty")"
  [[ -n "$run" ]] && break
  sleep 2
done
[[ -z "$run" ]] && { echo "the CI run did not appear; check: gh run list -R $repo" >&2; exit 1; }

echo "https://github.com/$repo/actions/runs/$run"
if gh run watch "$run" -R "$repo" --exit-status --interval 20 >/dev/null; then
  echo "✅ CI green for ${sha:0:7}"
else
  gh run view "$run" -R "$repo" --json jobs --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "❌ \(.name): \(.conclusion)"'
  exit 1
fi
