# DRAFT DECISION PACKET — 5 RED `artifact-read-authorization` — 2026-10-09

**Vai trò:** soạn sẵn phiên quyết định (draft) cho owner/coordinator. **KHÔNG sửa gì** — cả hai phiên bản dưới đây là **đề xuất chưa áp dụng**.
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG edit source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate; KHÔNG đọc `.env.live`; **OFFLINE** (không PG/Redis, không claim DB window); scope `du-rework`.
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · node v24.21.0 (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`).
**Trạng thái suite (đo độc lập, không flake):** `Test Suites: 1 failed, 1 total` · **`Tests: 5 failed, 85 passed, 90 total`** · REAL_EXIT=1 (2 tiến trình độc lập; receipt `verify-ara-INDEPENDENT-DSH-2026-10-09.md`).
**Digest (không đổi trong lượt này):** `tests/artifact-read-authorization.test.ts` = `3deb94fa…a60b5` · `src/modules/artifacts/artifacts.ts` = `1fa4d876…ae5f2` · `src/http/errors.ts` = `35e7eb3a…c4b0` · `docs/28-test-inventory.md` = `2de0fdf5…9855d`.

---

## BƯỚC 1 — Nguyên văn 5 assertion đang đỏ

**Case 1 — `tests/artifact-read-authorization.test.ts:371` (`does not grant reads for STAGING artifacts, even in the same operation`), assert tại `:375-377`:**
```ts
    await expect(service.requestAccess(STAGING_OUTPUT, readRequest())).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
```
Thực tế: `{"code": "PERMISSION_DENIED"}` (đi qua `artifacts.ts:753-755`, chạy **trước** `:756`).

**Case 2 — `:381` (`rejects expired and fenced requesters before minting a read grant`), assert đỏ tại `:384-386`:**
```ts
    await expect(
      makeService(expiredDb).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
```
Thực tế: `{"code": "LEASE_LOST", "status": 409}` (`artifacts.ts:707`). *(Phần thứ hai của cùng test — `:391-393` `staleDb` epoch cũ → `{ code: 'LEASE_LOST' }` — **đang PASS**.)*

**Case 3 — `:588` (`…reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact`), assert tại `:595-597`:**
```ts
      await expect(
        makeService(db).requestAccess(FOREIGN_STAGING_OUTPUT, readRequest())
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
```
Thực tế: `{"code": "PERMISSION_DENIED"}` (`artifacts.ts:753-755`).

**Case 4 — `:724` (`prefers expiry over task state when both are wrong`), assert tại `:730-732`:**
```ts
    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
```
Thực tế: `{"code": "LEASE_LOST", "status": 409}` (`artifacts.ts:707`, lease xét **trước** state).

**Case 5 — `:736` (`FINDING: the lease_active boolean collapses a missing expiry and a past one`), assert tại `:740-742`:**
```ts
    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
```
Thực tế: `{"code": "LEASE_LOST", "status": 409}`. Comment chẩn đoán ngay dưới (`:744-746`) ghi rõ: *"The query projects (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active, so a task that never received an expiry denies exactly like an expired one and the service cannot tell them apart."*

**Cơ chế code (đối chiếu trực tiếp, `artifacts.ts`):**
- `:704-706` epoch cũ → `conflict('LEASE_LOST', …)` = **409**
- `:707` `!task.lease_active` → `conflict('LEASE_LOST', …)` = **409** ← bắt cả "chưa từng có expiry" và "đã hết hạn"
- `:708-710` state ≠ RUNNING → `conflict('STATE_CONFLICT', …)` = 409
- `:750-752` không sameOperation & không declaredReference → `conflict('PERMISSION_DENIED', …)` = **409**
- `:753-755` `art.taskId !== req.taskId && art.state !== 'READY'` → `conflict('PERMISSION_DENIED', …)` = **409**
- `:756` `art.state !== 'READY'` → `conflict('STATE_CONFLICT', …)` = 409

**Mapping status (`src/http/errors.ts`):** `:53` `forbidden() = new HttpError(403, 'PERMISSION_DENIED', msg)` · `:55-56` `conflict(code) = new HttpError(409, code, extra)`.
⇒ Xác nhận claim nền: code trả **`PERMISSION_DENIED` với status 409** (không phải 403) ở `:751`/`:754`, và **`LEASE_LOST` 409** ở `:707`. Tức đường đọc này **không dùng `forbidden()` 403** — cặp `409 + PERMISSION_DENIED` chỉ tồn tại vì gọi `conflict()` với mã của `forbidden()`.

## BƯỚC 2 — Nguyên văn docs/28

**`docs/28-test-inventory.md:1323`:**
```
- **8 test mới** trong `artifact-grant-fencing.test.ts` (10 → **18**). Chỉ file test; `server.ts` sha `22afb2ff` **không đụng**. Hai helper: `seedTaskWithLease` và `readyArtifact`. Bốn nhóm: **cross-tenant** (api-key tenant B tải artifact của A → **404**, không 403 vì 403 rò existence; runtime token B trên blob grant của A → 403/404); **expired task lease** (lease chết ⇒ grant upload mới bị từ chối 409 `LEASE_LOST`; grant cấp khi lease còn sống **rồi** lease chết ⇒ read grant 409); **tampered token** (nối thêm/cắt/đảo/UUID giả và token thiếu/rỗng → 403); và **tenant mismatch** (finalize artifact của A bằng taskId của B → 409 `PERMISSION_DENIED`).
```
→ **Khớp code** (lease hết hạn = 409 `LEASE_LOST`).

**`docs/28-test-inventory.md:1399`:**
```
- **Ordering matters and is asserted**: cross-operation plus declared plus `STAGING` returns **409 `STATE_CONFLICT`**, not `PERMISSION_DENIED`. For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas expiry plus a wrong state yields 403, and a live lease with the correct epoch still grants.
```
→ **Lệch code ở HAI mệnh đề**: (i) declared cross-op STAGING thực tế trả **409 `PERMISSION_DENIED`** (`:753-755`), không phải `STATE_CONFLICT`; (ii) "expiry plus a wrong state yields **403**" — thực tế **409 `LEASE_LOST`** (`:707`), và state thậm chí không được xét.

**`docs/28-test-inventory.md:1400`:**
```
- **Verification**: three consecutive runs, each **90 passed, 90 total**, 1 suite passed. `tsc --noEmit` ExitCode 0 with a **0-byte log**, before and after M1.
```
→ **Số đã cũ**: suite hiện **5 failed, 85 passed, 90 total** (exit 1). Phần `tsc` vẫn đúng (`tsc --noEmit` exit 0, 0 byte log — đã đo lại nhiều lượt).

## BƯỚC 3 — Hai phiên bản sửa (ĐỀ XUẤT, KHÔNG ÁP DỤNG)

### Phiên bản B — sửa TEST cho khớp code

| Dòng | Hiện tại | Đổi thành (đề xuất) |
|---|---|---|
| `:386` | `.rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });` | `.rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });` (hoặc tối thiểu `{ code: 'LEASE_LOST' }`) |
| `:732` | `.rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });` | `.rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });` |
| `:742` | `.rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });` | `.rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });` |
| `:375-377` (case 1) | `code: 'STATE_CONFLICT'` | **Theo packet: giữ nguyên** ⇒ case 1 **vẫn đỏ**. Muốn xanh phải đổi thành `code: 'PERMISSION_DENIED'` (và tuỳ chọn `status: 409`) |
| `:597` (case 3) | `code: 'STATE_CONFLICT'` | **Theo packet: giữ nguyên** ⇒ case 3 **vẫn đỏ**. Muốn xanh phải đổi thành `code: 'PERMISSION_DENIED'` |

**Hệ quả bắt buộc phải ghi:** nếu chỉ sửa 3 dòng `:386/:732/:742` như mô tả, suite còn **2 failed, 88 passed, 90 total** — **case 1 và case 3 vẫn đỏ** (đúng như packet yêu cầu ghi rõ). Muốn B làm suite xanh thì phải sửa **cả 5**.
**Kèm theo (nếu chọn B):** tên test sẽ nói sai sự thật và cần đổi đồng thời — `:588` "…**reports a state conflict, not a permission denial**…" (nay code trả permission denial), `:724` "prefers expiry over task state when both are wrong" (nay lease được xét trước và trả LEASE_LOST), `:736` "FINDING: the lease_active boolean collapses…" (FINDING này vẫn đúng nhưng kỳ vọng 403 phải đổi). Ngoài ra `:744-746` (comment chẩn đoán) nên giữ lại vì nó ghi nhận đúng hạn chế của projection.

### Phiên bản C — sửa DOCS cho khớp code

| Dòng | Hiện tại | Đổi thành (đề xuất) |
|---|---|---|
| `:1399` mệnh đề 1 | "cross-operation plus declared plus `STAGING` returns **409 `STATE_CONFLICT`**, not `PERMISSION_DENIED`." | "cross-operation plus declared plus `STAGING` returns **409 `PERMISSION_DENIED`** (`artifacts.ts:753-755`, kiểm tra *foreign task + chưa READY* chạy **trước** nhánh `STATE_CONFLICT` ở `:756`)." |
| `:1399` mệnh đề 2 | "…whereas expiry plus a wrong state yields 403, and a live lease with the correct epoch still grants." | "…whereas an expired (or never-set) lease yields **409 `LEASE_LOST`** (`artifacts.ts:707`) **trước khi** task state được xét, và một lease còn sống với epoch đúng vẫn được cấp." |
| `:1399`+1 (dòng mới) | *(chưa có)* | Thêm dòng CORRECTION ngay dưới `:1399`: `> **CORRECTION 2026-10-09 (independent verify, DSH):** hai mệnh đề trên đã sai trước bản này — code thực thi trả \`409 PERMISSION_DENIED\` cho declared cross-op STAGING (\`artifacts.ts:753-755\`) và \`409 LEASE_LOST\` cho lease hết hạn (\`artifacts.ts:707\`); \`403 PERMISSION_DENIED\` chỉ đến từ \`forbidden()\` (\`src/http/errors.ts:53\`) và hiện **không** được dùng trên đường đọc. Bằng chứng: 5 RED tại \`tests/artifact-read-authorization.test.ts:375,386,597,732,742\`; 2 tiến trình độc lập, exit 1.` |
| `:1400` | "three consecutive runs, each **90 passed, 90 total**…" | "**Verification (2026-10-09)**: suite hiện **5 failed, 85 passed, 90 total** (exit 1, node v24.21.0, 2 tiến trình độc lập, không flake); ba lần '90 passed' ghi ở đây là số **trước** khi lộ lệch hợp đồng docs↔code. `tsc --noEmit` ExitCode 0 với log 0 byte: vẫn đúng." |

