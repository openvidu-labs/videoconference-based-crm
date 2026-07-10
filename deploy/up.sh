#!/usr/bin/env bash
# Deploy OpenVidu Meet 3.8.0 (local deployment) together with the Lilac CRM app.
#
# OpenVidu's compose file is pulled as an OCI artifact and merged with
# docker-compose.app.yml, which adds the CRM container to the same project
# and network. See https://openvidu.io/latest/meet/deployment/local/
set -euo pipefail
cd "$(dirname "$0")"

OPENVIDU_VERSION="${OPENVIDU_VERSION:-3.8.0}"
PROJECT_NAME="${PROJECT_NAME:-openvidu-crm}"

./build.sh

docker compose -p "$PROJECT_NAME" \
  -f "oci://openvidu/local-meet:${OPENVIDU_VERSION}" \
  -f docker-compose.app.yml \
  up -d -y openvidu-meet-init crm-app

echo
echo "Deployment ready:"
echo "  CRM app:              http://localhost:3000"
echo "  OpenVidu Meet:        http://localhost:9080  (admin / admin)"
echo "  Meet REST API docs:   http://localhost:9080/meet/api/v1/docs/"
