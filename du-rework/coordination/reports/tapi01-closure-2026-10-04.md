# T-API-01-CLOSURE — profile detail read real data — cc_2 — 2026-10-04

**Packet:** coordinator 22:58 (+07) (đề xuất (2) của W3 receipt §8.4). **Lane:** cc_2 · **Run:** `run_069ecd6957cd`. **Mode:** offline; không commit/push; không tick.
**Read-only giữ nguyên:** `runtime.ts`, `publish.ts`, `submission.ts`, `operations/**`, worker-sdk/document-core — không chạm. Không cần migration (dùng 0028 registry + 0027 pointer + 0026 bindings đã có).

---

## 0. TL;DR

`GET /api/v1/admin/profiles/:b/:v/:name` giờ trả **dữ liệu THẬT**: revision active từ `profile_active_revisions`, policy đọc từ revision được pin, `currentValues` phẳng cho form, và **`apiKeyId` (write identity, KHÔNG bao giờ là hash/cipher)** để client gửi lại trong `profile.*`. Chứng minh **end-to-end offline**: detail → `apiKeyId` → `profile.upsert` (dispatcher/leaf thật) → **re-READ thấy revision mới** (read-after-write). Compatibility giữ: `/new` + tên chưa lưu = blank editor như cũ (R-12 blind save); pointer-missing = 404 fail-closed; additive schema (pin 2 chiều).

## 1. File đã ghi (post-edit sha16)

| File | Việc | sha16 |
|---|---|---|
| `packages/contracts/src/profile-policy.ts` | `ProfileDetailReadSchema` + `apiKeyId` optional (uuid) + docblock closure | `E9957B8C612CFAA4` |
| `packages/contracts/tests/profile-policy.test.ts` | +1 pin: apiKeyId optional/uuid; pre-closure wire vẫn parse; reject id sai + unknown key | `5045858D469793D4` |
| `services/orchestrator/src/modules/admin-read/profile-detail.ts` (MỚI) | `loadProfileDetail` (registry⋈pointer⋈bindings) + `profileDetailPolicyRead`/`CurrentValues` + `EMPTY_PROFILE_POLICY_READ`; không decrypt | `87C465EB6FB0B9E0` |
| `services/orchestrator/src/http/routes/admin.ts` | route detail: real read; blank giữ cho `/new` + not-found; pointer-missing 404; `apiKeyId` trên wire | `26D119EA0946779D` |
| `services/orchestrator/tests/tapi01-closure-offline.test.ts` (MỚI) | 7 test offline (fake Db stateful + journal) | `BE2EDE591E03618F` |

## 2. Hành vi route (chốt)

- **Profile CÓ lưu**: 200 + `revision` real (từ pointer), `policy` read-shape (`fileUrlAuthConfigured` quyết bằng regex cipher HOẶC legacy-plaintext JSON parse — KHÔNG decrypt), `currentValues` phẳng `{key: "<string>"}` (string giữ nguyên; number/boolean/JSON → stringify; null/undefined → ''), `apiKeyId`, manifest/capabilities như cũ. Query deterministic `ORDER BY moved_at DESC, profile_id LIMIT 1`; registry multiple-row không ambiguous trong practice (platform read).
- **`/new`**: blank như cũ (`profileName:''`, revision 0, policy EMPTY read-shape, KHÔNG apiKeyId). Lưu ý pre-existing: sentinel `''` không thỏa `profileName.min(1)` của schema (schema mô tả profile ĐÃ LƯU) — giữ nguyên hành vi, ghi nhận.
- **Tên chưa lưu (named)**: giữ **blank editor 200** (R-12 blind first save — quyết định tương thích: test live-gated `admin-base-routes.test.ts:153-185` đang expect 200/revision 0 cho `default` chưa seed; đổi sang 404 sẽ phải sửa test lane khác — không làm).
- **Registry có row nhưng pointer mất**: **404 fail-closed** ("has no active revision pointer") — không đoán MAX(revision).
- **`latest` sentinel**: resolve version active như cũ, vẫn trả real revision.
- **Auth**: giữ `assertAdminAuth` (no token → 401).

