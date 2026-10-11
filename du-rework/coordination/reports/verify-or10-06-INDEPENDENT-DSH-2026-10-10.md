# Verify độc lập (DSH) — OR10-06 admin idempotency scope fix — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên `src/modules/admin-actions/dispatcher.ts` và `tests/or10-06-admin-idempotency-scope.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-06-2026-10-10/DSH/` (`or10-06.log`, `tsc.log`).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-06-admin-idempotency-scope.test.ts tests/admin-idempotency.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 47 passed, 47 total` · không FAIL |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

Digest (16 ký tự đầu): `dispatcher.ts` = `69ca6729c3bc6709` (1613 dòng) · test OR10-06 = `3c7fbc24d7c5f907` (165 dòng).

## 2. Đọc mã — scope hash và thứ tự fence

- `dispatcher.ts:10` — dùng đúng hai primitive chung: `import { canonicalPayloadHash, executeIdempotent } from '../idempotency/idempotency';` ⇒ hash và vòng replay đi qua **cùng** đường idempotency của hệ, không tự chế khoá riêng.
- **Scope theo principal/tenant:** helper quanh `:193-196` trả `undefined` cho principal `platform`, còn operator có `tenantId` thì trả chính tenant đó — tức danh tính principal/tenant là **một phần ngữ cảnh** dùng cho idempotency, không chỉ payload.
- **Fence chạy trước, có chủ đích:** comment `:160` ghi *ZERO side effects (authorizeAdminAction runs before any workflow call)*; `:48` nêu `authorizeBindingTenant` trả **403** khi tenant lệch; `:60-63` nói chỉ có **một** cổng thuần `assertRoleActionTenant` và `authorizeAdminAction` trả **cùng câu chữ** cho mọi giá trị để không rò sự tồn tại của tài nguyên.

## 3. Kiểm bounds theo packet (đối chiếu test)

| Bound | Có được kiểm? | Bằng chứng |
|---|---|---|
| **Scope `canonicalPayloadHash` theo principal/tenant** | **CÓ** | test `:113` describe `OR10-06 admin idempotency scope (offline)`; `:153` `does not return one principal’s marker to another principal in the same tenant` ⇒ marker của principal A **không** được trả cho principal B dù cùng tenant |
| **Replay không bỏ qua authorization fence** | **CÓ** | `:114` `replays for the same principal, then fences a cross-tenant or revoked resource **before marker lookup**` ⇒ fence (cross-tenant/revoked) chạy **trước** khi tra marker idempotency, nên replay không thể đi tắt qua phân quyền |
| **Tenant fence trong truy vấn** | **CÓ** | fake DB của test tự kiểm SQL chứa `AND tenant_id = $2` khớp tham số (`:45`) ⇒ nếu code quên scope tenant, harness sẽ báo |

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| 2 suite (OR10-06 + admin-idempotency) | **PASS** — exit 0, `2 passed, 2 total`, `47 passed, 47 total` |
| Typecheck | **PASS** — exit 0 |
| Scope hash theo principal/tenant | **ĐẠT** — test `:153` chứng minh marker không rò giữa principal cùng tenant |
| Replay không bỏ qua authorization fence | **ĐẠT** — test `:114` chứng minh fence chạy trước marker lookup; `dispatcher.ts:48,60-63,160` khớp mô tả |

⇒ **OR10-06: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, không DB/Redis thật:** cả hai suite dùng client/harness giả; hành vi thật của bảng idempotency (unique index, race hai request cùng key, TTL) **chưa** được chứng minh — cần gate live nếu muốn chốt.
2. **Độ phủ 2 ca cho OR10-06**: chưa thấy ca cho (a) cùng principal nhưng payload khác (phải KHÔNG replay), (b) principal `platform` (tenant `undefined`) để khẳng định scope không bị nới, (c) marker cũ bị thu hồi/đổi trạng thái giữa hai lần gọi.
3. **`dispatcher.ts` rất lớn (1613 dòng)** — thay đổi nhỏ ở đây khó review; đề nghị cân nhắc tách khi có dịp (chỉ là quan sát, không thuộc phạm vi OR10-06).
4. Không commit: test là file mới; `dispatcher.ts` có thể ` M` từ lane khác ⇒ kết quả gắn digest §1.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
