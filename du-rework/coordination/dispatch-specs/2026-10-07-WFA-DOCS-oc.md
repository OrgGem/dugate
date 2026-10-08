# DISPATCH SPEC: WFA-DOCS — docs + OpenAPI cho Workflow API (song song với qwen_2)

- Task: `WFA-DOCS` (canonical plan: `du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §6 WFA-T38 + §5 WFA-06)
- Assigned Agent: **OC lane** (`term_cefb27a0-271a-4343-b2dc-ae1fe9910365`)
- Role: WFA docs/OpenAPI owner
- Status: DISPATCHED / LEASE_ASSIGNED
- Repo scope: `du-rework`
- Canonical plan: `du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md`
- Directives:
  - **Do NOT commit, do NOT push.**
  - **Không hand-edit** `du-rework/docs/21-openapi.json` — chỉ regenerate qua `tools/openapi/gen_openapi.py`.
  - Chỉ sửa các **workflow sections** trong 2 docs dưới; không đụng sections của lane khác.
  - Lease này KHÔNG giao với qwen_2 (`WFA-HANDOVER` mục 1–6 chạm product source; lane này chỉ chạm docs + generator + generated JSON). Nếu generator cần sửa product source mới chạy được → dừng, ghi request, không tự sửa.
  - Giữ nguyên quy ước trung thực: phân biệt IMPLEMENTED (admission) vs OPEN (runtime/e2e). Không nâng mức claim khi chưa có evidence mới.

---

## 1. Việc phải làm

| # | File | Việc cần làm | Kiểm tra đóng |
|---|---|---|---|
| 1 | `tools/openapi/gen_openapi.py` + `validate_openapi.py` | Chạy regen + validate trên Node 24 (Node phải có trên PATH). Baseline: 60 paths, 0 drop, version 1.5.0, 2 workflow paths `/api/v1/docs/workflows` + `/api/v1/docs/workflows/schema` hiện diện | cả 2 exit 0; `docs/21-openapi.json` regen byte-identical hoặc diff có chủ đích ghi rõ |
| 2 | `docs/06-public-api.md:29` + `docs/39-legacy-parity-contract.md:30-32` | Sửa stale: services/billing/balance/usage ghi "chưa implement / không có route" nhưng code **đã có** handler (`orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts:806-904`, `billingFor` đã wire tại `legacy-host-adapter.ts:417,609-653`). Chỉ `GET /api/v1/services` là đúng chưa chạy (500 thiếu catalogue — ghi rõ là lỗi đã biết, không ghi "chưa implement") | reviewer đọc doc vs code, khớp từng dòng |
| 3 | `docs/06-public-api.md:15` | Path rút gọn `POST /docs/{action}` gây nhầm — legacy thật là `/api/v1/docs/...`; 6 core actions đã có handler (`legacy-http-mount.ts:600-646`). Sửa cho đúng | như trên |
| 4 | `docs/06-public-api.md:44` | Câu "bỏ qua `?sync` và `Idempotency-Key`" chỉ đúng cho **workflow routes**; 6 core actions tôn trọng cả hai (`legacy-http-mount.ts:247-253,282-291,321-324`). Sửa phạm vi câu | như trên |
| 5 | `docs/39-legacy-parity-contract.md:40` | "grep server.ts → 0 hit compat" đã lỗi thời: mount giờ ở `http/routes/public.ts:13-14,299` (sau CONV-02 tách route). Cập nhật file:line | như trên |
| 6 | Parity matrix (cả 2 docs) | Đối chiếu `coordination/reports/wfa-verification-2026-10-07.md` + `wfa-integration-2026-10-07.md`: chỉ đánh dấu verified cho acceptance đã có evidence (T04..T13, T29..T32, T14, T37, T16/T17, T23/T24 + 8/8 receipt mới); còn lại giữ OPEN với owner/action kế tiếp. Không tự tick ACCEPTED | matrix khớp reports, không claim thừa |

Non-goals: Portal/Workflow Builder docs, API mới, provider trả phí, production cutover.

## 2. Lệnh kiểm tra

```
cd du-rework
python tools/openapi/gen_openapi.py
python tools/openapi/validate_openapi.py
```

Node v24.21.0 phải có trên PATH khi chạy generator (baseline: gen 60 paths / 0 drop exit 0; validate exit 0). Ghi command + cwd + exit code + version vào receipt.

## 3. Bàn giao

- Receipt: `du-rework/coordination/reports/wfa-docs-2026-10-07.md` (evidence: command/cwd/exit, diff summary từng dòng docs sửa + file:line code đối chiếu, OpenAPI version/paths count).
- Đồng bộ `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md` cho phần docs/contract chạm tới.
- Independent review trước release do lane khác làm; không tự tick ACCEPTED.
