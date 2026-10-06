# LIV-03 — Services health & environment evidence (cc_1)

**Packet:** liv03-services-health · **Lane:** cc_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T00:47+07:00 (coordinator command-code).
**Status:** READ-ONLY (curl/netstat/Get-Process/docker ps/đọc file). Không restart service, không sửa file nào, không stop container của user; không tick gate (mọi gate giữ **NO-GO**); không commit; không chạm `nocobase-10`. File duy nhất được ghi: receipt này.

## 1. Health checks ×3 (literal)

**Loose sequence** (giữa các round có thu thập evidence tĩnh xen kẽ):

| round | timestamp | 3000/health | 3001/admin/login | 8091/health/ready |
|---|---|---|---|---|
| 1 | 2026-10-04T00:53:15+07:00 | **200** | **200** | **200** |
| 2 | 2026-10-04T00:54:28+07:00 | **200** | **200** | **200** |
| 3 | 2026-10-04T00:55:06+07:00 | **200** | **200** | **200** |

**Tight sequence (đúng nhịp ~10s):**

```
round 1 @ 2026-10-04T00:55:23.630+07:00 : 3000=200 3001=200 8091=200
round 2 @ 2026-10-04T00:55:33.829+07:00 : 3000=200 3001=200 8091=200   (+10.2s)
round 3 @ 2026-10-04T00:55:43.859+07:00 : 3000=200 3001=200 8091=200   (+10.0s)
```

Body trích (không secret):

- `GET 3000/health` → `{"status":"ok","db":true,"redis":true,"activeLeases":0,"queueIntegrity":{"state":"OK","orphansLast":0,"stalled":0,"lastSweepAt":"…T17:53:11Z"}}` — `lastSweepAt` tiến theo từng round (`17:53:11Z → 17:54:26Z → 17:55:06Z`) ⇒ sweep timer nền đang chạy.
- `GET 3001/admin/login` → HTML `<!doctype html>… <title>Admin sign-in</title>…`.
- `GET 8091/health/ready` → `{"ok":true}`.

**Verdict: PASS** (3 URL × 3 round × 2 sequence = 18/18 HTTP 200).

## 2. Bindings (port → PID → process)

```
> netstat -ano | Select-String LISTENING   (lọc 8 port đích)
port 3000 <- PID 51792 (node)         port 5433 <- PID 47940 (com.docker.backend)
port 3001 <- PID 51792 (node)         port 6380 <- PID 47940 (com.docker.backend)
port 8091 <- PID 55548 (node)         port 9003 <- PID 47940 (com.docker.backend)
                                      port 9014 <- PID 47940 (com.docker.backend)
                                      port 8200 <- PID 47940 (com.docker.backend)

> docker ps --filter name=du-live
du-live-postgres | Up 47 minutes (healthy) | 127.0.0.1:5433->5432/tcp
du-live-vault    | Up 47 minutes (healthy) | 127.0.0.1:8200->8200/tcp
du-live-redis    | Up 47 minutes (healthy) | 127.0.0.1:6380->6379/tcp
du-live-minio    | Up 47 minutes (healthy) | 127.0.0.1:9003->9000/tcp, 127.0.0.1:9014->9001/tcp
```

Process map (node, `Get-CimInstance Win32_Process`):

| PID | start | command | vai trò |
|---|---|---|---|
| 40528 | 00:38:48 | `scripts/dev.cjs --env-file=.env.live` | dev runner (spawn 3 service, console logs, single Ctrl+C) |
| 51792 | 00:38:49 | `services/orchestrator/dist/main.js --env-file=.env.live` | Orchestrator API **3000** + Admin shell **3001** (cùng process) |
| 55548 | 00:38:49 | `services/connector/dist/entrypoint.js --env-file=.env.live` | Connector **8091** |
| 40276 | 00:38:49 | `businesses/document-core/dist/main.js --env-file=.env.live` | Worker document-core |

**Verdict: PASS** — mọi port đích có owner xác định; container du-live healthy.

## 3. Env inventory `du-rework/.env.live` (mask toàn bộ giá trị)

62 dòng (10 comment, 42 key). Danh sách **chỉ tên key** + đánh dấu; giá trị không xuất hiện ở bất kỳ đâu trong receipt:

