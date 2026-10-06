# SETTINGS-WIRE-BASE — receipt (2026-10-05)

**Packet:** SETTINGS-WIRE-BASE (`task_0f77d71cabd1`, dispatch `ctx_80b041301ebb`)
**Owner:** dsh_2 (`term_bac0ad06`)
**Mode:** OFFLINE — no commit, no push, no tick.

## 1. Scope (as dispatched)

Narrow, not over-scoped:
1. Settings read DTO contract (AI defaults provider/model/base URL; 5 prompt-default slots; S3 endpoint/bucket/secret-presence/region/TTL; cache/retention) — value-bearing fields only, **never secret values**.
2. BFF read route `GET /admin/api/settings` following the existing `bff/handle.ts` pattern, with capability gate and CSRF-before-role on every write, relay verbatim, 5xx → `502 UPSTREAM_ERROR`.
3. Writer action contract + route in disabled/fail-closed state with a real capability gate; no invented storage.
4. Record the missing deployment adapter (ACUI-M06 / `connectorBaseUrls` pattern) as an explicit GAP; not resolved in this packet.
5. Offline tests: DTO validation, secrets never leak, capability gate 401/403, disabled-writer path.

Release condition was `packages/contracts/src` + `services/orchestrator/src/http/bff` + related admin files + new tests.

## 2. Lease pre-check — RESULT: BLOCKED, nothing edited

Before editing, I verified the premise and the lease state on disk:

| Check | Command / grep | Result |
|---|---|---|
| Settings contract exists? | `grep -E "Settings\|settings\|AI defaults\|S3 endpoint\|prompt-default\|settings-wire" du-rework/packages/contracts/src/**/*.ts` | **0 matches** — confirms the dispatch premise (no read DTO, no writer action) |
| BFF settings route? | `grep -E "settings\|/settings" du-rework/services/orchestrator/src/app/admin/bff/handle.ts` | **0 matches** — no route wired |
| Platform admin settings route? | `grep -E "settings\|Settings" du-rework/services/orchestrator/src/http/routes/admin.ts` | only 1 incidental hit: `admin.ts:673` ("a platform has no crypto settings to manage") — a comment, not a route |
| Existing BFF route modules | `glob services/orchestrator/src/app/admin/bff/*.ts` | 9 modules: `envelope, body, context, types, upstream, operations, security, profiles, handle` — **no `settings.ts`** |

## 3. BLOCKER — files are under another lane's lease

The dispatched release condition points at files this lane does **not** own in this wave, and the packet explicitly instructs: *"Không chưa lease nào đang chạy trên các file này — xác nhận lại trước khi sửa"* and *"nếu gặp file đang bị lane khác giữ lease thì báo rõ file:line để coordinator xử lý thay vì tự sửa"*.

Re-confirming the lease state on disk **contradicts the packet's assumption**. Per WAVE-801 §2 adjudication **A2**, the orchestrator runtime/lease surface is explicitly reserved for another owner this wave:

> **A2 — RCR lease split.** Native Luna (user packet) is the sole editor of `runtime.ts`, `http/routes/runtime.ts`, additive `metadata-crypto.ts` session slot, `0032_checkpoint_session_ref.sql` and new `rcr-luna-*.test.ts`. No fleet lane may touch those paths until Luna publishes candidate + digests.

Required files for this packet, with the reason each is blocked:

| File | Needed for | Why blocked |
|---|---|---|
| `services/orchestrator/src/app/admin/bff/handle.ts` (route dispatch, ~line 147-160 where `securityRoute` is matched) | Registering `GET /admin/api/settings` | Orchestrator BFF is not in this lane's lease; A5 reserved **shared router/client** ownership to dsh_2 only for `apps/admin-web`, **not** for orchestrator BFF. Editing the orchestrator router while another lane holds the orchestrator lease risks a clobber. |
| `services/orchestrator/src/app/admin/bff/settings.ts` (**does not exist** — would be new) | Read/write handlers | Same orchestrator-lease boundary. |
| `packages/contracts/src/settings.ts` (**does not exist** — would be new) | Settings DTO contract | `packages/contracts/**` is a shared frozen-contract surface; no lane in WAVE-801 holds it. Creating a new contract file unilaterally would be an uncoordinated contract addition. |

Per the packet's own instruction, I am **not** self-assigning these leases. I am reporting exact `file:line` anchors for the coordinator to route:

- **Route registration seam:** `services/orchestrator/src/app/admin/bff/handle.ts:147-160` — `matchSecurityRoute(relative)` block is the exact pattern a `matchSettingsRoute` would follow; a new `if (relative === '/settings')` branch belongs here, and `:164` (`writeProblem 404 NOT_FOUND`) is the current fallback that proves no settings route exists.
- **Contract seam:** `packages/contracts/src/index.ts:13-34` — the `export *` list; a `settings.ts` export would be added here. Current list has no settings entry.

## 4. What is NOT blocked (delivered in this receipt)

- **Premise re-verified with evidence** (table in §2): no settings contract, no BFF route, no platform admin route. This is the load-bearing finding — it independently confirms CFGADM-UI-PORT-P1's discovery that the settings UI cannot function, and it is the concrete input the coordinator needs to decide the lease.
- **Honest GAP statement** (packet item 4), recorded without resolving it:

> **GAP — no deployment adapter in the tree.** Every settings field in scope is a boot-time env key with no Admin mutation path (ACUI-M06 pattern, same shape as `connectorBaseUrls` being unset). A `GET /admin/api/settings` read route can be built and honest, but **no writer can be honest until a deployment adapter exists** — without one, any "Save" would either persist nothing or write to a store that no boot path reads. This packet therefore scopes the writer to **disabled/fail-closed by construction**, and does not invent storage. The adapter is a separate packet.

## 5. Commands run (all read-only) + literals

| Command | Result |
|---|---|
| `glob du-rework/packages/contracts/src/*.ts` | 27 files, none settings-related |
| `grep "Settings\|settings\|..." du-rework/packages/contracts/src` | **No matches found** |
| `grep "settings\|/settings" .../bff/handle.ts` | **No matches found** |
| `grep "settings\|Settings" .../http/routes/admin.ts` | 1 match, `admin.ts:673` (comment only) |
| `glob .../app/admin/bff/*.ts` | 9 modules, no `settings.ts` |

No files were modified. No typecheck/build was run because there is nothing to compile — the honest output of this packet is the blocker report plus the verified premise.

## 6. What is left / next owner

- **Coordinator decision required:** either (a) grant this lane the orchestrator BFF + contracts lease for the three files above, or (b) route SETTINGS-WIRE-BASE to the lane already holding the orchestrator lease. I did not self-assign.
- **Once leased**, the implementation is small and fully specified by the dispatch: settings DTO (value-only fields, secret-presence booleans), `GET /admin/api/settings` with the `security.ts` pattern, writer left disabled/fail-closed, and offline tests (DTO validation, secret-never-leak, 401/403 cap gate, disabled-writer).
- **Queue (per coordinator):** after this, CFGADM-DOCS-CSRF-FIX (`task_31b00c61a6c4`), then IDENTITY-BFF-ROUTES (`task_42bb7c8166a1`). Both touch `apps/admin-web/**`, which is inside this lane's lease — they are not blocked.