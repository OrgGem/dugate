# Verify độc lập (DSH) — OR10-01 origin allowlist implementation (R1') — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên migration 0041, `ProfileEndpointPolicySchema` (packages/contracts), `ingestion-consumer.ts`, `acquisition-ref-resolver.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-01-allowlist-impl-2026-10-10/DSH/` (`contracts-jest.log`, `orch-regression.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-or10-01-allowlist-impl-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy — **CÓ 2 RED, báo nguyên văn**

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand` — cwd `orchestrator/packages/contracts` | **1** | `Test Suites: 1 failed, 29 passed, 30 total` · **`Tests: 1 failed, 569 passed, 570 total`** |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-01-credential-origin-allowlist.test.ts tests/p730-acquire-composition.test.ts tests/p730-acquire-consumer-auth.test.ts tests/p730-acquire-ref-resolver.test.ts tests/tapi01-closure-offline.test.ts tests/v1-boot-typed-denial.test.ts` — cwd `orchestrator/services/orchestrator` | **1** | `Test Suites: 1 failed, 5 passed, 6 total` · **`Tests: 1 failed, 64 passed, 65 total`** |

**RED #1 (contracts):** `FAIL tests/operations-list-contract.test.ts` › `operations-list request contract › declares the six parameters the route reads` — `expect(received).toEqual(expected)` với `Expected - 0 / Received + 2` ⇒ **mảng nhận được có thêm 2 phần tử** so với kỳ vọng 6 tham số. Nghi vấn hợp lý (chưa chốt): hai tham số `from`/`to` do AWEB-20a thêm vào query operations list ⇒ contract test của operations list chưa cập nhật. **Tôi không sửa** và **không** kết luận thay owner.
**RED #2 (orchestrator):** `FAIL tests/v1-boot-typed-denial.test.ts` › `V1 profile cipher denial › decrypts a configured cipher normally when a …` (tên bị cắt trong log). 5 suite còn lại — **gồm `tests/or10-01-credential-origin-allowlist.test.ts` và toàn bộ nhóm `p730-acquire-*`** — **PASS**. ⇒ RED #2 **không** nằm trong nhóm allowlist; nghi vấn (chưa chốt) là suite này nhạy với `NODE_ENV` ambient (`production`) như sự cố nhóm A trước đây, cần lượt riêng xác minh.

*Chưa chạy trong lượt này:* `tsc --noEmit` (ngoài ngân sách) ⇒ **không** có kết luận typecheck cho OR10-01.

## 2. Bounds theo packet — đọc mã

### 2.1 Migration 0041 — additive, có default an toàn
`migrations/0041_profile_binding_allowed_origins.sql` (4 dòng), nguyên văn:
```
3: ALTER TABLE profile_bindings
4: ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb;
```
⇒ **additive** (`ADD COLUMN IF NOT EXISTS`), và `NOT NULL` đi kèm `DEFAULT '[]'::jsonb` nên hàng cũ vẫn hợp lệ ngay — không cần backfill, không DROP.

### 2.2 `packages/contracts` — schema allowlist
- `profile-policy.ts:278` `CredentialAllowedOriginsSchema` (schema nguồn) · `:295` type `CredentialAllowedOrigins` · `:298-299` `validateCredentialAllowedOrigins(value)` ⇒ `parse` (throw khi sai).
- `:316` `ProfileEndpointPolicySchema` (shape GHI của `policy`) · `:325` `allowedOrigins: CredentialAllowedOriginsSchema.optional()` ⇒ trường allowlist **có** trong policy write-shape, và **optional** (không phá payload cũ).
- `:337` type `ProfileEndpointPolicy` · `:356`/`:364` xuất hiện `allowedOrigins` + `allowedOriginsInvalid: z.literal(true)` ⇒ có nhánh **báo lỗi hợp lệ** cho allowlist sai.
- `profile-commands.ts:3,83` dùng `ProfileEndpointPolicySchema` trong command shape ⇒ allowlist đi cùng đường lệnh profile.

### 2.3 `acquisition-ref-resolver.ts` — fail-closed enforce
- `:2` import `CredentialAllowedOriginsSchema` từ `@du/contracts` (dùng chung schema, không tự định nghĩa lại).
- `:24` tài liệu: *Fail-closed and typed, **BEFORE any network*** ⇒ kiểm trước khi phát request.
- `:49` `export type SourceCredentialOriginMode = 'warn' | 'enforce'` ⇒ có **enforce mode**.
- `:52`/`:63-64` mã cảnh báo/lỗi `ORIGIN_NOT_ALLOWLISTED` và `ORIGIN_POLICY_MISSING` ⇒ phân biệt trường hợp origin không nằm allowlist với trường hợp thiếu policy.
- `:104` câu SQL đọc cả `file_url_auth_cipher` **và** `allowed_origins` ⇒ policy lấy từ cột mới của 0041.

### 2.4 Đối chiếu `ingestion-consumer.ts:577-585` — **lệch vị trí, ghi nhận**
Đoạn `:570-583` thực tế là logic **PK conflict / materialization** (`ARTIFACT_BY_ID_SQL`, `persistedMatches`, `materializationConflict`), `:585` mở đầu hàm `openGate(...)`. **Không** có mã allowlist origin ở dải dòng này. Logic allowlist nằm ở `acquisition-ref-resolver.ts` (§2.3). ⇒ Chỉ số dòng trong packet **không** trỏ đúng chỗ; tôi báo lệch, không sửa.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| Migration 0041 | **ĐẠT** — additive + `DEFAULT '[]'` |
| `ProfileEndpointPolicySchema` có allowlist | **ĐẠT** — `profile-policy.ts:316,325` (+ validate `:298-299`, lỗi `:364`) |
| Fail-closed enforce mode | **ĐẠT (mã)** — `acquisition-ref-resolver.ts:24,49,52,63-64,104` |
| Suite allowlist + p730 + tapi01 | **PASS** — 5 suite xanh trong lệnh 2 |
| Contracts suite | **ĐỎ** — `operations-list-contract.test.ts` (6 tham số, nhận +2) |
| `v1-boot-typed-denial` | **ĐỎ** — 1 test profile cipher denial (ngoài nhóm allowlist) |
| Typecheck | **KHÔNG CHẠY** trong lượt này |

⇒ **OR10-01 allowlist impl: phần implementation (migration + schema + resolver enforce) ĐẠT theo đọc mã và 5 suite xanh**, **nhưng có 2 test đỏ trong regression** — không tick gate.

## 4. GAP / open items

1. **RED #1 cần owner chốt:** `operations-list-contract.test.ts` kỳ vọng **6** tham số nhưng nhận **8** (+2). Nếu +2 là `from`/`to` của AWEB-20a thì contract test cần cập nhật theo hợp đồng mới — việc của owner AWEB-20a/contracts, **không** phải OR10-01.
2. **RED #2 cần lượt riêng:** `v1-boot-typed-denial` đỏ 1 test; nhóm allowlist **không** liên quan (5 suite xanh). Nghi vấn `NODE_ENV` ambient, chưa xác minh.
3. **Chưa chạy typecheck** cho orchestrator/contracts trong lượt này ⇒ không kết luận.
4. **Chưa chứng minh enforce trên dữ liệu thật:** các suite dùng harness/fake; hành vi `enforce` khi gặp origin lạ trên hạ tầng thật (và tương tác với `file_url_auth_cipher`) **chưa** được kiểm live.
5. **Chưa đối chiếu nội dung receipt gốc** `receipt-or10-01-allowlist-impl-2026-10-10.md` (chỉ xác nhận tồn tại).
6. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 5. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
