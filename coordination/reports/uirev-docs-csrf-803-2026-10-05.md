# UI Contract §5 Review Receipt: Docs Screen CSRF & Session Gate (#803)

- **Date:** 2026-10-05
- **Reviewer:** Antigravity (UI Lead & Reviewer — `term_ae2d7e42-8042-4b85-95d5-cabed5ee3191`)
- **Task ID:** `task_ddd1e93d0669` (Dispatch: `ctx_a7d8815fb340`)
- **Coordinator:** DeepSeek Coordinator (`term_6904d82c-e563-416b-9cc2-8da4f7bc16b3`)
- **Target Surface:** `/docs` (`apps/admin-web/src/features/docs/docs-screen.tsx`)
- **Mode:** READ-ONLY Verification (Zero edits to source code, zero git commits)
- **Previous Finding:** `CHANGES_REQUIRED` in `uirev-cfgadm-port-2026-10-05.md:32, 82-100` (missing session bootstrap and CSRF proof).
- **Subject of Review:** `CFGADM-DOCS-CSRF-FIX` by `dsh_2`.

---

## 1. Target Build Digest & Asset Verification

In strict accordance with review guidelines, SHA-256 digests were independently computed directly from disk on `apps/admin-web/dist/` without relying on prior reports:

| Build Asset | File Path | SHA-256 Hash (Full) | SHA-256 (Prefix) |
|---|---|---|---|
| `dist/index.html` | `apps/admin-web/dist/index.html` | `124B64886A3B31BE3600D8F8485CADE2D05B45AA63016DFF74C01D3FAAF29237` | `124b64886a3b31be` |
| `dist/assets/index-BZ2-Edjb.js` | `apps/admin-web/dist/assets/index-BZ2-Edjb.js` | `2296C26628F4A454909F1612D1199BC7541FB82EC77D3D27A602C141BA011058` | `2296c26628f4a454` |
| `dist/assets/index-BffJF1YL.css` | `apps/admin-web/dist/assets/index-BffJF1YL.css` | `BAF331D4EA62F3274FC1AC9E83EA049787FC7F786FAC6330FBF69DE3457BF021` | `baf331d4ea62f327` |

### Bundle Confirmation:
Static inspection of `dist/assets/index-BZ2-Edjb.js` (line 163) confirms that component `Rj` (`DocsScreen`) embeds the updated session bootstrap logic:
- `t.getSession()` executed in `v.useEffect` upon mount.
- Session role extraction `_ = r.kind === "ready" ? r.session.role : null`.
- Capability calculation `F = _ === "admin" || _ === "operator"`.
- Execution guard in `Q()` (`runTestEndpoint`): `if (r.kind !== "ready" || !F) { ... return; }`.
- Button disablement: `disabled={G || !F}` where `G` is busy state and `F` is `canRunTest`.

---

## 2. Detailed Audit of the 4 Specific Mandates

### 2.1. Mandate 1: CSRF Attachment on Mutation & Zero Raw Error Body Leakage
- **CSRF Attachment:**
  - `docs-screen.tsx:45-55`: The mount hook `useEffect` calls `await client.getSession()`, which stores the server-issued CSRF token into the `AdminApiClient` instance closure (`lib/api/client.ts:223`).
  - `docs-screen.tsx:115-128`: `client.testProfileEndpoint(...)` sets `csrf: true`, which dynamically injects `headers['x-csrf-token'] = csrfToken` (`lib/api/client.ts:156`).
  - Mutation dispatches pass a freshly generated `crypto.randomUUID()` as `idempotencyKey` (`docs-screen.tsx:127`).
- **Error & Response Rendering:**
  - `docs-screen.tsx:245-249`: Failed executions render a structured `<AlertBanner variant="error" title={testProblem.title ?? 'Test failed'}>` with text `{testProblem.status} · {testProblem.code ?? 'ERROR'}`.
  - Zero raw HTML error responses, zero stack traces, and zero unhandled exception dumps are passed to the DOM.
  - Successful executions (`docs-screen.tsx:250-254`) render formatted, indented JSON via `JSON.stringify(testResult, null, 2)` inside `<pre className="max-h-64 overflow-auto ...">`.

### 2.2. Mandate 2: Strict Fail-Closed Behavior When Session or Capability Missing
- **Session State Isolation:**
  - `docs-screen.tsx:22-26`: `SessionState` strictly defines `{ kind: 'loading' } | { kind: 'ready'; session: AdminWebSession } | { kind: 'failed'; problem: AdminApiProblem }`.
- **Pre-Flight Block in Code:**
  - `docs-screen.tsx:94-102`: In `runTestEndpoint()`, if `sessionState.kind !== 'ready' || !canRunTest`, the function sets `testProblem` locally (`status: 403`, `code: 'FORBIDDEN'`) and immediately returns.
  - **Result:** Exactly **0 network requests** are sent if the session is unauthenticated, unavailable, or restricted.
