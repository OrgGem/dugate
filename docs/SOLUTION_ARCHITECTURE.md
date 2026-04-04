# DUGate — Solution Architecture Document

> **Document ID**: SA-DUGATE-2026-001  
> **Version**: 2.0  
> **Classification**: INTERNAL — FOR APPROVAL  
> **Author**: Solution Architecture Team  
> **Date**: 2026-04-04  
> **Status**: APPROVED

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Business Context & Problem Statement](#2-business-context--problem-statement)
3. [Solution Overview](#3-solution-overview)
4. [Architecture Principles](#4-architecture-principles)
5. [System Context (C4 Level 1)](#5-system-context-c4-level-1)
6. [Container Architecture (C4 Level 2)](#6-container-architecture-c4-level-2)
7. [Component Architecture (C4 Level 3)](#7-component-architecture-c4-level-3)
8. [Sequence Diagrams](#8-sequence-diagrams)
9. [Deployment Architecture — Docker & Kubernetes](#9-deployment-architecture--docker--kubernetes)
10. [Security Architecture](#10-security-architecture)
11. [Non-Functional Requirements (NFR)](#11-non-functional-requirements-nfr)
12. [Technology Stack Decision Matrix](#12-technology-stack-decision-matrix)
13. [Approval Sign-off](#13-approval-sign-off)

---

## 1. Executive Summary

**DUGate** (Document Understanding API Gateway) là một giải pháp kiến trúc cổng trung gian API nội bộ, chuyên biệt xử lý các bài toán **Phân tích Tài liệu** (Document Understanding) cho môi trường doanh nghiệp — đặc biệt phù hợp với ngành Tài chính & Ngân hàng.

Thay vì mỗi nghiệp vụ tự tích hợp riêng lẻ đến hàng chục dịch vụ AI thông qua LLMs Hub nội bộ, DUGate **quy chuẩn hóa** toàn bộ lớp truy cập thành **6 API Endpoint duy nhất**, vận hành trên kiến trúc **Pipeline Engine bất đồng bộ** với khả năng **định tuyến theo Profile**, đảm bảo:

- **Zero-coupling** giữa ứng dụng nghiệp vụ và AI backend
- **Multi-tenant isolation** qua API Key + Profile-based routing với cấu hình tham số thống nhất (Unified Parameter Schema)
- **Audit-grade traceability** với structured logging & cURL reconstruction
- **Enterprise-grade deployment** trên Docker & Kubernetes

---

## 2. Business Context & Problem Statement

Trong bối cảnh chuyển đổi số, nhu cầu xử lý tài liệu bằng AI (OCR, trích xuất, phân loại, đối soát, v.v.) ngày càng tăng nhanh trên nhiều đơn vị nghiệp vụ. Các mô hình LLM hiện được cung cấp tập trung qua **LLMs Hub** nội bộ. Tuy nhiên, cần **quy hoạch các dịch vụ về Document Understanding** thành một lớp cổng trung gian chuẩn hóa để giải quyết các vấn đề phát sinh khi mỗi ứng dụng tự tích hợp riêng lẻ:

| # | Vấn đề | Ảnh hưởng |
|---|--------|-----------|
| P1 | Mỗi app tự tích hợp riêng lẻ → N×M integrations | Chi phí bảo trì tăng tuyến tính, logic bị phân mảnh |
| P2 | Không kiểm soát prompt/model tập trung | Rủi ro prompt injection, output inconsistency giữa các đơn vị |
| P3 | Không có audit trail trên API gọi AI | Vi phạm compliance nội bộ, khó truy vết sự cố |
| P4 | Không có spending limit per-team | Token usage vượt tầm kiểm soát |
| P5 | Thiếu cơ chế pipeline chain | Không thể ghép nối nhiều bước xử lý (OCR → Extract → Validate) |

**DUGate giải quyết** bằng cách đóng vai trò lớp Gateway giữa ứng dụng nghiệp vụ và LLMs Hub — chuẩn hóa toàn bộ thành 6 API duy nhất:

```mermaid
graph LR
    A1[App Nghiệp vụ A] -->|x-api-key| GW[🏗️ DUGate Gateway]
    A2[App Nghiệp vụ B] -->|x-api-key| GW
    A3[App Nghiệp vụ C] -->|x-api-key| GW
    GW -->|Profile routing| HUB[🔗 LLMs Hub]
    GW -->|Profile routing| OCR[OCR Engine]
    GW -->|Profile routing| INT[Internal AI Service]
    HUB --> M1[Gemini]
    HUB --> M2[GPT]
    HUB --> M3[Claude]

    style GW fill:#51cf66,stroke:#333,stroke-width:3px
    style HUB fill:#4dabf7,stroke:#333,stroke-width:2px
```

---

## 3. Solution Overview

### 3.1 Kiến trúc Logic — 6 Unified Endpoints

DUGate quy chuẩn hóa toàn bộ bài toán Document Understanding thành **6 hành động ngữ nghĩa** (semantic actions):

| # | Endpoint | Chức năng | Sub-cases |
|---|----------|-----------|-----------|
| 1 | `/api/v1/ingest` | Đọc, OCR, số hóa tài liệu | `parse`, `ocr`, `digitize`, `split` |
| 2 | `/api/v1/extract` | Trích xuất dữ liệu có cấu trúc | `invoice`, `contract`, `id-card`, `receipt`, `table`, `custom` |
| 3 | `/api/v1/analyze` | Đánh giá, phân loại, fact-check | `classify`, `sentiment`, `compliance`, `fact-check`, `quality`, `risk`, `summarize-eval` |
| 4 | `/api/v1/transform` | Chuyển đổi, dịch thuật, mã hóa PII | `convert`, `translate`, `rewrite`, `redact`, `template` |
| 5 | `/api/v1/generate` | Sinh nội dung mới (tóm tắt, QA) | `summary`, `qa`, `outline`, `report`, `email`, `minutes` |
| 6 | `/api/v1/compare` | So sánh ngữ nghĩa/text diff | `diff`, `semantic`, `version` |

### 3.2 Core Architecture Pattern

```
Client Request → Middleware (Auth) → Endpoint Runner (Routing & Param Guard) → Pipeline Submit → Pipeline Engine → External API Processor → LLMs Hub / AI Backend
       ↑                                                                                                                                           ↓
       └──────────────────── Operation Polling / Webhook ←─────────────────── PostgreSQL (State Machine) ←─────────────────────────────────────────┘
```

### 3.3 Chat Assistant Capability

Ngoài 6 Endpoint chính chuyên phục vụ kết nối dữ liệu máy-máy (M2M), DUGate cung cấp thêm lớp tiện ích **Chat Assistant** (`/api/chat`).
- **Mục đích**: Giao diện tương tác trò chuyện quản trị cấu hình AI cho Admin.
- **Cơ chế**: Proxy tới LLMs Hub thông qua external connection `sys-assistant`. Hệ thống tự động nội suy và context hóa các tham số (ví dụ: `{{available_routes_json}}`, `{{user_chat_message}}`) dựa trên cấu trúc hiện hành từ `SERVICE_REGISTRY`.

---

## 4. Architecture Principles

| # | Nguyên tắc | Mô tả |
|---|-----------|------|
| AP-1 | **Gateway Abstraction** | Ứng dụng nghiệp vụ KHÔNG bao giờ gọi trực tiếp AI backend. DUGate là điểm truy cập duy nhất. |
| AP-2 | **Unified Parameter Guardrails** | Mọi tùy chỉnh tham số phụ thuộc vào khai báo `ParamSchema` tập trung. Các tham số hệ thống bị khóa (locked params) sẽ bị từ chối nếu Client chủ ý gửi từ bên ngoài. |
| AP-3 | **Profile-Driven Isolation** | Cấu hình Profile chỉ định các tham số và logic routing riêng cho từng ứng dụng API Key mà không ảnh hưởng key khác. |
| AP-4 | **Async-First** | Mọi pipeline mặc định bất đồng bộ (`202 Accepted`). |
| AP-5 | **Zero Client Code Change** | Thay đổi AI backend, pipeline model chỉ cần admin thao tác trên Server — 0 dòng code ứng dụng thay đổi. |
| AP-6 | **Defence in Depth** | Tầng auth kép: NextAuth (Admin UI) + API Key (Public API). AES-256-GCM bảo vệ secret key lưu trữ. |

---

## 5. System Context (C4 Level 1)

```mermaid
C4Context
    title DUGate — System Context Diagram

    Person(admin, "Administrator", "Quản trị Gateway, Profile, Connector, trò chuyện qua Chat Assistant")
    Person(dev, "Developer / App Client", "Tích hợp API qua x-api-key")

    System(dugate, "DUGate Gateway", "Document Understanding API Gateway — 6 Unified Endpoints & Chat")

    System_Ext(llmhub, "LLMs Hub", "Cổng trung gian LLM nội bộ — proxy đến Gemini, GPT, Claude")
    System_Ext(ocr_engine, "OCR Engine", "Dịch vụ nhận dạng ký tự quang học")
    System_Ext(internal_ai, "Internal AI Service", "Mô hình AI on-premise")

    System_Ext(postgres, "PostgreSQL", "Operational data store & Unified Config")

    Rel(admin, dugate, "Quản trị qua Admin UI, hỏi đáp Bot", "HTTPS/NextAuth")
    Rel(dev, dugate, "Gửi tài liệu, nhận kết quả", "HTTPS/x-api-key")
    Rel(dugate, llmhub, "Forward request", "HTTPS/API Key")
    Rel(dugate, ocr_engine, "Forward request", "HTTPS/API Key")
    Rel(dugate, internal_ai, "Forward request", "HTTP/mTLS")
    Rel(dugate, postgres, "CRUD Operations", "TCP/5432")
```

---

## 6. Container Architecture (C4 Level 2)

```mermaid
C4Container
    title DUGate — Container Diagram

    Person(client, "API Client")
    Person(admin, "Administrator")

    Container_Boundary(gateway, "DUGate Gateway") {
        Container(nginx, "Nginx Reverse Proxy", "nginx:alpine", "TLS termination, rate limiting, 300MB upload")
        Container(nextjs, "Next.js Application", "Node.js 20 / Next.js 14", "API Routes + Admin UI + Pipeline Engine")
        ContainerDb(pg, "PostgreSQL", "postgres:16-alpine", "Operations, ApiKeys, Connections, Profiles")
        Container(volumes, "Persistent Volumes", "Docker Volumes", "uploads/, outputs/, pgdata/")
    }

    Rel(client, nginx, "POST /api/v1/*", "HTTPS")
    Rel(admin, nginx, "Admin Dashboard", "HTTPS")
    Rel(nginx, nextjs, "Proxy pass", "HTTP:2023")
    Rel(nextjs, pg, "Prisma ORM", "TCP:5432")
    Rel(nextjs, volumes, "Read/Write files", "FS mount")
```

---

## 7. Component Architecture (C4 Level 3)

```mermaid
graph TB
    subgraph "Next.js Application Container"
        subgraph "Middleware Layer"
            MW[middleware.ts<br/>Dual Auth Gate]
        end

        subgraph "API Route Layer"
            V1["/api/v1/{service}" Routes<br/>ingest, extract, analyze,<br/>transform, generate, compare]
            CHAT["/api/chat" Route<br/>Chat Assistant proxy]
            ADMIN["/api/operations<br/>/api/settings<br/>/api/users" Admin Routes]
            INTERNAL["/api/internal/auth-key"<br/>Key validation]
            HEALTH["/api/health"<br/>Healthcheck]
        end

        subgraph "Core Engine"
            REG[SERVICE_REGISTRY<br/>6 Services × 30 Sub-cases<br/>Unified ParamSchema Metadata]
            RUNNER[Endpoint Runner<br/>Discriminator routing,<br/>Unified Param Guard & Merge]
            SUBMIT[Pipeline Submit<br/>Validation, file save,<br/>Operation create]
            ENGINE[Pipeline Engine<br/>Sequential step execution,<br/>retry, progress tracking]
            EXT_API[External API Processor<br/>multipart/form-data builder,<br/>cURL logging, prompt interpolation]
        end

        subgraph "Shared Libraries"
            AUTH[Auth Module<br/>NextAuth + bcrypt]
            PRISMA[Prisma Client<br/>Type-safe ORM]
            CRYPTO[Crypto Module<br/>AES-256-GCM]
            LOGGER[Logger<br/>Structured JSON logs]
            UPLOAD[Upload Helper<br/>File I/O]
            PARSER[Parser Factory<br/>PDF/DOCX native parse]
        end

        subgraph "Admin UI (React)"
            HOME[Home Page — 6 Services Grid]
            DASH[Operations Dashboard]
            PROFILES[Profile Manager]
            SETTINGS[API Connections Manager]
        end
    end

    MW --> V1
    MW --> CHAT
    MW --> ADMIN
    V1 --> RUNNER
    CHAT --> EXT_API
    RUNNER --> REG
    RUNNER --> SUBMIT
    SUBMIT --> ENGINE
    ENGINE --> EXT_API
    EXT_API --> PARSER
    RUNNER --> PRISMA
    ENGINE --> PRISMA
    ENGINE --> LOGGER
    EXT_API --> LOGGER
    AUTH --> PRISMA
    SUBMIT --> UPLOAD
    EXT_API --> CRYPTO
```

### 7.1 SERVICE_REGISTRY & ParamSchema

Version 2.0 đưa toàn bộ khai báo Metadata lưu tại `SERVICE_REGISTRY`, được định dạng bởi `ParamSchema`. Các schema này quy định rõ loại tham số, tính bắt buộc, và đặc biệt là cờ `defaultLocked` nhằm định tuyến cái nào được Client override và cái nào Admin được quyền khoá cứng (enforcement parameter).

```mermaid
graph LR
    subgraph "6 API Services"
        ING[ingest]
        EXT[extract]
        ANA[analyze]
        TRA[transform]
        GEN[generate]
        CMP[compare]
    end

    subgraph "15+ External AI Connectors"
        C1[ext-doc-layout]
        C2[ext-vision-reader]
        C3[ext-pdf-tools]
        C4[ext-data-extractor]
        C5[ext-classifier]
        C6[ext-sentiment]
        C7[ext-compliance]
        C8[ext-fact-verifier]
        C9[ext-quality-eval]
        C10[ext-content-gen]
        C11[ext-translator]
        C12[ext-rewriter]
        C13[ext-redactor]
        C14[ext-qa-engine]
        C15[ext-comparator]
        CSYS[sys-assistant]
    end

    ING --> C1
    ING --> C2
    ING --> C3
    EXT --> C4
    ANA --> C5
    ANA --> C6
    ANA --> C7
    ANA --> C4
    ANA --> C8
    ANA --> C9
    ANA --> C10
    TRA --> C1
    TRA --> C11
    TRA --> C12
    TRA --> C13
    GEN --> C10
    GEN --> C14
    CMP --> C15
```

---

## 8. Sequence Diagrams

### 8.1 Luồng xử lý API Request (Async — Production Flow)

```mermaid
sequenceDiagram
    autonumber
    participant Client as 📱 Client App
    participant Nginx as 🔒 Nginx (TLS)
    participant MW as 🛡️ Middleware
    participant AuthSvc as 🔑 Auth Service
    participant Router as 🔀 Endpoint Runner
    participant Registry as 📋 Service Registry
    participant DB as 🗄️ PostgreSQL
    participant Submit as 📤 Pipeline Submit
    participant Disk as 💾 File Storage

    Client->>+Nginx: POST /api/v1/extract<br/>Headers: x-api-key, Content-Type: multipart<br/>Body: file + type=invoice
    Nginx->>+MW: Proxy pass (HTTP:2023)

    rect rgb(255, 240, 240)
        Note over MW,AuthSvc: Authentication Phase
        MW->>+AuthSvc: GET /api/internal/auth-key<br/>Headers: x-api-key
        AuthSvc->>DB: SELECT * FROM ApiKey WHERE keyHash = SHA256(key)
        DB-->>AuthSvc: ApiKey { id, role, status, spendingLimit }
        AuthSvc->>AuthSvc: Validate status=active, spending within limit
        AuthSvc-->>-MW: { valid: true, apiKeyId: "uuid" }
        MW->>MW: Inject header x-api-key-id = "uuid"
    end

    MW->>+Router: Forward request with x-api-key-id

    rect rgb(240, 255, 240)
        Note over Router,Registry: Routing & Param Resolution Phase
        Router->>Registry: Lookup SERVICE_REGISTRY["extract"]
        Registry-->>Router: ServiceDef { discriminator: "type", ParamSchema, subCases }
        Router->>Router: Resolve subCase by type="invoice"
        Router->>Router: Build Guardrails (block defaultLocked from client)
        Router->>DB: SELECT * FROM ProfileEndpoint<br/>WHERE apiKeyId AND endpointSlug="extract:invoice"
        DB-->>Router: ProfileEndpoint { parameters, connectionsOverride }
        Router->>Router: Merge unified parameters: Client payload config + Profile JSON
        Router->>Router: Resolve connections: override → registry default
    end

    rect rgb(240, 240, 255)
        Note over Router,Disk: Pipeline Submission Phase
        Router->>+Submit: submitPipelineJob({ pipeline, files, endpointSlug })
        Submit->>DB: Validate connectors: ExternalApiConnection.state = ENABLED
        Submit->>Submit: Check idempotencyKey (AIP-155)
        Submit->>Disk: Save uploaded files → /uploads/{operationId}/
        Submit->>DB: INSERT Operation { state: RUNNING, pipelineJson, filesJson }
        Submit->>Submit: Fire-and-forget: runPipeline(operationId)
        Submit-->>-Router: { ok: true, operation }
    end

    Router-->>MW: 202 Accepted<br/>Operation-Location: /api/v1/operations/{id}
    MW-->>Nginx: Response
    Nginx-->>-Client: 202 Accepted + operation_id
```

### 8.2 Pipeline Engine — Multi-Step Execution

```mermaid
sequenceDiagram
    autonumber
    participant Engine as ⚙️ Pipeline Engine
    participant DB as 🗄️ PostgreSQL
    participant Processor as 🔌 External API Processor
    participant Parser as 📄 Parser Factory
    participant AI as 🤖 LLMs Hub / AI Backend
    participant Webhook as 📡 Webhook

    Engine->>DB: Load Operation (pipelineJson, filesJson)

    loop For each step in pipeline[0..N]
        Engine->>DB: UPDATE progress: step {i}/{N}, progressPercent

        Engine->>DB: SELECT ExternalApiConnection WHERE slug = step.processor
        DB-->>Engine: Connection { url, auth, prompt, responseContentPath }

        opt Has per-client override
            Engine->>DB: SELECT ExternalApiOverride WHERE connectionId + apiKeyId
            DB-->>Engine: Override { promptOverride }
        end

        Engine->>+Processor: runExternalApiProcessor(ctx, connection, override)

        alt Single file → Native parser available (PDF/DOCX)
            Processor->>Parser: ParserFactory.getParserForFile(filename)
            Parser-->>Processor: Parser instance
            Processor->>Parser: parse(fileBuffer)
            Parser-->>Processor: { markdown, pageCount }
            Note over Processor: Skip external call → cost = $0
        else External API required
            Processor->>Processor: Resolve prompt: override → default<br/>Interpolate {{variables}}
            Processor->>Processor: Build FormData:<br/>• prompt field<br/>• static form fields<br/>• file attachments
            Processor->>Processor: Log cURL command (audit)
            Processor->>+AI: HTTP POST multipart/form-data<br/>Headers: x-api-key / Bearer
            AI-->>-Processor: JSON response
            Processor->>Processor: resolveDotPath(response, "data.response")
        end

        Processor-->>-Engine: ProcessorResult { content, tokens, cost }

        Engine->>Engine: Chain output → next step inputText
        Engine->>DB: UPDATE stepsResultJson (intermediate save)
    end

    Engine->>DB: UPDATE Operation SET state=SUCCEEDED,<br/>outputFormat, outputContent, totalCostUsd, usageBreakdown
    opt webhookUrl configured
        Engine->>+Webhook: POST webhookUrl<br/>{ operation_id, metadata: { state: "SUCCEEDED" } }
        Webhook-->>-Engine: 200 OK
        Engine->>DB: UPDATE webhookSentAt
    end
```

### 8.3 Operation Polling — Client-side

```mermaid
sequenceDiagram
    autonumber
    participant Client as 📱 Client
    participant GW as 🏗️ DUGate
    participant DB as 🗄️ PostgreSQL

    Client->>GW: POST /api/v1/extract (file + params)
    GW-->>Client: 202 Accepted<br/>{ operation_id: "abc-123",<br/>  metadata: { state: "RUNNING" },<br/>  Operation-Location: "/api/v1/operations/abc-123" }

    loop Poll every 2-5 seconds
        Client->>GW: GET /api/v1/operations/abc-123
        GW->>DB: SELECT * FROM Operation WHERE id = "abc-123"
        DB-->>GW: Operation { state, progressPercent, progressMessage }

        alt state = RUNNING
            GW-->>Client: 200 { metadata: { state: "RUNNING", progress: 45, message: "Step 1/2..." } }
        else state = SUCCEEDED
            GW-->>Client: 200 { metadata: { state: "SUCCEEDED" }, result: { output_format: "json", content: "{...}" }, usage: { tokens: 1234, cost: 0.02 } }
        else state = FAILED
            GW-->>Client: 200 { metadata: { state: "FAILED", error_code: "PIPELINE_ERROR", message: "..." } }
        end
    end
```

### 8.4 Per-Profile Connector Routing Override

```mermaid
sequenceDiagram
    autonumber
    participant Admin as 👤 Admin
    participant UI as 🖥️ Admin Dashboard
    participant DB as 🗄️ PostgreSQL
    participant Client as 📱 Client (Key A)
    participant GW as 🏗️ DUGate
    participant AI_OCR as 🤖 ext-ocr-premium
    participant AI_Default as 🤖 ext-data-extractor

    rect rgb(255, 250, 230)
        Note over Admin,DB: Admin configures Profile Override
        Admin->>UI: Set Key A → extract:invoice<br/>connectionsOverride = ["ext-ocr-premium"]
        UI->>DB: UPSERT ProfileEndpoint { apiKeyId: A,<br/>endpointSlug: "extract:invoice",<br/>connectionsOverride: '["ext-ocr-premium"]' }
    end

    rect rgb(230, 255, 230)
        Note over Client,AI_OCR: Client A → uses overridden connector
        Client->>GW: POST /api/v1/extract (type=invoice, x-api-key=A)
        GW->>DB: Load ProfileEndpoint for Key A + "extract:invoice"
        DB-->>GW: connectionsOverride = ["ext-ocr-premium"]
        GW->>AI_OCR: Forward → ext-ocr-premium (overridden)
        AI_OCR-->>GW: Result
        GW-->>Client: 202 Accepted
    end

    rect rgb(230, 240, 255)
        Note over Client,AI_Default: Client B (no override) → uses default
        Client->>GW: POST /api/v1/extract (type=invoice, x-api-key=B)
        GW->>DB: Load ProfileEndpoint for Key B → null
        GW->>AI_Default: Forward → ext-data-extractor (default from registry)
        AI_Default-->>GW: Result
        GW-->>Client: 202 Accepted
    end
```

### 8.5 Admin Authentication — NextAuth Session Flow

```mermaid
sequenceDiagram
    autonumber
    participant Browser as 🌐 Browser
    participant Nginx as 🔒 Nginx
    participant MW as 🛡️ Middleware
    participant NextAuth as 🔐 NextAuth
    participant DB as 🗄️ PostgreSQL

    Browser->>Nginx: GET /settings
    Nginx->>MW: Proxy pass
    MW->>MW: getToken(req) — check JWT cookie
    alt No valid JWT
        MW-->>Browser: 302 Redirect → /login
        Browser->>Nginx: POST /api/auth/callback/credentials<br/>{ username, password }
        Nginx->>NextAuth: Forward
        NextAuth->>DB: SELECT * FROM User WHERE username = ?
        DB-->>NextAuth: User { id, password_hash, role }
        NextAuth->>NextAuth: bcrypt.compare(input, hash)
        alt Password valid
            NextAuth-->>Browser: Set-Cookie: next-auth.session-token (JWT)<br/>302 Redirect → /settings
        else Password invalid
            NextAuth-->>Browser: Error: "Mật khẩu không chính xác"
        end
    else Valid JWT exists
        MW-->>Browser: 200 OK — render /settings page
    end
```

---

## 9. Deployment Architecture — Docker & Kubernetes

### 9.1 Tổng quan triển khai

Hệ thống được đóng gói hoàn toàn bằng **Docker** với multi-stage build (giảm image từ ~1.2GB → ~350MB), triển khai trên **Kubernetes** cho môi trường production. Môi trường dev/staging sử dụng Docker Compose.

| Thành phần | Image | Port | Vai trò |
|------------|-------|------|---------|
| **dugate-app** | `node:20-slim` (multi-stage) | 2023 | API Gateway + Admin UI + Pipeline Engine |
| **dugate-db** | `postgres:16-alpine` | 5432 | Operation state, API Key, Connection registry |
| **nginx-ingress** | `nginx:alpine` | 80/443 | TLS termination, rate-limit, upload cap 300MB |

### 9.2 Docker Compose — Development / Staging

```mermaid
graph TB
    subgraph "Docker Compose Stack"
        subgraph "Network: dugate-net (bridge)"
            APP["📦 app (dugate)<br/>node:20-slim<br/>Port: 2023"]
            DB["🗄️ db<br/>postgres:16-alpine<br/>Port: 5432"]
        end

        subgraph "Persistent Volumes"
            V1[("pgdata")]
            V2[("uploads")]
            V3[("outputs")]
        end

        APP --> DB
        DB --> V1
        APP --> V2
        APP --> V3
    end

    CLIENT[Client] -->|:2023| APP
```

### 9.3 Kubernetes — Production Topology

```mermaid
graph TB
    subgraph "Kubernetes Cluster"
        subgraph "Namespace: dugate-prod"
            ING[☁️ Ingress Controller<br/>TLS + cert-manager<br/>300M upload limit]

            subgraph "Deployment: dugate-app (3 replicas)"
                POD1["Pod 1"]
                POD2["Pod 2"]
                POD3["Pod 3"]
            end

            SVC_APP[Service: dugate-app<br/>ClusterIP:2023]

            subgraph "StatefulSet: dugate-db"
                DB_POD["Pod: postgres:16<br/>PVC: 50Gi"]
            end

            SVC_DB[Service: dugate-db<br/>ClusterIP:5432]
            HPA[HPA: min 2 → max 10<br/>CPU target: 70%]
        end
    end

    INTERNET[🌐 Internet] -->|HTTPS| ING
    ING --> SVC_APP
    SVC_APP --> POD1
    SVC_APP --> POD2
    SVC_APP --> POD3
    POD1 --> SVC_DB
    SVC_DB --> DB_POD
    HPA -.->|Auto-scale| POD1
```

**Đặc điểm triển khai chính:**

| Khía cạnh | Cấu hình |
|-----------|----------|
| **Deployment strategy** | RollingUpdate — `maxSurge: 1`, `maxUnavailable: 0` (zero-downtime) |
| **Auto-scaling** | HPA: 2 → 10 pods, trigger tại CPU 70% hoặc Memory 80% |
| **Health check** | Liveness + Readiness probe qua `GET /api/health` |
| **Secrets** | K8s Secret: `DB_PASSWORD`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY` |
| **Storage** | PVC ReadWriteMany cho `uploads/` và `outputs/` |
| **Database** | StatefulSet + PVC 50Gi ReadWriteOnce |

---

## 10. Security Architecture

### 10.1 Authentication Matrix

| Endpoint Pattern | Auth Method | Token / Key | Session Type |
|-----------------|-------------|-------------|--------------|
| `/api/v1/*` | API Key Header | `x-api-key` → SHA-256 → DB lookup | Stateless |
| `/api/chat` | NextAuth JWT | Cookie Auth Guard | Stateless (Bot usage via session) |
| `/api/auth/*` | NextAuth Credentials | username + bcrypt password | JWT cookie |
| `/api/internal/*` | Internal only (middleware bypass) | N/A — only callable by middleware | N/A |
| `/api/health` | None (public) | N/A | N/A |
| `/*` (pages) | NextAuth JWT | Session cookie | JWT |

### 10.2 Secrets Management

| Secret | Storage | Rotation Strategy |
|--------|---------|-------------------|
| `DB_PASSWORD` | K8s Secret / `.env` | Quarterly, zero-downtime via pg_hba reload |
| `NEXTAUTH_SECRET` | K8s Secret | Requires re-login for all admin sessions |
| `ENCRYPTION_KEY` | K8s Secret | Requires re-encrypt all ExternalApiConnection.authSecret |
| AI API Keys | DB (AES-256-GCM encrypted) | Admin changes via Dashboard — no deployment needed |
| `x-api-key` (client) | Client-managed | Admin revokes + issues new key via Dashboard |

---

## 11. Non-Functional Requirements (NFR)

| NFR | Target | Implementation |
|-----|--------|---------------|
| **Availability** | 99.9% uptime | K8s replicas ≥ 2, RollingUpdate zero-downtime, PG healthcheck |
| **Latency (P95)** | < 500ms (gateway overhead) | Direct proxy, no message queue, async pipeline |
| **Throughput** | 100 req/s sustained | HPA auto-scale 2→10 pods, connection pooling via Prisma |
| **Max upload** | 300MB per file | Nginx `client_max_body_size`, K8s Ingress annotation |
| **Pipeline timeout** | 300s per connector step | Per-connector `timeoutSec` config, AbortController |
| **Data retention** | Files: 24h, Operations: 30d | Cleanup scheduler cron + `filesDeleted` flag |
| **Recovery (RPO/RTO)** | RPO: 1h, RTO: 15min | PG WAL archival, PVC snapshots, rollout undo |
| **Observability** | Full structured logging | JSON log format, correlation ID, cURL audit trail |
| **Scalability** | Horizontal only | Stateless app pods, shared PVC for uploads |

---

## 12. Technology Stack Decision Matrix

| Layer | Technology | Lý do chọn | Thay thế đã xem xét |
|-------|-----------|-----------|---------------------|
| **Runtime** | Node.js 20 LTS | Ecosystem Next.js, async I/O native, low-memory footprint | Deno (immature ecosystem) |
| **Framework** | Next.js 14 App Router | SSR admin UI + API routes cùng codebase, chuẩn Vercel | Express.js (không có SSR), NestJS (over-engineering) |
| **Database** | PostgreSQL 16 | ACID, JSONB native, Prisma first-class support, mature | MySQL (JSONB yếu), MongoDB (không ACID) |
| **ORM** | Prisma 5 | Type-safe schema, auto-migration, connection pooling | TypeORM (less type-safe), Drizzle (younger ecosystem) |
| **Auth** | NextAuth v4 + bcryptjs | Native Next.js integration, JWT stateless, credential provider | Passport.js (not Next-native), Clerk (SaaS dependency) |
| **Encryption** | AES-256-GCM (native crypto) | Zero-dependency, NIST approved, authenticated encryption | Vault (infrastructure overhead) |
| **Container** | Docker + multi-stage build | 350MB production image, reproducible builds | Podman (less tooling) |
| **Orchestration** | Kubernetes | HPA, rolling update, secret management, network policy | Docker Swarm (limited auto-scaling) |
| **Reverse Proxy** | Nginx | TLS termination, rate-limit, mature config | Traefik (auto-discovery overkill for single service) |
| **AI Integration** | HTTP multipart/form-data via LLMs Hub | Provider-agnostic, tương thích LLMs Hub nội bộ, no SDK lock-in | SDK per-provider (tight coupling, bypass Hub) |

---

## 13. Approval Sign-off

| Vai trò | Họ tên | Ngày | Chữ ký |
|---------|--------|------|--------|
| **Solution Architect** | | | |
| **Technical Lead** | | | |
| **Security Officer** | | | |
| **Infrastructure Lead** | | | |
| **Project Manager** | | | |

---

> **Document Control**  
> - v2.0 (2026-04-04): Cập nhật kiến trúc tham số Unified Parameters, ParamSchema Metadata, Tích hợp tính năng Chat Assistant. 
> - v1.0 (2026-04-03): Initial draft — full architecture with sequence diagrams, Docker & K8s deployment
> - Next review: Q3-2026

---

*DUGate — Kiến trúc chuẩn hóa truy cập Document AI cho doanh nghiệp.*
