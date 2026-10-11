# Verify độc lập (DSH) — MDB-POLICY-03 workflow schema policy — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet MDB-POLICY-03.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không revert, không mutation tạm, không sửa file ngoài lease); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-mdb-policy-03-2026-10-10/DSH/` (`p03-run1..3.log`, `p02-delta.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest tại thời điểm verify)

| File | sha256 |
|---|---|
| `scripts/ldba-context-provider.cjs` | `b1b1adebea7fa6b3a28e55dbb4e344d27a6db856302c851eda93599f5d935bf9` |
| `tests/mdb-policy-03-workflow-schema.test.cjs` | `af06ea2cfc9e7b7dba4c751eb741f62d58cee89ce555fe66514b812d18a70610` |
| `tests/mdb-policy-02-profiles.test.cjs` (ngoài lease) | `ae2ecdbb068a84a2b3b12303d530859be246cb9b8df8691a1d77e601a262847a` — **không đổi** |

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/mdb-policy-03-workflow-schema.test.cjs` (lần 1) | **0** | `# tests 17` · `# pass 17` · `# fail 0` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `# tests 17` · `# pass 17` · `# fail 0` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `# tests 17` · `# pass 17` · `# fail 0` |
| 4 | `node --test tests/mdb-policy-02-profiles.test.cjs` (kiểm Δ1) | **1** | `# tests 19` · `# pass 18` · `# fail 1` — xem §3 |

⇒ Suite mới **17/17 xanh, 3/3 lượt exit 0**.

## 2. Canonical digest và seal envelope (đọc trực tiếp provider)

- **Canonical JSON:** `canonicalWorkflowJsonBytes` tại `scripts/ldba-context-provider.cjs:464`, được ghi chú là **byte-identical** với `canonicalizeMetadataJson` (`metadata-crypto.ts:187-199`), `canonicalLegacyWorkflowJsonBytes` (`legacy-workflow.ts:395-406`) và pin canonical — tức policy tự cài lại đúng thuật toán canonical (sort key đệ quy, giữ thứ tự mảng) chứ không import (module `.cjs` không được require dependency nào, theo ràng buộc CR10-01).
- **Digest:** `sha256:` + sha256(canonical pin bytes) — cùng nguồn `workflow-schemas.ts:70-76` → `legacy-workflow.ts:320-326` (comment `:368-369`).
- **Seal envelope:** slot `WORKFLOW_SCHEMA_SLOT = 'legacy_workflow_schemas.schema_ref'` (`:410`); `schemaRef` là `SealedMetadata` 9 field (`version/algorithm/keyRef/dek/nonce/tag/aad/ciphertext/plaintextSha256`) với **đúng AAD triple** `(tenantId | legacy_workflow_schemas.schema_ref | slug:revision)` (`:371-373`), khớp `metadata-crypto.ts:306-335`.
- **Vì sao digest chống drift** (`:385-391`): reader re-allocate + re-digest mỗi lần đọc, nên policy phải tạo **cùng bytes**; và mọi object trong `LegacyWorkflowSchemaSchema` là `.passthrough()` nên key lạ không làm đổi canonical bytes.
- Test tự pin các tính chất này (theo receipt §3): digest tính trên **plaintext đã mở** (ràng buộc digest ↔ nội dung đã seal), digest **không đổi khi đảo thứ tự key input** (chứng minh canonicalization thật chạy), và kiểm **non-vacuous** sentinel: sentinel phải **có** trong plaintext đã mở và **không** có trong cột sealed.

## 3. Δ1 — tái lập độc lập trên `tests/mdb-policy-02-profiles.test.cjs`

```
# tests 19 | # pass 18 | # fail 1        REAL_EXIT=1
not ok 18 - the five remaining callbacks stay fail-closed
location: tests/mdb-policy-02-profiles.test.cjs:216:1
```

- Guard của suite policy-02 liệt kê **5 callback còn lại** và đòi mỗi cái ném `CONTEXT_POLICY_REQUIRED`; sau khi policy-03 land, `prepareWorkflowSchema` trở thành policy thật nên guard fail với `actual: 'INVALID_SOURCE'` / `expected: 'CONTEXT_POLICY_REQUIRED'` (receipt ghi ở `:128`).
- File **ngoài lease** và **không bị sửa** (digest `ae2ecdbb…2847a` không đổi so với lượt verify MDB-POLICY-02 của tôi) ⇒ **cùng một lớp staleness guard**, không phải regression hành vi.
- **Chuỗi lan truyền đã thành hệ thống:** P-01 làm đỏ `mdb-01-composition-provider.test.ts:41`; P-02 làm đỏ `mdb-policy-01-connector.test.cjs:292`; P-03 làm đỏ `mdb-policy-02-profiles.test.cjs:216`. Mỗi lần land một policy lại làm stale guard đếm callback của suite trước.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite MDB-POLICY-03 (17 test) | **PASS** — 3/3 lượt exit 0 |
| Canonical digest | **ĐẠT** — thuật toán ghi rõ byte-identical với reader; test pin key-order independence + digest trên plaintext đã mở |
| Seal envelope | **ĐẠT** — đúng slot, đúng AAD triple, đúng 9 field `SealedMetadata`; test non-vacuous sentinel |
| Δ1 (guard policy-02 stale) | **TÁI LẬP ĐỘC LẬP** — 1 test đỏ tại `:216`, đúng nguyên nhân, ngoài lease |
| Digest file | **KHỚP** với các lượt trước; file ngoài lease không bị sửa |

⇒ **MDB-POLICY-03: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline (17/17 ×3)**, với 1 hậu quả ngoài lease cần coordinator adjudicate. Không tick gate.

## 5. GAP / open items

1. **Δ1 + chuỗi guard stale (3 suite):** cần một lượt cập nhật guard của cả ba suite cũ (`mdb-01-composition-provider.test.ts:41`, `mdb-policy-01-connector.test.cjs:292`, `mdb-policy-02-profiles.test.cjs:216`) theo contract mới, nếu không lane kiểm thử luôn có test đỏ dù sản phẩm đúng. Đây là việc lease/adjudicate, không phải sửa code sản phẩm.
2. **Δ4 (receipt §7):** seal cần **seam thật** (module wrap Vault-backed + `dist` của `@d…`) ⇒ offline luôn từ chối; tôi verify ở mức hợp đồng + test double, **không** chứng minh được seal chạy với Vault thật. A1 timezone vẫn mở.
3. **Δ1 của packet (receipt §7):** refusal là **throw** `WorkflowSchemaPolicyError` (`.code` + `.callback`) chứ không phải `{ skipped, reason }` như spec §2.1 — vì runner không có kênh skip cho AppSetting; đây là deviation cần coordinator xác nhận.
4. **Δ2/Δ3 (receipt §7):** packet tạo đường tự bọc envelope trong khi plan chốt hướng khác; validator là **mirror strict** (tập con của zod) chứ không dùng zod ⇒ hai nguồn sự thật cần được chấp nhận có ý thức.
5. **Δ5/Δ6 (receipt §7):** 3 env mới (2 chưa có tiền lệ); FINDING `x-api-key` nằm trong `SECRET_HEADER_NAMES` của MDB-POLICY-01 — ngoài lease lượt này, cần owner xem.
6. **Chưa commit:** provider + test 03 là `??` untracked ⇒ kết quả gắn digest §0.

## 6. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test (không đụng guard stale ngoài lease, không revert để lấy RED).
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
