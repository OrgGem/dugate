# UI REVIEW — CONNECTOR-WIRE-B-UI (§5) — 2026-10-05

- **Packet:** `UI-REVIEW-CW-B-UI` (Coordinator dispatch 2026-10-05 02:04 +07).
- **Subject:** Connector Management UI slice (`CONNECTOR-WIRE-B-UI`, lane `dsh_2`).
- **Producer Receipt:** `coordination/reports/connector-wire-b-ui-2026-10-05.md` (`task_f7ad68e17fa3`).
- **Production Build:** `apps/admin-web/dist/assets/index-xBfDFWzz.js` (477.12 kB, gzip 149.14 kB) · SHA-256 digest `6148de23c282f0d5` · CSS `assets/index-HHyOtXdi.css` (40.81 kB).
- **Scope & Mode:** **READ-ONLY review against `docs/admin-ui-development-contract.md` §5.** No source code edits, no master plan modifications, no git commits or pushes.

---

## Verdict: `UI_APPROVED`

The Connector Management UI (`apps/admin-web/src/features/connectors/connectors-screen.tsx`, `state.ts`, `types.ts`, `client.ts`) fully satisfies all architectural, security, and visual criteria of **Admin UI Development Contract §5**. It delivers strict fail-closed capability gating, dual-shape rendering (platform ledger vs degraded projection), zero-leakage configuration projection, structural-only cURL draft mapping, and honest disabled controls with explanatory rationale.

---

## 1. Compliance Matrix Against Contract §5 Criteria

| Criteria / Dimension | Requirement | Implementation Evidence & Static Inspection | Evaluation |
|---|---|---|---|
| **(a) Capabilities 404 / Stub** | Unreadable/missing capabilities must display warning banner and gate OFF all write controls (fail-closed). | `connectors-screen.tsx:288-296`: `<AlertBanner variant="warning" title="Capability advertisement unavailable">` rendered on 404/502.<br>`state.ts:228-244`: `connectorActionGating(null)` unconditionally sets `{upsert: false, activate: false, disable: false, retire: false, test: false, rotate: false}` with explanatory `reason`.<br>All action buttons have `disabled={!gating.<action> \|\| ...}` with title set to `gating.reason`.<br>Verified by `connectors-wire.spec.ts:115` (Test 2) and `api-keys-connectors.spec.ts:137` (Test 6). | **PASS** (Fail-Closed) |
| **(b) Legacy Revision Shape** | Degraded projection must display honest badge, without pretending connector truth; never render config keys. | `state.ts:189-200`: `parseConnectorRevisionRead` discriminates strictly on key-set (`endpoint` vs `config`). Malformed bodies never fall back to legacy (Test 5).<br>`connectors-screen.tsx:570-578`: Renders Badge `warning` with label `"degraded projection"` and text `"adapter/capabilities are placeholders, not connector truth"`.<br>`connectors-screen.tsx:584-606`: Renders definition list of endpoint, capabilities, secret slots, updatedAt. **Config keys are never queried or rendered.**<br>Verified by `connectors-wire.spec.ts:188` (Test 6) and `api-keys-connectors.spec.ts:153` (Test 7). | **PASS** |
| **(c) Management Ledger Shape** | Management ledger must display `"platform ledger"`, render configuration keys only, and separate masked headers. | `connectors-screen.tsx:570`: Badge `info` with label `"platform ledger"`.<br>`ManageRevisionFacts` (`connectors-screen.tsx:730-771`) consumes `summarizeConnectorConfig(read.revision.config)`.<br>`state.ts:256-269`: `keys = Object.keys(config).sort()`. Values are never returned.<br>Headers are partitioned: non-secret names in `headerNames`, `[REDACTED]` or secret-named in `redactedHeaderNames` (rendered as `· masked: ...`). Values never reach the DOM.<br>Verified by `connectors-wire.spec.ts:234` (Test 10). | **PASS** (Zero Secret Leak) |
| **(d) cURL Draft Save & Coordinates** | Save disabled when coordinates missing, naming exact missing field; payload must contain zero secrets or local file paths. | `state.ts:304-324`: `buildConnectorUpsertParams` enforces non-empty `connectorId`, `adapter`, `credentialRef`. Returns `{ok: false, missing: '...'}` specifying the exact missing coordinate.<br>`state.ts:327-364`: `connectorConfigFromDraft` reduces secret headers and form fields to names only (`redactedHeaderNames`, `secretFormFieldNames`); strips local file paths (`fileFormFieldNames`); auth reduces to `{type, headerName, secretPresent: boolean}` with zero secret bytes.<br>`ImportedDraftCard` (`connectors-screen.tsx:809-815`): `saveDisabled = !gating.upsert \|\| !planOk \|\| busy`; renders helper: `"Save stays disabled until <code>{missing}</code> is filled in"`.<br>Verified by `connectors-wire.spec.ts:251-335` (Tests 11, 12, 13, 14). | **PASS** (Payload Scrubbed) |
| **(e) Rotate Secret Control** | Rotate secret button must be disabled with honest explanatory rationale. | `connectors-screen.tsx:671-682`: `<Button size="sm" variant="outline" disabled ...>` is hardcoded `disabled`.<br>Title provides explicit reason: `"Rotate is not wired in this UI slice — the write-only value path (connectors.rotate_credential) is a separate packet (Δ5)"` when `gating.rotate` is true, or `"Credential workflow is not composed on this deployment"` when false.<br>Verified by `api-keys-connectors.spec.ts:163` (Test 7). | **PASS** (Honest Tooltip) |
| **(f) Semantic HTML & Design Tokens** | Consistent design tokens, semantic components, and responsive reflow at 320px. | Single-source tokens from `src/styles/` (`tokens.css`, Tailwind utility classes).<br>No inline style hacks or rogue palettes.<br>Semantic structure (`<Table>`, `<Card>`, `<dl>`, `<FormField>`, `<AlertBanner>`, `<ConfirmDialog>`).<br>Responsive layout (`flex-wrap`, `min-w-0`, `grid-cols-1 sm:grid-cols-[max-content_1fr]`). | **PASS** (Design System Compliant) |