| nhóm | key |
|---|---|
| runtime/infra | `DU_LIVE_INFRA`, `DATABASE_URL` [url-có-creds], `AUTO_MIGRATE`, `REDIS_URL` [url], `ORCHESTRATOR_PORT`(=3000), `PORT`(=3000), `ADMIN_SHELL_PORT`(=3001), `CONNECTOR_PORT`(=8091) |
| storage | `ARTIFACT_STORAGE_BACKEND`, `ARTIFACT_S3_ENDPOINT` [url], `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_FORCE_PATH_STYLE`, `ARTIFACT_STORAGE_MIGRATION_WINDOW`, `AWS_ACCESS_KEY_ID` **[SECRET]**, `AWS_SECRET_ACCESS_KEY` **[SECRET]** |
| vault | `VAULT_ADDR` [url], `VAULT_TOKEN` **[SECRET]** (len=14 — khớp `root-dev-token`, đã xác thực `lookup-self` ở LIV-05), `VAULT_TRANSIT_MOUNT`, `VAULT_TRANSIT_KEY` (tên key, không phải secret), `VAULT_KV_MOUNT`, `DU_VAULT_TRANSIT_ENC_TOKEN` **[SECRET]**, `DU_VAULT_TRANSIT_DEC_TOKEN` **[SECRET]**, `DU_VAULT_TRANSIT_OPTIONS`, `DU_ENCRYPTION_METADATA_ENABLED`, `DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED` |
| auth/token | `ADMIN_SHELL_COOKIE_SECRET` **[SECRET]**, `RUNTIME_TOKEN` **[SECRET]** (×2 lần trong file — **giá trị giống hệt nhau**, sha12 khớp), `ADMIN_TOKEN` **[SECRET]**, `WORKER_IDENTITY_TOKENS_BY_BUSINESS` **[SECRET]**, `WORKER_RUNTIME_TOKEN` **[SECRET]**, `CONNECTOR_SERVICE_TOKEN` **[SECRET]**, `SERVICE_IDENTITY_SECRET` **[SECRET]**, `INVOCATION_GRANT_SECRET` **[SECRET]**, `CONNECTOR_ENCRYPTION_KEY` **[SECRET]** (len=44, không phải hex → dạng base64/32-byte key) |
| khác | `RUNTIME_URL` [url], `CONNECTOR_URL` [url], `CONNECTOR_REDIS_PREFIX`, `CONNECTOR_MIGRATION_DIRECTORY`, `DOCUMENT_CORE_CONCURRENCY`(=2), `HEARTBEAT_INTERVAL_MS`(=5000), `SHUTDOWN_GRACE_MS` |

**Hai deviation được xác nhận bằng netstat + docker:**

| deviation | bằng chứng |
|---|---|
| `CONNECTOR_PORT=8091` (thay vì 8081) | port **8081** ← container `graphql-data-connector-agent-1` (`0.0.0.0:8081->8081/tcp`) — chiếm trước; connector rework chạy 8091 và `health/ready=200` |
| MinIO console **9014** (thay vì 9004) | port **9004** ← container `onlyoffice-documentserver` (`0.0.0.0:9004->80/tcp`); minio compose map `9014->9001` |

**Verdict: PASS** — inventory đủ, mask đúng, 2 deviation đúng như ghi nhận trước.

## 4. Worker

- **Dev runner:** PID 40528 `scripts/dev.cjs --env-file=.env.live` (đầu file ghi rõ: "Runs Orchestrator, Connector, and Worker in a single terminal with colored logs and single Ctrl+C shutdown" — nên **log đi vào console của terminal, không ghi file**).
- **Worker process:** PID **40276** `businesses/document-core/dist/main.js --env-file=.env.live`, start 00:38:49.
- **Liveness (TCP ESTABLISHED, đọc qua netstat theo PID):**
  - 40276 → Redis **6380** ×2 (BullMQ consumer) + Orchestrator **3000** ×1 (runtime API) ⇒ worker sống và đã nối đúng backend.
  - 55548 (connector) → **6380** ×1 (+ephemeral).
  - 51792 (orchestrator) → **5433** ×4 (PG pool) + **6380** ×1 (+ephemeral).
- **Log gần nhất:** quét `*.log` trong `du-rework` (excl node_modules) 2 giờ gần nhất = **0 file** — khớp thiết kế console-only của dev runner. Không truy được log file ⇒ **không chứng minh bằng log**, chỉ kết luận bằng process + TCP; ghi đúng thực tế, không suy diễn.

**Verdict: PASS (process + TCP)** — log-file evidence: **không chứng minh được** (không có file log; runner ghi console).

## 5. Tổng hợp verdict

| mục | verdict |
|---|---|
| Health 3000/3001/8091 (×3 round loose + ×3 tight 10s) | **PASS** — 18/18 HTTP 200; body hợp lệ |
| Bindings 8 port + docker du-live | **PASS** — owner xác định; 4 container healthy |
| Env inventory + mask | **PASS** — 42 key liệt kê đúng, secret đánh dấu, 0 giá trị lộ |
| Deviation 8091 / 9014 | **PASS** — xác nhận bằng container chiếm port |
| Worker process + wiring | **PASS** — PID 40276, ESTABLISHED 6380/3000 |
| Worker log file | **KHÔNG CHỨNG MINH ĐƯỢC** — dev runner console-only, 0 file `.log` |

## 6. Commands (literal)

```
cwd: D:\Git\dugate
Invoke-WebRequest http://127.0.0.1:3000/health | 3001/admin/login | 8091/health/ready   (×3 + tight ×3 with Start-Sleep 10)
netstat -ano | Select-String LISTENING   → lọc 3000/3001/8091/5433/6380/9003/9014/8200 (+8081/9004 cho deviation)
docker ps --filter name=du-live ; docker ps --format '{{.Names}} | {{.Ports}}'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" ; Get-Process -Id <pid>
netstat -ano | Select-String ESTABLISHED | lọc theo PID (40276/55548/51792)
Get-Content du-rework/.env.live  → chỉ in TÊN key + cờ secret; SHA12/length cho 5 key nhạy cảm
```

Chỉ đọc — không restart, không sửa gì, không dừng container nào; không tick gate, không commit.