*(Ghi chú ngoài phạm vi, chỉ để owner biết: `:1397` còn trỏ `createArtifactService().requestAccess (321-420)` — dải dòng đã cũ so với code hiện tại; không đưa vào phiên bản C vì không liên quan 5 RED.)*

### Điểm owner PHẢI quyết (không nằm trong cả B và C)
1. **Hợp đồng wire cho "artifact chưa READY do task khác đọc"**: giữ `409 + PERMISSION_DENIED` (`conflict()` tại `:754`) hay đổi sang `403 + PERMISSION_DENIED` (`forbidden()`, `errors.ts:53`)? Đây là cặp status/mã mà **không nơi nào khác** trong đường đọc dùng.
2. **Hợp đồng cho lease hết hạn**: `409 LEASE_LOST` (code hiện tại, khớp `docs/28:1323`) hay `403 PERMISSION_DENIED` (test + `docs/28:1399`)? Kèm câu hỏi phụ: có cần tách "chưa từng có expiry" khỏi "đã hết hạn" (FINDING ở `:736`) hay chấp nhận gộp như projection hiện tại.

## BƯỚC 4 — Bảng so sánh hai phiên bản

| Tiêu chí | **B — sửa TEST** | **C — sửa DOCS** |
|---|---|---|
| File chạm | `tests/artifact-read-authorization.test.ts` (3 dòng bắt buộc + 2 dòng nếu muốn xanh + 3 tên test) | `docs/28-test-inventory.md` (`:1399` 2 mệnh đề + 1 dòng CORRECTION mới + `:1400`) |
| Suite sau khi sửa | Sửa đúng như packet (chỉ 2/4/5): **vẫn 2 RED** (case 1, 3). Sửa cả 5: **90/90 xanh** | **Vẫn 5 RED** (docs không tác động test) |
| Tác động hợp đồng | **Đổi kỳ vọng quan sát được** (403/STATE_CONFLICT → 409/LEASE_LOST, PERMISSION_DENIED) ⇒ ngầm chốt hành vi code hiện tại là chuẩn | **Không đổi hành vi**; chỉ ghi lại sự thật hiện tại |
| Giữ thông tin chẩn đoán | **Kém**: phải sửa tên test và kỳ vọng, dễ xoá mất dấu vết "409+PERMISSION_DENIED là cặp lệch chuẩn" và FINDING `:744-746` | **Tốt**: giữ nguyên 5 RED làm oracle; thêm CORRECTION nói rõ code vs docs |
| Reversible | Có (git), nhưng nếu đã xanh thì áp lực "đừng đỏ lại" tăng | Có, thuần văn bản |
| Rủi ro chính | Hợp thức hoá một cặp `status 409 + code PERMISSION_DENIED` **chưa từng được owner duyệt**; đồng thời bỏ mất tín hiệu rằng `forbidden()` 403 đang tồn tại mà không dùng | Gate **vẫn mở** (suite vẫn đỏ) ⇒ phải có bước tiếp theo; nếu chỉ dừng ở C thì "đỏ treo" |
| Cần owner quyết? | **CÓ** — quyết định 1 & 2 ở trên (đây là hợp đồng wire, không phải chi tiết test) | **CÓ** — xác nhận nội dung CORRECTION + số liệu; vẫn cần quyết định 1 & 2 để mở gate |
| An toàn hơn | ✗ (đụng hợp đồng quan sát được) | **✓** (chỉ tài liệu, không đổi hành vi) |

