# SEC-ENC-01 — canonical persistence policy and field inventory — receipt

Task: `SEC-ENC-01` under `tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md`. Owner: OpenCode 1 (`oc_1`), platform
crypto & contracts integrator. Date: 2026-10-06. No commit, no push, no cutover.
Status: **interface frozen + offline tests green; parent SEC-SENSITIVE-PERSISTENCE stays OPEN** (SEC-ENC-02/03/04/05/06
and VFY-SEC-ENC-01 untouched).

## 1. Deliverables

1. **Field inventory + policy freeze** published as the canonical
   [`docs/41-persistence-encryption-policy.md`](../../docs/41-persistence-encryption-policy.md): 20-row
   producer→consumer→store→format→key-owner→status matrix (8 enforced control-plane slots, public-upload artifact
   path, delivery envelopes, 7 PLANNED writer classes owned by SEC-ENC-02/03/04, reviewed exemptions), the internal
   transport exception restated as transport-only, fail-closed rules, key outage/rotation/revocation semantics and
   the migration contract.
2. **Contract schemas frozen** in `packages/contracts/src/encryption-persistence.ts` (exported via
   `packages/contracts/src/index.ts`): purpose taxonomy (`PERSISTENCE_PURPOSES` with enforced + reserved names),
   `SealedMetadataEnvelopeSchema` (small metadata envelope), `EncryptedStorageStreamManifestSchema` (streaming
   artifact envelope incl. keyed `manifestMac`), storage AAD schemas (`StorageContextAad`,
   `StorageSingleShotAad`, `StorageChunkAad`), metadata AAD digest contract and the explicit-only
   `SyntheticDataExemptionSchema` (absence of config = required).
3. **Single format source enforced in code**: the storage facade's AAD builders now construct their JSON through the
   contract schemas (`crypto-storage-facade.ts`), so facade bytes and contract cannot drift; existing facade tests
   prove the change is byte-compatible.
4. Focused tests: contracts schema/tamper suite and an orchestrator freeze-parity suite (real `seal()`, real facade
   AAD/stream manifest, wrong-context and key-outage negatives).

## 2. Changed paths and hashes

| File | SHA-256 |
|---|---|
| `packages/contracts/src/encryption-persistence.ts` (new) | `FB13984F74E17489934976941F3B36860D9D8C380519EE47A92F4078A52408C0` |
| `packages/contracts/src/index.ts` (export line) | `279F9A01BE05BC2EE8B29A9075408913110636EBA0EA0E04102D9F3A55594458` |
| `packages/contracts/tests/encryption-persistence.test.ts` (new) | `5F8B1A7704484CAD4B4F01A79435E65601E7F79C06B38E8E2019A789CBA7A176` |
| `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` | `007B32A1C5C57D52971BF10CE67E4449704DD0CEEE7713D28B1E4CE7633A1D97` |
| `services/orchestrator/tests/persistence-encryption-freeze.test.ts` (new) | `F55B9F80F962766DB3EA75350303B7F143DEA1F60B2A39481E14F6FDB06578BB` |
| `docs/41-persistence-encryption-policy.md` (new) | `EB4D9F808C11B2D20573C68DD3AE84D6F1E149D084F8056DBC905CB51B914555` |

All changes stay inside the granted lease (`packages/contracts/src/encryption*.ts`, `.../modules/encryption/**`,
security/encryption docs). Test files were added in the conventional test directories because the task's acceptance
requires focused tests; no other product source was touched. `docs/21-openapi.json` was not edited (no wire change).

## 3. Test evidence (real runs, cwd `du-rework`)

| Command | Exit | Result | Log |
|---|---|---|---|
| `pnpm --filter @du/contracts test` (full suite incl. the new 10 cases) | **0** | **28 suites / 537 tests passed** | `coordination/reports/raw/sec-enc-01/contracts-full-suite.log` |
| `pnpm --filter @du/orchestrator exec jest --runTestsByPath tests/persistence-encryption-freeze.test.ts …` + the 7 compiling encryption suites | **0** | **8 suites / 297 tests passed** | `.../orchestrator-encryption-green.log` |
| `pnpm --filter @du/contracts build` (needed so `@du/contracts` dist exposes the new schemas) | 0 | tsc clean | `.../contracts-build.log` |

