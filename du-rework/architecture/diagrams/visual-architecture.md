# Sơ đồ trực quan — luồng xử lý và triển khai AWS

**Phạm vi:** bộ sơ đồ Mermaid tổng hợp cho DU Platform (`du-rework`): vòng đời một yêu cầu theo phong cách sequence diagram và topology triển khai AWS theo phong cách architecture diagram. Sơ đồ mô tả **topology mục tiêu + implementation hiện có**, không phải bằng chứng deployment đã kiểm chứng; mọi gate/go-live vẫn theo [09-readiness.md](../09-readiness.md).

**Nguồn đối chiếu:** [10 — hệ thống hiện hành](../10-current-system.md), [12 — luồng và dữ liệu](../12-flows-and-data.md), [06 — deploy AWS trên EC2](../06-aws-deployment.md), [19 — deploy trên EKS](../19-eks-deployment.md), [docs/40 — kiến trúc repo và service](../../docs/40-du-platform-architecture.md).

> Quy ước đọc: nét liền là đường bắt buộc trong topology mục tiêu; nét đứt là phụ thuộc theo cấu hình (optional feature). DB/RDS/Redis là nguồn trạng thái bền vững; queue chỉ là kênh delivery có thể phát lại; bytes không đi qua queue.

## 1. Sequence — vòng đời một yêu cầu (submit → dispatch → execute → result)

```mermaid
sequenceDiagram
    autonumber
    actor C as Client (x-api-key)
    participant API as Orchestrator · Public JSON :3000
    participant RT as Orchestration Runtime :3002
    participant PG as Platform PostgreSQL
    participant Q as BullMQ / Valkey
    participant W as Business Worker
    participant S3 as S3 artifact storage
    participant X as Connector Service :8080
    participant P as Provider (OCR/vision/LLM)

    rect rgb(239, 246, 255)
        note over C,PG: 1 · Submit — admission và trạng thái bền vững
        C->>API: POST /api/v1/... + x-api-key + Idempotency-Key (upload/ref)
        API->>API: admission: tenant · profile · business version · schema
        API->>PG: TX: operation + task + outbox
        API-->>C: 202 Accepted + operationId
        note right of PG: PG là nguồn sự thật của state.<br/>task nguồn URL còn ingestion gate thì chưa runnable
    end

    rect rgb(240, 253, 244)
        note over RT,Q: 2 · Dispatch — outbox → queue (at-least-once)
        RT->>PG: sweep outbox (bỏ qua delivery còn gate)
        RT->>Q: enqueue delivery ID ổn định (task ref — không có bytes)
        note right of Q: delivery có thể phát lại — payload<br/>không chứa file bytes / signed URL dài hạn
        opt Source URL chưa READY
            RT->>S3: tải source theo policy → ghi bản bất biến
            RT->>PG: pin artifact + bỏ gate → dòng outbox runnable
        end
    end

    rect rgb(254, 249, 195)
        note over Q,P: 3 · Execute — lease, xử lý, provider
        Q-->>W: delivery (task ref)
        W->>RT: claim + business identity
        RT->>PG: lease epoch + state transition (fencing)
        note left of W: delivery cũ không hoàn tất được task<br/>sau khi lease đã đổi (lease epoch)
        W->>W: parse / split local (document-kit) — không tốn provider
        W->>RT: xin invocation grant (task/slot)
        RT-->>W: signed grant: tenant · task · step · connector revision
        W->>X: POST /invocations + service identity + grant
        note right of X: provider trả lời mơ hồ → ledger UNKNOWN, không retry mù — poll/reconcile theo contract
        X->>P: bounded JSON/multipart HTTP (deadline, allowlist)
        P-->>X: response / async poll handle
        X-->>W: completed / pending / unknown / failed
        W->>RT: heartbeat · checkpoint · progress
        W->>S3: checkpoint / artifact trung gian (gắn task + lease)
        W->>RT: complete / fail (kết quả business)
        RT->>PG: fenced durable update → operation SUCCEEDED
    end

    rect rgb(243, 232, 255)
        note over C,API: 4 · Result — poll hoặc webhook
        C->>API: GET /operations/{id}/result (hoặc nhận webhook)
        API->>PG: tenant-scoped projection
        API->>S3: đọc bytes kết quả (nếu có)
        API->>API: giải mã storage envelope → mã hóa lại cho recipient (nếu policy)
        API-->>C: 200 ResultEnvelope JSON / encrypted wrapper / download
    end
```

