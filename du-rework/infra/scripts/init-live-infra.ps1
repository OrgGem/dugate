# PowerShell Script: Initialize MinIO Bucket (with Versioning) and HashiCorp Vault (KV v2 + Transit)
# Cwd: du-rework/

param(
  [string]$MinioEndpoint = "http://127.0.0.1:9003",
  [string]$MinioUser = "minioadmin",
  [string]$MinioPassword = "minioadmin_secret",
  [string]$BucketName = "du-artifacts-live",
  [string]$VaultAddr = "http://127.0.0.1:8200",
  [string]$VaultRootToken = "root-dev-token"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Initializing Live Test Infrastructure (MinIO + Vault)  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Wait for MinIO container
Write-Host "[1/4] Waiting for MinIO to be healthy..." -ForegroundColor Yellow
$minioReady = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $res = Invoke-WebRequest -Uri "$MinioEndpoint/minio/health/live" -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -eq 200) {
      $minioReady = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $minioReady) {
  Write-Error "MinIO is not reachable at $MinioEndpoint after 30 seconds."
}
Write-Host "  -> MinIO is healthy at $MinioEndpoint" -ForegroundColor Green

# 2. Configure MinIO bucket & enable versioning using internal mc
Write-Host "[2/4] Setting up MinIO bucket: $BucketName with Object Versioning..." -ForegroundColor Yellow
docker exec du-live-minio mc alias set local http://127.0.0.1:9000 $MinioUser $MinioPassword
docker exec du-live-minio mc mb --ignore-existing local/$BucketName
docker exec du-live-minio mc version enable local/$BucketName
docker exec du-live-minio mc version info local/$BucketName
Write-Host "  -> Bucket $BucketName ready and Versioning enabled." -ForegroundColor Green

# 3. Wait for Vault container
Write-Host "[3/4] Waiting for HashiCorp Vault to be healthy..." -ForegroundColor Yellow
$vaultReady = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $res = Invoke-WebRequest -Uri "$VaultAddr/v1/sys/health" -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -in 200, 429, 472, 473) {
      $vaultReady = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $vaultReady) {
  Write-Error "Vault is not reachable at $VaultAddr after 30 seconds."
}
Write-Host "  -> Vault is healthy at $VaultAddr" -ForegroundColor Green

# 4. Configure Vault KV v2 and Transit Engine
Write-Host "[4/4] Configuring Vault KV v2 & Transit KMS..." -ForegroundColor Yellow

$secretsList = docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault secrets list

# Check KV v2 at secret/
if ($secretsList -notmatch "secret/\s+kv") {
  docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault secrets enable -version=2 -path=secret kv
  Write-Host "  -> KV v2 engine enabled at secret/" -ForegroundColor Green
} else {
  Write-Host "  -> KV v2 engine already mounted at secret/ (OK)" -ForegroundColor Gray
}

# Check Transit engine at transit/
if ($secretsList -notmatch "transit/\s+transit") {
  docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault secrets enable -path=transit transit
  Write-Host "  -> Transit KMS engine enabled at transit/" -ForegroundColor Green
} else {
  Write-Host "  -> Transit KMS engine already mounted at transit/ (OK)" -ForegroundColor Gray
}

# Create symmetric transit key for App-layer encryption
docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault write -f transit/keys/du-app-encryption-key type=aes256-gcm96
Write-Host "  -> Transit key 'du-app-encryption-key' configured." -ForegroundColor Green

# Apply policies
$policiesDir = "D:\Git\dugate\du-rework\infra\vault\policies"
if (Test-Path "$policiesDir\orchestrator-writer.hcl") {
  docker cp "$policiesDir\orchestrator-writer.hcl" du-live-vault:/tmp/ow.hcl
  docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault policy write orchestrator-writer /tmp/ow.hcl
  Write-Host "  -> Policy 'orchestrator-writer' uploaded." -ForegroundColor Green
}
if (Test-Path "$policiesDir\connector-reader.hcl") {
  docker cp "$policiesDir\connector-reader.hcl" du-live-vault:/tmp/cr.hcl
  docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=$VaultRootToken du-live-vault vault policy write connector-reader /tmp/cr.hcl
  Write-Host "  -> Policy 'connector-reader' uploaded." -ForegroundColor Green
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Live Test Infrastructure is FULLY READY for Testing!    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
