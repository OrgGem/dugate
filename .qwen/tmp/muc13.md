
## 13 — CYCLE 13: W-INGEST-0019-2 (deadline_at sentinel = Const literal inline, khop 0019)

#### Bối cảnh (đo trước khi sửa)
- Packet W-INGEST-0019-2 (task_370713dea9d2, dispatch ctx_f57469bd76f4); F01 HIGH
  từ hourly review Turn 219. 0019 đã ship 4 expression index bake Const literal,
  nhưng query bind sentinel qua Param -> planner không coi Param bằng Const ⇒
  không chọn index ⇒ tái hiện T-35 (Sort -> Seq Scan).
- Neo packet đọc fresh TRƯỚC khi sửa (src trôi dòng liên tục): map sentinel 2526,
  bindOperationsListSortKey 2547, bindOperationsCursor 2585, listOperationsPage
  2620, call site 2636 — tất cả ĐÚNG tại thời điểm đo.
- Baseline cùng lệnh TRƯỚC sửa (4 suite liên quan, cwd services/orchestrator):
  Tests: 144 passed, 13 skipped, 157 total — Exit Code: 0. 13 skip =
  admin-keyset-explain (gate DU_LIVE_INFRA; lane không mở window).

#### Thay đổi (duy nhất services/orchestrator/src/server.ts — đúng phạm vi packet)
1. bindOperationsListSortKey(sort): bỏ tham số params + bỏ params.push. Nhánh
   nullable trả COALESCE(<column>, '<sentinel>'::timestamptz), sentinel lấy từ
   CHÍNH map OPERATIONS_LIST_NULL_SORT_BOUND_SQL theo direction — một map phục vụ
   cả hai nửa hợp đồng (literal trong ORDER BY + value cursor mang cho key NULL),
   nên hai nửa không thể lệch nhau.
2. Call site listOperationsPage:2645 goi bindOperationsListSortKey(sort). pageParams
   vẫn theo thứ tự filter params -> cursor boundary params -> limit. Không còn slot
   sentinel ở giữa ⇒ filter KHÔNG đổi số thứ tự; với cursor + deadline_at, limit tụt
   từ $6 xuống $5 (self-consistent vì LIMIT đọc pageParams.length lúc build).
3. bindOperationsCursor KHÔNG đổi: vẫn push (cursor.createdAt, cursor.id) và
   $<len-1>::timestamptz, $<len>::uuid — boundary vẫn param-bound đúng packet;
   sentinel giờ nằm trong sortKeySql mà nó nội bao.
4. Bốn comment sửa cho khỏi nói dối: NULLABLE_SORT_FIELDS (bound sentinel ->
   sentinel literal), map sentinel (ghi rõ một-map-hai-nửa + phải khớp 0019
   byte-for-byte), doc của bindOperationsListSortKey (Const vs Param + lý do index
   chết), comment call site.

SQL before/after (deadline_at:desc, không filter, có cursor):
BEFORE  WHERE (COALESCE(deadline_at, $1::timestamptz), id) < ($2::timestamptz, $3::uuid)
        ORDER BY COALESCE(deadline_at, $1::timestamptz) DESC, id DESC LIMIT $4
        params = [sentinel, cursorCreatedAt, cursorId, limit+1]
AFTER   WHERE (COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz), id) < ($1::timestamptz, $2::uuid)
        ORDER BY COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC LIMIT $3
        params = [cursorCreatedAt, cursorId, limit+1]
Minh bạch bằng chứng: khối AFTER trên là composed (đọc code + số học placeholder).
Phần in NGUYÊN VĂN từ route là ca không-cursor, ghi ở E3.

#### Verify (offline; exit code nguyên văn từ wrapper)
- E1 Typecheck dạng packet: pnpm --filter @du/orchestrator typecheck
  (tsc --noEmit -p tsconfig.json) — Exit Code: 0.
- E1b Dạng lệnh user giao: npx tsc --noEmit -p tsconfig.json trong
  services/orchestrator — Exit Code: 0. Δ11 vẫn đúng: tsconfig exclude tests ⇒
  gate này không phủ file test.
- E2 Byte-identity với 0019 (scratch check, không phải artifact):
  desc = COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)
  asc  = COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz)
  mỗi expression xuất hiện ĐÚNG 2 lần trong 0019 (tenant-led + key-led) ⇒ khớp 4/4
  index từng ký tự. Thêm: sortFn không còn params.push, không còn dạng
  $<len>::timestamptz; cursorFn chỉ push cặp boundary; cursorFn không tham chiếu
  map sentinel. Kết quả: ALL CHECKS PASS — Exit Code: 0.
