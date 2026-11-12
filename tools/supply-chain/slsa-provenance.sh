#!/usr/bin/env bash
# SLSA v1 build provenance predicate for the Zenith image, printed as JSON.
#
#   tools/supply-chain/slsa-provenance.sh zenith-backend/Dockerfile > provenance.json
#   cosign attest-blob --key cosign.key --type slsaprovenance1 --predicate provenance.json \
#     --tlog-upload=false --use-signing-config=false --bundle image-id.provenance.sigstore.json zenith-backend.image-id
#
# GitHub's own attestations need GitHub Enterprise for private repositories. This is the open-source equivalent:
# the same SLSA predicate, signed with our cosign key and not published to the public transparency log.
#
# It records what was built (repository and commit), how (workflow, run, event) and from what (the digests of the
# Dockerfile's base images, which must be pulled already: `docker build` does it). Reads the GITHUB_* variables;
# outside Actions it describes the local checkout.
set -euo pipefail

dockerfile="${1:?usage: slsa-provenance.sh <Dockerfile>}"
repo_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/zenith}"
sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
ref="${GITHUB_REF:-$(git symbolic-ref -q HEAD || echo detached)}"
workflow="${GITHUB_WORKFLOW_REF:-local}"
run_url="${GITHUB_RUN_ID:+$repo_url/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}}"
started="${PROVENANCE_STARTED_ON:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# Digest of a base image: pinned in the FROM line, else the local copy, else the registry. `docker build` with
# BuildKit (the default, and what the CI runner does) keeps base images in its own cache, not in the image store,
# so `docker image inspect` finds nothing there: the registry answers instead. Each lookup may fail without
# aborting (pipefail would end the script silently); only an unresolved digest is an error.
base_digest() {
  local image="$1" d=""
  [[ "$image" == *@sha256:* ]] && { echo "${image##*@}"; return; }
  d="$(docker image inspect "$image" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null |
    head -n1 | sed 's/.*@//' || true)"
  [[ -z "$d" ]] && d="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' 2>/dev/null |
    jq -r '.digest // empty' || true)"
  echo "$d"
}

# Base images: "FROM image[:tag] [AS name]", skipping stages that build FROM an earlier stage.
deps="$(jq -n --arg uri "git+$repo_url@$ref" --arg sha "$sha" '[{uri: $uri, digest: {gitCommit: $sha}}]')"
stages=()
while read -r image alias; do
  [[ -n "$alias" ]] && stages+=("$alias")
  for s in "${stages[@]:-}"; do [[ "$image" == "$s" ]] && continue 2; done
  digest="$(base_digest "$image")"
  [[ -z "$digest" ]] && { echo "cannot resolve the digest of base image $image" >&2; exit 1; }
  deps="$(jq --arg uri "pkg:docker/$image" --arg d "${digest#sha256:}" '. + [{uri: $uri, digest: {sha256: $d}}]' <<<"$deps")"
done < <(awk 'toupper($1)=="FROM" { img=$2; alias=""; if (toupper($3)=="AS") alias=$4; print img, alias }' "$dockerfile")

jq -n \
  --arg repo "$repo_url" --arg ref "$ref" --arg sha "$sha" --arg workflow "$workflow" \
  --arg dockerfile "$dockerfile" --arg event "${GITHUB_EVENT_NAME:-local}" --arg run "$run_url" \
  --arg started "$started" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson deps "$deps" \
  '{
    buildDefinition: {
      buildType: "https://github.com/zuccadev-labs/Zenith/tools/supply-chain/docker-build@v1",
      externalParameters: { repository: $repo, ref: $ref, workflow: $workflow, dockerfile: $dockerfile },
      internalParameters: { event: $event },
      resolvedDependencies: $deps
    },
    runDetails: {
      builder: { id: ($repo + "/" + $workflow) },
      metadata: ({ startedOn: $started, finishedOn: $finished } + (if $run != "" then { invocationId: $run } else {} end))
    }
  }'
