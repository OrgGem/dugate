#!/usr/bin/env bash
# Shell Script: Initialize MinIO Bucket (with Versioning) and HashiCorp Vault (KV v2 + Transit)
set -euo pipefail

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9003}"
MINIO_USER="${MINIO_USER:-minioadmin}"
MINIO_PASSWORD="${MINIO_PASSWORD:-minioadmin_secret}"
BUCKET_NAME="${BUCKET_NAME:-du-artifacts-live}"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_ROOT_TOKEN="${VAULT_ROOT_TOKEN:-root-dev-token}"

echo "=========================================================="
echo "  Initializing Live Test Infrastructure (MinIO + Vault)  "
echo "=========================================================="

echo "[1/4] Waiting for MinIO to be healthy..."
for i in {1..30}; do
  if curl -sf "${MINIO_ENDPOINT}/minio/health/live" > /dev/null 2>&1; then
    echo "  -> MinIO is healthy at ${MINIO_ENDPOINT}"
    break
  fi
  sleep 1
done

echo "[2/4] Setting up MinIO bucket: ${BUCKET_NAME} with Object Versioning..."
NETWORK="du-rework-live_default"
docker run --rm --network "${NETWORK}" minio/mc /bin/sh -c "
  mc alias set local http://minio:9000 ${MINIO_USER} ${MINIO_PASSWORD}
  mc mb --ignore-existing local/${BUCKET_NAME}
  mc version enable local/${BUCKET_NAME}
  mc version info local/${BUCKET_NAME}
"

echo "[3/4] Waiting for HashiCorp Vault to be healthy..."
for i in {1..30}; do
  if curl -sf "${VAULT_ADDR}/v1/sys/health" > /dev/null 2>&1; then
    echo "  -> Vault is healthy at ${VAULT_ADDR}"
    break
  fi
  sleep 1
done

echo "[4/4] Configuring Vault KV v2 & Transit KMS..."
docker exec -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" du-live-vault vault secrets enable -version=2 -path=secret kv 2>/dev/null || true
docker exec -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" du-live-vault vault secrets enable -path=transit transit 2>/dev/null || true
docker exec -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" du-live-vault vault write -f transit/keys/du-app-encryption-key type=aes256-gcm96

POLICIES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../vault/policies" && pwd)"
if [ -f "${POLICIES_DIR}/orchestrator-writer.hcl" ]; then
  cat "${POLICIES_DIR}/orchestrator-writer.hcl" | docker exec -i -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" du-live-vault vault policy write orchestrator-writer -
fi
if [ -f "${POLICIES_DIR}/connector-reader.hcl" ]; then
  cat "${POLICIES_DIR}/connector-reader.hcl" | docker exec -i -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" du-live-vault vault policy write connector-reader -
fi

echo "=========================================================="
echo "  Live Test Infrastructure is FULLY READY for Testing!    "
echo "=========================================================="
