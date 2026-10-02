# ACUI-00 — Catalog cấu hình Orchestrator (từ plan `ADMIN-CONTROL-PLANE-UI-2026-10-02.md`)

## Bối cảnh

Plan ACUI (SPECIFIED) mở đầu bằng ACUI-00: **catalog mọi setting** trước khi làm UI. Nguồn: `du-rework/tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` (đọc cả §Nguyên tắc cấu hình chung).
Task này là **inventory/analysis + deliverable mới** — không implement UI, không sửa source.

## Mục tiêu

1. Inventory **mọi cấu hình vận hành** từ: `services/orchestrator/src/main.ts`, `app/admin/oidc-boot.ts`, `businesses/document-core/src/config.ts`,
   `services/connector/src/entrypoint.ts`, `.env.example`(s), các bảng policy, connector revision/credential — mỗi item ghi:
   `id`, service, scope (`global|tenant|business|profile|user`), kiểu/validation, quyền đọc/ghi, nguồn hiện hành, secret policy,
   revision/effective state, item **đã quản lý được hay chưa**.
2. Phân loại 3 cơ chế áp dụng (theo §Nguyên tắc): managed (PG versioned) / secret-ref (Vault) / deployment (staging adapter hoặc `unmanaged - requires deployment action`).
3. Mapping **legacy config → replacement** + dependency register cutover (cùng `ORCH-PAR-00/06` — cite evidence file:line).
4. Đối chiếu chéo findings ACUI-M01..M07 (trong plan) — item nào catalog đã cover.

## Ranh giới

- READ-ONLY mọi source; **chỉ ghi mới**: `coordination/reports/qwen-acui-00-config-catalog-2026-10-02.md` (+ optional machine-readable JSON cùng thư mục).
- **KHÔNG ghi vào `docs/`** (lane khác đang sửa tài liệu) — nếu cần đồng bộ docs thì đề xuất trong receipt.
- Không tick gate; không commit; không sửa `tasks/*.md`/AGENTS.md/tasks-README; không nhắm `nocobase-10`.

## Acceptance

- Không có config nào không được phân loại (grep đối chứng từ các nguồn ở §1); mỗi dòng có file:line + owner + scope + source + tác động + rollback + màn UI dự kiến.
- Receipt nêu rõ phần chưa xác định (không đoán).
