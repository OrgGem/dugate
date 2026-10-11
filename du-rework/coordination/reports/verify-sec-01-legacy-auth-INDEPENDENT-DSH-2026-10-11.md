# Verify độc lập (DSH) — SEC-OR-01 legacy read scope (operator/viewer) — 2026-10-11

**Vai trò:** Independent Verifier (term_8bfe6adc), READ-ONLY lease.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate; receipt **0 ký tự nháy kép** (đã tự quét).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-sec-01-legacy-auth-2026-10-11/DSH/` (`pnpm-test.log`, `tsc.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| A | `pnpm --dir orchestrator/services/orchestrator test -- tests/sec-or-01-legacy-read-scope-offline.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 4 passed, 4 total`** · `Time: 4.081 s` · không block lỗi |
| B | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — cwd `orchestrator/services/orchestrator` | **0** | không output · **`errors = 0`** |

Test file `tests/sec-or-01-legacy-read-scope-offline.test.ts`: **183 dòng**, tồn tại.

## 2. Bốn ca test — đúng các hành vi packet yêu cầu (nguyên văn tên ca)

```
:51  describe: SEC-OR-20261011-01 legacy operations and overview read scope
:52  uses the session tenant credential and overrides the legacy operations tenant filter
:94  uses the session tenant and tenant credential for legacy overview despite a foreign query value
:118 denies viewers and operators without a mapped tenant credential before either fetcher runs
:145 preserves platform admin access and its explicitly requested tenant filters
```

| Bound theo packet | Ca test chứng minh |
|---|---|
| **Session operator/viewer bị chặn đúng tenant** | `:52` — credential **theo tenant của session** được dùng và **ghi đè** bộ lọc tenant của đường legacy operations; `:94` — màn overview legacy cũng dùng **tenant của session** dù query mang giá trị **của tenant khác** (*foreign query value*) ⇒ giá trị do client gửi **không** thắng được tenant của phiên |
| **Fail-closed 403 khi không map được credential** | `:118` — *denies viewers and operators **without a mapped tenant credential** **before either fetcher runs*** ⇒ từ chối **trước khi** bất kỳ fetcher nào chạy (không có nhánh im lặng trả dữ liệu) |
| **Không còn lấy platform bearer để vượt fence tenant** | `:145` — quyền **platform admin** vẫn được giữ **kèm** bộ lọc tenant mà nó **yêu cầu tường minh** ⇒ đường platform là **ngoại lệ có chủ đích**, không phải đường mặc định mà operator/viewer rơi vào |

## 3. Đối chiếu nhanh phía source (những gì tôi đọc được)

`src/http/routes/admin.ts`:
- `:79-84` — route plane admin xác thực bằng **platform admin bearer** (`assertAdminAuth`) nên role suy ra là `platform`; hằng `ADMIN_TOKEN_AUDIT_FIELDS = { actorRole: 'platform' }`.
- `:113-115`, `:142-143`, `:169-172` — các hàng audit **platform-global** đặt `tenantId: null` kèm lý do (business/version không thuộc tenant) ⇒ việc `null` tenant ở đây là **có chủ đích và có ghi chú**, không phải rò tenant.
- `:190-208` — phạm vi mutation: principal `tenant_operator` bị ràng buộc theo credential (**không** theo lựa chọn của caller), target ngoài tenant trả **403 PERMISSION_DENIED** với **cùng thông điệp** cho mọi giá trị (không rò tồn tại).

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite SEC-OR-01 | **PASS** — 4/4, exit 0 |
| Typecheck orchestrator | **PASS** — exit 0, 0 lỗi |
| Tenant của session thắng query của client | **ĐẠT** — ca `:52`, `:94` |
| Fail-closed trước khi fetch khi thiếu credential map | **ĐẠT** — ca `:118` |
| Platform bearer là ngoại lệ tường minh, không phải đường vượt fence | **ĐẠT** — ca `:145` |
| 403 cho target ngoài tenant (mutation plane) | **ĐẠT** — `admin.ts:190-208` (đọc trực tiếp) |

⇒ **SEC-OR-01 legacy read scope: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Chưa đọc hết đường resolve của legacy read scope:** tôi xác nhận hành vi qua **4 ca test** + các đoạn `admin.ts` liên quan, nhưng **chưa** lần ra chính xác file/hàm nối *session tenant → tenant credential* cho hai fetcher legacy (operations/overview) — muốn có `file:line` đầy đủ cần một lượt đọc chuyên sâu.
2. **Offline, không DB/HTTP thật:** harness dùng fetcher/DB giả ⇒ hành vi thật trên PostgreSQL và qua BFF thật (cookie phiên, mapping credential) **chưa** được chứng minh — đây là loại thay đổi an ninh nên nếu muốn chốt cần gate live.
3. **Chưa chạy suite rộng hơn** (ví dụ nhóm admin-*/legacy-http-mount) trong lượt này ⇒ chưa loại trừ regression ngoài 1 file được chỉ định.
4. **Không có bằng chứng browser:** màn overview/operations ở tầng UI không được kiểm trong lượt này.
5. Không commit: cây còn nhiều file ` M` (test là file mới/` M` tùy trạng thái) ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa product code; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép** (đúng ràng buộc lượt này), **0 dòng trailing whitespace**.