Coverage added: purpose taxonomy uniqueness/enforced-vs-planned disjointness; synthetic exemption requires every
explicit acknowledgement field; storage context/single/chunk AAD shape and cross-format transplant refusal;
32-byte metadata AAD digest; sealed-metadata envelope accepts the real `seal()` output and rejects nonce/tag/aad/digest
drift or extra fields; stream manifest rejects reorder, duplicate nonces, truncation, size drift, missing MAC and a
context AAD that does not encode the storage context; runtime `METADATA_SLOTS` ≡ contract enforced metadata purposes;
facade single-shot AAD parses the contract schema and a transplanted `artifactId` fails `AUTHENTICATION_FAILED`; a
real >5 MiB stream manifest parses the contract schema; Vault-outage paths return `KEY_PROVIDER_FAILED`, never
plaintext. The existing `crypto-storage-facade.test.ts` and `crypto-storage-plaintext-bound.test.ts` suites pass on
the refactored AAD builders, proving byte compatibility.

**Pre-existing blockers observed (not caused by this packet, owner = artifact/SEC-ENC-04 lane):**
`pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` fails only in untracked working-tree files:
`src/modules/artifacts/artifact-encryption.ts:280` (`unknown` → `number`), `src/modules/artifacts/artifacts.ts:890`
(`Readable` imported as type but used as value), `src/modules/artifacts/multipart-service.ts:258`
(`encryptionRequired` missing on `MultipartServiceOptions`). Consequently 4–5 suites that transitively import those
files (`delivery-encryption`, `public-upload-encryption-gateway`, both `enc-meta-sentinel-*`, `rcr-luna-http-encryption`)
fail to compile and are reported as OPEN, not as failures of this packet (`orchestrator-src-tsc.log`,
`orchestrator-encryption-suite.log`).

## 4. Acceptance mapping

| SEC-ENC-01 acceptance item | Status |
|---|---|
| Field-to-writer/reader matrix complete | Done in `docs/41` §3 (20 rows, code-grounded producers/consumers/stores) |
| Approved exemptions explicit | Done: content-free metadata list only; filenames/URLs/prompts/session refs classified non-exempt |
| Format freeze available to all consumers | Done: contract schemas + purpose taxonomy exported from `@du/contracts`; facade already consumes AAD schemas |
| Focused tamper/AAD/key-failure tests | Done: 10 contracts cases + 5 orchestrator parity/negative cases, all green |
| No inventory-only acceptance of the parent | Respected: parent and all SEC-ENC-02..06/VFY remain open |
| Strict startup/read/write + rotation/revocation semantics | Documented (`docs/41` §4) on existing primitives; **boot enforcement is SEC-ENC-05**, not claimed here |

## 5. Limitations / handoff

- No live PG/S3 byte-scan was run; VFY-SEC-ENC-01 owns synthetic-sentinel inspection of real storage.
- PLANNED rows 11–18 are interface-frozen only; SEC-ENC-02/03/04 must implement against the reserved purposes and
  formats declared in `docs/41` and `encryption-persistence.ts`.
- `docs/04-data-state.md:84-86` and `docs/07-internal-api.md:86-88` still carry superseded "no encryption code"
  status paragraphs; their owners should update them under the docs lease (noted in docs/41 §6).
- Evidence logs: `coordination/reports/raw/sec-enc-01/` —
  `contracts-full-suite.log` `B61322D31A1398F2F3DD35B8BAADAF836B39C7692B889CF8967821314005BA05`,
  `contracts-new-test.log` `E9B6ADA35CCE5502ED5457999A3694626B956505918E9D2F90BA5F88A66E30EA`,
  `contracts-build.log` `F7E1113A0CAF22697C7C28FFC2D2E8283A2D197285AFC2F906FCEB36CEC06C78`,
  `orchestrator-encryption-green.log` `8FC1D423DD5D492D1858FE60BB5F23568AC96EC4385DB9AB10FD75949D6AB029`,
  `orchestrator-new-test.log` `44BAE003DB516653B5124753AFCE31525A95C082AFE37B6655B086A12AD94B0D`,
  `orchestrator-src-tsc.log` `8137301D99DA0F3E24D7C312885735AB7E70D6237272E5A9B7DD1F79305E8AEA`,
  `orchestrator-encryption-suite.log` `FA0DD98B669C81CDFF65571885BC263F16CE4D1AE2BF74F715F6FDC521B6A56C`.
- Next: independent tester + reviewer; SEC-ENC-02/03/04 can start in parallel against the frozen interface.
  No commit/tick/push performed.
