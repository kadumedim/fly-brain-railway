#!/usr/bin/env sh
# Build and push the fly-web image.
#
# Railway runs linux/amd64. A plain `docker build` on an Apple Silicon Mac
# produces an arm64 image, and the container then dies with
#   exec container process `/usr/local/bin/docker-entrypoint.sh`: Exec format error
# (and the generated domain 502s). Always go through this script.
#
#   ./build-push.sh
#   IMAGE=ghcr.io/you/fly-web:latest ./build-push.sh
set -eu

IMAGE="${IMAGE:-${1:-ghcr.io/kadumedim/fly-web:latest}}"
cd "$(dirname "$0")"

# --push (not `docker push`): buildx with an explicit --platform never loads the
# image into the local daemon, so a separate push would upload nothing new.
# --provenance=false keeps the tag a plain single-arch manifest instead of an OCI
# index carrying an unknown/unknown attestation entry.
docker buildx build \
	--platform linux/amd64 \
	--provenance=false \
	-t "$IMAGE" \
	--push \
	.

# Print the pushed image's platform so the arch is visible after every build.
printf 'pushed %s -- platform: ' "$IMAGE"
docker buildx imagetools inspect "$IMAGE" --format '{{.Image.OS}}/{{.Image.Architecture}}'
