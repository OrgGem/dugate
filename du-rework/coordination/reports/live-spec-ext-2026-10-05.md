# LIVE-SPEC-EXT (qwen_2) — mo rong live-admin-web.spec.ts — 2026-10-05

**Lease:** tests browser spec + receipt moi. Read-only: app source, contracts, runtime, worker-sdk. Offline. No commit.

## 1. Da them (4 test, LIVE-READY-PREP3 items)

- `tests/browser/admin-web/live-admin-web.spec.ts` (extend) — test **6..9**:
  - **6. connectors** — list/capabilities + activate/disable (both-ways honest, toggle chi click khi enabled).
  - **7. profiles** — upsert voi **apiKeyId THAT** lay tu BFF `/admin/api/api-keys?limit=50` (real); neu backend khong ship thi honest card hien.
  - **8. operations detail -> result/artifact** — mo row dau, cho artifacts table HOAC honest empty.
  - **9. vault/security config presence** — security heading + crypto view HOAC honest unavailable, + `/vault|local|provider/i` phai hien.
- Giu nguyen gate tu file: `test.skip(!LIVE, ...)` o `describe` level (DU_LIVE_INFRA=1 + AWEB_LIVE_URL) — 4 test moi ke thua gate.
- CJS-safe: dung `__dirname`/template literal, **khong** `import.meta` (spec duoc transpile sang CJS).

## 2. Bang chung (literal Exit Codes)

- **Collect:** `npx playwright test --config=playwright.config.ts live-admin-web.spec.ts --list` ->
  `Total: 9 tests in 1 file`, **Exit Code: 0** (5 cu + 4 moi deu duoc collect).
- **Gate offline:** chay that (khong set env) -> `9 skipped`, **Exit Code: 0** — offline file skip sach, khong cham deployment.
- **KHONG chay live** (DU_LIVE_INFRA khong set). Day la offline headroom, khong phai acceptance.

## 3. Δ / gioi han

- **Δ-LS-1 (selector la best-effort):** selector cho 4 test moi duoc rut tu cac spec OFFLINE cung app/web (`profiles.spec.ts`, `operations-business.spec.ts`, `identity-security-settings.spec.ts`, `api-keys-connectors.spec.ts`). Vi gate, chung **chua duoc verify tren live UI that**. Khi live run that, neu selector lech thi can chay `--list` va fix lai selector roi chay lai — chi leg live moi xac nhan.
- **Δ-LS-2 (profiles apiKeyId real = theo luong BFF):** lay id tu `/admin/api/api-keys?limit=50`; neu route tra 404 (deployment khong mount api-keys BFF), the `editor.or(notShipped)` assertion se van pass theo nhanh honest — **khong claim apiKeyId da dung neu route khong ton tai**.
- **Δ-LS-3:** khong tick live acceptance; DU_LIVE_INFRA/DB window van la duyet cua tester lane.

## 4. File da ghi

- `tests/browser/admin-web/live-admin-web.spec.ts` (sua: them 4 test).
- `coordination/reports/live-spec-ext-2026-10-05.md` (file nay).
- Khong cham `tests/browser/tests/live-admin-e2e.spec.ts` (Playwright spec khac, khong co gate) va khong su dung.
