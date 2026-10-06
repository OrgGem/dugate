# CFGADM-DOCS-CSRF-FIX — receipt (2026-10-05)

**Packet:** CFGADM-DOCS-CSRF-FIX (`task_31b00c61a6c4`, dispatch `ctx_f3ae443d0e9c`)
**Owner:** dsh_2 (`term_bac0ad06`) — sole editor of `apps/admin-web` client/router per A5
**Mode:** OFFLINE — no commit, no push, no tick. No DB/Redis/S3.
**Precondition satisfied:** SETTINGS-WIRE-BASE receipt written first (`coordination/reports/settings-wire-base-2026-10-05.md`).

## 1. The defect (confirmed, not assumed)

`docs-screen.tsx` POSTs `POST /admin/api/profiles/test-endpoint`. The client's CSRF proof is **only** learned from `getSession()`:

- `apps/admin-web/src/lib/api/client.ts:146` — `let csrfToken: string | null = null;`
- `client.ts:156` — `if (init.csrf === true && csrfToken !== null) headers['x-csrf-token'] = csrfToken;`
- `client.ts:221-223` — `getSession()` is the **only** writer of `csrfToken`.

`docs-screen.tsx` never called `getSession()`, so `csrfToken` stayed `null`, the header was **silently omitted** (`&& csrfToken !== null` fails open on the header, it does not error), and the BFF answered `403 CSRF_REJECTED`. The `/docs` Test Workbench user path was dead — exactly the same class of defect I fixed in `connectors-screen.tsx` under Packet A.

Note the fail-open shape: `client.ts:156` drops the header instead of erroring, so a screen that forgets the bootstrap produces a confusing 403 rather than a clear local failure. This is why the screen-level gate below matters.

## 2. The fix — session bootstrap + fail-closed, using the UI_APPROVED identity pattern

**File modified (only file changed):** `apps/admin-web/src/features/docs/docs-screen.tsx`

Reference pattern copied from `apps/admin-web/src/features/identity/identity-screen.tsx:45-63` (UI_APPROVED) — a `SessionState` discriminated union of `loading | ready | failed`, populated by a `getSession()` call in a `useEffect` with an `active` unmount guard.

Changes:

1. **`SessionState` union + bootstrap effect** — `docs-screen.tsx:16-22` (type + comment), `:43-55` (effect). Calls `client.getSession()` on mount, with the same `let active = true` / cleanup guard as the identity screen.

2. **Capability + fail-closed gate** — `docs-screen.tsx:57-68`. The workbench POST is a write, so it requires **both**:
   - a **proven session** (`kind === 'ready'`) — this is what supplies the CSRF proof, and
   - a **permitted role**: `role === 'admin' || role === 'operator'`.
   
   `testUnavailableReason` produces a specific, honest reason per state (loading / session failed / role not permitted).

3. **Rendered disabled-with-reason states** — `docs-screen.tsx:165-176` (catalog card: `LoadingState` while bootstrapping + `AlertBanner` for the failure/reason) and `:198-207` (inside the modal, so the reason is visible where the action is). The endpoint catalog is **preserved unchanged** — still all 13 entries, still rendered during and after every state.

