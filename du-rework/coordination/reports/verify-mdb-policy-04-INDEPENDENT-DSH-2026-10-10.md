# Verify độc lập (DSH) — MDB-POLICY-04 filecache policy — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet MDB-POLICY-04.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không revert, không mutation tạm, không sửa file ngoài lease); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-mdb-policy-04-2026-10-10/DSH/` (`p04-run1..3.log`, `p03-delta.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest khớp receipt gốc)

| File | sha256 |
|---|---|
| `scripts/ldba-context-provider.cjs` | `89c6ec07f6cf83dd28aabbf060d1ab88f9704f226b42b37fa901fbda429cff57` (khớp hash **sau** receipt §2.1) |
| `tests/mdb-policy-04-filecache.test.cjs` | `43d324b7348fa315889516ac00b38512f3c7e338d7b88e80e0131753a5d164f1` (khớp receipt §2.2) |

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/mdb-policy-04-filecache.test.cjs` (lần 1) | **0** | `# tests 16` · `# pass 16` · `# fail 0` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `# tests 16` · `# pass 16` · `# fail 0` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `# tests 16` · `# pass 16` · `# fail 0` |
| 4 | `node --test tests/mdb-policy-03-workflow-schema.test.cjs` (kiểm delta) | **1** | `# tests 17` · `# pass 16` · `# fail 1` — xem §3 |

⇒ Suite mới **16/16 xanh, 3/3 lượt exit 0**, khớp receipt §4 (GREEN 16/16 ×3).

## 2. Bốn callback — tính đúng đắn và trạng thái fail-closed

- **`readFileCacheBytes`** (`scripts/ldba-context-provider.cjs:947`), **`artifactTokenFor`** (`:996`), **`artifactPurposeFor`** (`:1010`): cả ba đã là implementation thật (không còn `requireApprovedPolicy`), nằm trong khối export; test 04 pin hành vi của từng hàm (16 test, gồm negative control).
- **Chỉ `prepareAdminLocalUser` còn fail-closed:** comment cuối file ghi rõ tại `:1025` (`Only prepareAdminLocalUser stays fail-closed: the legacy bcrypt verifier cannot …`) và mapping `prepareAdminLocalUser: requirePasswordReset` tại `:1037` ⇒ **đúng như packet yêu cầu**: 7 callback đã có policy thật, callback duy nhất còn lại là `prepareAdminLocalUser` (không thể hash bcrypt → scrypt khi chưa có plaintext).
- Cơ chế fail-closed vẫn nguyên: `requireApprovedPolicy` (`:16`) ném `ContextPolicyError` với `code = 'CONTEXT_POLICY_REQUIRED'` (`:11`).

## 3. Delta — guard staleness lan sang suite policy-03 (tái lập độc lập)

```
# tests 17 | # pass 16 | # fail 1        REAL_EXIT=1
not ok 16 - the four remaining callbacks stay fail-closed
Expected values to be strictly equal:
expected: 'CONTEXT_POLICY_REQUIRED'
actual: 'INVALID_ARTIFACT_BYTES'
```

- Guard của suite policy-03 liệt kê 4 callback còn lại; sau khi policy-04 land, một trong số đó trả `INVALID_ARTIFACT_BYTES` thay vì ném `CONTEXT_POLICY_REQUIRED` ⇒ **cùng lớp staleness**, không phải regression hành vi.
- **Chuỗi lan truyền nay đã 4 bước:** P-01 → `mdb-01-composition-provider.test.ts:41`; P-02 → `mdb-policy-01-connector.test.cjs:292`; P-03 → `mdb-policy-02-profiles.test.cjs:216`; P-04 → `mdb-policy-03-workflow-schema.test.cjs` (test `the four remaining callbacks stay fail-closed`). Mỗi policy mới land lại làm stale guard đếm callback của suite trước.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite MDB-POLICY-04 (16 test) | **PASS** — 3/3 lượt exit 0 |
| `readFileCacheBytes` / `artifactTokenFor` / `artifactPurposeFor` | **ĐẠT** — implementation thật, được test pin |
| Fail-closed còn lại | **ĐẠT** — duy nhất `prepareAdminLocalUser` (`:1025`, `:1037`) |
| Digest provider/test | **KHỚP** receipt gốc |
| Delta guard policy-03 | **TÁI LẬP ĐỘC LẬP** — 1 test đỏ, đúng nguyên nhân, ngoài lease |

⇒ **MDB-POLICY-04: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline (16/16 ×3)**, với 1 hậu quả ngoài lease cần coordinator adjudicate. Không tick gate.

## 5. GAP / open items

1. **Guard staleness đã thành vấn đề hệ thống (4 suite):** cần **một lượt riêng** cập nhật guard của cả bốn suite cũ theo contract mới (danh sách callback còn fail-closed co lại sau mỗi policy), nếu không lane kiểm thử luôn đỏ dù sản phẩm đúng. Đây là việc lease/adjudicate, không phải sửa code sản phẩm.
2. **Δ2 (receipt §3):** hàng `FileCache` legacy **không có cột `purpose`** và cả ba writer đều là phía input ⇒ quyết định gán purpose là **suy diễn của policy**, cần coordinator xác nhận (tôi đọc code, không tự quyết).
3. **Chưa chứng minh đường ghi thật** (như P-02/P-03): không có PG rehearsal trong lượt này; bằng chứng là hợp đồng + test offline. A1 timezone vẫn mở.
4. **Chưa commit:** provider + test 04 là `??` untracked ⇒ kết quả gắn digest §0.
5. **Δ khác của receipt** (env mới, seam S3/Vault) tôi không tự kiểm chứng trong lượt này vì ngoài ngân sách; chỉ ghi nhận là cần owner đọc.

## 6. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test (không đụng guard stale ngoài lease, không revert để lấy RED).
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