---

## 2. Verification & Test Evidence

### 2.1 Literal Playwright Test Runs
Executed in `D:\Git\dugate\du-rework\tests\browser`:
```bash
npx playwright test admin-web/connectors-wire.spec.ts admin-web/p730-curl-import.spec.ts admin-web/p745-ui-keys.spec.ts --config admin-web/playwright.config.ts
```
- **Result:** **`43 passed (813ms)` — EXIT 0**.
  - `connectors-wire.spec.ts`: **16/16 passed** (capability advertisement, gating fail-closed, strict revision parsing, config summary key-only, draft coordinate validation, zero secret leak in payload, typed client wiring guards).
  - `p730-curl-import.spec.ts`: **19/19 passed** (bounded cURL parser, masking, no shell/eval, reveal toggle).
  - `p745-ui-keys.spec.ts`: **8/8 passed** (write identity mapping and forward).

### 2.2 Production Build & Static Analysis
Executed in `D:\Git\dugate\du-rework\apps\admin-web`:
- `npx vite build`: **BUILD_EXIT = 0** in 8.07s.
  - `dist/assets/index-xBfDFWzz.js`: 477.12 kB (gzip: 149.14 kB).
  - `dist/assets/index-HHyOtXdi.css`: 40.81 kB (gzip: 8.08 kB).
- `npx tsc --noEmit -p tsconfig.json`: **TSC_EXIT = 0** (0 diagnostics, clean typecheck).

---

## 3. Reconciliation of Gaps & Technical Notes

1. **G1 (BFF Missing Read Route) — RECONCILED / STALE**:
   - As flagged by the Coordinator, `services/orchestrator/src/app/admin/bff/handle.ts` was implemented by `dsh_1` (`CONNECTOR-WIRE-B-BFF`, receipt `connector-wire-b-bff-2026-10-05.md`). It exposes both `GET /admin/api/connectors` and `GET /admin/api/connectors/capabilities` with platform-admin fencing. G1 is completely closed.
2. **G4 (Harness Stub Capability Simulation) — OFFLINE GAP ACCEPTED**:
   - The test harness stub currently does not emulate dynamic multi-tenant connector management stores; instead, it exercises the missing/unavailable capability branch (`api-keys-connectors.spec.ts` Tests 6 & 7).
   - This proves the critical defensive path: when capabilities are absent, the UI fails closed immediately. Pure state and mapping tests (`connectors-wire.spec.ts`) cover the positive branches without requiring a live stack.
3. **Draft cURL Save Safety**:
   - Static inspection confirms that `ImportedDraftCard` maps the draft using `buildConnectorUpsertParams`. The resulting payload sends configuration keys and structure only; no API keys, bearer tokens, or local filesystem paths can leak through the wire.

---

## 4. Conclusion & Next Steps

The `CONNECTOR-WIRE-B-UI` implementation is **`UI_APPROVED`**. 
All front-end requirements for Connector Management are fulfilled without technical debt, secret leakage, or unverified button states.

- **For Coordinator**: The UI review milestone for Connector Management is cleared. The team may proceed to integrate this slice into the 6-stage commit plan (§12 / §13).
