# infra/eks — sample manifests triển khai DU Rework trên EKS

**Phạm vi:** điểm khởi đầu đã đối chiếu `compose/*.yml`, `Dockerfile` (5 targets, Node 24) và ma trận ingress PM-M02. **Không phải production đã kiểm chứng.** Mọi gate/go-live theo `architecture/09-readiness.md`; hướng dẫn từng bước ở `docs/12c-eks-deployment-guide.md`; topology mục tiêu ở `architecture/19-eks-deployment.md`.

Mọi giá trị account/region/hostname/secret trong thư mục này đều là **placeholder** (`ACCOUNT_ID`, `REGION`, `change-me`, `.example.com`). Không commit giá trị thật.

## Cấu trúc

```
infra/eks/
  README.md            # file này
  base/
    kustomization.yaml           # pin 5 image digests ECR tại đây
    namespace.yaml               # du-platform
    serviceaccounts.yaml         # 5 SA riêng để gắn IRSA role khác nhau
    clustersecretstore.yaml      # Secrets Manager provider (placeholder region)
    externalsecret-orchestrator.yaml
    externalsecret-connector.yaml
    externalsecret-workers.yaml
    configmap-orchestrator.yaml  # map từ compose/orchestrator.yml (không secret)
    configmap-connector.yaml     # map từ compose/connector.yml
    configmap-workers.yaml       # map từ compose/{document-core,lc-checker,example-review}.yml
    job-migrate.yaml             # migrate một lần, AUTO_MIGRATE=false
    deployment-orchestrator.yaml # 1 Deployment, 3 container ports (3000/3002/3001)
    service-orchestrator.yaml    # 3 ClusterIP: public :3000, internal :3002, portal :3001
    deployment-connector.yaml    # replicas: 1 mặc định (migration chưa serialize)
    service-connector.yaml       # ClusterIP :8080, không ingress
    deployment-workers.yaml      # 3 Deployments, không Service/Ingress/DB credential
    ingress-public.yaml          # ALB → orchestrator-public:3000 duy nhất
    ingress-portal.yaml          # private ALB → orchestrator-portal:3001 duy nhất
    hpa.yaml                     # CPU/memory mẫu; backlog metrics là khuyến nghị
    pdb.yaml                     # budgets tối thiểu
    networkpolicy.yaml           # default-deny ingress + allowlist PM-M02
```

## Quy ước placeholder cần thay (deployment owner)

| Placeholder | Thay bằng |
|---|---|
| `ACCOUNT_ID`, `REGION` | ECR registry + IAM role ARN + SecretStore region |
| `sha256:PIN_THE_DIGEST_HERE` | digest thật sau `docker push` (không deploy tag trôi) |
| `api.example.com`, `portal.example.com` | DNS thật + ACM cert ARN |
| `RDS_ENDPOINT`, `ELC_ENDPOINT`, `du-artifacts-example` | managed endpoints/bucket thật |
| `10.0.0.0/16` trong NetworkPolicy | VPC CIDR thật |
| `du/orchestrator`, `du/connector`, `du/workers` | tên secret thật trong Secrets Manager (dạng JSON key-value) |

## Thứ tự apply

```bash
kubectl apply -k infra/eks/base   # sau khi đã pin digest trong kustomization.yaml
# Hoặc từng bước để kiểm soát (xem docs/12c-eks-deployment-guide.md §3–§5):
# namespace → serviceaccounts → clustersecretstore → externalsecrets →
# configmaps → job-migrate (đợi complete + verify) →
# connector → orchestrator (+ ingress) → workers → hpa/pdb/networkpolicy
```

## Nguyên tắc giữ nguyên từ Compose (không được đảo ngược khi sửa YAML)

1. Worker **không** có Service/Ingress/`DATABASE_URL`; `RUNTIME_URL` luôn là internal `http://orchestrator-internal:3002/api/runtime/v1`, `CONNECTOR_URL=http://connector:8080`.
2. `orchestrator-internal:3002` và `connector:8080` **không bao giờ** xuất hiện trong Ingress/DNS.
3. `AUTO_MIGRATE=false` trong Deployment; migration chỉ qua Job.
4. Probes: orchestrator liveness `/health` + readiness `/api/v1/health` (:3000); connector liveness `/health/live` + readiness `/health/ready` (:8080); workers không probe HTTP.
5. `terminationGracePeriodSeconds`: orchestrator/connector 60s, worker 30s.