## 3. Gates literal

```
contracts build: CONTRACTS_BUILD_EXIT=0
contracts jest (profile-policy + profile-commands): 2 suites / 40 tests passed — exit 0
orchestrator tsc: ORCH_TSC_EXIT=0
Regression set (tapi01-closure + p730-admin-mutate + aweb04-bff-profiles + admin-audit-list-page
  + admin-mutation-atomicity + admin-action-dispatcher) ×3 liên tiếp:
  RUN 1/2/3: 6 suites / 134 tests passed — exit=0 cả 3
Suite mới riêng: 7/7 (gồm E2E detail→upsert→re-read).
```
**E2E offline (test cuối):** GET detail (rev 2, apiKeyId) → `dispatchAdminAction profile.upsert` với `apiKey:{apiKeyId}` + `policy:{}` → 201 **rev 3** (registry KHÔNG nhân đôi — cùng profileId) → GET lại thấy **rev 3**, policy carry-forward (jobPriority HIGH, fileUrlAuthConfigured true, cipher không lộ). Wire JSON assert không chứa cipher/`fileUrlAuthCipher`.

## 4. Tương thích / cross-check

- **BFF**: KHÔNG cần sửa — detail relay raw; upsert đã forward `body.apiKey` (W3). KB.
- **Live-gated `admin-base-routes.test.ts`** (hiện skip offline): nhánh blank giữ nguyên ⇒ khi chạy live vẫn 200/rev 0 như test expect (body có thêm `policy` — test chỉ đọc các field đã liệt kê, additive an toàn).
- **Contracts pin 2 chiều**: wire cũ (không apiKeyId) vẫn parse; wire mới (apiKeyId uuid) parse; id sai/`apiKeyHash` sibling bị `.strict()` chặn.

## 5. Follow-up / Δ

- **Δ-UI-1 (cần lease admin-web — chưa làm, theo packet "báo nếu cần")**: để luồng UI end-to-end dùng khóa từ detail, cần `apps/admin-web`:
  1) `src/lib/api/types.ts`: `ProfileDetail` + `apiKeyId?: string`; `PolicyUpsertBody` + `apiKey?: { apiKeyId: string }` (hoặc union id/hash như contract).
  2) `src/features/profiles/profiles-screen.tsx`: `saveRow` gắn `apiKey: {apiKeyId: detail.apiKeyId}` (chỉ khi có — `/new` chưa có identity); `publish()`/`rollback()` cũng cần `apiKey` vì **cả 3 command** `profile.*` đều bắt buộc apiKey (ProfileCommandKeyShape) — client signature `publishProfile`/`rollbackProfile` cần thêm tham số/body field.
  3) Không cần sửa `client.ts` ngoài body types (đã `expectedRevision: number` từ Δ10).
  Đề xuất: packet `P745-UI-*` (hoặc P730-UI-INTEGRATE mở rộng) giữ lease admin-web.
- **Δ-DOC-1 (doc-note)**: `docs/21-openapi.json` còn ghi route "contract frozen, not yet routed" — cập nhật khi docs owner chạm (không sửa trong packet này).
- **Không cần migration.**

## 6. Limitations

- Chưa chạy PG thật (offline); serialization/ORDER BY/JSONB coercion chỉ pin qua fake + types.
- UI journey chưa chạy (Δ-UI-1 chờ lease); acceptance "upsert dùng khóa từ detail" đã chứng minh ở tầng route+dispatcher offline.
- `/new` sentinel vs `profileName.min(1)`: pre-existing tension, giữ nguyên hành vi — chỉ ghi nhận.
- Boundary: 5 file nêu §1 + receipt này; không chạm runtime/publish/submission/operations/worker-sdk/document-core; không commit/push; không tick.
