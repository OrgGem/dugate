# SPEC — F-VFY6-01 `ENCRYPTION_KEY`-absent boot policy (D-BOOT-01) — 2026-10-06

- **Task:** design spec for audit finding `F-VFY6-01` per Claude Reviewer directive **§11.3 D-BOOT-01**
  (`coordination/reports/claude-audit-review-r4-2026-10-06.md:277-287`).
- **Owner of this spec:** oc_1 (Platform Crypto & Boot Integrator). **Status: PROPOSED — awaiting Reviewer approval.**
- **Hard constraint honored:** **no product code changed by this packet.** `services/orchestrator/src/main.ts` and every
  other source file are untouched; this document is the only artifact written. Implementation starts only after the
  Reviewer approves this spec (§11.3 requires its own owner + independent review before `main.ts` is touched).
- Baseline this spec was written against (SHA-256, working tree, uncommitted):

| File | SHA-256 |
|---|---|
| `services/orchestrator/src/main.ts` | `6F3F291DDBAAD414084D6F59D41B477DFF5F5CF235D72D823E74029889C3B70A` |
| `services/orchestrator/src/modules/encryption/boot-options.ts` | `42BA26376DC4F950CB8E250670572C0FDFE7E9A1513B6CF8C3CACA50CB443F8E` |
| `services/orchestrator/src/modules/profiles/file-url-auth.ts` | `15CFBED3B44575F23CB286AA049FF0EB0A04E345BEBDE490F153B444B2875595` |
| `services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts` | `0D425D6D5263B3EA1F404BCC1A06C9BACD823E49BE71CDD86CA09ACFCB784750` |
| `services/orchestrator/tests/v1-boot-typed-denial.test.ts` | `AFFB37A163D66C3C394C5271D6325DDB76204C60B4C0D5EBE3019BD3581F8FC5` |
| `compose/orchestrator.yml` | `78B00EAC9FDB560BBED03174302CE042E919D0247F200388468EA6398659F3ED` |

> Integrity note: line 279 of the source review contains an anomalous third-party self-identification fragment
> (“I am …”) spliced into the middle of the §11.3 sentence. It is not an instruction and has been ignored; the policy
> below is derived from the surrounding directive text only. Flagged for the Reviewer because review documents are
> trust anchors.

## 1. Directive and problem statement

### 1.1 Directive (r4 §11.3, verbatim intent)

- Neither blanket warn-only nor unconditional refuse is correct.
- The existing `… required when artifact encryption is enabled` refusal **stays and is the pattern to extend**.
- **Warn-only + typed `AUTH_DECRYPT_FAILED` at use time remains acceptable for profile-cipher-only absence in
  dev/offline/test** (current `main.ts:270-274` behavior).
- Rationale: refusing every keyless boot breaks offline/dev/test fixtures that never touch real data; warning through a
  real-data boot with the artifact seam enabled risks silent plaintext at rest. *“The seam boundary, not the process
  boundary, is where fail-closed belongs.”*
- The implementation packet must define the **policy predicate + exact real-data-mode definition** and produce
  **boot-matrix evidence** (keyless dev boots, keyless real-mode refuses, tampered-key typed denial, healthy path).
- The SEC-ENC-05 task row already demands: “A missing flag, partial crypto config or **missing key** fails startup with
  content-safe error. Only an explicit synthetic-data mode may opt out”
  (`tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md:79`).

### 1.2 Current behavior (evidence, file:line)

