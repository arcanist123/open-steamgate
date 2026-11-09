#!/usr/bin/env bash
# Prove that the local tag the smoke suite tested is the image pushed by
# digest, and that the pushed image is for the expected platform and commit.
#
#   verify-pushed.sh <repository> <manifest-digest> <tested-tag> <platform> <revision>
#
# What `docker image inspect --format '{{.Id}}'` returns depends on the
# daemon's image store. The classic store (overlay2 graph driver) answers the
# image CONFIG digest; the containerd image store (the default of Docker 29,
# which ubuntu-26.04 runners ship) answers the MANIFEST digest of the pulled
# image. Either one identifies the content; anything else is a different image.
# Each failing check says what it expected and what it got, so a red step names
# its own cause.
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <repository> <manifest-digest> <tested-tag> <platform> <revision>" >&2
  exit 2
fi
repository="$1" digest="$2" tested="$3" platform="$4" revision="$5"

fail() { echo "verify-pushed: $*" >&2; exit 1; }

[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "not a manifest digest: '$digest'"

tested_id="$(docker image inspect --format '{{.Id}}' "$tested")"
pushed_config="$(docker buildx imagetools inspect "$repository@$digest" --raw | jq -er '.config.digest')"
if [[ "$tested_id" == "$pushed_config" ]]; then
  echo "verify-pushed: tested image ID is the pushed config $pushed_config (classic image store)"
elif [[ "$tested_id" == "$digest" ]]; then
  echo "verify-pushed: tested image ID is the pushed manifest $digest (containerd image store)"
else
  fail "tested image $tested has ID $tested_id; pushed manifest $digest has config $pushed_config"
fi

pushed_image="$(docker buildx imagetools inspect "$repository@$digest" --format '{{json .Image}}')"
pushed_platform="$(jq -r '.os + "/" + .architecture' <<<"$pushed_image")"
[[ "$pushed_platform" == "$platform" ]] || fail "pushed platform $pushed_platform, expected $platform"
pushed_revision="$(jq -r '.config.Labels["org.opencontainers.image.revision"] // ""' <<<"$pushed_image")"
[[ "$pushed_revision" == "$revision" ]] || fail "pushed revision label '$pushed_revision', expected $revision"
echo "verify-pushed: $repository@$digest is $platform at $revision"
