# UI Contract §5 Review: CFGADM UI Porting Wave

**Date:** 2026-10-05  
**Reviewer:** Antigravity (`term_ae2d7e42-8042-4b85-95d5-cabed5ee3191`)  
**Task ID:** `task_5586939eb699` (Dispatch: `ctx_9726b19a093f`)  
**Coordinator:** DeepSeek Coordinator (`term_6904d82c-e563-416b-9cc2-8da4f7bc16b3`)  
**Mode:** READ-ONLY Verification (Zero edits to source code, zero git commits)  

---

## 1. Target Build Digest & Asset Verification

As instructed, asset SHA-256 digests were read and computed directly from disk in `apps/admin-web/dist/assets/` rather than relying on prior report notations:

| Asset | Size | SHA-256 (Full) | SHA-256 (Prefix) |
|---|---|---|---|
| `dist/assets/index-Bs0p8VRI.js` | 499,525 bytes | `8CCDBAB15D44CCA1886895475EF3A2AE4352304FA2DC235CF1B93C793348C1D7` | `8ccdbab15d44cca1` |
| `dist/assets/index-BffJF1YL.css` | 41,300 bytes | `BAF331D4EA62F3274FC1AC9E83EA049787FC7F786FAC6330FBF69DE3457BF021` | `baf331d4ea62f327` |
| `dist/index.html` | 470 bytes | — | Entry point referencing `index-Bs0p8VRI.js` & `index-BffJF1YL.css` |

> **Note on Digest History:** Earlier reports (such as VFY-801 or P2) recorded `index-VXqFDc-c.js` (`91323b349fc14175...`). Following the integration of CFGADM-UI-PORT-P3 (`workflows` and `docs` routes), the current live production bundle is `index-Bs0p8VRI.js` (`8ccdbab15d44cca1...`).

---

## 2. Executive Summary of Route Verdicts

| Route Surface | Spec / Port Key | Route Path | Verdict | Key Finding / Blocking Citation |
|---|---|---|---|---|
| **Identity** | `CFGADM-08` | `/identity` | **`UI_APPROVED`** | Strict fail-closed capability gating, write-only passwords, `VIEWER` default, safe OIDC projection allowlist, CAS expectedVersion check. |
| **Workflows** | `CFGADM-09` | `/workflows` | **`UI_APPROVED`** | Correctly shipped DISABLED with honest warning citing `Δ-DEV-03`. Un-faked data, fail-closed state, zero bogus API queries. |
| **Settings** | `CFGADM-01/02/03/04` | `/settings` | **`UI_APPROVED`** | 17 legacy keys catalogued across 3 groups. All 17 write controls disabled with honest reasons (>30 chars). Zero credential values exposed or accepted into DOM. |
| **Docs & Workbench** | `CFGADM-11` | `/docs` | **`CHANGES_REQUIRED`** | Endpoint catalog is clean, but Test Workbench POST to `/profiles/test-endpoint` **omits the `X-CSRF-Token` header** because `client.getSession()` was not bootstrapped. Gating will fail on live BFF with 403 `CSRF_REJECTED`. Citation: `apps/admin-web/src/features/docs/docs-screen.tsx:22, 66`. |

---

## 3. Surface-by-Surface Contract §5 Detailed Audit

### 3.1. Surface 1: `CFGADM-08` Identity Management (`/identity`)
- **Source Files:**
  - `apps/admin-web/src/features/identity/identity-screen.tsx`
  - `apps/admin-web/src/features/identity/identity-api.ts`
- **Contract & Security Gating:**
  - **Capability & Session Gating:** `identity-screen.tsx:75-80, 103-106` enforces that save operations require:
    1. Active session with `session.role === 'admin'`.
    2. Server-advertised `snapshot.capabilities.userWriter === true`.
    3. Auth mode set to `local` or `both` (`snapshot.auth.mode === 'local' || snapshot.auth.mode === 'both'`).
    If any check fails, controls are disabled and `submitUser` aborts fail-closed with `"The server has not enabled the identity writer. No change was sent."`
  - **Password Handling:** `identity-screen.tsx:360-373` renders `<Input type="password" autoComplete="new-password" ... />` exclusively during creation (`editingUser === null`). It is accompanied by the explicit warning: `"Write-only. This value is sent to the server and is never returned or displayed."` When editing existing users, the password input is completely omitted (`identity-screen.tsx:358`).
  - **Role Defaults & Lifecycle:** Default role for new users is initialized to `'VIEWER'` (`line 39, 85, 154`). There is **zero hard delete** action; lifecycle deactivation is handled solely via the `enabled: boolean` status checkbox (`Account enabled`, `identity-screen.tsx:387-398`).
  - **OIDC Metadata Allowlist:** `identity-api.ts:183-201` (`parseOidcMetadata`) strictly parses and admits only `{ issuer, clientId, callbackUrl, scopes }`. Any other keys returned from upstream (such as client secrets, cipher strings, tokens) are dropped.
  - **Intentional Empty States:**
    - When `auth.oidc === null`: `identity-screen.tsx:257-259` renders `"No OIDC metadata is configured or available."`
    - When users array is empty: `identity-screen.tsx:307-309` renders `<EmptyState title="No users" description="No local users are present in the current server snapshot." />`.
  - **Integrity & Concurrency:** Mutations send `X-CSRF-Token` (`line 118, 122`), an idempotency key (`identity-api.ts:98`), and enforce optimistic concurrency with `expectedVersion: currentUser.version` (`identity-screen.tsx:121, 140-147`).
