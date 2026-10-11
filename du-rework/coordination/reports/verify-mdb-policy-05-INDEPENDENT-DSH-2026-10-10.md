# Verify độc lập (DSH) — MDB-POLICY-05 guard alignment — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet MDB-POLICY-05.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không mutation, không revert); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-mdb-policy-05-2026-10-10/DSH/` (`run1..3-nodetest.log`, `run1..3-jest.log`, `tsc.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy ×3 (REAL_EXIT đo ngay sau mỗi lệnh)

Lệnh A (4 suite `node:test` trong một tiến trình):
```
node --test tests/mdb-policy-01-connector.test.cjs tests/mdb-policy-02-profiles.test.cjs tests/mdb-policy-03-workflow-schema.test.cjs tests/mdb-policy-04-filecache.test.cjs
```
Lệnh B: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts`

| Lần | Lệnh A REAL_EXIT | Literal A | Lệnh B REAL_EXIT | Literal B |
|---|---:|---|---:|---|
| 1 | **0** | `# tests 72` · `# pass 72` · `# fail 0` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 2 passed, 2 total` |
| 2 | **0** | `# tests 72` · `# pass 72` · `# fail 0` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 2 passed, 2 total` |
| 3 | **0** | `# tests 72` · `# pass 72` · `# fail 0` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 2 passed, 2 total` |

- **100% xanh sạch:** không có dòng `not ok` nào trong cả 3 lượt (đã lọc và kiểm).
- **Số test cộng đúng:** 72 = P-01 (20) + P-02 (19) + P-03 (17) + P-04 (16) ⇒ không suite nào bị rơi khi chạy gộp.
- **Suite mdb-01 nay xanh 2/2** (trước alignment là `1 failed, 1 passed` với assertion `:41` đòi `CONTEXT_POLICY_REQUIRED`) ⇒ **điểm đỏ của P-01 đã được align đúng**.
- **Typecheck:** `tsc --noEmit -p tsconfig.json` → **REAL_EXIT=0**, không output.

## 2. Provider sha KHÔNG đổi

`scripts/ldba-context-provider.cjs` = **`89c6ec07f6cf83dd28aabbf060d1ab88f9704f226b42b37fa901fbda429cff57`** — **trùng khít** hash tôi đã đo độc lập trong lượt verify MDB-POLICY-04 (`verify-mdb-policy-04-INDEPENDENT-DSH-2026-10-10.md:0`). ⇒ Alignment này **chỉ chạm test/guard**, **không** thay đổi artifact runtime; mọi đặc tính đã verify ở P-01..P-04 (cipher, strict config, canonical digest, seal envelope, 3 artifact/filecache callback) giữ nguyên hiệu lực.

## 3. Guard có bắt lỗi thật không

Bằng chứng mạnh nhất là **lịch sử hoạt động của chính guard này**, mỗi lần đều do tôi tái lập độc lập:
- P-01 land → guard bắt: `mdb-01-composition-provider.test.ts:41` đỏ (`CONTEXT_POLICY_REQUIRED` vs resolve `INVALID_SOURCE`).
- P-02 land → `mdb-policy-01-connector.test.cjs:292` đỏ (`Missing expected exception`).
- P-03 land → `mdb-policy-02-profiles.test.cjs:216` đỏ (`INVALID_SOURCE` vs `CONTEXT_POLICY_REQUIRED`).
- P-04 land → `mdb-policy-03-workflow-schema.test.cjs` đỏ (`INVALID_ARTIFACT_BYTES` vs `CONTEXT_POLICY_REQUIRED`).

⇒ Guard **thực sự ném-đỏ khi một callback thôi fail-closed**, không phải assertion rỗng; sau alignment cả 5 suite xanh ⇒ danh sách guard nay khớp đúng tập còn lại (`prepareAdminLocalUser`, xác nhận ở `scripts/ldba-context-provider.cjs:1025`+`:1037` trong lượt P-04).
*Giới hạn trung thực:* trong lượt này tôi **không** mutation lại (packet cấm sửa code), nên không có bằng chứng mutant-killed mới; tôi dựa vào 4 lần guard bắt lỗi thật đã ghi ở trên.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| 4 suite `node --test` (72 test) | **PASS** — 3/3 lượt exit 0, 72/72, không `not ok` |
| `mdb-01-composition-provider.test.ts` | **PASS** — 3/3 lượt exit 0, 2/2 (điểm đỏ cũ đã hết) |
| Typecheck | **PASS** — exit 0 |
| Provider sha không đổi | **ĐẠT** — `89c6ec07…` trùng hash đo ở P-04 ⇒ thay đổi chỉ ở test |
| Guard bắt lỗi thật | **ĐẠT** (gián tiếp, qua 4 lần bắt đỏ thật ở P-01..P-04) |
| 100% xanh sạch | **ĐẠT** — 5 suite, 74 test (72 + 2), 3 lượt, không fail/skip |

⇒ **MDB-POLICY-05: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate.

## 5. GAP / open items

1. **Chưa mutation-check độc lập** trong lượt này (bị cấm sửa code) ⇒ bằng chứng guard là lịch sử 4 lần bắt đỏ, không phải mutant mới. Nếu coordinator muốn bằng chứng mutant của bên thứ ba, cần cấp lease sửa tạm.
2. **Chưa chứng minh đường ghi thật / live**: không có PG rehearsal, không Vault/S3 thật ⇒ các đặc tính seal/cipher/digest chỉ được pin ở mức hợp đồng + test double; **A1 timezone vẫn mở** nên backfill thật vẫn bị chặn.
3. **Chưa commit:** provider + các test policy là `??` untracked ⇒ kết quả gắn digest ở §2; dist/artifact build cục bộ vẫn phải rebuild ở môi trường deploy (bài học từ CR10-02-D1).
4. **Δ của các packet trước vẫn treo cho owner** (không thuộc lượt này): `staticFormFields`/16 field hiển thị (P-01 Δ2), mất dữ liệu step vô hình (P-02 Δ2), refusal throw vs skip (P-03 Δ1), purpose của FileCache là suy diễn (P-04 Δ2), env mới chưa có tiền lệ.

## 6. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test.
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
