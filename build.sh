#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build.sh — build the Docker image and push to your private registry
#
# Usage:
#   ./build.sh           → builds with tag "latest"
#   ./build.sh 1.2.3     → builds with tag "1.2.3" (also tags as latest)
#
# Reads REGISTRY from .env (or from the environment).
# ---------------------------------------------------------------------------

# Load .env if present
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

# Validate
if [ -z "${REGISTRY:-}" ]; then
  echo "Error: REGISTRY is not set."
  echo "  Add  REGISTRY=your.registry.example.com  to .env"
  exit 1
fi

IMAGE="${REGISTRY}/streamable"
TAG="${1:-latest}"

echo "▶ Building  ${IMAGE}:${TAG}"
docker build --platform linux/amd64 -t "${IMAGE}:${TAG}" .

# Always keep a :latest tag in sync
if [ "${TAG}" != "latest" ]; then
  docker tag "${IMAGE}:${TAG}" "${IMAGE}:latest"
fi

echo "▶ Pushing   ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"

if [ "${TAG}" != "latest" ]; then
  echo "▶ Pushing   ${IMAGE}:latest"
  docker push "${IMAGE}:latest"
fi

echo "✓ Done — ${IMAGE}:${TAG}"