> Bản SVG tĩnh: [visual-sequence-e2e.svg](visual-sequence-e2e.svg)

Bất biến chính của luồng:

- **PostgreSQL là nơi quyết định task state**; BullMQ/Valkey chỉ là kênh delivery có thể phát lại. Worker report phải qua runtime fencing (lease epoch).
- **Bytes không đi qua control plane**: queue, DB metadata và log không chứa file bytes, raw prompt, provider secret hay signed URL dài hạn.
- **Hai ranh giới ingestion độc lập**: dispatcher lọc outbox còn `gate='ingestion'`, và runtime từ chối claim task chưa READY (`STATE_CONFLICT` trước khi cấp lease).
- **Invocation grant** giới hạn tenant/task/step/input/artifact/revision; service identity không thay thế grant.
- **Kết quả**: contract đã freeze — `200 JSON` plain hoặc encrypted wrapper; không còn `302`.

## 2. Sequence — Connector invocation, UNKNOWN và usage

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker SDK
    participant RT as Orchestration Runtime
    participant X as Connector Service
    participant CDB as Connector PostgreSQL
    participant RQ as Redis / Valkey (quota)
    participant P as Provider

    W->>RT: xin invocation grant theo task/slot
    RT-->>W: signed grant (tenant · task · step · revision)
    W->>X: POST /invocations + service identity + grant
    X->>CDB: nạp revision (chỉ ACTIVE) + credential ref
    X->>X: kiểm binding grant ↔ stored revision (tenant/task/step)
    X->>RQ: quota lease theo tenant/connector
    X->>CDB: claim invocation (idempotency key, dedup)
    alt Provider trả lời rõ
        X->>P: bounded JSON/multipart HTTP (deadline, allowlist, response limit)
        P-->>X: 200 + payload / async poll handle
        X->>CDB: ledger COMPLETED + usage outbox
        X-->>W: completed
    else Response mơ hồ / timeout
        X->>CDB: ledger UNKNOWN (không retry mù)
        X-->>W: unknown → poll/reconcile theo contract
    end
    note over X,RT: Usage outbox → POST usage-events khi có USAGE_SINK_URL + token
    X->>RT: usage event (identity riêng)
    RT->>RT: ingest/projection idempotent — không double-count
    note over X: Management plane /connectors* tách khỏi invocation plane /invocations*:<br/>scope connector:manage vs connector:invoke
