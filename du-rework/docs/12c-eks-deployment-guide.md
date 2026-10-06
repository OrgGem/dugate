# EKS deployment guide (DU Rework)

**Phạm vi:** hướng dẫn từng bước đưa DU Rework lên Amazon EKS từ các sample manifests trong [`infra/eks/`](../infra/eks/README.md), đối chiếu topology mục tiêu ở [`architecture/19-eks-deployment.md`](../architecture/19-eks-deployment.md). Đây là **guide vận hành mục tiêu**, không phải bằng chứng deployment đã kiểm chứng. Gate/go-live vẫn theo [09-readiness](../architecture/09-readiness.md); triển khai Compose/EC2 hiện có xem [12b](12b-deployment-guide.md) và [06](../architecture/06-aws-deployment.md).

Mọi giá trị secret/hostname/account trong guide và YAML đều là **placeholder** (`ACCOUNT_ID`, `REGION`, `change-me`, `.example.com`). Không commit giá trị thật.

## 0. Quyết định cần chốt trước khi làm (deployment owner)

Region/AZ, VPC/subnets (public/private per AZ), cluster version, node-group/instance mix, RDS PostgreSQL SKU (Multi-AZ, 2 DB/role riêng platform/connector), ElastiCache Valkey SKU (`noeviction`, TLS + AUTH/ACL đã test với BullMQ), S3 bucket/KMS policy (private, versioning, encryption), ECR repo naming, ALB scheme (public/private), TLS cert (ACM), DNS, log sink (Elasticsearch/OpenSearch private), retention/PII, RPO/RTO, provider quota + egress policy, client compatibility. Agenda đầy đủ ở [09](../architecture/09-readiness.md).

## 1. Prerequisites

1. **Cluster:** EKS (khuyến nghị ≥ 1.29), 2–3 AZ, private node groups cho workload + public subnets cho ALB public (nếu dùng internet-facing).
2. **Add-ons/controllers:**
   - `aws-load-balancer-controller` (ALB Ingress + target-type `ip`).
   - `external-secrets` operator (Secrets Manager → K8s Secret) **hoặc** Sealed Secrets.
   - `metrics-server` (HPA CPU/memory); KEDA hoặc custom-metrics adapter nếu muốn HPA theo backlog/outbox age (khuyến nghị, xem [07](../architecture/07-capacity.md)).
   - Log collector: Fluent Bit DaemonSet → Elasticsearch/OpenSearch private qua TLS (JSON stdout đã redacted, buffer disk có quota).
   - (Tùy chọn) Vault Agent/CSI nếu dùng `DU_VAULT_*`; EBS/EFS CSI chỉ khi fixture test cần volume — DB production không chạy trong Pod.
3. **Managed plane sẵn sàng:** RDS (2 DB/role), ElastiCache Valkey, S3 bucket (versioning + SSE-S3/KMS), Secrets Manager chứa toàn bộ secret (xem §3), ECR repos cho 5 image.
4. **IAM (IRSA):** mỗi ServiceAccount một role tối thiểu:
   - `orchestrator` → S3 artifact bucket (scoped prefix) + KMS (nếu dùng) + Secrets Manager read (qua External Secrets) — **không** cần quyền provider egress.
   - `connector` → S3 scoped + Secrets Manager read + provider egress qua NAT (kết hợp `PROVIDER_ALLOW_HOSTS` ở tầng app).
   - workers (`document-core`, `lc-checker`, `example-review`) → S3 scoped (read source/pin, write output/checkpoint) + Secrets Manager read tối thiểu; **không** mount `DATABASE_URL`.
5. **Tooling:** `awscli v2`, `kubectl`, `kustomize` (hoặc kubectl ≥ 1.28 built-in), quyền `eks:AccessEntry` phù hợp.

## 2. Build, push, pin digest

Build từ `Dockerfile` gốc (5 targets, Node 24, `USER node`), push ECR, ghi digest — **không deploy bằng tag trôi**:

