# AWEB-04 wire conformance — theo contract Phase-1 đóng băng (2026-10-04)

**Packet:** aweb04-wire-conformance · **Lane:** cc_1 · **Dispatch:** 2026-10-04T15:12+07:00.
**Trạng thái:** DONE. Không đổi semantics fence; không chạm orchestrator `src/**` (chỉ fixture test), `components/ui/**`, `styles/**`, `app-shell/**`, contracts, migrations, `tasks/**`, `docs/**`. Không commit.

## 1. Ba quyết định của coordinator — đã áp

| # | Quyết định | Áp dụng |
|---|---|---|
| 1 | `fileUrlAuthConfig` **giữ snake_case** (`{type, token?, header_name?, header_value?, query_key?, query_value?}`) trên **write**; read chỉ có `fileUrlAuthConfigured: boolean` | `types.ts:101-109` (`FileUrlAuthConfigWrite`) + `types.ts:117` (`ProfilePolicyRead.fileUrlAuthConfigured`); form snake_case ids `fua-token/fua-header-name/fua-header-value/fua-query-key/fua-query-value` (`profiles-screen.tsx:619-745`); builder `buildFileUrlAuth` (:788-804) chỉ gửi field thuộc `type` đã chọn |
| 2 | Bỏ `schemaVersion`, `endpoints[]`, `effective` khỏi **read wire** | parser không còn đọc 3 field (grep sạch — mục 3); preview card chuyển thành honest “Preview requires backend…” (không parse `effective`); matrix không còn đọc `endpoints[]` |
| 3 | `capabilities` = **array-of-object** `{connectorId, capability}` | `types.ts:121-124` (`ProfileCapability`); parser lọc object hợp lệ; gating UI theo **tên capability** (`hasCapability('publish'/'rollback'/'testEndpoint')`), badges hiển thị `connectorId:capability` |

Read wire đóng băng đã bám đúng §7.1 của `profile-parity-phase1-2026-10-04.md`:
`{businessId, businessVersion, profileName, revision, currentValues, policy:{enabled, parameters(map), jobPriority, allowedFileExtensions, fileUrlAuthConfigured, connectionsOverride}, manifest:{actions:[{name}]}, capabilities:[{connectorId, capability}]}`.

## 2. Field chuyển **UI-internal** (không chờ từ API)

- `RowDraft` (profileName/enabled/priority/extensions/params/connSteps): **một row seed** từ `manifest.actions[0]` + `policy` của detail; operator có thể “Add endpoint row” để bulk upsert nhiều key trong một lượt (giữ T-UI-04 `allSettled` per-row). Không có field nào được thêm vào wire để phục vụ việc này.
- `FileUrlAuthDraft` (`touched`, `type`, các field snake_case): chỉ gửi khi touched; **không bao giờ prefill** từ server.
- `rowResults` (bulk per-row report): state UI thuần.

## 3. Kiểm tra “không còn parse snake_case sai”

```
grep fileUrlAuthConfig|fileUrlAuthConfigured trong lib/api + features/profiles:
  types.ts:102 FileUrlAuthConfigWrite (WRITE)       types.ts:117 fileUrlAuthConfigured (READ)
  profiles-screen.tsx:155 policy.fileUrlAuthConfig = buildFileUrlAuth(...)   # write-path duy nhất
  profiles-screen.tsx:623 detail.policy.fileUrlAuthConfigured → badge        # read-path duy nhất
  state.ts:64  fileUrlAuthConfigured: value['fileUrlAuthConfigured'] === true
grep \.endpoints|\.effective|schemaVersion|ProfileEndpointPolicy|ProfileSlot trong features/profiles:
  = 1 dòng, chỉ là comment mô tả field đã bỏ (state.ts:8) — không còn code parse.
```

## 4. Hành vi T-UI giữ nguyên (đã re-verify bằng browser)

- locked slots: readonly + disabled + `data-locked="true"` + badge (case 2).
- 409 `REVISION_CONFLICT` và 400 `PROFILE_LOCKED_FIELD`: banner + hint, **draft giữ nguyên** (case 4/5).
- bulk `Promise.allSettled` per-row, không rollback chung (case 6 — nay thêm row thứ hai bằng “Add endpoint row” + name `compare` để stub trả 422 per-row).
- write-only: banner copy-once, không storage; params locked bị bỏ khỏi policy gửi lên (`buildPolicy` skip `isLocked`).
- honest gating: `capabilities []` → mọi action disabled + badge “policy backend not shipped” (case 1); `testEndpoint` chỉ bật khi capability object có mặt (case 8).

## 5. Test/fixture đã cập nhật (không đổi semantics fence)

- `tests/browser/admin-web/harness.ts`: fixture + placeholder profile serve **wire conformant**; mode `partial` chuyển điều kiện fail sang `params.profileName !== 'extract'` (không còn `policy.endpointSlug`).
- `tests/browser/admin-web/profiles.spec.ts`: case 6 dùng add-row; các case khác giữ nguyên locator (Save extract, data-locked, banner codes).
- `services/orchestrator/tests/aweb04-bff-profiles.test.ts`: **fixture-only** — stub GET profile đổi sang shape conformant; assert fence/forwarding không đổi.

## 6. Commands literal

```
pnpm exec jest (aweb02+04+05+06+07+08) → 6 suites, 66 tests passed          JEST=0
pnpm --filter @du/orchestrator typecheck → TSC=0
pnpm --filter @du/admin-web build      → exit 0 (2662 modules; JS 444.44 kB / gzip 139.90 kB)
npx playwright test --config admin-web/playwright.config.ts --output .pw-output-wire
  43 passed
  5 skipped      # live spec gated — skip sạch
PW=0
```
Evidence: `coordination/evidence/aweb04-wire/` (screenshots các spec cùng lượt; profiles 04-01..09 được ghi lại theo wire mới).

## 7. File đã chạm

| File | Thay đổi |
|---|---|
| `apps/admin-web/src/lib/api/types.ts` | Profile read/write types theo contract (bỏ 3 field, capabilities objects, snake_case write) |
| `apps/admin-web/src/lib/api/index.ts` | export types mới |
| `apps/admin-web/src/features/profiles/state.ts` | parser conformant (parameters map, capabilities objects, bỏ field đã cắt) |
| `apps/admin-web/src/features/profiles/profiles-screen.tsx` | draft rows UI-internal, fileUrlAuth snake_case write-only, gating theo capability objects, preview honest |
| `tests/browser/admin-web/harness.ts` | fixture conformant + partial theo profileName |
| `tests/browser/admin-web/profiles.spec.ts` | case 6 add-row |
| `services/orchestrator/tests/aweb04-bff-profiles.test.ts` | fixture-only conformant |

## Verdict

**ACCEPTED**: 3 quyết định coordinator áp đủ (snake_case write-only, cắt `schemaVersion`/`endpoints[]`/`effective` khỏi read parse, capabilities array-of-object); không còn parse sai field nào (grep sạch); hành vi T-UI giữ nguyên và re-verified; 66/66 jest, tsc 0, build 0, Playwright **43 passed + 5 skipped** (`--output` riêng, live skip sạch).