- **Verdict:** **`UI_APPROVED`**

---

### 3.2. Surface 2: `workflows` Route (`/workflows`)
- **Source Files:**
  - `apps/admin-web/src/features/workflows/workflows-screen.tsx`
  - `apps/admin-web/src/routes/workflows.tsx`
  - `apps/admin-web/src/router.tsx:49`
- **Audit Findings:**
  - **Shipped Disabled:** `workflows-screen.tsx:11-15` renders an `<AlertBanner variant="warning" title="Workflows route is disabled">`:
    > *"The workflows administration route is currently disabled by deployment policy (Δ-DEV-03). It will be enabled once the workflows backend is available for this deployment. No workflows data is read or mutated in this state."*
  - **Factual & Un-Faked Rationale:** No dummy rows or placeholder tables are generated. Zero HTTP requests are dispatched to any unready workflows API.
  - **Responsive 320px Reflow:** Verified in Playwright; `scrollWidth == 320, clientWidth == 320`, zero horizontal scrollbar.
- **Verdict:** **`UI_APPROVED`**

---

### 3.3. Surface 3: `docs-screen.tsx` API Docs + Test Workbench (`/docs`)
- **Source Files:**
  - `apps/admin-web/src/features/docs/docs-screen.tsx`
  - `apps/admin-web/src/routes/docs.tsx`
  - `apps/admin-web/src/router.tsx:50`
- **Audit Findings:**
  - **Endpoint Catalog:** Renders a clean 13-endpoint list derived from the client surface (`/session`, `/audit`, `/api-keys`, `/connectors`, `/profiles`, `/operations`, `/usage`, `/businesses`, `/crypto-config`, `/actions`).
  - **Secret Hygiene:** Zero secret keys, tokens, or credentials appear on the screen or in workbench inputs.
  - **Error Display:** Displays genuine status codes (`testProblem.status`, `testProblem.code`, `testProblem.title`) on validation or server errors (`docs-screen.tsx:174-178`).
  - **DEFECT FOUND (CSRF Proof Missing on Mutation Dispatch):**
    - In `docs-screen.tsx:22`:
      ```tsx
      export function DocsScreen() {
        const client = useMemo(() => createAdminApiClient(), []);
      ```
    - In `apps/admin-web/src/lib/api/client.ts:146, 156, 223`:
      ```ts
      let csrfToken: string | null = null;
      ...
      if (init.csrf === true && csrfToken !== null) headers['x-csrf-token'] = csrfToken;
      ...
      async getSession() {
        const result = await request<AdminWebSession>('GET', '/session', {});
        if (result.ok) csrfToken = result.data.csrfToken;
        return result;
      }
      ```
    - Unlike sibling screens (`connectors-screen.tsx:122`, `businesses-screen.tsx:39`, `profiles-screen.tsx:97`), `DocsScreen` **never invokes `client.getSession()`**.
    - Consequently, `csrfToken` remains `null`. When `client.testProfileEndpoint(...)` executes with `{ csrf: true }`, `client.ts` omits the `x-csrf-token` header.
    - **Empirical Confirmation:** Intercepted request headers in live headless browser run confirmed:
      ```json
      {
        "cookie": "du_admin=...",
        "origin": "http://127.0.0.1:57705",
        "accept": "application/json",
        "content-type": "application/json",
        "idempotency-key": "e9e9f0a0-a9b4-4895-a9a7-8687ba0bfec4"
      }
      >>> CSRF token present on request: false
      ```
    - On a live BFF enforcing CSRF on POST `/admin/api/profiles/test-endpoint`, this will be rejected with HTTP 403 `CSRF_REJECTED`.
  - **Required Remediation (for dsh_2):**
    In `apps/admin-web/src/features/docs/docs-screen.tsx`, bootstrap the session on mount or before invoking `runTestEndpoint` (e.g., `await client.getSession()`) so that the client instance acquires the server-issued CSRF token.
- **Verdict:** **`CHANGES_REQUIRED`**  
  **Citation:** `apps/admin-web/src/features/docs/docs-screen.tsx:22, 66`

---

