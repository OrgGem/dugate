# P745-UI-KEYS-JOURNEY - receipt (real browser journey for the profiles write flow)

> **RESUME POINT (qwen_5, 2026-10-05 01:5x)** - packet UI-KEYS-JOURNEY-PW, run run_069ecd6957cd.
> Status: **journey proven in a real browser, x3, plus a full-suite regression run.** Test only:
> no production source touched. No commit/push. Live DB seed is an explicit GAP (section 5).

---

## 1. What was built

New spec: `tests/browser/admin-web/p745-ui-keys-journey.spec.ts`
(1 case, full journey). It reuses the runner-confirmed infra already in the directory
(`playwright.config.ts` + `harness.ts`); no runner, no dependency, no lockfile change.

Journey: Open Profiles -> Load stored profile (doc-core, fixture mode) -> edit `value ai_model` ->
**Save extract** (upsert) -> **Publish** -> **Rollback to v8**. Asserts the UI states at every step
AND the exact dispatcher wire bodies.

## 2. Harness change (test infra only, additive) - needed to observe the wire

- `CapturedWrite` interface + `writes[]` capture; every action POST now records `{action, params}`;
  new read-only endpoint `/__stub/writes`; cleared on `/__stub/mode?reset=1`.
  Existing `/__stub/requests` shape is UNCHANGED, so `overview.spec.ts` and
  `operations-business.spec.ts` (the two specs that read it) are unaffected.
- The fixture-mode profile detail now carries `apiKeyId: aaaaaaaa-1111-4111-8111-111111111111`,
  so the detail read reveals the write identity that `buildUpsertBody` / `buildPublishBody` /
  `buildRollbackBody` map onto the bodies (this is the "upsert with apiKeyId from detail" the
  packet asks for). Placeholder mode deliberately still omits it - that keeps the honest-absence
  path (`/new`, unstored profile -> no `apiKey` key in the body) alive, as `command-bodies.ts` requires.

## 3. Wire bodies asserted (from /__stub/writes)

| Step | action | asserted params |
|---|---|---|
| Save | profile.upsert | `expectedRevision: 7`, `apiKey: {apiKeyId: aaaa...1111}`, policy JSON contains the edited `gpt-4o-mini` |
| Publish | profile.publish | `expectedRevision: 8`, `apiKey: {apiKeyId: aaaa...1111}` |
| Rollback | profile.rollback | `targetRevision: 8`, `expectedRevision: 9`, `apiKey: {apiKeyId: aaaa...1111}` |

`writes.map(action)` asserted to equal exactly `[profile.upsert, profile.publish, profile.rollback]` - no
extra action rides the journey. `apiKey` equality is the load-bearing assertion: without an `apiKeyId` on
the detail, `buildUpsertBody` omits the key entirely and the bodies would be missing it.

## 4. Literal runs

Journey spec alone (Playwright, real Chromium, harness seam):
```
  1 passed (2.8s)   exit 0      (attempt 1)
  1 passed (2.3s)   exit 0      (attempt 2)
  1 passed (2.4s)   exit 0      (attempt 3)
```

Full admin-web suite (regression proof for the harness change):
```
Running 94 tests using 1 worker
  89 passed (52.7s)   5 skipped
  5 skipped = live-admin-web.spec.ts (AWEB-08, live-gated; correctly skipped, not a failure)
  exit 0
```

`profiles.spec.ts` is 9/9 green with the fixture `apiKeyId` added - so the harness edit did not
perturb the AWEB-04 evidence. `p745-ui-keys.spec.ts` (other lane) also 8/8 green.

## 5. GAP - live DB seed (explicit, per packet)

This journey runs against the harness stub, NOT a live stack. The live leg - real Postgres rows for a
profile revision + real Vault/credential state - is NOT part of this packet and was NOT run. The wire
bodies above are what the SCREEN sent to the dispatcher seam; they are not proof the platform accepted
or persisted them against a real DB.

## 6. Evidence

| File | Bytes |
|---|---:|
| coordination/evidence/p745-ui-keys-journey/p745-ui-keys-journey/745-01-saved-revision-8.png | 138,683 |
| coordination/evidence/p745-ui-keys-journey/p745-ui-keys-journey/745-02-published-revision-9.png | 134,505 |
| coordination/evidence/p745-ui-keys-journey/p745-ui-keys-journey/745-03-rolled-back-revision-8.png | 135,329 |

PNG sizes are 134-139 kB (a blank solid screenshot compresses far smaller). The DOM + wire-body
assertions are the load-bearing proof, not the images.

## 7. Ledger

- UI-KEYS-JOURNEY-PW - Muc 1 - real browser profiles journey (edit -> save/upsert -> publish -> rollback)
  with wire-body assertions; 3 consecutive green runs, 1/1 passed each, exit 0; harness extended additively
  (`/__stub/writes` + fixture `apiKeyId`) and full-suite regression run 89 passed / 5 skipped, exit 0;
  3 PNGs + harness.json under coordination/evidence/p745-ui-keys-journey/; live DB seed recorded as GAP;
  no production source touched; no commit.
