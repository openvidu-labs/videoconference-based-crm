#!/usr/bin/env bash
# Stop and remove the OpenVidu Meet + Lilac CRM deployment.
# Add -v to also remove the OpenVidu data volumes.
set -euo pipefail
cd "$(dirname "$0")"

OPENVIDU_VERSION="${OPENVIDU_VERSION:-3.7.0}"
PROJECT_NAME="${PROJECT_NAME:-openvidu-crm}"

docker compose -p "$PROJECT_NAME" \
  -f "oci://openvidu/local-meet:${OPENVIDU_VERSION}" \
  -f docker-compose.app.yml \
  down "$@"
