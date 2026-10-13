# Contracts

`@du/contracts` là wire contract dùng chung cho toàn bộ workspace: DTO, Zod/JSON-Schema
validator, error taxonomy, wire bounds và mô tả API versioned. Đây là package mà mọi
service và business import, nên nó là nơi contract freeze được theo dõi
(`coordination/gates/contracts-v1.md`).

## Purpose

Wire DTO, JSON schema/validator, standardized errors, wire bounds và API descriptions
phiên bản hóa. Wire contract version hiện tại là `WIRE_CONTRACT_VERSION = '1'`.

## Boundary

Pure contracts: chỉ phụ thuộc `zod`. Không Next, DB, secret, network hay business
dependency.

## Structure

Module path ổn định theo gate `contracts-v1.md`; tất cả được re-export từ
`src/index.ts`:

| Module | Nội dung |
|---|---|
| `version.ts` | `WIRE_CONTRACT_VERSION` và type tương ứng |
| `errors.ts` | Error taxonomy và error code dùng chung |
| `manifest.ts` / `manifest-validator.ts` | Business/action manifest shape + validator |
| `json-schema-guard.ts` | Guard cho JSON Schema khai báo trong manifest |
| `operations.ts` | Operation state machine và list contract |
| `runtime.ts` | Runtime API wire, lease/checkpoint, multipart lifecycle bounds |
| `queue.ts` | Queue và task payload shape |
| `connector.ts` | Connector invocation wire + `CONNECTOR_ARTIFACT_MAX_BYTES` (10 MiB) |
| `sdk.ts` | Worker SDK extension interfaces |
| `public-api.ts` | Public `/api/v1` wire shapes |
| `hashing.ts` / `ip-policy.ts` | Hash helper và egress IP policy shape |
| `vault.ts` / `vault-policies.ts` / `oidc-claim-shapes.ts` | Vault + OIDC claim contract |
| `usage-metrics.ts` / `pricing.ts` / `usage-reconciliation.ts` / `usage-budget.ts` | Usage và billing contract |
| `encryption.ts` | Delivery encryption envelope, chunking geometry |

Xem [workspace structure](../../../docs/03-project-structure.md).

## Wire bounds

Các hằng số trong `runtime.ts`/`connector.ts` là **outer wire bound**, không phải SLA.
Deployment chỉ có thể hạ chứ không nâng. Ví dụ `MULTIPART_FIXED_PART_BYTES = 8 MiB`,
`MULTIPART_MAX_TOTAL_BYTES = 8 GiB`, `CONNECTOR_ARTIFACT_MAX_BYTES = 10 MiB`.
Trần một phần của Orchestrator là 64 MiB (định nghĩa ở service, không phải ở đây) —
xem [Orchestrator README](../../services/orchestrator/README.md).

## Build & Test

```bash
pnpm --filter @du/contracts build
pnpm --filter @du/contracts lint
pnpm --filter @du/contracts test
```

## Read first

- [04-data-state](../../../docs/04-data-state.md)
- [05-business-registry](../../../docs/05-business-registry.md)
- [06-public-api](../../../docs/06-public-api.md)
- [07-internal-api](../../../docs/07-internal-api.md)
- [08-connector-api](../../../docs/08-connector-api.md)
- [09-queue-sdk](../../../docs/09-queue-sdk.md)

## Task packets

- [P1-foundation-contracts](../../../tasks/P1-foundation-contracts.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Thay đổi wire contract cần đi qua contract owner và gate `contracts-v1.md` — agent không tự sửa contract đang freeze.