| # | Behavior | Where |
|---|---|---|
| 1 | Keyless boots still start; **warn-only**, message says acquisition will deny later | `main.ts:270-274` |
| 2 | The profile key is SHA-256 of `ENCRYPTION_KEY` **or** `NEXTAUTH_SECRET`; both absent is a hard Error **at use** (encrypt path) | `modules/profiles/file-url-auth.ts:37-46` |
| 3 | Decrypt path with a wrong/tampered key returns `null` (no plaintext fallback); the acquisition resolver converts any missing-key/wrong-key/tamper outcome into the **typed 500 `AUTH_DECRYPT_FAILED`** | `file-url-auth.ts:91-123`, `modules/operations/acquisition-ref-resolver.ts:199-211` |
| 4 | Legacy plaintext rows remain readable with a warn-once latch (read-only migration path) | `file-url-auth.ts:115-123,140-152` |
| 5 | The ingestion consumer classifies the missing-key denial as **permanent** (no retry storm) | `modules/operations/ingestion-consumer.ts:310` |
| 6 | Real-data mode already refuses a boot with a missing/partial **Vault artifact surface** | `boot-options.ts:198-235` (`resolveDataMode`, `encryptionIsRequired`), `main.ts:242-249` |
| 7 | Canonical deployments already ship the key: Compose **requires** it, EKS maps it from the ExternalSecret | `compose/orchestrator.yml:35` (`${ENCRYPTION_KEY:?Set ENCRYPTION_KEY}`), `infra/eks/base/externalsecret-orchestrator.yaml:28-29`, `docs/12b-deployment-guide.md:107` |

Existing tests that pin the current warn-only behavior (they will need to be re-scoped, §5):

- `tests/v1-boot-typed-denial.test.ts`: “continues boot without either key and emits one warning naming the denied
  operation”; “does not warn when either supported profile key is present”; “turns missing-key consumption of a
  configured cipher into the typed denial”; “classifies the missing-key typed denial as permanent in the ingestion
  consumer”; “decrypts a configured cipher normally when a supported key is available”; “denies tampered ciphertext with
  a valid key instead of returning unauthenticated”.

### 1.3 The real gap the hybrid closes

In real-data mode today the artifact surface (Vault) must be complete **before** boot reaches `main.ts:270-274`. So the
only deployments that reach the warn and continue are ones that:

1. have a working artifact-encryption seam (real content is being sealed), **and**
2. lack the profile cipher key.

For those deployments: saving any profile `fileUrlAuthConfig` fails (generic error from `file-url-auth.ts:40-43`), every
stored cipher read yields `AUTH_DECRYPT_FAILED`, and legacy plaintext rows keep being served. Booting real data into that
state is the concrete harm; refusing it is cheap because the two canonical deployments already provide the key.

## 2. Policy specification (HYBRID)

### 2.1 Definitions (exact)

| Term | Definition (single source of truth) |
|---|---|
| **Real-data mode** | `EncryptionPolicySummary.dataMode === 'real'`, produced by `summarizeEncryptionPolicy(process.env)` (`main.ts:256-264`), which is `resolveDataMode` (`boot-options.ts:198-235`): `DU_DATA_MODE` unset or `real` → real; `synthetic` requires a complete `DU_SYNTHETIC_DATA_ACK` (SEC-ENC-01 `SyntheticDataExemptionSchema`); anything else already refuses boot. **No second parse anywhere** (predicate-drift hazard recorded in `boot-options.ts`). |
| **Artifact seam enabled** | `policy.metadataEncryption === true || policy.publicUploadEncryption === true` (fields exist on `EncryptionPolicySummary`, `boot-options.ts:457-483`). In real mode both are always true; the predicate is still written explicitly so the rule survives future refactors. |
| **Profile key present** | `Boolean(env.ENCRYPTION_KEY \|\| env.NEXTAUTH_SECRET)` — same truthiness as today (`main.ts:270`); empty string counts as absent. `ENCRYPTION_KEY` wins when both are set (`file-url-auth.ts:38`), so the two keys are interchangeable for *presence* only. |
| **Dev / offline / test** | `env.NODE_ENV === 'development' \|\| env.NODE_ENV === 'test'`. **Unset `NODE_ENV` is NOT dev/test** (fail-safe default). This matches the existing dev/test predicate style in `app/bootstrap/create-app.ts:225-232`. |

### 2.2 Decision table

