# Receipt — Codex Wave 3, W1 (Finding 2)

| Field | Value |
|---|---|
| Packet | `FOLLOWUP-CODEX-WAVE3-W1` (P2) |
| Worker | `dsh_1` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** (`CODEX_WAVE3_W1_COMPLETE`) — tsc 0, 5 suites / 69 tests passed, 31/31 on pc-r05 suite |
| Files changed | `src/modules/connectors/provider-test.ts`, `src/modules/connectors/probe-authorization.ts`, `tests/pc-r05-connector-probe-root-grant.test.ts` |

## Finding 2 — Lock Order & Root Grant Admission in Provider Test

### Changes Made
1. **Universal Lock Order Invariant in `provider-test.ts`**:
   - `reserveProviderTestRun`: Updated `lockProviderTestAuthority` and reservation lock acquisition to strictly follow the canonical lock order:
     `root (FOR SHARE) -> key row -> grant row`
   - Preflight determines if a root is involved without holding locks, followed by root lock acquisition before key lock, preventing deadlocks against concurrent key revocations.
2. **Root Grant Resolution**:
   - For `GROUP_MANAGED` keys, admission resolves root grants via `profile_group_root_grants` rather than assuming `profile_action_key_grants`.
   - Converted keys during reservation encounter `409 ADMISSION_CHANGED` (fail-closed, retryable).
3. **Comprehensive Test Suite**:
   - `tests/pc-r05-connector-probe-root-grant.test.ts` updated with 31/31 passing tests covering:
     * Canonical order `preflight -> root -> key -> grant -> rate -> runInsert`
     * Active grant requirement before rate/run locks
     * Missing/revoked grant rejection
     * Mode flip fences and legacy key behavior

## Verification
- `node node_modules/typescript/bin/tsc --noEmit` -> **exit 0**
- `tests/pc-r05-connector-probe-root-grant.test.ts` -> **31/31 passed**
- Adjacent test suites:
  * `plat-mig-02-probe-authorization.test.ts`
  * `profile-api-keys-membership-offline.test.ts`
  * `provider-test-content.test.ts`
  * `provider-test-role.test.ts`
  * Total: **5 suites / 69 tests passed**
