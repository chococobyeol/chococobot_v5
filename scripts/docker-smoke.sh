#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-chococobot-v5:smoke}"
ENV_FILE="${ENV_FILE:-.env.smoke}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; create it from .env.smoke or set ENV_FILE=/path/to/env" >&2
  exit 1
fi

docker build -t "${IMAGE_NAME}" .
docker run --rm --env-file "${ENV_FILE}" -e SMOKE_MODE=1 "${IMAGE_NAME}"