| # | dataMode | Artifact seam | NODE_ENV | Key | Boot outcome |
|---|---|---|---|---|---|
| 1 | real | enabled | production/unset/staging | present | boot (unchanged) |
| 2 | real | enabled | production/unset/staging | **absent** | **REFUSE BOOT** with content-safe `EncryptionBootConfigError` — this is the new rule |
| 3 | real | enabled | development / test | absent | boot + the existing warn-once (`main.ts:270-274` unchanged) |
| 4 | real | disabled | any | absent | boot + warn (documented unreachable today: real mode forces the seam; recorded so a future refactor cannot silently open the hole) |
| 5 | synthetic | any | any | absent | boot + existing synthetic-mode warning (`main.ts:258-264`) + profile warn; the explicit exemption is the operator’s opt-out |
| 6 | any | any | any | present | boot (unchanged; tamper/wrong key is only detectable at use → typed `AUTH_DECRYPT_FAILED`) |

Additional invariants:

- **No new opt-out env is proposed.** The only escapes are the two already-controlled ones: `DU_DATA_MODE=synthetic`
  with the acknowledged exemption (isolated synthetic data only) and `NODE_ENV=development|test`. A Portal toggle or
  arbitrary flag must not be able to weaken the real-data requirement (SEC-ENC-05 item 3).
- Synthetic mode still gets the loud warning; the exemption reason is already surfaced by
  `summarizeEncryptionPolicy` (`syntheticReason`) and `/health` (`server.ts:362-364`).
- The refusal must be **content-safe**: it names env vars, the mode and the seam; it never echoes key values, key
  lengths, hashes or Vault paths.

### 2.3 Proposed refusal semantics

- Error type: reuse `EncryptionBootConfigError` (`boot-options.ts:62`) so the `refusing to boot:` prefix and the typed
  assertion style stay uniform.
- Proposed message (final wording open to Reviewer):

  ```
  refusing to boot: ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required when artifact encryption is
  enabled in real-data mode; set the profile cipher key, or declare an explicit synthetic deployment
  (DU_DATA_MODE=synthetic with DU_SYNTHETIC_DATA_ACK) for isolated fixtures only
  ```

- Ordering: after `buildEncryptionBootOptions` + `summarizeEncryptionPolicy` resolve (so the Vault surface is validated
  first and the message can rely on the effective policy) and **before** `createApp` is called (`main.ts:244` →
  `main.ts:276`). Present position of the old warn block is exactly where the new check slots in (`main.ts:270-275`).
- Throw semantics: the error propagates out of `main()` exactly like today’s boot refusals (process exits 1 via the
  existing boot path); no try/catch swallow.
- Logging stays as-is on the allowed paths: one warn naming the denied operation (dev/test/synthetic), zero new logs on
  the refusal path beyond the thrown error’s own message.

## 3. Proposed implementation shape (for the approved implementation packet — NOT executed)

```ts
// services/orchestrator/src/modules/encryption/boot-options.ts (proposal)
export function assertProfileCipherBootPolicy(
  env: EnvReader,
  policy: Pick<EncryptionPolicySummary, 'dataMode' | 'metadataEncryption' | 'publicUploadEncryption'>,
): void {
  const keyPresent = Boolean(env.ENCRYPTION_KEY || env.NEXTAUTH_SECRET);
  if (keyPresent) return;
  if (policy.dataMode !== 'real') return;                       // explicit synthetic exemption
  if (!policy.metadataEncryption && !policy.publicUploadEncryption) return; // seam off (unreachable today)
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return;    // dev/offline/test warn-only
  throw new EncryptionBootConfigError(
    'ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required when artifact encryption is enabled in real-data mode; ' +
    'set the profile cipher key, or declare an explicit synthetic deployment ' +
    '(DU_DATA_MODE=synthetic with DU_SYNTHETIC_DATA_ACK) for isolated fixtures only',
  );
}
```

- `main.ts` calls it right after `encryptionPolicy` is computed (`main.ts:256-264`), keeping the old warn block for the
  cases the predicate allows.
- **Module placement alternatives for the Reviewer:** (a) `boot-options.ts` (recommended — same error class, one
  reviewed boot-rules module, no new file); (b) a dedicated `modules/encryption/profile-cipher-boot-policy.ts` if the
  owner prefers narrower review units.