```bash
# Ví dụ; thay ACCOUNT_ID/REGION
aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
docker build --target orchestrator    -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-orchestrator:$(git rev-parse --short HEAD) -f Dockerfile .
docker build --target connector      -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-connector:$(git rev-parse --short HEAD) -f Dockerfile .
docker build --target document-core  -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-document-core:$(git rev-parse --short HEAD) -f Dockerfile .
docker build --target lc-checker     -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-lc-checker:$(git rev-parse --short HEAD) -f Dockerfile .
docker build --target example-review -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-example-review:$(git rev-parse --short HEAD) -f Dockerfile .
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/du-orchestrator:$(git rev-parse --short HEAD)
# ... push 4 image còn lại, rồi lấy digest:
aws ecr describe-images --repository-name du-orchestrator --image-ids imageTag=<TAG> --query 'imageDetails[0].imageDigest'
```

Ghi 5 digest vào `infra/eks/base/kustomization.yaml` (trường `images:`) hoặc `--set-image` lúc apply. Giữ `TAG` + `DIGEST` trong release note (freeze theo quy ước ở [14](../architecture/14-document-governance.md)).

## 3. Secrets và Config (không commit giá trị thật)

1. Tạo các secret trong **Secrets Manager** (mỗi key một entry JSON hoặc từng secret riêng — khớp `RemoteRef.key` trong `externalsecret-*.yaml`):
   - `du/orchestrator`: `DATABASE_URL`, `REDIS_URL`, `RUNTIME_TOKEN`, `ADMIN_TOKEN`, `ENCRYPTION_KEY`, `INVOCATION_GRANT_SECRET`, `SERVICE_IDENTITY_SECRET`, `WORKER_IDENTITY_TOKENS_BY_BUSINESS`, `TENANT_ADMIN_TOKENS_BY_TENANT`, `ADMIN_SHELL_COOKIE_SECRET`, `USAGE_TOKEN`, `WEBHOOK_SECRET`, `DU_CONNECTOR_MANAGEMENT_HEADERS`, `DU_VAULT_*`, `DU_ADMIN_OIDC_CLIENT_SECRET`, `AWS_*` (chỉ khi không dùng IRSA).
   - `du/connector`: `DATABASE_URL`, `REDIS_URL`, `SERVICE_IDENTITY_SECRET`, `INVOCATION_GRANT_SECRET` (= `CONNECTOR_INVOCATION_GRANT_SECRET` trong compose), `CONNECTOR_ENCRYPTION_KEY`, `USAGE_SINK_TOKEN`.
   - `du/workers`: `RUNTIME_TOKEN`, `REDIS_URL`, `CONNECTOR_SERVICE_TOKEN` (signed `connector:invoke`).
2. Sửa `infra/eks/base/*.yaml`: namespace, `ClusterSecretStore`, IRSA role ARN trên ServiceAccounts, `ConfigMap` (URL nội bộ ClusterIP, concurrency, timeout — đã map từ compose), hostname/TLS/DNS trong Ingress.
3. Áp dụng lớp nền:
```bash
kubectl apply -f infra/eks/base/namespace.yaml
kubectl apply -f infra/eks/base/serviceaccounts.yaml
kubectl apply -f infra/eks/base/clustersecretstore.yaml
kubectl apply -f infra/eks/base/externalsecret-orchestrator.yaml
kubectl apply -f infra/eks/base/externalsecret-connector.yaml
kubectl apply -f infra/eks/base/externalsecret-workers.yaml
kubectl apply -f infra/eks/base/configmap-orchestrator.yaml
kubectl apply -f infra/eks/base/configmap-connector.yaml
kubectl apply -f infra/eks/base/configmap-workers.yaml
kubectl -n du-platform get externalsecrets,secrets
```
4. Kiểm tra Secret đã sync (không `echo` giá trị ra log/terminal chia sẻ): `kubectl -n du-platform get secret orchestrator -o jsonpath='{.metadata.name}'`.

## 4. Migration (Job một lần, trước rollout)

