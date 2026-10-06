# F-VFY6-01 closure receipt — profile cipher boot refusal (D-BOOT-01) — 2026-10-06

- **Packet:** F-VFY6-01 implementation (dispatch packet 3), authorized by Claude Reviewer
  `coordination/reports/claude-audit-review-r4-2026-10-06.md:323-337` (§12.2), spec
  `coordination/reports/spec-f-vfy6-01-boot-policy-2026-10-06.md`.
- **Owner:** oc_1 (Platform Crypto & Boot Integrator). **Constraints honored:** no commit, no push, no tick; edits only
  to the four authorized items.
- **Status:** IMPLEMENTED with offline evidence (typecheck + 7-case matrix + main-harness integration green).
  **F-VFY6-01 stays OPEN** until the r4.1 candidate-level matrix (§4.3 of the spec) runs and an independent review
  accepts it — per §12.2 that evidence, not this receipt, closes the finding.

## 1. Changes (approved scope only)

| # | File | Change | Refs | SHA-256 |
|---|---|---|---|---|
| 1 | `services/orchestrator/src/modules/encryption/boot-options.ts` | `EncryptionPolicySummary.profileCipherKeyPresent` (presence-only) + compute in `summarizeEncryptionPolicy` + new `assertProfileCipherBootPolicy` (single-source `dataMode` from the summary; Q1 NODE_ENV-only; Q2 staging refuses; Q6 approved text via `EncryptionBootConfigError`) | interface `:467`, summary `:489`, predicate `:511` | `49D7B941AE6E1C63ABB692F6BD20E510617818E835C9A017629C84D8AE970BB3` |
| 2 | `services/orchestrator/src/main.ts` | import + call at the **old warn site** (Q5), before `createApp`; warn block below now runs only for dev/test, synthetic, or seam-off keyless boots | import `:23`, call `:274` | `798065CD1A474277E2C1396E66535721A322A400A71ED21A5047A710FCADC5F3` |
| 3 | `/health` (Q3) | **No server.ts edit needed**: `profileCipherKeyPresent` flows through the existing content-free spread `body.encryption = { …encryptionPolicy, secretResolver }` (`server.ts:361-364`); asserted by the wiring test | `server.ts:361-364` (untouched) | tree state owned by other lanes (`4FC40290…`), block verified intact |
| 4 | Tests | 7-case unit matrix + presence-only summary test (`tests/encryption-boot-options.test.ts`); 4 `main()` integration cases via the real predicate (`tests/v1-boot-typed-denial.test.ts`); summary literals/health expectation updated (`tests/sec-enc-05-boot-wiring.test.ts`) | — | boot-options `061D8A87A245DC2C72BBA343E79BEED4EB40E1151B5ADA8CFEDAA3E155D6D1B7`; wiring `BC4118900496FE6C1F9E82FAE417E78438E1FF3486F5282A706F5A93E8D9C488`; v1-boot `1AEFA3A84A947E5D9B4883D1CBF55EB51B4BD93F6173AE73665B9E056EE7785C` |

Reviewer Q-mapping: **Q1** NODE_ENV-only (no new flag) — predicate reads `process.env.NODE_ENV`; **Q2** staging refuses
(only `development`/`test` bypass); **Q3** `profileCipherKeyPresent` presence-only in `/health`, value never serialized;
**Q4** write-path typing deliberately NOT touched (separate packet); **Q5** check sits at the old warn site;
**Q6** refusal text asserted character-for-character in unit case 1.

## 2. Evidence (real runs, cwd `du-rework`)

