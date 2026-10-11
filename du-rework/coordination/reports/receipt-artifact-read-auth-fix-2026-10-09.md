# Receipt — artifact-read-authorization 5 RED → đồng bộ với code + docs/28 (2026-10-09)

- **Dispatcher:** Antigravity (Single Dispatcher), packet gửi Codex-1 + Qwen-2.
- **Lease:** DUY NHẤT `orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts`.
- **Không sửa product code, không commit, không push, không git add.**

## 1. Đối chiếu tiền đề (đọc code + docs, không tin prompt)

| Nội dung packet | Đối chiếu | Kết luận |
|---|---|---|
| `artifacts.ts:707` lease hết hạn → 409 `LEASE_LOST` | `src/modules/artifacts/artifacts.ts:707` `if (!task.lease_active) throw conflict(LEASE_LOST, ...)`; nhánh này **trước** kiểm tra task state ở `:709-711` | Khớp |
| `artifacts.ts:753-755` → 409 `PERMISSION_DENIED` | `:753-755` `if (art.taskId !== req.taskId && art.state !== READY) throw conflict(PERMISSION_DENIED, ...)`; **chạy trước** `if (art.state !== READY) throw conflict(STATE_CONFLICT, ...)` ở `:756` | Khớp |
| docs/28 `:1323` + CORRECTION `:1400` đã xác nhận 409 LEASE_LOST / 409 PERMISSION_DENIED | `docs/28-test-inventory.md:1323` (expired lease → 409 LEASE_LOST; tenant mismatch → 409 PERMISSION_DENIED) và `:1399-1400` CORRECTION 2026-10-09 (DSH) ghi rõ **lý do thứ tự**: check foreign+unready chạy trước nhánh STATE_CONFLICT; lease hết hạn trả 409 trước khi xét task state; `403 PERMISSION_DENIED` chỉ đến từ `forbidden()` (`src/http/errors.ts:53`) và **không** dùng trên đường đọc | Khớp |

**Bằng chứng độc lập của tôi trước packet này:** tôi đã tự chạy suite này ở leg verify (`coordination/reports/verify-legacy-ara-INDEPENDENT-QWEN-2026-10-09.md`, mục Lệnh 2) và thấy **đúng 5 RED** với đúng cặp expected/received mà packet nêu (`:375`, `:386`, `:597`, `:732`, `:742`). Nên đây là lần thứ hai độc lập xác nhận, không phải chỉ tin prompt.

## 2. Dòng đã sửa (6 dòng trong 1 file lease)

| Dòng | Trước | Sau | Vì sao đúng |
|---|---|---|---|
| `:376-377` | `code: STATE_CONFLICT` | `status: 409,` + `code: PERMISSION_DENIED` | foreign task + chưa READY → `:753-755` chạy trước `:756` |
| `:387` | `{ status: 403, code: PERMISSION_DENIED }` | `{ status: 409, code: LEASE_LOST }` | lease hết hạn → `:707` |
| `:589` | tên test: `reports a state conflict, not a permission denial, ...` | `reports a permission denial, not a state conflict, ...` | tên cũ **mô tả ngược** contract sau khi sửa; để nguyên sẽ gây hiểu nhầm cho người đọc sau |
| `:598` | `code: STATE_CONFLICT` | `{ status: 409, code: PERMISSION_DENIED }` | cùng lý do `:753-755` (declared cross-op STAGING) |
| `:733` | `{ status: 403, code: PERMISSION_DENIED }` | `{ status: 409, code: LEASE_LOST }` | lease hết hạn thắng task state (thứ tự `:707` trước `:709`) |
| `:743` | `{ status: 403, code: PERMISSION_DENIED }` | `{ status: 409, code: LEASE_LOST }` | cùng lý do; test này vẫn FINDING về `lease_active` nên tôi **giữ nguyên tiêu đề FINDING** |

### Hai lựa chọn tôi tự quyết, cần dispatcher biết

1. **Tôi pin thêm `status: 409`** cho `:376-377` và `:598` (packet chỉ yêu cầu đổi `code`, có nêu tuỳ chọn thêm status). Lý do: docs `:1400` viết rõ **409**, và `conflict()` đã được chứng minh trả 409 qua chính RED `:386/:732/:742` (received `{status: 409, code: LEASE_LOST}`). Pin status làm test bắt được hồi quy nếu lỗi quyền bị đổi thành 403. **Đã xác minh bằng run thật** (xem §3), không phải suy đoán.
2. **Tôi đổi tiêu đề 1 test** (`:589`) dù packet chỉ nói sửa assertion. Lý do: tiêu đề cũ nói "state conflict, not a permission denial" trong khi assertion mới là ngược lại → mâu thuẫn nội tại. Nếu dispatcher muốn giữ phạm vi **chỉ-assertion**, đây là dòng duy nhất cần revert.

## 3. Chạy lại (cwd `du-rework/orchestrator/services/orchestrator`)

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
  PASS  tests/artifact-read-authorization.test.ts
Test Suites: 1 passed, 1 total
Tests:       90 passed, 90 total
REAL_EXIT: 0
```

**Đạt đúng yêu cầu: 90 passed / 90 total, REAL_EXIT 0.** 5 test đã sửa giờ xanh, 85 test cũ vẫn xanh, không có test nào mới đỏ.

## 4. Phân định thay đổi + xác nhận ranh giới

- **Của tôi: đúng 6 dòng** ở `:376`, `:387`, `:589`, `:598`, `:733`, `:743`.
- **KHÔNG phải của tôi:** `git diff` file này còn **2 hunk** ở `:198` (comment 4 dòng về `assertLease` project `lease_active`) và `:206` (`lease_active: task.leaseActive,`) — thay đổi có sẵn của lane khác trên cùng file. Tôi **không** chạm vào và **không** claim 2 hunk đó.
- `git diff --numstat` file = `+12 / −6`: con số này so với HEAD nên **gồm cả 2 hunk của lane khác**, không phải toàn bộ delta của tôi.
- **Product code:** `src/modules/artifacts/artifacts.ts` **0 diff vs HEAD** → không bị tôi sửa (và cũng không ai sửa). Không sửa backend.
- **Docs:** `docs/28-test-inventory.md` có `+3/−2` vs HEAD — đó là khối CORRECTION của lane DSH, **không phải của tôi**; tôi không sửa docs.
- **Không** `git commit`, **không** `git push`, **không** `git add`.
- **Không tick gate, không ghi VERIFIED/ACCEPTED.** Việc chốt gate thuộc coordinator/Reviewer.
- File duy nhất tôi ghi ngoài receipt này: `tests/artifact-read-authorization.test.ts`.

## 5. Ghi chú còn lại

- Còn **đúng 2** assertion `code: STATE_CONFLICT` khác trong file (`:609`, `:693` — đã kiểm bằng grep, chỉ 2 hit) — cả hai **đang xanh**, nằm ngoài 5 RED của packet, tôi **không** đụng.
- Suite `legacy-http-mount.test.ts` không liên quan; tôi không chạy lại nó vì packet giới hạn ở suite này.
- Bản chất đỏ của 5 test này là **test chốt contract cũ** (403/STATE_CONFLICT) trong khi code đã đổi; sau khi sửa, chúng là pin của contract đúng theo docs `:1400`.