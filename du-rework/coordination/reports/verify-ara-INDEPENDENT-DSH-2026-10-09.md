# VERIFY ĐỘC LẬP (DSH) — artifact-read 5 RED · public-upload xanh trên v24 · live-gate — 2026-10-09

**Vai trò:** verifier độc lập (lane khác là tác giả fix/investigation). **Không sửa gì.**
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG edit source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate; KHÔNG đọc `.env.live`; **OFFLINE** (không PG/Redis, không claim DB window); scope `du-rework`.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node v24** = `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`, `-v` = **v24.21.0**.
**Digest (trước/sau khi chạy — KHÔNG đổi):** `tests/artifact-read-authorization.test.ts` = `3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5` · `tests/public-upload-encryption-gateway.test.ts` = `cca893d236ff91afe8c2da5a7a8287018a45195434d9c2ea20a0ad1ff09ee8cf` · `jest.unit.config.cjs` = `027032b21948140175b7880769addeaec51ca68623bb277133c9f207b45c92a0`.
**Raw:** `du-rework/coordination/reports/raw/verify-ara-2026-10-09/DSH/` (`lenh1-artifact-read-authorization.log`, `lenh2-public-upload-encryption-gateway.log`, `SHA256SUMS.txt`).

## 1. Bảng lệnh × REAL_EXIT × literal

| # | Lệnh (node v24, REAL_EXIT lấy bằng `$LASTEXITCODE` ngay sau lệnh, không pipe) | REAL_EXIT | `Test Suites:` | `Tests:` |
|---|---|---:|---|---|
| 1 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` | **1** | `Test Suites: 1 failed, 1 total` | **`Tests: 5 failed, 85 passed, 90 total`** |
| 2 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | **0** | `Test Suites: 1 passed, 1 total` | **`Tests: 12 passed, 12 total`** |

## 2. Danh sách 5 case fail (tên + dòng assert + Expected/Received nguyên văn)

| # | Case | `it()` | Assert | Expected → Received |
|---|---|---|---:|---|
| 1 | `R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation` | `:371` | `:375` | `"code": "STATE_CONFLICT"` → **`"code": "PERMISSION_DENIED"`** |
| 2 | `R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant` | `:381` | `:386` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |
| 3 | `CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` | `:588` | `:597` | `"code": "STATE_CONFLICT"` → **`"code": "PERMISSION_DENIED"`** |
| 4 | `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong` | `:724` | `:732` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |
| 5 | `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one` | `:736` | `:742` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |

**Hiệu chỉnh nhỏ so với claim #1 của packet:** claim ghi "code trả `PERMISSION_DENIED(409)`/`LEASE_LOST(409)`". Bằng chứng literal của tôi: `LEASE_LOST` đi kèm **`status: 409`** (3 case); còn `PERMISSION_DENIED` xuất hiện ở 2 case (1, 3) — **hai case đó chỉ assert trường `code`** (`toMatchObject({ code: … })`, không có `status`), nên **trạng thái của `PERMISSION_DENIED` không được chứng minh là 409** từ log này. Ba số còn lại của claim (5 RED, `STATE_CONFLICT` được test mong đợi, `LEASE_LOST` là cái code trả) **khớp**.

## 3. LỆNH 3 — hai đoạn nguyên văn docs/28 (mâu thuẫn trực tiếp)

**`docs/28-test-inventory.md:1323`** (nguyên văn, trích đoạn về lease):
> **8 test mới** trong `artifact-grant-fencing.test.ts` (10 → **18**). Chỉ file test; `server.ts` sha `22afb2ff` **không đụng**. Hai helper: `seedTaskWithLease` và `readyArtifact`. Bốn nhóm: **cross-tenant** (api-key tenant B tải artifact của A → **404**, không 403 vì 403 rò existence; runtime token B trên blob grant của A → 403/404); **expired task lease** (lease chết ⇒ grant upload mới bị từ chối 409 `LEASE_LOST`; grant cấp khi lease còn sống **rồi** lease chết ⇒ read grant 409); **tampered token** (nối thêm/cắt/đảo/UUID giả và token thiếu/rỗng → 403); và **tenant mismatch** (finalize artifact của A bằng taskId của B → 409 `PERMISSION_DENIED`).

**`docs/28-test-inventory.md:1399`** (nguyên văn, trích đoạn về thứ tự):
> **Ordering matters and is asserted**: cross-operation plus declared plus `STAGING` returns **409 `STATE_CONFLICT`**, not `PERMISSION_DENIED`. For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas expiry plus a wrong state yields 403, and a live lease with the correct epoch still grants.

**Mâu thuẫn trong cùng một file:**
- `:1323` nói lease chết ⇒ **409 `LEASE_LOST`** (hợp với **code** đang thực thi: `src/modules/artifacts/artifacts.ts:707` `throw conflict('LEASE_LOST', …)` ⇒ 409).
- `:1399` nói "expiry plus a wrong state yields **403**" và cross-op declared `STAGING` ⇒ **409 `STATE_CONFLICT`** (hợp với **5 assertion của test** đang đỏ, ngược với code: `artifacts.ts:753-755` trả `PERMISSION_DENIED` ⇒ 403).
⇒ Tài liệu **trực mâu thuẫn chính nó** ở hai dòng khác nhau: `:1323` đứng cùng phía code, `:1399` đứng cùng phía test. Đây là gốc của 5 RED (test bám `:1399`, code làm theo `:1323`).

## 4. Xác minh claim #3 — live-gate

`jest.unit.config.cjs` (nguyên văn từng dòng):

| Dòng | Nội dung |
|---:|---|
| 14 | `'artifact-grant-fencing\\.test\\.ts$',` |
| 18 | `'migrations\\.test\\.ts$',` |
| 21 | `'usage-summary\\.test\\.ts$',` |

⇒ **KHỚP claim #3 chính xác** (cả 3 suite nằm trong `liveSuites` ⇒ bị loại khỏi unit lane, **không tính là pass**).

## 5. LỆNH 4 — trạng thái file (modified)

`git status --porcelain | Select-String 'public-upload|artifact-read'`:
```
 M du-rework/orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts
 M du-rework/orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts
