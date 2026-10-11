# Verify độc lập (DSH) — OR10-04 retry workflow schema snapshot — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên `src/modules/operations/retry.ts` và `tests/or10-04-retry-workflow-schema.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-04-2026-10-10/DSH/` (`or10-04.log`, `tsc.log`).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-04-retry-workflow-schema.test.ts tests/cb02c-retry-callback-pin.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 3 passed, 3 total` (không FAIL) |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

Digest: `retry.ts` sha256 (16 ký tự đầu) = `691e38512ee020a4`, 110 dòng · test OR10-04 = `1178d85f63312a88`, 116 dòng.

## 2. Logic trong `retry.ts` (đọc trực tiếp)

- `:12` khoá operation `FOR UPDATE`; `:18` khoá **root task** đang retry `FOR UPDATE`.
- `:24` mở payload đã niêm phong của task gốc: `open(task.payload_ref, 'tasks.payload_ref', String(task.id))`.
- `:63-65` sinh **id mới** cho lần retry: `newId`, `taskId`, `correlationId` — tức retry là **một task mới**, không tái dùng task cũ.
- `:69-76` — phần cốt lõi của OR10-04: comment nói rõ *Retry the admitted execution snapshot, including its pinned legacy workflow*; nhánh `:74-75` **giữ nguyên** `payloadSnapshot` khi nó có `legacyWorkflowSchema` (`Object.hasOwn(payloadSnapshot, 'legacyWorkflowSchema') ? payloadSnapshot : …`). Không có lời gọi resolve schema catalog hiện tại trong nhánh này.
- `:77` payload retry được **niêm phong lại cho task MỚI**: `seal(retryPayloadValue, 'tasks.payload_ref', taskId)` ⇒ AAD gắn với task id mới, không tái dùng envelope của task gốc.

## 3. Kiểm bounds theo packet

| Bound | Có được kiểm? | Bằng chứng |
|---|---|---|
| **Task ID seal khác nhau** | **CÓ** | test `:96` lấy `newTaskId` từ tham số INSERT của task mới và `:101` dùng `refId: newTaskId` khi mở lại envelope ⇒ envelope của task retry gắn task id MỚI, khác `taskId` gốc (`:16`); `retry.ts:77` seal theo `taskId` mới |
| **`legacyWorkflowSchema` không bị thay bằng schema catalog hiện tại** | **CÓ** | test `:34` tên ca nêu thẳng *re-seals the admitted pin for the new task **without resolving the current schema***; fixture tạo `originalPin = pin(1, 'Invoice flow revision 1')` (`:41`) và `currentPin = pin(2, 'Invoice flow revision 2')` (`:42`) rồi assert payload của task mới vẫn mang pin gốc ⇒ nếu code resolve revision mới, test sẽ đỏ |
| **Payload gốc được mở bằng refId = task id gốc** | **CÓ** | `retry.ts:24` truyền `String(task.id)`; test mô phỏng `open` với `refId` tương ứng (`:64`,`:96-101`) |

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| 2 suite (OR10-04 + cb02c) | **PASS** — exit 0, `2 passed, 2 total`, `3 passed, 3 total` |
| Typecheck | **PASS** — exit 0 |
| Retry giữ snapshot pin gốc | **ĐẠT** — `retry.ts:69-77` giữ `legacyWorkflowSchema`, không resolve catalog hiện tại |
| Seal theo task id mới | **ĐẠT** — `:63-65` id mới + `:77` re-seal theo `taskId` mới; test pin bằng `refId: newTaskId` |

⇒ **OR10-04: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, không DB thật**: hai suite dùng `client` giả/scripted; hành vi `FOR UPDATE`, `INSERT ... RETURNING` và mở envelope qua crypto thật **chưa** được chứng minh trên PostgreSQL — cần gate live nếu muốn chốt.
2. **Chỉ 1 ca cho OR10-04** (test file 116 dòng, 1 `describe`/1 `it` chính): chưa thấy ca cho (a) payload gốc **không** có `legacyWorkflowSchema` (đường fallback `:73`), (b) pin hỏng/không mở được, (c) retry khi root task ở trạng thái khác. Đây là giới hạn độ phủ, không phải lỗi.
3. `retry.ts` ngoài phạm vi: nhánh `:73` (PENDING ingestion → `ingestionState: 'PENDING'`) không thuộc OR10-04; tôi chỉ ghi nhận.
4. Không commit: test là file mới; `retry.ts` có thể ` M` từ lane khác ⇒ kết quả gắn digest §1.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
