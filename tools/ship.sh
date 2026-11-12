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

# A dispatch resolves the branch when GitHub receives it: right after a push it can still resolve to the previous
# commit (it happened). Wait until GitHub sees the pushed commit on the branch.
for _ in $(seq 1 30); do
  [[ "$(gh api "repos/$repo/branches/$branch" --jq .commit.sha 2>/dev/null)" == "$sha" ]] && break
  sleep 2
done

# Recent gh prints the run's URL: take its id; otherwise find the run by commit (it can take a minute to be listed).
out="$(gh workflow run ci.yml -R "$repo" --ref "$branch" 2>&1)"
echo "CI dispatched for $branch at ${sha:0:7}"
run="$(grep -oE '/actions/runs/[0-9]+' <<<"$out" | grep -oE '[0-9]+$' | head -n1 || true)"
for _ in $(seq 1 60); do
  [[ -n "$run" ]] && break
  run="$(gh run list -R "$repo" --workflow ci.yml --branch "$branch" --event workflow_dispatch -L 10 \
    --json databaseId,headSha --jq "[.[] | select(.headSha == \"$sha\")][0].databaseId // empty")"
  [[ -n "$run" ]] && break
  sleep 3
done
[[ -z "$run" ]] && { echo "the CI run did not appear; check: gh run list -R $repo" >&2; exit 1; }
# The verdict must be about this commit, not about whatever the branch pointed to.
# Right after the dispatch the run can still answer 404 for a few seconds (it happened): retry.
run_sha=""
for _ in $(seq 1 20); do
  run_sha="$(gh run view "$run" -R "$repo" --json headSha --jq .headSha 2>/dev/null || true)"
  [[ -n "$run_sha" ]] && break
  sleep 3
done
if [[ "$run_sha" != "$sha" ]]; then
  echo "the CI run $run tests ${run_sha:0:7}, not ${sha:0:7}: run tools/ship.sh again" >&2
  exit 1
fi

echo "https://github.com/$repo/actions/runs/$run"
if gh run watch "$run" -R "$repo" --exit-status --interval 20 >/dev/null; then
  echo "✅ CI green for ${sha:0:7}"
else
  gh run view "$run" -R "$repo" --json jobs --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "❌ \(.name): \(.conclusion)"'
  exit 1
fi
