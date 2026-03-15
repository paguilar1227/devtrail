#!/bin/bash
# scripts/deploy.sh — Build, push to ACR, deploy Container App + run migrations
set -euo pipefail

# Configuration
RESOURCE_GROUP="${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
ACR_NAME="${ACR_NAME:?Set ACR_NAME}"
CONTAINER_APP_NAME="${CONTAINER_APP_NAME:-openbrain-prod-api}"
IMAGE_NAME="open-brain-v2"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

echo "=== Building Docker image ==="
docker build -t "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}" .
docker tag "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}" "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"

echo "=== Pushing to ACR ==="
az acr login --name "${ACR_NAME}"
docker push "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
docker push "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"

echo "=== Updating Container App ==="
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --image "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"

echo "=== Deploying Azure Function ==="
FUNCTION_APP_NAME="${FUNCTION_APP_NAME:-openbrain-prod-func}"
cd functions/consolidation-trigger
func azure functionapp publish "${FUNCTION_APP_NAME}" --typescript
cd ../..

echo "=== Done! ==="
az containerapp show --name "${CONTAINER_APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query "properties.configuration.ingress.fqdn" -o tsv