`AUTO_MIGRATE=false` trong Deployment — migration chỉ chạy bằng Job với chính image Orchestrator (`node dist/migrate-cli.js migrate`, `restartPolicy: Never`), đúng như service `migrate` trong `compose/orchestrator.yml`:

```bash
kubectl apply -f infra/eks/base/job-migrate.yaml
kubectl -n du-platform wait --for=condition=complete job/orchestrator-migrate --timeout=600s
kubectl -n du-platform logs job/orchestrator-migrate
# Verify read-only (ví dụ): kết nối RDS bằng role read-only, kiểm tra schema version / bảng kỳ vọng.
```

Connector hiện migrate lúc start — **giữ `replicas: 1`** cho tới khi có migration owner serialize (ghi chú trong `deployment-connector.yaml`). Không scale Connector multi-replica trước mốc đó.

## 5. Deploy theo thứ tự: Connector → Orchestrator → Workers

```bash
kubectl apply -f infra/eks/base/deployment-connector.yaml
kubectl apply -f infra/eks/base/service-connector.yaml
kubectl -n du-platform rollout status deploy/connector

kubectl apply -f infra/eks/base/deployment-orchestrator.yaml
kubectl apply -f infra/eks/base/service-orchestrator.yaml
kubectl apply -f infra/eks/base/ingress-public.yaml
kubectl apply -f infra/eks/base/ingress-portal.yaml
kubectl -n du-platform rollout status deploy/orchestrator

kubectl apply -f infra/eks/base/deployment-workers.yaml
kubectl -n du-platform rollout status deploy/document-core
kubectl -n du-platform rollout status deploy/lc-checker
kubectl -n du-platform rollout status deploy/example-review

kubectl apply -f infra/eks/base/hpa.yaml
kubectl apply -f infra/eks/base/pdb.yaml
kubectl apply -f infra/eks/base/networkpolicy.yaml
```

Hoặc một lệnh: `kubectl apply -k infra/eks/base` (sau khi đã pin digest trong `kustomization.yaml`).

## 6. Verify (khớp PM-M02 + health + wiring)

1. **Health/probe:**
```bash
kubectl -n du-platform get pods -o wide
kubectl -n du-platform exec deploy/orchestrator -- node -e "fetch('http://127.0.0.1:3000/health').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
kubectl -n du-platform exec deploy/connector -- node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```
2. **Worker registration/heartbeat:** kiểm tra log worker `registered` + `heartbeat ok`, và phía Orchestrator thấy version/digest/capacity (Registry API, xem [05](../architecture/05-internal-api.md)).
3. **PM-M02 fence (hai lớp):**
   - Route guard trong code đã có (`ingress-guard.ts`): trên Public `:3000`, `/api/v1/admin*`, `/api/runtime*`, `/api/internal*` bị chặn bằng generic 404 **kể cả khi caller có credential hợp lệ**.
   - Infra lớp 2: Public ALB **chỉ** target `orchestrator-public:3000`; Private ALB **chỉ** target `orchestrator-portal:3001`; **không** có Ingress/DNS cho `orchestrator-internal:3002` và `connector:8080`; NetworkPolicy default-deny + allowlist đã apply.
   - Kiểm tra từ ngoài cluster: public origin phục vụ public `/api/v1/*` + health; admin/runtime/internal trả 404 generic; portal origin chỉ UI/session/BFF allowlist.
4. **Wiring nội bộ:** workers dùng `RUNTIME_URL=http://orchestrator-internal:3002/api/runtime/v1`, `CONNECTOR_URL=http://connector:8080`; usage sink (nếu bật) `http://orchestrator-internal:3002/api/runtime/v1/usage-events` + dedicated token; không thay upload/artifact origin public bằng origin internal.
5. **Storage/log:** S3 qua IRSA (bỏ trống `AWS_ACCESS_KEY_ID/SECRET` khi dùng IRSA); log JSON redacted ra stdout → Fluent Bit → ES/OpenSearch; không log raw file/prompt/secret/signed URL.