- **UI Button & Banner Fail-Closed:**
  - `docs-screen.tsx:199`: The "Run test" button has `disabled={busy || !canRunTest}`. When role is `viewer`, `unscoped`, or session is loading/failed, the button is physically unclickable.
  - `docs-screen.tsx:61-68, 171-178, 206-213`: When disabled, an `AlertBanner` explicitly displays the honest rationale (`Reading the admin session before enabling writes...`, `Admin session unavailable...`, or `Profile Test Endpoint requires an admin or operator session...`).

### 2.3. Mandate 3: Endpoint Catalog Honesty Preservation
- The 13 endpoints declared in `docs-screen.tsx:71-88` remain completely preserved and unmutated:
  1. `GET /session`
  2. `GET /audit`
  3. `GET /api-keys`
  4. `GET /connectors` (and `/connectors/capabilities`)
  5. `GET /connectors/:id/revisions/:rev`
  6. `GET /profiles/:b/:v/:name`
  7. `POST /profiles/.../upsert|publish|rollback`
  8. `POST /profiles/test-endpoint`
  9. `GET /operations`
  10. `GET /usage`
  11. `GET /businesses`
  12. `GET/POST /crypto-config`
  13. `POST /actions`
- As verified in receipt `coordination/reports/docs-catalog-honesty-803-2026-10-05.md`, all 13 map 1:1 to real frontend client methods and real backend BFF routes (13/13 Type 1, 0 phantom endpoints).

### 2.4. Mandate 4: Zero Layout Regression (320px Reflow, Focus Rings, Empty/Loading States)
- **320px Reflow:**
  - Bounded container classes (`space-y-4`, `flex flex-col gap-3`, `w-full`).
  - Text truncation applied on endpoint items (`truncate text-sm font-medium`, `truncate text-xs text-muted-foreground`), badges styled with `shrink-0`.
  - Textarea and inputs resize fluidly to 100% width; no fixed horizontal margins exceeding 320px viewport.
- **Focus & Keyboard Navigation:**
  - All interactive elements utilize shared UI primitives (`Button`, `Input`, `Modal`) containing visible focus rings (`outline: 2px solid var(--focus-ring)`).
  - Explicit labels provided: `aria-label="businessId"`, `aria-label="businessVersion"`, `aria-label="profileName"`, `aria-label="endpointSlug"`, `aria-label="file urls"`.
- **Loading & State Indicators:**
  - `docs-screen.tsx:165-170`: Renders `<LoadingState title="Reading the admin session" description="The Test Workbench stays disabled until the server issues its CSRF proof." />` while initial session fetch is in progress.

---

## 3. Review Checklist & Verification Matrix

| Checklist Item | Target Coordinate (`file:line`) | Verified Status |
|---|---|---|
| Mount Session Bootstrap | `docs-screen.tsx:45-55` | **PASS** |
| Fail-Closed Role Check | `docs-screen.tsx:59-68` | **PASS** |
| Zero-Roundtrip Preflight Block | `docs-screen.tsx:94-102` | **PASS** |
| CSRF Header Injection | `docs-screen.tsx:115`, `client.ts:156` | **PASS** |
| Idempotency Key Injection | `docs-screen.tsx:127`, `client.ts:157` | **PASS** |
| Button Disabled When Restricted | `docs-screen.tsx:199` (`disabled={busy \|\| !canRunTest}`) | **PASS** |
| Sanitized Error AlertBanner | `docs-screen.tsx:245-249` | **PASS** |
| Formatted JSON Output Display | `docs-screen.tsx:250-254` | **PASS** |
| 13/13 Catalog Honesty | `docs-screen.tsx:71-88` | **PASS** |
| 320px Mobile Responsiveness | `docs-screen.tsx:147-164, 205-255` | **PASS** |
| Visible Focus & Accessibility Labels | `docs-screen.tsx:215-240` | **PASS** |

---

## 4. Final Verdict

### Formal Verdict: **`UI_APPROVED`**

- **Prior Defect Resolution:** The previously reported defect in `uirev-cfgadm-port-2026-10-05.md:32, 82-100` (`CHANGES_REQUIRED` on `/docs`) is **fully resolved**.
- **Compliance:** `apps/admin-web/src/features/docs/docs-screen.tsx` satisfies 100% of the UI Contract §3, §4, and §5 requirements:
  - CSRF proof bootstrap is securely wired.
  - Fail-closed write gating operates identically to the proven `/identity` screen pattern.
  - Zero raw server errors or sensitive credentials are disclosed.
  - Catalog honesty is fully maintained.
- **Status:** Cleared for production integration.
