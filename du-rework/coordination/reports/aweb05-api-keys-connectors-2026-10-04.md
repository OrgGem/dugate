# AWEB-05 — API Keys + Connectors slice (2026-10-04)

**Packet:** aweb05-api-keys-connectors · **Lane:** cc_1 (Admin UI integrator) · **Dispatch:** 2026-10-04T12:22+07:00.
**Trạng thái:** DONE. Không commit, không tick. `components/ui/**`, `styles/**`, `app-shell/**`, `server.ts`, `main.ts`, `packages/contracts/**`, `tasks/**`, `docs/**` **không bị sửa**; `shell-server.ts` không đổi trong packet này (mtime 11:49 — từ AWEB-02).

## 1. Route / state matrix

| BFF route (mới) | Hành vi | Evidence |
|---|---|---|
| `GET /admin/api/api-keys` | Proxy `GET /api/v1/admin/api-keys`; principal-aware: platform → adminToken; operator → token **đúng tenant** (map đảo `tenantAdminTokens`); tenant ép từ session, foreign `?tenantId=` → 403; allow-list `limit/cursor/status/prefix/sort`; `no-store` | `bff/handle.ts:237-296` |
| `GET /admin/api/api-keys/:id` | By-id; id sai/hết hạn/quá dài → 404 không gọi upstream | `bff/handle.ts:257-260` |
| `GET /admin/api/connectors/:id/revisions/:rev` | Proxy revision (adapter/state/maskedHost/capabilities); upstream 404 (chưa cấu hình `connectorBaseUrls`) → 404 `NOT_FOUND` nguyên vẹn; POST → 405 | `bff/handle.ts:305-352` |
| `POST /admin/api/actions` (đã có) | `apikey.issue` → 201 kèm `rawKey` (copy-once, `no-store`); `apikey.revoke` → 200; `idempotency-key` forward | từ AWEB-02, giữ nguyên |

| UI route | States | Ghi chú |
|---|---|---|
| `/admin/web/api-keys` | loading/ready/empty/error/denied; issue (copy-once banner) + revoke (ConfirmDialog); **Rotate/Disable disabled + badge `rotate/disable: requires backend` (F7)**; Profile bindings read-only từ payload `grants` | `features/api-keys/*` |
| `/admin/web/connectors` | idle/loading/ready/denied; 404 → card **“Connector unavailable … `connectorBaseUrls`/PAR-03/14”**; ready → chi tiết + **Test/Rotate disabled + `test/rotate: requires backend`** | `features/connectors/*` |
| Links | Overview → 2 link section (my file), route mới trong `router.tsx` | `features/overview/overview-screen.tsx:86-93`, `router.tsx:30-32` |

Secret hygiene: list/by-id không bao giờ chứa raw key (chỉ prefix/maskedHint); copy-once chỉ trong response issue, client giữ trong memory (không localStorage/sessionStorage), banner dismiss/reload là mất; UI write-only không có ô nhập lại secret.

## 2. Copy-once evidence (browser thật)

- Case 2 (`api-keys-connectors.spec.ts`): issue → banner “Copy this key now — it will not be shown again” hiện **đúng 1 lần** (`toHaveCount(1)`), screenshot `05-02-copy-once.png` (đã xem trực tiếp: banner + rawKey `du_test_copy_once_raw_key_9f2c` + Copy/Dismiss + note “memory only”); `localStorage/sessionStorage` = rỗng; Dismiss → count 0; **reload → vẫn 0**; row mới `du_live_new` xuất hiện; screenshot `05-03-copy-once-hidden-after-reload.png`.
- Read path không lộ: test jest `issue passes rawKey exactly once (no-store); a later read never contains it` — GET sau đó không chứa rawKey/adminToken/tenant token.

## 3. Backend gaps (ghi rõ owner)

- **Rotate/Disable API key (F7)**: chưa có action ⇒ UI disabled + badge, không nút giả.
- **Connector list/registry + ledger (PAR-03/14)**: không có route list ⇒ UI lookup theo id + ghi rõ; revision là projection thật từ `connectorBaseUrls` (thiếu ⇒ 404 honest).
- **Connector test/rotate (F3/PAR-03/14)**: cần `credentialWorkflow` + capability thật trong composition (main.ts — packet AWEB-02b của cc_2); payload hiện `capabilities: []` ⇒ UI giữ disabled kèm lý do.
- Profile binding: chỉ hiển thị read-only từ projection có sẵn; tạo binding vẫn ngoài phạm vi màn này.