**Kết luận draft (không tick gate, không tự quyết):** C **an toàn hơn** và nên làm trước để tài liệu thôi mâu thuẫn; B **chỉ nên làm sau khi** owner chốt hai điểm hợp đồng ở trên, và khi làm thì phải sửa **đủ 5** assertion + 3 tên test (nếu chỉ sửa 3 dòng như mô tả, suite còn 2 RED). **Không phiên bản nào tự nó đóng gate** — cả hai đều chờ quyết định owner về cặp `status/code`.

## BƯỚC 5 — Xác nhận không ai sửa gì

`git status --porcelain | Select-String 'artifact-read|docs/28'`:
```
 M du-rework/orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts
?? du-rework/coordination/reports/investigate-artifact-read-auth-2026-10-09.md
?? du-rework/coordination/reports/raw/investigate-artifact-read-auth-2026-10-09/
?? du-rework/coordination/reports/raw/triage-artifact-read-authorization-2026-10-08/
?? du-rework/coordination/reports/raw/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08/
?? du-rework/coordination/reports/raw/verify-artifact-read-auth-2026-10-09/
?? du-rework/coordination/reports/triage-artifact-read-authorization-2026-10-08.md
?? du-rework/coordination/reports/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08.md
?? du-rework/coordination/reports/verify-artifact-read-auth-INDEPENDENT-DSH-2026-10-09.md
```
- **`docs/28-test-inventory.md` KHÔNG xuất hiện** ⇒ tài liệu vẫn nguyên trạng (sạch vs HEAD), **chưa ai sửa** — hai phiên bản B/C ở trên **chưa được áp dụng**.
- File test vẫn ` M` (thay đổi có từ trước, của lane khác — không phải lượt này; digest `3deb94fa…` không đổi sau khi tôi chạy test).

## XÁC NHẬN

- **KHÔNG sửa gì**: không edit source/test/config/docs (kể cả `docs/28`); chỉ ghi receipt này.
- **KHÔNG tick gate** nào (VERIFIED/ACCEPTED/IMPLEMENTED đều của coordinator); **KHÔNG commit/`git add`/push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.
- **OFFLINE**: không PostgreSQL/Redis/S3; **không claim DB window**; kết quả suite trích từ lượt verify độc lập cùng ngày (`verify-ara-INDEPENDENT-DSH-2026-10-09.md`, 2 log raw + SHA256SUMS).
- **Giới hạn:** đây là **draft** — không có dòng nào trong hai phiên bản B/C được áp dụng; số liệu "sau khi sửa" ở bảng so sánh là **suy luận từ code+assertion đã đọc**, chưa chạy thử (muốn xác nhận phải có người áp dụng rồi chạy lại, ngoài quyền read-only của lượt này).