## 7. Canary và mở tải

1. Register business version mới ở trạng thái disabled → enable → chuyển tenant canary qua profile revision (xem [05](../architecture/05-internal-api.md) Registry/Profile).
2. Quan sát error/latency/usage, backlog-per-ready-instance, `oldest runnable age`, outbox age/in-flight (không scale chỉ theo RPS).
3. Giữ worker version cũ khi còn operation/human wait có thể resume; rollback profile pointer không viết lại snapshot operation đang chạy.

## 8. Rollback

- Rollback = deploy lại image/profile tương thích trước (schema forward-compatible, expand/contract). Không rollback DB phá hủy; không `kubectl rollout undo` mù khi schema đã tiến.
- Giữ recovery point RDS (snapshot/PITR) trước mỗi migrate Job; rehearse restore trước khi đưa vào SLA (Redis persistence không thay thế DB truth — reconcile sau restore).

## 9. Backup / restore rehearsal

- **RDS:** Multi-AZ, automated backup + PITR đã bật; rehearse restore ra instance tách biệt, verify schema + read-only query.
- **S3:** versioning + lifecycle không xóa object của operation active/waiting; pin dữ liệu operation đang chạy/chờ khỏi GC.
- **Valkey:** AOF + `noeviction`; mất message reconcile từ task/outbox trong DB (phải fault-test trước khi đưa vào SLA).

## 10. Troubleshooting nhanh

| Triệu chứng | Kiểm tra |
|---|---|
| Pod `CrashLoopBackOff` lúc boot | `kubectl logs` — thường thiếu env bắt buộc (fail-closed boot) hoặc Secret chưa sync; `kubectl describe pod` xem env/probe. |
| Readiness mãi không pass | RDS/ElastiCache security group + endpoint/TLS; `/health` là dependency readiness (PG+Redis), provider outage không được làm sập liveness. |
| Worker không claim task | `RUNTIME_URL` phải là internal `:3002` (không phải `:3000`); `RUNTIME_TOKEN`/identity theo business; Redis reachability; registration version/digest. |
| Connector 403/grant fail | `SERVICE_IDENTITY_SECRET`, grant signature/issuer/audience/expiry/binding; `PROVIDER_ALLOW_HOSTS`; egress NAT. |
| Public trả admin/runtime | Sai Ingress target (phải chỉ 3000) hoặc ai đó mở Ingress cho 3002/8080 — audit Ingress + NetworkPolicy ngay; route guard trả 404 generic là hành vi đúng. |
| HPA giật cục | Kiểm tra metric: backlog-per-ready-instance + oldest runnable age, không dùng tổng operation (gồm WAITING_INPUT/delayed retries); memory-bound parser slots. |

## 11. Acceptance checklist (trích, freeze trước go-live)

- [ ] 5 image digests pinned, ECR push log lưu release note.
- [ ] Migrate Job success + read-only schema verify.
- [ ] Health/probe xanh: orchestrator `/health` + `/api/v1/health` (:3000), connector `/health/live` + `/health/ready` (:8080), worker registration/heartbeat.
- [ ] PM-M02 fence hai lớp verified (route guard + Ingress/NetworkPolicy), không Ingress/DNS cho 3002/8080.
- [ ] IRSA least-privilege verified; worker không có `DATABASE_URL`; không secret trong image/log.
- [ ] S3 private/versioned/encrypted; lifecycle an toàn cho active/waiting ops.
- [ ] HPA/PDB/termination budgets verified; scale-in drain claim/checkpoint.
- [ ] Canary profile/version passed; error/latency/usage trong ngưỡng.
- [ ] Backup/restore rehearsal passed (RDS PITR + S3 + reconcile).
- [ ] PM-M02 full acceptance, live S3/Vault/real-provider, security gate (Node24/image scan), VFY/REVIEW migration: **OPEN trừ khi có evidence** — không suy ra cutover-ready từ guide/YAML này.
