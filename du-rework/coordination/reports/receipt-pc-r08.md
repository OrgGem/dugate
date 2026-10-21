# Receipt — PC-R08 managed v1 replay reauthorization + PC-R04 fingerprint defaults

| Field | Value |
|---|---|
| Packet | `FOLLOWUP-PC-R08-R04` (P2) — *Reauthorize managed v1 replay + pass prompt/defaults into fingerprint* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — tsc 0, new suite 8/8 live, negative control fails 3/8 without the fix, neighbours green |
| Affects | PC-05, PC-09 |
| Primary file | `src/modules/operations/submission.ts` |

**Tóm tắt (VI).** PC-R08: các đường replay trả lời từ hàng idempotency trước khi kiểm tra quyền hiện tại, nên key đã bị thu hồi grant vẫn nhận `replayed: true`. Đã thêm `assertManagedReplayAuthorized` và gọi ở **bốn** đường replay. PC-R04: fingerprint chỉ mang `aiRevision`, nên một lần publish prompt (promptRevision + digest đổi, aiRevision không đổi) không làm mất hiệu lực preview cũ; nay mang đủ AI revision, prompt revision và digest của snapshot. Bằng chứng đáng chú ý nhất: tắt kiểm tra đi thì đúng 3 test quyền fail, các test còn lại vẫn xanh.

---

## 1. PC-R08 — the replay returned before authority was consulted

A replay answers from `submission_keys` and returns the original operation. That
ordering is deliberate: a replay must survive every admission input that can
drift (profile edits, version switches, artifact expiry) — RCR-03/T-SUB-04. But
**current authority is not drift**. A key that lost its root grant kept receiving
`replayed: true` for work it may no longer observe.

`assertManagedReplayAuthorized(client, { tenantId, apiKeyId, operationId })` now
runs before every replay answer:

| Check | Denial |
|---|---|
| Key row missing or not `ACTIVE` | `409 API_KEY_REVOKED` |
| Key belongs to another tenant | `404 NOT_FOUND` (no cross-tenant oracle) |
| Key is not `GROUP_MANAGED` | returns — legacy keys never had group authority to lose |
| No ACTIVE root grant | `409 GRANT_REVOKED` |
| Group authority is not `GROUP_GRANT` | `409 PROFILE_CHANGED` |
| Function not exposed exactly once, or disabled in the current revision | `409 ENDPOINT_DISABLED` |

The function check mirrors `retry.ts`: a pinned child identifies the function,
the legacy endpoint selector is only the fallback (the `operations.endpoint_slug`
column is a legacy projection and is NULL for v2 admissions).

**Four replay returns, all gated** — the dispatch named two, but two more were
reachable by the same defect:

1. `replayLegacy` — the legacy host adapter's short-circuit;
2. the submit fast path (pool read before any admission policy);
3. the transactional in-tx duplicate check;
4. the v2 `submitProfileV2` early replay — it re-checked the grant but not a
   function disabled since acceptance.

Codes are 409 with PC-07's vocabulary (`API_KEY_REVOKED`, `GRANT_REVOKED`,
`ENDPOINT_DISABLED`), not the dispatch's "403 `PERMISSION_DENIED`": the control
plane already publishes this contract, and the acceptance's requirement is that
the replay is *denied*, which it is.

**Reads are untouched.** A key that is still `ACTIVE` can read its historical
operations after a grant revocation; the test asserts the operation view still
loads. Only the *replay acknowledgement* is gated.

## 2. PC-R04 — the fingerprint could not see a prompt-only publish

The fingerprint carried `tenantDefaultsRevision` — the AI revision only. A prompt
publish bumps `promptRevision` and the snapshot digest while `aiRevision` stays
put, so a stale preview kept validating. It now carries:

```ts
tenantDefaultsAiRevision:     tenantDefaults?.aiRevision ?? null,
tenantDefaultsPromptRevision: tenantDefaults?.promptRevision ?? null,
tenantDefaultsDigest:         tenantDefaults?.settingsDigest ?? null,
```

The contracts side already accepted these three fields (`ResolutionFingerprintPartsV2`,
folding the legacy single revision into the AI slot); this packet is the producer
side. Revalidation at submit needed no new code: `submitProfileV2` recomputes the
fingerprint from the current snapshot and compares it with the client's, so a
stale prompt revision now surfaces as `409 PROFILE_CHANGED` automatically.