## 4. Findings phát hiện trong packet (đã xử lý nội bộ, không sửa file ngoài lease)

- **Client CSRF instance bug** (test bắt được): `postAction` trên client instance mới không có CSRF token đã lưu từ `getSession` → 403 CSRF_REJECTED. Fix: mỗi screen dùng **một client instance** (`useMemo`) — `features/api-keys/api-keys-screen.tsx:35`. (Overview không mutation nên không dính.)
- **Envelope unwrap**: BFF bọc `{data: …}` cho actions; client nay unwrap để `rawKey` đọc đúng (`lib/api/client.ts:130-150`).
- **F3 xác nhận thực tế**: `FormField` không truyền `id` vào input con ⇒ UI phải tự gắn `id` (đã làm cho `#issue-tenant`, `#connector-id`, `#connector-revision`) — finding F3 của AWEB-03b có bằng chứng cụ thể hơn.
- **Harness isolation**: stub sống ngoài 1 test ⇒ thêm `/__stub/mode?reset=1`, spec gọi `beforeEach` (tránh state REVOKED/tích luỹ giữa các lần chạy).

## 5. Commands + literal output

```
pnpm --filter @du/admin-web build                          → BUILD_EXIT=0
  ✓ 2645 modules transformed.
  dist/assets/index-CgFNVO5c.css   39.82 kB │ gzip:   7.93 kB
  dist/assets/index-BAzsxOZ4.js   392.02 kB │ gzip: 128.29 kB

npx playwright test --config admin-web/playwright.config.ts → PW_EXIT=0
  21 passed (23.5s)   # 6 AWEB-01b + 7 AWEB-03b overview + 8 AWEB-05 (chạy lại case copy-once riêng: 1 passed)

pnpm exec jest --runInBand tests/aweb05-bff-reads.test.ts   → 8 passed, 8 total   (mới)
pnpm exec jest --runInBand tests/aweb02-bff-foundation.test.ts → 26 passed, 26 total (regression, quét bundle mới)
pnpm --filter @du/orchestrator typecheck                    → TSC=0
```

## 6. File đã chạm

| File | Thay đổi |
|---|---|
| `src/app/admin/bff/handle.ts` | +2 read route + helper `rbacPrincipal/credentialFor/decodePathSegment` (chỉ file backend bị sửa) |
| `apps/admin-web/src/lib/api/{types,client,index}.ts` | api-keys + connectors types/methods, envelope unwrap |
| `apps/admin-web/src/features/api-keys/{state.ts,api-keys-screen.tsx}` (mới) | list/issue/revoke + F7 disabled + bindings |
| `apps/admin-web/src/features/connectors/{state.ts,connectors-screen.tsx}` (mới) | lookup + honest unavailable |
| `apps/admin-web/src/routes/{api-keys,connectors}.tsx` (mới), `src/router.tsx` | route mới |
| `apps/admin-web/src/features/overview/overview-screen.tsx` | +link section nav |
| `tests/browser/admin-web/harness.ts` | stub api-keys/actions/connectors + reset + request log |
| `tests/browser/admin-web/api-keys-connectors.spec.ts` (mới) | 8 case |
| `services/orchestrator/tests/aweb05-bff-reads.test.ts` (mới) | 8 test BFF |
| `coordination/evidence/aweb05/**` | 15 ảnh `05-*` |

Không chạm: `components/ui/**`, `styles/**`, `app-shell/**` (Antigravity); `server.ts`; `main.ts`; contracts; tasks; docs.

## 7. Gaps / next

- Live evidence (Vault/connector thật) chờ composition `credentialWorkflow`/`connectorBaseUrls` (AWEB-02b/PAR-03/14) — khi đó chỉ cần bật nút, luồng actions đã sẵn.
- Connector list route + api-key rotate/disable action: đề xuất thành packet backend riêng (ghi owner).
- 320px mới phủ trang api-keys; connectors reflow theo cùng grid (`grid-cols-1 sm:...`) nhưng chưa có case riêng — bổ sung khi màn có thêm nội dung.

## Verdict

**ACCEPTED ở tầng BFF + browser harness**: 2 read route mới với fence đầy đủ (8/8 jest, kể cả negative “upstream untouched”), UI 2 màn với copy-once đúng 1 lần (ảnh + storage + reload), revoke confirm thật, F7/F3 hiển thị disabled có lý do (không nút giả), 21/21 Playwright, build/typecheck 0, aweb02 regression 26/26. Gap backend nêu rõ owner (PAR-03/14, F7, AWEB-02b).