| Run | Command | Exit | Result | Raw |
|---|---|---|---|---|
| Typecheck | `pnpm --filter @du/orchestrator run typecheck` | **0** | clean | `raw/f-vfy6-01/typecheck-final.log` `8EA0CC23…` |
| Focused | `jest --runTestsByPath tests/encryption-boot-options.test.ts tests/sec-enc-05-boot-wiring.test.ts tests/v1-boot-typed-denial.test.ts --verbose` | **0** | **3 suites / 60 tests passed** | `raw/f-vfy6-01/focused-tests2.log` `ACFE7BDD…` |
| Per-suite | same three, individually | **0 / 0 / 0** | boot-options **46**, wiring **4**, v1-boot **10** | `count-encryption-boot-options.log` `584BBD7D…`, `count-sec-enc-05-boot-wiring.log` `3EEA5FCD…`, `count-v1-boot-typed-denial.log` `670EBC24…` |
| Regression | 23 boot/SEC-ENC/artifact/multipart suites (same battery as SEC-ENC-05) | **0** | **23 suites / 487 tests passed** (baseline 473 + 14 new) | `raw/f-vfy6-01/regression-23-suites.log` `3A296A7B…` |

First focused attempt failed on two integration-setup mistakes (helper scope in the new describe; the synthetic test
staged through `NODE_ENV=production`, tripping the unrelated `ORCHESTRATOR_INTERNAL_BASE_URL` production guard). Fixed
by defining the local fixture and staging the synthetic bypass on `staging`; failure history kept at
`raw/f-vfy6-01/focused-tests.log` `0C770E48…`.

### 2.1 Seven-case matrix (unit, `assertProfileCipherBootPolicy`)

| Case | Scenario | Expectation | Result |
|---|---|---|---|
| 1 | real + seam + `NODE_ENV=production` + no key | throws `EncryptionBootConfigError` with the approved text; sentinel env value absent from message | PASS |
| 2 | `NODE_ENV` unset, and `staging` | both refuse (fail-safe, no carve-out) | PASS |
| 3 | `NODE_ENV=development` / `test` | warn-only (no throw) | PASS |
| 4 | explicit synthetic mode, outside dev/test | warn-only (no throw) | PASS |
| 5 | `ENCRYPTION_KEY=''` + no `NEXTAUTH_SECRET` | empty counts as absent → refuses | PASS |
| 6 | only `ENCRYPTION_KEY`, or only `NEXTAUTH_SECRET` | boots | PASS |
| 7 | seam off + no key | never refuses (documented invariant) | PASS |

Plus: summary test proves `profileCipherKeyPresent` is `false/true` correctly and the key value never appears in the
serialized summary.

### 2.2 `main()` integration (real predicate through the boot harness)

| Test | Result |
|---|---|
| keyless real-data + seam + production → `main()` rejects (`refusing to boot: ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required`), `createApp` never called, zero warns | PASS |
| keyless real-data + seam + staging → rejects (Q2) | PASS |
| keyless real-data + seam + development → boots, exactly one `AUTH_DECRYPT_FAILED` warn | PASS |
| keyless synthetic + seam + staging → boots, synthetic warn + profile warn (2 warns) | PASS |
| existing keyless warn-only test (seam off) and key-present test | unchanged, PASS |

## 3. Scope compliance

- Edited only: `boot-options.ts`, `main.ts`, and the three test files above. `server.ts` was **not** modified by this
  packet (the health block gained the field automatically via the summary spread; verified in-tree).
- `server.ts`, `compose/orchestrator.yml`, EKS manifests, `docs/**`, `apps/**` untouched. Q4 (profile write-path typed
  denial) intentionally out of scope.

## 4. Open items (not closed by this receipt)

1. **Candidate-level matrix §4.3** on the tagged r4.1 image (keyless dev boot; keyless real-mode refusal; tampered-key
   typed `AUTH_DECRYPT_FAILED`; healthy path) — live gate, still open; §12.2 requires it plus independent review before
   the finding/rows move.
2. **Docs/traceability** listed in spec §5/§8 (`docs/41-persistence-encryption-policy.md` profile-cipher row,
   `docs/12b-deployment-guide.md:107` wording, `docs/28-test-inventory.md` / `docs/35-acceptance-baseline.md`) were not
   in this dispatch's four-item scope — flagged for the coordinator to schedule rather than edited unilaterally.
3. Compliance/health verification beyond the wiring test (live `/health` sample on r4.1) rides the same live gate.

No commit, no push, no task-row tick performed.
