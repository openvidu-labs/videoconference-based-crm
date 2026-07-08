#!/usr/bin/env bash
# Build the Lilac CRM Docker image (lilac-crm:latest).
set -euo pipefail
cd "$(dirname "$0")"

docker build -t lilac-crm:latest -f Dockerfile ..
echo "Built image lilac-crm:latest"
