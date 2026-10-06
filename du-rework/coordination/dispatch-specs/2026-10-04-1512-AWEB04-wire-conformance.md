# Dispatch spec — AWEB-04 wire conformance theo contract đóng băng (2026-10-04 15:12 +07)

## Nguồn

- Contract đóng băng Phase 1: `coordination/reports/profile-parity-phase1-2026-10-04.md` §5 + §7 (nguồn tham chiếu backend).
- Lệch đã ghi tại receipt đó §7.4 vs `aweb04-profiles-slice-2026-10-04.md` §1.

## Quyết định của coordinator (đã gửi Claude)

1. `fileUrlAuthConfig` **giữ snake_case** (`{type, header_name, header_value, query_key, query_value, token?}`) trên wire — KHÔNG `{mode, header, secret}`.
2. AWEB-04 **bỏ** `schemaVersion`, `endpoints[]`, `effective` khỏi kỳ vọng **read wire**; field UI-internal (nếu cần) phải khai báo UI-internal, không chờ từ API.
3. `capabilities` trên read là **array-of-object** (`{connectorId, capability}`), không `string[]`.

## Việc cần làm (bounded, cc_1)

1. Cập nhật `apps/admin-web/src/lib/api/**` + `src/features/profiles/**` (types/parser/fixtures/screen mapping) theo 3 quyết định trên; giữ nguyên hành vi T-UI (locked/data-locked, 409/400 banners, bulk `allSettled` per-row, write-only, honest gating).
2. Cập nhật fixture/test tương ứng (`tests/browser/admin-web/**`, `services/orchestrator/tests/aweb04-bff-profiles.test.ts` nếu fixture chạm shape) — không đổi semantics fence.
3. Re-run: jest các suite liên quan (66+), tsc, build, Playwright `--output` riêng (kỳ vọng 43 passed + live skip).
4. Ghi rõ trong receipt: các field bị bỏ khỏi wire parse, field nào chuyển UI-internal, và **không** còn chỗ nào parse snake_case sai.

## Lease

- `apps/admin-web/src/lib/api/**`, `src/features/profiles/**`, `src/routes/**` (nếu chạm), `tests/browser/admin-web/**`, `services/orchestrator/tests/aweb04-bff-profiles.test.ts` (fixture-only). **KHÔNG** sửa `components/ui/**`, `styles/**`, `app-shell/**`, orchestrator `src/**` (ngoài test fixture), contracts, migrations, `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb04-wire-conformance-2026-10-04.md`.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 15:12.
