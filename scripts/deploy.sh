#!/bin/bash
# scripts/deploy.sh — Build, push to ACR and roll the Container App to the new image.
# Migrations apply automatically when the container starts.
set -euo pipefail

# Configuration
RESOURCE_GROUP="${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
ACR_NAME="${ACR_NAME:?Set ACR_NAME}"
CONTAINER_APP_NAME="${CONTAINER_APP_NAME:-devtrail-prod-api}"
IMAGE_NAME="devtrail"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

echo "=== Building Docker image (linux/amd64 for Azure) ==="
docker build --platform linux/amd64 \
  -t "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}" .
docker tag "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}" \
  "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"

echo "=== Pushing to ACR ==="
az acr login --name "${ACR_NAME}"
docker push "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
docker push "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:latest"

echo "=== Updating Container App ==="
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --image "${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"

echo ""
echo "=== Deploy complete! ==="
FQDN=$(az containerapp show \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "properties.configuration.ingress.fqdn" -o tsv)
echo "App URL: https://${FQDN}"
echo "MCP URL: https://${FQDN}/mcp (send Authorization: Bearer <DEVTRAIL_API_KEY>)"