### 3.4. Surface 4: `settings-screen.tsx` Catalog (`/settings`)
- **Source Files:**
  - `apps/admin-web/src/features/settings/settings-screen.tsx`
  - `apps/admin-web/src/features/settings/catalog.ts`
  - `apps/admin-web/src/features/settings/state.ts`
- **Audit Findings:**
  - **17 Legacy Keys Mapped:** Accurately catalogs 17 keys from `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md`:
    - 6 in AI defaults (5 port + 1 retire: `api_secret_key`)
    - 5 in Prompt defaults
    - 6 in Storage & retention
  - **Honest Disabled State:** All 17 action buttons have `disabled={true}` and a descriptive `title` attribute (>30 characters, no claim of save or mutation).
  - **Secret Non-Disclosure:** 4 secret keys (`ai_api_key`, `openai_api_key`, `s3_access_key`, `s3_secret_key`) + `api_secret_key` are explicitly badged as `secret`. There are **0 `<input>` elements** on the entire page, ensuring no secrets can be entered, echoed, or captured.
  - **GAPs Documented:** Prominent `<AlertBanner variant="info" title="No settings wire on this build">` informs operators that no Settings DTO or writer action exists in `packages/contracts`, directing them to the deployment compose/env surface.
- **Verdict:** **`UI_APPROVED`**

---

## 4. General Criteria Verification

| Criterion | Result | Evidence / Details |
|---|---|---|
| **Secret Hygiene** | **PASS** | Bundle regex scan for `AIzaSy`, `AKIA...`, `sk-...` yielded 0 hits. No secret values in DOM. Write-only password in Identity. |
| **Fail-Closed Capabilities** | **PASS** | When `capabilities.userWriter === false` or `session.role !== 'admin'`, identity edit/create controls are disabled (`cfgadm-08-user-writer-absent-fail-closed.png`). Workflows route refuses read/write. |
| **Design Tokens & Theme** | **PASS** | Uses standard semantic CSS variables from `tokens.css` (`--text-sub`, `--border-subtle`, `--radius-sm`, etc.). No hardcoded arbitrary color values. |
| **320px Reflow** | **PASS** | All routes tested under Playwright viewport `320x800`. Evaluated `document.documentElement.scrollWidth <= clientWidth` on all 4 surfaces. Zero horizontal overflow. |
| **Console Hygiene** | **PASS** | Grep scan for `console.` across `src/features/{identity,workflows,docs,settings}` yielded 0 calls. Zero sensitive logs. |

---

## 5. Empirical Browser Test Execution

Tests were executed against the live build served via `tests/browser/admin-web/harness.ts`:

```text
Running 9 tests using 1 worker
  ok 1 CFGADM-08 identity user and OIDC metadata surface › create, read back, update role, and render safe OIDC metadata (1.3s)
  ok 2 CFGADM-08 identity user and OIDC metadata surface › shows explicit empty OIDC metadata state (923ms)
  ok 3 CFGADM-08 identity user and OIDC metadata surface › fails closed when the server has no user writer (930ms)
  ok 4 CFGADM-UI-PORT-P1 Settings port (real browser) › 1. three CFGADM groups render with all 17 legacy keys (1.0s)
  ok 5 CFGADM-UI-PORT-P1 Settings port (real browser) › 2. every write control is disabled with an honest reason (1.2s)
  ok 6 CFGADM-UI-PORT-P1 Settings port (real browser) › 3. secrets are labelled and no credential value reaches the DOM (967ms)
  ok 7 CFGADM-UI-PORT-P1 Settings port (real browser) › 4. the retire row is a decision, not a write target (881ms)
  ok 8 CFGADM-UI-PORT-P1 Settings port (real browser) › 5. 320px: the settings surface reflows without horizontal overflow (1.4s)
  ok 9 CFGADM-UI-PORT-P1 Settings port (real browser) › 6. keyboard: Tab reaches a control with a visible focus ring (886ms)
  9 passed (10.2s)
```

Additional verification script executed for Workflows & Docs:
- `uirev-workflows-disabled.png` (33.8 kB) — Banner and empty preview verified.
- `uirev-docs-catalog.png` (73.9 kB) — 13 endpoints verified.
- `uirev-docs-workbench.png` (112.9 kB) — Workbench modal verified; CSRF omission captured.
- `uirev-docs-320px.png` (66.2 kB) — 320px responsive reflow verified.
- `uirev-workflows-320px.png` (31.1 kB) — 320px responsive reflow verified.

---

## 6. Conclusion & Action Items

- **Overall Wave Status:** 3 surfaces APPROVED (`/identity`, `/workflows`, `/settings`); 1 surface REQUIRES CHANGES (`/docs`).
- **Remediation Item:** Owner of CFGADM-UI-PORT-P3 (`dsh_2`) should update `apps/admin-web/src/features/docs/docs-screen.tsx` to bootstrap the session via `client.getSession()` so `X-CSRF-Token` is properly attached to workbench mutations.