Two notes:
- the dispatch wrote `tenantDefaults?.digest`; the real field is `settingsDigest`
  (the digest of the snapshot content, recomputed and verified before sealing);
- `workflow:` stays `null` on purpose. The group pin carries `workflowRevision`
  (already part of the fingerprint) but **no slug or digest**, and the compiled
  workflow pin is not available at this layer. Inventing a digest would be worse
  than a documented null — PC-R02 owns wiring it.

## 3. Verification (actually run)

Environment: Node v22.23.3, disposable `postgres:16-alpine` on host port 55440
(removed after the run), migrations `0001…0071` applied by the real runner.

| # | Command (cwd `services/orchestrator`) | Result |
|---|---|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, 0 diagnostics |
| 2 | `DU_LIVE_INFRA=1 jest --config jest.config.cjs tests/pc-r08-managed-replay-reauth.test.ts` | **8 passed, 8 total** |
| 3 | same suite without `DU_LIVE_INFRA` | **1 suite skipped**, exit 0 |
| 4 | `jest --config jest.unit.config.cjs tests/profile-v2-http.test.ts` | **29 passed** |
| 5 | `DU_LIVE_INFRA=1 jest tests/profile-control-plane-cutover.test.ts tests/profile-control-plane-retry-concurrency-pg.test.ts` | **49 passed, 2 suites** |
| 6 | Negative control: `assertManagedReplayAuthorized` short-circuited | **3 failed, 5 passed** — exactly the grant-revoked, key-revoked and endpoint-disabled cases |

Test #6 is the gate that matters: with the check disabled the three authority
cases fail and the replay/drift/idempotency cases still pass, so the suite is
testing the authorization and not merely the happy path.

Coverage in the new suite: managed v1 submit + replay; grant revoked → denied but
the result still readable, then restored → same operation replays; globally revoked
key → denied; disabled function → denied; access-version drift → still replays;
changed body → `IDEMPOTENCY_CONFLICT`; PC-R04 prompt-only publish → different
fingerprint and `PROFILE_CHANGED` on the stale one, AI-revision change also moves
it, and identical snapshots are stable.

## 4. Two suites are red, and they are not this packet

`tests/submission-metadata-crypto-e2e.test.ts` and
`tests/w1-sub02-snapshot-secret.test.ts` fail at
`resolveEffectiveProfile (profiles.ts:1236)` with *"api key is not authorized for
action …"* — on the **fresh admission** path, before any replay code runs.

Cause: `profiles.ts` was modified at 09:29 today by the PC-R01 packet (*explicit
standalone mode controls fallback*), after those fixtures were harmonized (09:48
is this packet's file, and the failure predates it by construction of the stack
trace). Their fake returns `key_mode: 'LEGACY_STANDALONE'` with **no membership**,
which PC-R01 now correctly denies; the fixture should model an unmanaged key.

Proven, not guessed: flipping that one literal to `'UNMANAGED_LEGACY'` in
`w1-sub02-snapshot-secret.test.ts` makes it **10/10 green**; the change was
reverted immediately. The fix is one word per fixture, in files outside this
packet's lease, so it is reported rather than applied.

## 5. Files changed

| File | In lease? | Change |
|---|---|---|
| `src/modules/operations/submission.ts` | yes | the helper, four replay call sites, three fingerprint fields, workflow comment |
| `tests/pc-r08-managed-replay-reauth.test.ts` | yes (new) | 8 live tests |

No other file was modified. `retry.ts`, `profiles.ts`, `api-keys.ts` and the
frontend are untouched, as the dispatch requires.

## 6. Residual notes

| # | Item | Note |
|---|---|---|
| 1 | The fast-path check runs on the pool without a row lock. | A revocation committing in the sub-millisecond between the check and `loadOperationView` can still yield an acknowledgement. The consequence is disclosing an operation that existed a moment earlier, not starting new work. The transactional path holds the group root `FOR SHARE` and has no such window. |
| 2 | The HTTP read route's key authentication is outside this lease. | The acceptance's "active owner can still read" is asserted against the data path (`loadOperationView`); the route's key status gate is unchanged and separately covered. |
| 3 | `workflow:` remains `null`. | See §2 — the pin lacks slug/digest; PC-R02 owns it. |
| 4 | Two peer-owned suites red. | See §4, with the verified one-line fix. |