- E3 Route-emitted SQL, BẮT NGUYÊN VĂN từ harness conformance (không đoán):
  SELECT * FROM operations ORDER BY COALESCE(deadline_at,
  '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC LIMIT $1
  ⇒ hết-cursor: limit là $1 (không còn slot sentinel), id tiebreak còn nguyên.
- E4 4 suite liên quan, 3 lượt liên tiếp, KẾT QUẢ GIỐNG HỆT:
  run1/run2/run3 — Test Suites: 3 failed, 1 passed, 4 total;
  Tests: 14 failed, 13 skipped, 130 passed, 157 total — Exit Code: 1 cả 3 lượt.
  (Baseline cùng lệnh trước sửa: 144 passed / Exit Code: 0.)
- E5 Collateral full unit offline (pnpm run test:unit): Test Suites: 4 failed,
  1 skipped, 70 passed, 74 of 75; Tests: 15 failed, 28 skipped, 1774 passed,
  1817 total — Exit Code: 1. 15 = 14 của E4 + 1 pre-existing (Δ31).
- E6 Integrity file: server.ts CRLF thuần (3256 CRLF, 0 lone LF, 0 lone CR), 79
  em-dash còn nguyên, không U+FFFD; sha256_8 = 29c79b1a, 3257 dòng (baseline
  cycle 12 ghi aaea7f44…/3248 ⇒ +9 dòng, đúng bằng phần comment thêm vào).
  Migration 0019 KHÔNG đổi: 5129 bytes, sha256_8 = 8554cbba, 4 CREATE INDEX.
- Không mutation probe: packet không yêu cầu, và lane không mở file test của lane
  khác để dựng probe.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ29 — acceptance của packet tự mâu thuẫn với phạm vi ghi của nó. Điều kiện
  'existing suites still pass' KHÔNG đạt được nếu chỉ được sửa server.ts: 14 test
  đỏ nằm ở 3 suite Admin-lane, tất cả parse SQL do route phát ra và GIẢI sentinel
  qua placeholder:
  (a) tests/operations-list-contract-conformance.test.ts:227-228 (bảng
      ORDER_BY_BY_SORT) + test mang tên 'the NULL sentinel for the nullable column
      is bound, not interpolated' :314-330 — test này assert CHÍNH chiều ngược với
      fix (đòi sql không chứa '0001-01-01' và params phải chứa sentinel).
  (b) tests/admin-operations-list-pagination.test.ts:1743 — regex fake-DB chỉ nhận
      dạng COALESCE(<col>, $<n>::timestamptz) ⇒ 5 test throw 'unrecognised ORDER BY
      key expression'.
  (c) tests/admin-operations-sort-http-offline.test.ts:164 BOUNDARY_RE + :189 nhánh
      COALESCE ⇒ fake-DB không diễn giải được ⇒ 7 test nhận 500 thay vì 200.
  Lane KHÔNG sửa (đúng quyền sở hữu; Admin lane đang active, chạm vào là hỏng nhau
  trong checkout dùng chung). Đề xuất: packet W-ADMUX02-SORT-LITERAL-ALIGN-1 cho
  Admin lane, hoặc cấp quyền cho lane này sửa 3 harness.
- Δ30 — hợp đồng tài liệu + chú thích migration thành stale, lane không được sửa:
  docs/06-public-api.md:74 và docs/20-openapi-descriptions.md:39 mô tả sentinel
  dang 'đã bind'/'bound sentinel'; 0019 header (12-24) mô tả query là
  COALESCE(deadline_at, $sentinel::timestamptz); review.md:965, qwen-docs.md:2163
  và qwen-docs.md:2249 cũng vậy. Neo 0019 header server.ts:2547/2593/2659 sau sửa
  là 2556/2594/2668 (+9) — Reviewer/Tester nên định vị theo symbol, không theo số
  dòng. Δ24 cấm sửa migration đã apply nên lane để nguyên và ghi lại đây.
- Δ31 — collateral pre-existing KHÔNG thuộc packet:
  tests/connector-revision-http-offline.functional.test.ts (VAULT-06, file UNTRACKED
  trong git) đỏ 1 test 'restart/reconcile: stranded PENDING...' —
  expect(stranded.revision).toBe(2) nhận undefined. Đỏ y hệt khi chạy riêng lẻ
  (Exit Code: 1) và không chạm đường SQL nào của cycle này. Lane nhận thiếu sót
  protocol ở đây: chỉ baseline 4 suite trước khi sửa, không baseline full suite,
  nên không có bằng chứng tiền kiểm cho tính pre-existing — bằng chứng hiện có là
  cô lập symbol + untracked + đỏ độc lập. Đề xuất Verify xác nhận nguồn gốc (vùng
  Vault lane Δ7/Δ8).
- Rủi ro operational cho gate live (nêu thẳng, không chôn): nếu Tester chạy live
  EXPLAIN bằng SQL viết tay trong admin-keyset-explain.test.ts:448-470 (dạng
  $2::timestamptz), họ đang EXPLAIN lại hình thái CŨ và sẽ tái falsify. Live window
  phải chạy theo hình thái literal mới, cả hai chiều, tenant-scoped + cross-tenant,
  COSTS OFF; chỉ báo Index Scan trên operations_*_deadline_coalesce_*_id_idx khi
  Sort biến mất.
- Phạm vi: chỉ server.ts; không migration; không contracts; không docs; không test
  lane khác; không live window; không commit/push.

#### Tự phân loại 4 tầng
- SPECIFIED: packet rõ; F01 deterministic; literal target lấy từ 0019:66-79.
- IMPLEMENTED: sort-key builder phát Const literal theo direction; bỏ params
  coupling; cursor boundary vẫn param-bound; call site + comment cập nhật.
- VERIFIED (offline, MỘT PHẦN): tsc 0 ở cả hai dạng lệnh; byte-identity 4/4 với
  0019; SQL route-emitted đúng hình thái (bắt nguyên văn); 1774 test còn lại xanh;
  14 đỏ deterministic x3 và nằm toàn bộ ở harness ngoài phạm vi ghi. CHƯA VERIFIED:
  hành vi phân trang deadline_at với SQL mới (fake-DB Admin chưa hiểu hình thái mới
  ⇒ chưa có bằng chứng offline cho continuity/no-loss), và việc planner thật chọn
  index hay không.
- ACCEPTED: không thuộc quyền lane. T180-A1/T190-A1 vẫn chờ Tester live EXPLAIN;
  W-INGEST-0019-2 chỉ hết blocking khi Δ29 được adjudicate (suite xanh) + live
  green.