```

> Bản SVG tĩnh: [visual-sequence-connector.svg](visual-sequence-connector.svg)

> Wiring cần theo dõi: standalone Connector chưa truyền `SecretResolver` vào runtime cho nhánh `vault-kv2` — nhánh này fail-closed khi thiếu resolver ([12 §3](../12-flows-and-data.md)).

## 3. AWS diagram — topology EKS (mục tiêu)

```mermaid
flowchart LR
  classDef edge fill:#e0e7ff,stroke:#4f46e5,stroke-width:2px,color:#312e81
  classDef compute fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a8a
  classDef managed fill:#ffedd5,stroke:#ea580c,stroke-width:2px,color:#7c2d12
  classDef data fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d
  classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111827
  classDef note fill:#fef9c3,stroke:#ca8a04,color:#713f12

  Users(["API clients / integrations"]):::ext
  Ops(["Operators — VPN / private access"]):::ext

  subgraph AWS["AWS Cloud — account production"]
    subgraph VPC["VPC — 2 Availability Zones"]
      subgraph PUB["Public subnets"]
        ALBPUB["Internet-facing ALB · 443/TLS<br/>chỉ route /api/v1/* (trừ admin) + health"]:::edge
        NAT["NAT Gateway<br/>egress có kiểm soát"]:::edge
      end
      subgraph PRIV["Private subnets"]
        ALBPRIV["Internal ALB · 443/TLS<br/>chỉ tới Portal :3001"]:::edge
        subgraph EKS["Amazon EKS cluster"]
          ORCH["orchestrator Deployment (≥2 replicas)<br/>:3000 Public JSON · :3002 Internal · :3001 Portal/BFF<br/>Services: orchestrator-public / -internal / -portal"]:::compute
          CONN["connector Deployment :8080<br/>ClusterIP · không ingress — replicas=1 tới khi migration serialize"]:::compute
          WORK["worker Deployments: document-core · lc-checker · example-review<br/>HPA theo backlog · không DB creds · không Service/Ingress"]:::compute
          MIG["Job: migrate one-shot<br/>(AUTO_MIGRATE=false)"]:::compute
          FB["Fluent Bit DaemonSet<br/>stdout JSON đã redact"]:::compute
          NOTE["NetworkPolicy: default-deny + allowlist<br/>route guard authorization vẫn bắt buộc"]:::note
        end
        RDS["Amazon RDS for PostgreSQL — Multi-AZ<br/>DB platform + DB connector — role riêng"]:::managed
        ELC["Amazon ElastiCache for Valkey<br/>noeviction · TLS · AUTH/ACL — BullMQ + quota"]:::managed
      end
      S3["Amazon S3 — private · versioned · SSE-KMS<br/>artifact + checkpoint (S3 VPC endpoint / IRSA)"]:::data
    end
    ECR["Amazon ECR<br/>image pin theo digest"]:::managed
    SM["AWS Secrets Manager<br/>→ External Secrets → K8s Secret"]:::managed
    OS["OpenSearch / Elasticsearch private — TLS"]:::managed
    CW["CloudWatch — metrics · alarms<br/>(BullMQ cần exporter riêng)"]:::managed
  end

  PROV(["Approved providers<br/>OCR / vision / LLM"]):::ext

  Users -->|HTTPS| ALBPUB
  Ops -->|HTTPS| ALBPRIV
  ALBPUB -->|:3000 · /api/v1/*| ORCH
  ALBPRIV -->|:3001 Portal/BFF| ORCH
  WORK -->|claim · heartbeat · checkpoint · complete — ClusterIP :3002| ORCH
  WORK -->|invocation + signed grant — ClusterIP :8080| CONN
  ORCH -->|management / probe :8080| CONN
  ORCH --> RDS
  CONN --> RDS
  ORCH --> ELC
  CONN --> ELC
  WORK -->|REDIS_URL — queue consume| ELC
  ORCH --> S3
  WORK --> S3
  CONN --> S3
  CONN -->|443 allowlist| NAT
  WORK -.->|remote download theo policy — tắt mặc định| NAT
  NAT --> PROV
  ORCH & CONN & WORK -.->|stdout logs| FB
  FB --> OS
  ECR -.->|image pull| EKS
  SM -.->|secrets per ServiceAccount| EKS
  ORCH & CONN & WORK -.->|metrics| CW
```

> Bản SVG tĩnh: [visual-aws-eks.svg](visual-aws-eks.svg)

Điểm khác biệt so với topology EC2 ([06](../06-aws-deployment.md)): EC2 group → **Deployment + HPA + PDB**; ALB target group → **Service + Ingress**; host network → **VPC CNI + NetworkPolicy**; instance role → **IRSA role per ServiceAccount**; systemd/Compose unit → **Job + RollingUpdate**.

- **Ingress chỉ có hai cửa**: Public ALB → `orchestrator-public:3000`; Private ALB → `orchestrator-portal:3001`. `orchestrator-internal:3002` và `connector:8080` là ClusterIP, **không có ingress**.
- **Worker không có** Service, Ingress, hay DB credential; chỉ nói chuyện qua `orchestrator-internal:3002` và `connector:8080`.
- **Stateful plane ngoài cluster**: RDS (2 DB/role), ElastiCache, S3 — không chạy DB production trong Pod.

## 4. AWS diagram — phương án EC2 (song song, theo 06)

```mermaid
flowchart LR
  classDef edge fill:#e0e7ff,stroke:#4f46e5,stroke-width:2px,color:#312e81
  classDef compute fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a8a
  classDef managed fill:#ffedd5,stroke:#ea580c,stroke-width:2px,color:#7c2d12
  classDef data fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d
  classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111827
  classDef note fill:#fef9c3,stroke:#ca8a04,color:#713f12

  Users2(["API clients"]):::ext
  Ops2(["Admin — VPN / restricted access"]):::ext

  subgraph AWS2["AWS Cloud — một account · một Region production"]
    subgraph VPC2["VPC — 2 AZ (chuẩn bị mở rộng)"]
      ALB2["Public ALB — HTTPS 443"]:::edge
      ADMIN2["Admin restricted ingress (VPN)"]:::edge
      O2["EC2 group — Orchestrator container<br/>Public + Admin + Runtime"]:::compute
      C2["EC2 — Connector container<br/>(pilot: chung host với Orchestrator, container + credential tách)"]:::compute
      CLB2["Internal ALB — Connector endpoint"]:::edge
      PG2["PostgreSQL — EC2 riêng hoặc Amazon RDS<br/>platform + connector role tách"]:::managed
      R2["Redis / Valkey — EC2 riêng hoặc ElastiCache<br/>BullMQ + quota"]:::managed
      W2["EC2 group — document-core workers"]:::compute
      B2["EC2 groups — lc-checker · example-review"]:::compute
      EGR2["NAT / controlled egress"]:::edge
      LC2["Log collector — disk buffer có quota"]:::compute
      ES2["Elasticsearch private — TLS"]:::managed
      NOTE2["Worker không nhận public ingress;<br/>admin đi VPN/restricted — RBAC vẫn bắt buộc;<br/>pilot một host không phải HA"]:::note
    end
    S3_2["Amazon S3 — private · versioned<br/>bytes artifact + checkpoint"]:::data
  end

  PROV2(["Approved providers<br/>OCR / vision / LLM"]):::ext

  Users2 --> ALB2
  Ops2 --> ADMIN2
  ALB2 --> O2
  ADMIN2 --> O2
  R2 -->|delivery| W2
  R2 -->|delivery| B2
  W2 -->|runtime HTTPS| O2
  B2 -->|runtime HTTPS| O2
  W2 --> CLB2
  B2 --> CLB2
  O2 --> CLB2
  CLB2 --> C2
  O2 --> PG2
  C2 --> PG2
  O2 --> R2
  C2 --> R2
  C2 -->|443| EGR2
  W2 -.->|remote download theo policy| EGR2
  EGR2 --> PROV2
  O2 --> S3_2
  W2 --> S3_2
  B2 --> S3_2
  C2 --> S3_2
  O2 & C2 & W2 & B2 -->|redacted JSON logs| LC2
  LC2 --> ES2
```

> Bản SVG tĩnh: [visual-aws-ec2.svg](visual-aws-ec2.svg)

- Kubernetes **không cần** cho baseline EC2; Docker images immutable + systemd/Compose trên từng host.
- PostgreSQL và Redis/Valkey là **lựa chọn độc lập**: tự quản trên EC2 **hoặc** RDS/ElastiCache — cùng contract ứng dụng.
- HA thật cần ≥2 EC2 mỗi role qua LB + cấu hình session/distributed claims; gộp Orchestrator + Connector trên một host chỉ là phương án pilot, không phải HA.

## Cách xem và tái tạo

- GitHub/VSCode/VitePress render trực tiếp các khối Mermaid trong file này; không phụ thuộc dịch vụ vẽ bên ngoài khi xem.
- Ảnh SVG xuất kèm (dùng cho trình xem không hỗ trợ Mermaid): [sequence e2e](visual-sequence-e2e.svg) · [sequence Connector](visual-sequence-connector.svg) · [AWS EKS](visual-aws-eks.svg) · [AWS EC2](visual-aws-ec2.svg). SVG được xuất từ đúng khối Mermaid tương ứng, không chỉnh tay.
- Muốn xuất lại ảnh: dán từng khối vào [mermaid.live](https://mermaid.live), hoặc dùng `npx -y @mermaid-js/mermaid-cli -i <file>.mmd -o <file>.svg`.
- Khi topology source ([06](../06-aws-deployment.md), [19](../19-eks-deployment.md)) thay đổi, cập nhật khối Mermaid tương ứng trong file này và xuất lại SVG cùng lúc.
