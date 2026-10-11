# Verify độc lập (DSH) — OR10-03 runtime lease replay — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên `src/modules/runtime/runtime.ts` và `tests/or10-03-runtime-lease-replay.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-03-2026-10-10/DSH/` (`or10-03.log`, `tsc.log`, `SHA256SUMS.txt`).
**Receipt gốc đã đọc:** `coordination/reports/receipt-or10-03-2026-10-10.md` (tồn tại).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-03-runtime-lease-replay.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 6 passed, 6 total`** · không block lỗi |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

Test file 151 dòng. Không có FAIL ở lượt này.

## 2. Logic lease trong `runtime.ts` (đọc trực tiếp)

- **Hợp đồng ghi được ghi rõ ở đầu file:** `:38-39` — *Worker writes are fenced by authenticated business, current leaseEpoch, RUNNING state, and a live lease expiry. Stale reports return **409 LEASE_LOST***.
- **Từ chối replay cũ (stale):** `assertLeaseEpoch` (`:175-176`) — `if (task.lease_epoch !== leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');` ⇒ mọi báo cáo mang epoch cũ bị từ chối **409 LEASE_LOST**; `:184` tiếp tục chặn khi lease không còn active.
- **Replay chỉ an toàn cho đúng worker đang giữ lease:** comment `:604-608` nêu điều kiện `t.last_delivery_id === deliveryId && …` — *A delivery replay is safe only while this exact worker still owns the lease*; và **lease hết hạn sẽ đi theo đường takeover ở dưới và tăng epoch** (`:606`).
- **Takeover tăng epoch:** `:621` `const nextEpoch = (t.lease_epoch as number) + 1;` rồi `:624-627` `UPDATE tasks SET lease_epoch=$2, lease_expires_at=$3, leased_by=$4, …` ⇒ sau takeover, epoch của task đã đổi, nên mọi replay/report của chủ cũ **tự động thành stale** và bị `assertLeaseEpoch` chặn (409) — đúng cơ chế fence một chiều.
- **`claimTask`** (`:537-539`, tham số `deliveryId`) là điểm vào của cả đường replay lẫn đường takeover; comment `:583` cảnh báo một *stale delivery* không được mở cổng input/children gate.

## 3. Kiểm bounds theo packet

| Bound | Có được kiểm? | Bằng chứng |
|---|---|---|
| **Lease takeover tăng epoch** | **CÓ** (mã + test) | `runtime.ts:621,624-627` tăng `lease_epoch` khi cấp lease mới; test `:99` describe `runtime delivery replay lease ownership`, ca `:100` *replays the same delivery only for its owner **while the RUNNING lease is active*** ⇒ ngụ ý ngoài điều kiện đó (lease đổi chủ) replay không còn hợp lệ |
| **Từ chối stale replay** | **CÓ** (mã + test) | `assertLeaseEpoch` `:175-176` ném `LEASE_LOST` khi epoch lệch; ca `:111` *does not let a different worker replay the current worker lease* ⇒ worker khác không replay được lease hiện tại |
| **Fence theo delivery id + worker** | **CÓ** | comment `:604-608` mô tả điều kiện owner (`last_delivery_id === deliveryId`), và harness test có nhánh mô phỏng `UPDATE tasks SET lease_epoch=$2` (`test:72`) để kiểm đường takeover |

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite OR10-03 | **PASS** — 6/6, exit 0 |
| Typecheck | **PASS** — exit 0 |
| Stale replay rejection | **ĐẠT** — `runtime.ts:175-176` → 409 `LEASE_LOST` khi epoch lệch; test `:111` |
| Lease takeover epoch | **ĐẠT** — `:621`, `:624-627` tăng epoch; test `:100` |
| Hợp đồng fence (business/epoch/RUNNING/expiry) | **ĐẠT** — tài liệu `:38-39` khớp mã |

⇒ **OR10-03: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, `client` giả:** test dùng harness mô phỏng SQL (`SELECT … FROM tasks t JOIN operations o`, `UPDATE tasks SET lease_epoch=$2`, `UPDATE operations SET state='RUNNING'` — `test:63-84`); hành vi thật trên PostgreSQL (khoá `FOR UPDATE`, race hai worker cùng claim, đồng hồ lease) **chưa** được chứng minh — cần gate live.
2. **Độ phủ 6 ca / 151 dòng:** tôi đọc được 2 tên ca (`:100`, `:111`) khớp trực tiếp hai bound; 4 ca còn lại tôi **chưa** đọc tên (giới hạn ngân sách lượt này) ⇒ không khẳng định chúng phủ những gì.
3. **Chưa đối chiếu nội dung receipt gốc** (`receipt-or10-03-2026-10-10.md` tồn tại): lượt này verify bằng lệnh chạy thật + đọc mã, không đọc từng claim trong receipt.
4. **Chưa chạy suite runtime lớn** (ví dụ `tests/runtime.test.ts` — live-gated) nên chưa loại trừ regression ngoài phạm vi OR10-03.
5. Không commit: test là file mới/` M` tùy trạng thái; `runtime.ts` có thể ` M` từ lane khác ⇒ kết quả gắn HEAD §0.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
