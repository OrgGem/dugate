# Frontend browser verification receipt

Status: completed against the frozen Admin Web source on 2026-10-12. This work changed only the leased Playwright spec/config and this receipt; product source was not modified.

The isolated spec is [frontend-ux.verify.spec.ts](../../tests/browser/admin-web/frontend-ux.verify.spec.ts), using [frontend-ux.playwright.config.ts](../../tests/browser/admin-web/frontend-ux.playwright.config.ts) and the existing in-memory Admin shell harness. It covers navigation/deep links and access gates, Operations cursor paging and density, account/Trace error alignment, Secrets tenant pagination and mutation races, Business retry and workflow-profile retention, connector selection during a pending mutation, Settings draft retention across tabs, bounded Workflow mapping, and stale Profile filter responses.

## Results

- Fresh Admin Web package checks from `D:\Git\dugate\du-rework\orchestrator`: `pnpm --filter @du/admin-web typecheck` and `pnpm --filter @du/admin-web build` both passed (exit 0). Raw output: [typecheck](raw/frontend-browser-20261012-final-12/typecheck.log), [build](raw/frontend-browser-20261012-final-12/build.log).
- The full ten-test batch recorded in `final-05`, from `D:\Git\dugate\du-rework\tests\browser`, passed 9/10. Its only failure was a test fixture glob that intercepted the Operations collection but not `/admin/api/operations/{id}`. Captured request evidence showed the exact detail path; the correction uses a narrow collection/detail matcher and a 123-character fixture operation ID, within the BFF path limit. The detail DTO remains unchanged. Raw output and trace are preserved in [final-05](raw/frontend-browser-20261012-final-05/playwright.log).
- After the fixture correction, the Operations test passed 1/1 before and after the final package rebuild. The fresh-build run is [final-13](raw/frontend-browser-20261012-final-13/playwright.log); its eight viewport/theme captures and measurements are under [final-13 evidence](raw/frontend-browser-20261012-final-13/evidence/). Together, the 9 unaffected tests from final-05 and the corrected Operations rerun cover all ten scenarios. A single 10/10 full-batch rerun was not performed.
- I inspected all eight final-build Operations screenshots. At 1440, 768, 390, and 320 pixels in light and dark themes, the page width matched the viewport; headings and page controls remained visible, with no page-level horizontal overflow. The bounded Operations region measured 650 px high at the 1000 px desktop viewport, with 1012 px scroll content and 49 px rows; its sticky header stayed within 2 px while scrolling. Long business IDs were visually ellipsized on one line with the action below, and table actions remained readable. At narrower widths, the table keeps its own horizontal scroll for columns that do not fit. The Operations route contains no icon-plus-text buttons, so that per-route control count was 0; the responsive checks did not assert an invented control.
- `pnpm lint` from `tests/browser` still exits 2 due to existing errors outside the new spec/config: `connectors/state.ts:11,177`, `profiles/command-bodies.ts:7`, `profiles/state.ts:23`, `admin-web/harness.ts:1176`, and `admin-web/p745-ui-keys.spec.ts:76-77`. The new `frontend-ux` spec/config had no TypeScript errors. Raw output: [browser package lint](raw/frontend-browser-20261012-final-11/browser-package-lint.log); the focused spec/config compiler check is in [final-10](raw/frontend-browser-20261012-final-10/browser-spec-tsc.log).

The mock routes intercept browser requests at the UI boundary. These checks establish rendered behavior, cursor values and scope sent by the UI, disabled states, and draft retention; they do not verify BFF DTO validation or backend cursor semantics. The existing harness uses in-memory OIDC and scripted upstream responses without PostgreSQL, Redis, real providers, or live APIs. A connector `UNKNOWN` reconciliation scenario was not added; the pending-mutation selection guard was exercised instead.

## Commands and evidence

From `D:\Git\dugate\du-rework\tests\browser`:

```text
pnpm exec playwright test --config admin-web/frontend-ux.playwright.config.ts
pnpm exec playwright test --config admin-web/frontend-ux.playwright.config.ts --grep "operations uses cursor"
```

The corrected Operations case passed 1/1 in both [final-11](raw/frontend-browser-20261012-final-11/playwright.log) and [final-13](raw/frontend-browser-20261012-final-13/playwright.log); final-13 follows the fresh build and captures all eight viewport/theme combinations. The measured geometry is [frontend-browser-geometry.json](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-geometry.json), and the desktop density measurement is [frontend-browser-operations-measurement.json](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-measurement.json).

Screenshots inspected:

- 1440 px: [light](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-1440-light.png), [dark](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-1440-dark.png)
- 768 px: [light](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-768-light.png), [dark](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-768-dark.png)
- 390 px: [light](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-390-light.png), [dark](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-390-dark.png)
- 320 px: [light](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-320-light.png), [dark](raw/frontend-browser-20261012-final-13/evidence/frontend-browser-operations-320-dark.png)

The fresh source SHA-256 manifest is [source-sha256.txt](raw/frontend-browser-20261012-final-13/source-sha256.txt). Key final hashes are `app-shell.tsx` `FF9A4F31A74513020B6C6E7B533FE83C421FD595720236648BB6173C68DC9DB3`, `operations-screen.tsx` `FF3C537C09FDD931B498ED142DE57EDAA1173FB593F9E0DCCB9F352CDF50F58B`, `businesses-screen.tsx` `0AD415E1F70DFD45779F49248DFF6E2CDE5A240512C689E22BCD981A4F5843F4`, `profiles-screen.tsx` `63F8CED7B13F26867935271A4B393E26B531ED99D7567AA53D1E9987158D647B`, `secrets-screen.tsx` `77891849AC0F5EE2CBD4AB59CB5922A130B271C1D1B37F8F815E50EF9BAEA525`, `connectors-screen.tsx` `2DBEC139155632FD597519F9245111A7755D9648E0F4422BB18BFCFC4666C85E`, and `settings-screen.tsx` `C852399DA4EB3EF72ACE71B8137B975AAD7424B124D37E4755FD5450BD85C5C2`.