4. **Run button disabled + handler guard** — `docs-screen.tsx:189` (`disabled={busy || !canRunTest}`) and `:96-107` (guard inside `runTestEndpoint` that refuses before spending a round trip, reusing the real session problem's status/code rather than inventing one). This is belt-and-braces: even if the button state were bypassed, the handler refuses.

## 3. Audit of every other request path (packet asked: "not just this POST")

I re-checked **all** POST/mutation paths rather than assuming this was the only one.

Every write in the client passes `csrf: true`: `client.ts:207, 281, 290, 299, 306, 329, 340`. So the invariant is *"any screen that writes must have called `getSession()` first"*.

| Screen that can write | Calls `getSession()`? | Line |
|---|---|---|
| identity | yes | `identity-screen.tsx:48` |
| security | yes | `security-screen.tsx:38` |
| profiles | yes | `profiles-screen.tsx:97` |
| **docs** | **yes (this fix)** | `docs-screen.tsx:48` |
| overview | yes | `overview-screen.tsx:44` |
| api-keys | yes | `api-keys-screen.tsx:46` |
| connectors | yes | `connectors-screen.tsx:125` |
| businesses | yes | `businesses-screen.tsx:40` |
| workflows | n/a — route is DISABLED with an honest reason (Packet B, Δ-DEV-03 user-gated), reads and mutates nothing | — |

**`docs` was the only screen in the tree that wrote without bootstrapping the session.** No other write path is affected. `workflows` is disabled so it has no write path to protect.

## 4. Verification

| Command | cwd | Result |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | `apps/admin-web` | **exit 0, no output** |
| `npx vite build --mode production` | `apps/admin-web` | **✓ built in 7.84s** |

**Build digest (this is the review basis — it supersedes Packet B's stale digest):**

| Asset | SHA-256 (first 16) | Size |
|---|---|---|
| `dist/assets/index-BZ2-Edjb.js` | `2296c26628f4a454` | 500.90 kB / gzip 155.02 kB |
| `dist/assets/index-BffJF1YL.css` | `baf331d4ea62f327` | 41.30 kB / gzip 8.14 kB |

> Note for Antigravity re-review: Packet B shipped `index-Bs0p8VRI.js` / `8ccdbab15d44cca1`. That digest is now **STALE**. The `/docs` change is only reviewable on `index-BZ2-Edjb.js` / `2296c26628f4a454`. The CSS hash is unchanged (`baf331d4ea62f327`), consistent with a logic-only change.

Build notes (honest, not regressions): the chunk-size warning (>500 kB) is pre-existing and non-blocking; the PowerShell `NativeCommandError` noise is the wrapper's stderr stream, not a build failure — exit was 0 and assets were emitted.

Two intermediate errors were found and fixed in-turn (both honest, neither hidden):
- `TS6133 'LoadingState' is declared but never read` and `TS6133 'testUnavailableReason' … never read` — I had added the gate before wiring it into JSX. Fixed by rendering them.
- `TS2322 Property 'label' does not exist on type LoadingStateProps` — the component's prop is `title`, not `label` (`state-panel.tsx:17-21`). Fixed.

Also: no `any` introduced (repo is TS strict); `testProblem` remains typed `AdminApiProblem | null`.

**Not run in this packet:** browser evidence. The Playwright suite has no `/docs` case, and adding one is out of the stated lease (`features/docs/**` + minimally related files). Recording this honestly — see §6.

## 5. Write-set + digest

| File | Change | SHA-256 (first 16) | Lines |
|---|---|---|---|
| `apps/admin-web/src/features/docs/docs-screen.tsx` | MODIFIED — session bootstrap + fail-closed gate | `f5e2f3a8be6503b9` | 259 |

No route, no other feature, no router, no client, no harness touched. Confirmed against `features/index.ts` (2 exports, untouched) and the router (untouched).

## 6. What is left / honest gaps

- **No browser evidence in this packet.** `npx tsc` and `vite build` are green, but CFGADM-DOCS-CSRF-FIX did not run a Playwright case for `/docs` — the suite has no `/docs` case and adding one is outside the stated lease (`features/docs/**` + minimally related files). Per *offline ≠ live gate*, the UI row should stay open until a browser shot exists on build `index-BZ2-Edjb.js`. Recommend the coordinator fold this into the next `/docs` browser pass.
- **Suggested hardening, NOT done here (out of lease):** `client.ts:156` silently drops `x-csrf-token` when `csrfToken === null`. A stricter client would refuse a `csrf: true` request when no proof was ever learned, converting a confusing server 403 into an immediate local error. `lib/api/client.ts` is shared across every screen, so it is outside this packet's stated lease — flagged for the client owner rather than edited unilaterally.
- **Next task in the queue:** BFF-SETTINGS-IDENTITY (`task_6fa1b100409c`), lease A7 — `app/admin/bff/settings.ts` + new `identity.ts`, route registration at `handle.ts:147-160`, and settings/identity contracts in `packages/contracts/src` + the index export. That lease resolves the SETTINGS-WIRE-BASE blocker recorded in `settings-wire-base-2026-10-05.md` §3.