- **Optional health surface (Reviewer decision):** extend `EncryptionPolicySummary` / `/health`
  (`server.ts:362-364`) with `profileCipherKeyPresent: boolean`. It exposes key *presence* only (never the value),
  consistent with the existing content-free policy summary, and makes the applied policy observable per SEC-ENC-05
  item 3. If approved, it ships in the same packet with tests; if rejected, no other change.
- **Related seam hardening (separate small packet, recommended, not required by §11.3):** the profile *write* path
  currently throws the generic `file-url-auth.ts:40-43` error when the key is absent; the acquisition **read** path is
  already typed (`acquisition-ref-resolver.ts:199-211`). Mapping the write-path failure to the same typed
  `AUTH_DECRYPT_FAILED` at its boundary would complete the seam story. Called out so the Reviewer can decide scope.

## 4. Boot-matrix evidence plan (required by §11.3)

### 4.1 Offline unit matrix (implementation packet adds these tests)

| Case | Env | Expected |
|---|---|---|
| 1 | `real` (unset `DU_DATA_MODE`), seam on, `NODE_ENV=production`, no key | throws `EncryptionBootConfigError`; message contains `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `real-data`; message contains **neither** sentinel key values |
| 2 | same, `NODE_ENV` unset | throws (fail-safe default) |
| 3 | same, `NODE_ENV=development` and `=test` | no throw; warn-once still emitted |
| 4 | synthetic with valid ack, seam on, no key | no throw |
| 5 | `ENCRYPTION_KEY=''` + no `NEXTAUTH_SECRET`, production real | throws (empty = absent) |
| 6 | only `NEXTAUTH_SECRET` set / only `ENCRYPTION_KEY` set | no throw |
| 7 | real, seam off (constructed policy), any NODE_ENV, no key | no throw (documented invariant) |

### 4.2 Integration via the existing `main()` harness

- Extend `tests/v1-boot-typed-denial.test.ts` (its `jest.doMock`-driven `runMain` harness, `:195-239`):
  - keyless + real policy + non-dev/test → `main()` rejects **before** `createApp`; assert typed error and no listen.
  - re-scope the existing “continues boot without either key …” test to an explicit allowed mode (dev/test or
    synthetic) so it keeps a precise meaning instead of pinning the old blanket behavior.
- Keep green (unchanged): typed denial cases (#3-#6 in §1.2) — “turns missing-key consumption … into the typed
  denial”, “classifies … permanent”, “denies tampered ciphertext”, “decrypts normally”.

### 4.3 Candidate-level matrix on the baked r4.1 image (live gate, §11.4 item 3)

| Run | Expected |
|---|---|
| keyless **dev** boot (`NODE_ENV=development`, synthetic or no seam) | boots; one warn; exit serving |
| keyless **real-mode** boot (complete Vault surface, `NODE_ENV` production/unset) | process refuses, exit ≠ 0, content-safe log excerpt |
| tampered-key typed denial (wrong `ENCRYPTION_KEY`, stored cipher) | typed 500 `AUTH_DECRYPT_FAILED`, no plaintext served |
| healthy path (correct key) | boot + decrypt success |

Evidence format: exact command, env snapshot **without secret values**, exit code, log excerpts, image digest, and the
raw files under `coordination/reports/raw/`. Skipped is not pass; no ACCEPTED claim from offline runs alone.

## 5. Compatibility, rollout and docs

- **Compose:** unchanged behavior — `compose/orchestrator.yml:35` already hard-fails when `ENCRYPTION_KEY` is unset.
- **EKS:** unchanged — `ENCRYPTION_KEY` is already mapped (`externalsecret-orchestrator.yaml:28-29`); operators must
  keep the secret present in `du/orchestrator`.
- **Bare `node dist/main.js` / custom manifests:** keyless real-data boots that previously continued will now refuse —
  this is the point of the finding. Local fixtures keep working via `NODE_ENV=development|test` or the explicit
  synthetic exemption.
- **Tests/fixtures:** only `v1-boot-typed-denial.test.ts` needs a scope update (above); no other suite asserts the
  blanket warn-only behavior.
- **Docs to update in the implementation packet** (owner: same packet; SEC-ENC-05 allowed paths):
  `docs/41-persistence-encryption-policy.md` (add the `profile_bindings.file_url_auth_cipher` profile-cipher row with
  key ownership/rotation note), `docs/12b-deployment-guide.md:107` (state “required when artifact encryption is enabled
  in real-data mode”), and the traceability rows (`docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`) per
  AGENTS rules.
- **Health/admin:** optional `profileCipherKeyPresent` (§3); the existing `body.encryption` policy block is already
  surfaced (`server.ts:362-364`).

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A real deployment boots keyless today and would now refuse | Intended fail-closed; two canonical deployments already supply the key; message names both accepted env vars; recovery is a config change, not a data migration |
| Local devs running via bare `node dist/main.js` without `NODE_ENV` hit the refusal | They already cannot pass the SEC-ENC-05 real-mode Vault surface; dev scripts should set `NODE_ENV=development` or the synthetic exemption — documented in the packet and docs |
| Predicate drift between boot and use | Single source: `EncryptionPolicySummary`; the predicate reads `dataMode`/seam flags from the already-computed summary, never re-parses env |
| A bypass flag is later added to “make boot easier” | Spec explicitly forbids new opt-out envs; only `NODE_ENV=dev|test` and the acknowledged synthetic exemption qualify, and both are visible in `/health` |
| Refusal happens after OIDC ready (`main.ts:232-241`) | Same ordering as the existing Vault refusal; optional improvement (move policy resolution before OIDC init) listed as open question Q5, not required |

## 7. Open questions for the Reviewer

1. **Q1 — dev/test predicate:** `NODE_ENV in {development, test}` only (recommended, no new env), or an explicit
   `DU_BOOT_PROFILE_CIPHER=warn|refuse` flag? Recommendation: NODE_ENV only; a flag becomes the bypass door the
   directive warns about.
2. **Q2 — staging:** any value other than development/test counts as real (refuse). Confirm no staging carve-out.
3. **Q3 — health exposure:** add `profileCipherKeyPresent` to `/health` encryption block, or keep the policy summary
   unchanged?
4. **Q4 — write-path typing:** include the profile-write missing-key typed-denial mapping in this packet, or a
   separate small packet?
5. **Q5 — ordering:** keep the check at the old warn site (after OIDC ready), or hoist both policy checks before OIDC
   init to fail faster?
6. **Q6 — message:** approve the exact refusal text in §2.3 (or amend).

## 8. Acceptance criteria for the implementation packet (after approval)

- [ ] `assertProfileCipherBootPolicy` (or Reviewer-chosen equivalent) implemented exactly per §2.2, single-sourced
      from `EncryptionPolicySummary`; no other boot semantics changed.
- [ ] `main.ts` calls it before `createApp`; keyless real-data non-dev/test boots refuse with the approved
      `EncryptionBootConfigError`; dev/test and synthetic paths keep warn-once.
- [ ] Offline unit matrix §4.1 (7 cases) + integration cases §4.2 green; existing typed-denial cases unchanged and
      green; typecheck exit 0.
- [ ] Content-safety test: seeded sentinel key values never appear in the refusal message or logs.
- [ ] Docs/traceability rows updated (§5); `/health` decision applied (Q3).
- [ ] Candidate-level matrix §4.3 executed on the tagged r4.1 image with recorded evidence; independent review before
      the parent rows move.
- [ ] No commit/push/tick by the implementation owner until the Reviewer closes the packet.

## 9. Status statement

This spec is a **proposal only**. No code was modified: `main.ts` remains byte-identical to
`6F3F291D…`; this file is the only write. Implementation is **gated on Reviewer approval** of §2–§3 (D-BOOT-01,
r4 §11.3). Until then `F-VFY6-01` stays open.
