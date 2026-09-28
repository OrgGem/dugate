# Claude lane report — W48-C1 admin audit ledger (REAL, không placeholder)

Ngày: 2026-09-25. Packet W48-C1: audit ledger chặn cả ADM-BASE-01 (HIGH admin RBAC gate)
và ADM-UX-04 (empty-events row). Trước packet này, `GET /api/v1/admin/audit` trả về
`events: []` hardcode vì chưa hề có bảng ledger.

## Trạng thái 4 work item

- (1) Migration mới: DONE — `migrations/0010_admin_audit.sql` tạo bảng `admin_audit_events`
  với đủ 8 cột packet yêu cầu (`id, tenant_id, actor, action, resource, severity,
  correlation_id, created_at`) + index theo tenant-thời gian và theo thời gian.
- (2) Write path: DONE — cả 5 admin mutation THẬT trên platform đều ghi 1 dòng audit thật.
- (3) GET fix: DONE — đọc bảng thật với tenant predicate + tôn trọng `limit`, giữ nguyên
  envelope `{ tenantId, events }` nên UI không vỡ.
- (4) 3 test theo packet: DONE — **ĐÃ CHẠY XONG, 3/3 PASS × 3 run** (xem "Kết quả test" bên dưới).

## File đã sửa / tạo (kèm Test-Path)

1. TẠO `du-rework/services/orchestrator/migrations/0010_admin_audit.sql`
   - `admin_audit_events`: `id uuid PK DEFAULT gen_random_uuid()`, `tenant_id uuid NULL`
     (NULL cho event platform-global — `business_versions` không có cột tenant nên không có
     tenant trung thực để gán; xem comment trong file), `actor/action/resource/severity`
     (default `'info'`), `correlation_id`, `created_at timestamptz DEFAULT now()`.
   - Index `admin_audit_events_tenant_time (tenant_id, created_at DESC)` — đúng predicate
     của GET; index `admin_audit_events_time (created_at DESC)` cho view global tương lai.
   - Forward-compatible `CREATE TABLE/INDEX IF NOT EXISTS` (tiền lệ 0007/0009).
2. TẠO `du-rework/services/orchestrator/src/modules/audit/audit.ts`
   - `createAuditService(db)` với `record(input)` (INSERT 1 dòng bất biến, gọi SAU khi mutation
     thành công) và `listForTenant(tenantId, limit)` (SELECT ... WHERE tenant_id=$1
     ORDER BY created_at DESC, id DESC LIMIT $2, map sang wire).
   - `action` tái dùng union `AuditEventKind` của renderer (không sửa lane OpenClaude);
     `resource` → wire `resourceId`, `created_at` → ISO `occurredAt`.
3. SỬA `du-rework/services/orchestrator/src/server.ts`
   - Import + khởi tạo `audit` trong `createApp`, thêm field `audit: AuditService` vào
     `RouteContext`, gắn vào object `route({...})`.
   - 5 write-path (actor cố định `'admin'`, correlationId = `ctx.correlationId`, raw
     credential KHÔNG BAO GIỜ chạm ledger):
     enable → `business.enable`/`success`/`business:<id>@<version>` (tenant NULL);
     activate → `business.activate`/`info` (tenant NULL);
     deactivate → `business.drain`/`warning` (route giữ tên `deactivate` theo W28-C,
     chỉ wire kind theo renderer);
     profile-bindings → `apikey.profile_bind`/`info`/`apikey:<keyId>` mang `tenantId` của key
     (mutation duy nhất mang tenant — dùng làm bằng chứng audit); REVIEWER 6/6 item 1:
     kind cũ `apikey.create` render nhãn SAI "API key created" nên đã đổi sang kind trung thực
     (xem "REVIEWER 6/6 — item 1" bên dưới);
     sweep-deadlines → `operation.deadline`/`warning`/`operations:deadline-sweep` (tenant NULL).
   - GET `/api/v1/admin/audit`: dùng `ctx.audit.listForTenant(tenantId, limit)` với clamp
     limit 1..200 giữ nguyên; xóa `void limit`; tenant rỗng trả `events: []` trung thực
     (tránh uuid-syntax 500) — giữ shape envelope.
4. SỬA `du-rework/services/orchestrator/src/modules/profiles/profiles.ts`
   - `createRevision` trả thêm `tenantId` + `apiKeyId` (additive; caller duy nhất là route
     trên, helper test `runtime.test.ts` dùng cast nên không vỡ).