?? du-rework/coordination/reports/fix-public-upload-encryption-gateway-red-2026-10-08.md
?? du-rework/coordination/reports/investigate-artifact-read-auth-2026-10-09.md
… (các receipt/raw khác của lane khác)
```
⇒ **Cả hai file test đều đang ` M` (modified)** — đúng như claim; thay đổi không do tôi (digest của tôi đo trước/sau khi chạy không đổi).

## 6. Verdict theo từng claim

| Claim | Kết quả | Bằng chứng |
|---|---|---|
| 1) artifact-read còn **5 RED** (STATE_CONFLICT/403-PerMISSION_DENIED kỳ vọng vs code trả khác) | **ĐÚNG** (kèm hiệu chỉnh nhỏ về `PERMISSION_DENIED(409)`) | §1 L1: exit 1, `5 failed, 85 passed, 90 total`; §2 bảng 5 case |
| 2) public-upload **GREEN 12/12 trên node v24** sau khi đổi RSS assertion | **ĐÚNG** | §1 L2: exit 0, `12 passed, 12 total` (digest `cca893d2…` = bản đã sửa) |
| 3) live-gate `artifact-grant-fencing` / `migrations.test.ts` / `usage-summary.test.ts` tại `:14/:18/:21` | **ĐÚNG** | §4 ba dòng nguyên văn |

**Ghi chú phạm vi (không tick gate):** claim #2 chỉ nói suite **xanh trên v24**; trong lượt verify trước của tôi (DSH3, cùng ngày) đã chứng minh việc "xanh" này đạt được bằng cách **xoá 3 dòng assertion RSS** và thay bằng assertion cơ chế — nghĩa là **không còn phép đo bộ nhớ**. Ở receipt này tôi chỉ xác nhận lại đúng nội dung claim (xanh 12/12), không thẩm định lại kết luận đó.

## 7. Xác nhận

- **KHÔNG sửa gì**: digest 3 file (`artifact-read…test.ts`, `public-upload…test.ts`, `jest.unit.config.cjs`) **không đổi** sau mọi lần chạy; không edit source/test/config/docs; chỉ ghi receipt này + raw log.
- **KHÔNG tick gate** nào (VERIFIED/ACCEPTED/IMPLEMENTED đều của coordinator); **KHÔNG commit/`git add`/push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.
- **OFFLINE**: chỉ `jest.unit.config.cjs`; không PostgreSQL/Redis/S3; **không claim DB window**; không chạy suite live nào (3 suite live-gated ở §4 không được tính pass).
- **Giới hạn:** chỉ chạy trên node v24 (đúng packet); không lặp lại nhiều lần nên không có kết luận về flakiness; không phân tích sâu nguyên nhân mismatch docs↔code (đó là việc của lane investigation/owner).