5. TẠO `du-rework/services/orchestrator/tests/admin-audit.test.ts` — Test-Path packet yêu cầu:
   `du-rework/services/orchestrator/tests/admin-audit.test.ts`
   - Test 1: mutation (POST profile-bindings) sinh audit row THẬT — đọc lại qua GET, assert
     đủ field ledger (`id/kind/severity/occurredAt/tenantId/actor`), raw key không lộ,
     cross-check trực tiếp bảng `admin_audit_events`.
   - Test 2: tenant A không đọc được event của tenant B (predicate server-side; mọi row A
     thấy đều mang `tenantId` của A).
   - Test 3: `limit` được tôn trọng (`limit=2` → ≤2 rows, `limit=1` → đúng 1 row = row mới nhất).
   - Fixture: 2 tenant + 2 key riêng biệt, hash seed = `hashKey(raw)` thật (không dùng
     placeholder `'hash-<id>'`); cleanup chỉ xóa row của suite.
   - Ổn định Windows (sau RUN REQUEST #2): `postBinding` retry fetch tối đa 3 lần, delay
     500ms giữa lần, CHỈ retry khi `fetch` ném lỗi network (ETIMEDOUT/ECONNREFUSED);
     assertion status 201 giữ nguyên nghiêm ngặt nên fail thật không bị che.

## Typecheck / lint (tự chạy, không cần DB)

- `npm run lint` tại `du-rework/services/orchestrator` (= `tsc --noEmit -p tsconfig.json`):
  sạch, exit 0, không output.
- Lưu ý: `tsc` ở repo root báo lỗi `TS2802` có sẵn ở nhiều file (connector, isolation,
  runtime.test.ts...) — lỗi tiền tồn, KHÔNG do packet này; orchestrator `lint` sạch.

## Khai báo trung thực (không bịa — theo RÀNG BUỘC packet)

- Các mutation publish / retire / key create-revoke / rotation / connector-update KHÔNG có
  route platform `/api/v1/admin/**` thật (chỉ là form display-only trong `src/app/admin`,
  lane OpenClaude) nên không thể ghi audit row cho chúng mà không bịa route. Đã ghi rõ ở
  comment trong `server.ts` (profile-bindings). Đây là gap, không phải done.
- Không sửa `packages/worker-sdk` (lane Qwen_2), không sửa `services/connector` (lane
  Codex_2), không sửa `src/app/**` (lane OpenClaude). Không commit, không push, không tick row.

## Kết quả test — DONE (Tester chạy 2026-09-25, chi tiết tại `reports/tester.md` W48-C1)

- DB window CLAIM 00:51:33 → RELEASE 00:51:54 (+07:00). 3 run liên tiếp, đơn tiến trình,
  lệnh `npx jest tests/admin-audit.test.ts --runInBand` tại `services/orchestrator`.
- Run 1: PASS 3/3 (7.7s) | Run 2: PASS 3/3 (2.6s) | Run 3: PASS 3/3 (2.5s). ExitCode 0 cả 3.
- Cả 3 case packet đều xanh ổn định: (1) mutation → audit row thật, (2) tenant isolation,
  (3) limit respected.

## REVIEWER 6/6 DIRECTIVE (Codex-3 audit W48-C1) — trạng thái

### Item 1 — Event taxonomy: DONE (code + test xong, chờ Tester re-run)

- Vấn đề: POST profile-bindings ghi kind `apikey.create` khiến UI render nhầm "API key created"
  trong khi không có key nào được issued — chỉ là grant bind.
- Fix: write-path giờ ghi `action: 'apikey.profile_bind'` (`server.ts` + comment giải thích);
  `audit.ts` module doc + `AuditRecordInput.action` doc cập nhật (cho phép kind namespaced trung
  thực ngoài union renderer, ledger truth trước fallback); test 1 + cross-check DB assert kind
  mới. File sửa: `src/server.ts`, `src/modules/audit/audit.ts`, `tests/admin-audit.test.ts`.
- Typecheck: `npm run lint` tại `services/orchestrator` sạch, exit 0.
- NUDGE cho lane OpenClaude (không sửa `src/app/**` theo ownership): renderer union
  `AuditEventKind` + `AUDIT_KIND_META` + `AUDIT_KIND_SET` trong
  `src/app/admin/overview-view-models.ts` / `overview-section-data.ts` chưa biết
  `apikey.profile_bind` — fetcher hiện fallback `'operation.complete'` cho kind này. Đề nghị lane
  UI adopt kind mới (label gợi ý: "API key profile bound", severity `info`) để pane hiển thị
  đúng; ledger đã trung thực, fallback chỉ tạm thời và đã document trong code.
- Test re-run: RUN REQUEST mới đã phát tới Tester (xem bên dưới).

### Kết quả RUN REQUEST #2 — fail/pass/fail do ETIMEDOUT Windows (evidence: `tester.md`)

- DB window CLAIM 01:21:25 → RELEASE 01:21:45 (+07:00). Run 2 PASS 3/3; run 1 và 3 FAIL tại
  test 1 với `TypeError: fetch failed — connect ETIMEDOUT 127.0.0.1:<port>` ngay tại `fetch`
  trong `postBinding` (chạy liên tiếp trên Windows → TIME_WAIT / listen-backlog).
- Kết luận: code đúng (run 2 xanh, pattern lỗi thuần network), suite chưa ổn định trên
  Windows → đã thêm retry (xem mục 5 test, "Ổn định Windows") và phát RUN REQUEST #3.

### RUN REQUEST #3 → Tester — ĐÃ TIÊU THỤ, 3/3 PASS (thông báo Tester; `tester.md` chưa append)

- Thông báo từ Tester: cả 3 run PASS, ExitCode 0 cả 3 (thời gian 3.7s / 2.8s / 3.0s),
  DB window đã release an toàn. Retry Windows đã phát huy tác dụng.
- LƯU Ý TRUNG THỰC: tại thời điểm ghi báo cáo này, `reports/tester.md` mới ghi tới
  RUN REQUEST #2 (363 dòng, dừng ở Run 3 fail ETIMEDOUT); kết quả #3 mới chỉ có qua thông
  báo trực tiếp, chưa có raw output văn bản trong file. Đã nhờ Tester append raw output #3
  vào `tester.md`; khi có sẽ đối chiếu lại. Không claim evidence chưa đọc được.

### Item 2 — Transactional/atomicity: CHƯA LÀM (ghi nhận để turn kế)

- Hiện tại `record()` chạy SAU khi mutation commit — nếu audit INSERT fail, mutation đã thành
  công nhưng không có audit row (fail-open ở phía audit). Hướng xử lý dự kiến: bọc mutation +
  audit trong cùng `db.tx` ở các route có tx (activate/deactivate đã có tx trong registry;
  enable là raw UPDATE; profile-bindings là 2 query rời) hoặc retry/DLQ cho audit fail.
  Cần thiết kế, không làm vội trong turn này.

### Item 3 — Tenant auth check trên GET audit: CHƯA LÀM (ghi nhận để turn kế)

- Hiện tại route chỉ `assertAdminAuth` (single static bearer, chưa có principal/role) + predicate
  `WHERE tenant_id=$1`. Reviewer muốn kiểm tra principal/role khi lọc tenant — phụ thuộc kiến
  trúc RBAC admin (ngoài scope W48-C1). Ghi nhận, không bịa principal.

## RUN REQUEST #2 → Tester (DB window holder) — ĐÃ PHÁT (chờ kết quả)

Đã phát tới `term_50c6a1ed` (tab Tester): chạy lại suite sau fix taxonomy **3 lần liên tiếp,
đơn tiến trình**, mỗi lần một lệnh, không chồng suite Live khác:

```
cd du-rework/services/orchestrator && npx jest tests/admin-audit.test.ts --runInBand
```

- Mong đợi mỗi lần: 3 passed, exit 0 (test 1 assert kind mới `apikey.profile_bind`).
- Kết quả nhờ ghi vào `coordination/reports/tester.md` (mục W48-C1 re-run taxonomy).

## R1-B MM-10b — heartbeat 200 sau cancel: FIXED (lint sạch, chờ test phía Qwen-2/Tester)

- Khảo sát gốc: Qwen-2 `reports/qwen2.md` mục 31 (không sửa src, đúng boundary).
- Root cause (xác nhận khi đọc code): `heartbeatTask` (`runtime.ts:127-145`) SELECT epoch-only
  + UPDATE fence epoch-only; `cancelOperation` (`lifecycle.ts`) không bump epoch/clear lease →
  same-epoch heartbeat trên task CANCELLED khớp 1 row → 200 + kéo dài lease trên hàng terminal.
  Thêm: `cancelRequested: false` hardcode dù `operations.cancel_requested=true` (kênh cooperative
  cancel qua heartbeat đang chết; SDK worker đọc cờ này tại `worker.ts:328`).
- Fix tại `services/orchestrator/src/modules/runtime/runtime.ts` (`heartbeatTask`), đúng 4 điểm
  packet R1-B giao, giữ thứ tự guard để không gãy suite 20/20 hiện hữu:
  1) SELECT thêm `t.state` + `o.cancel_requested` qua `JOIN operations`;
  2) check epoch-stale TRƯỚC (409 LEASE_LOST — giữ contract stale→409 của `runtime.test.ts`
  và p8-02 §3), check terminal-state SAU (410 TASK_TERMINAL, pattern như `completeTask`);
  3) UPDATE thêm `AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`
  (belt-and-braces cho race SELECT→UPDATE);
  4) return `cancelRequested: Boolean(row.cancel_requested)` thay vì hardcode false.
- Không sửa `lifecycle.ts` (gợi ý optional clear lease của Qwen-2 không bắt buộc vì state-guard
  đã chặn; tránh chạm behavior cancel ngoài scope).
- Typecheck: `npm run lint` tại `services/orchestrator` sạch, exit 0.
- Không test nào assert `cancelRequested` cứng (grep tests: 0 hit) nên đổi behavior an toàn;
  heartbeat đúng-epoch trên task RUNNING vẫn 200 như cũ.
- Test phía Qwen-2/Tester: flip `p8-02b` MM-10b `expect(hb.status).toBe(200)` → 410 +
  `code TASK_TERMINAL` rồi RUN REQUEST 3 lần — thuộc lane Qwen-2/Tester, tôi không tự chạy DB.
  Không commit/push/tick.

## Chặn trở (nếu có)

- Nếu Tester báo DB window bận: tên chặn trở = "DB window occupied — chờ Tester", packet còn
  lại đúng 1 việc (kết quả 3 run) sẽ tiếp tục turn kế theo LUẬT CHỐNG DỪNG, không cần nhắc.
