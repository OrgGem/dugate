# SEC-ENC-05 — mandatory real-data boot policy & wiring integrator — receipt

Task: `SEC-ENC-05` under `tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md:75-86`. Owner: oc_1, platform crypto & boot
integrator. Date: 2026-10-06. No commit, no push.
Status: **boot policy + composition wiring IMPLEMENTED, focused/related tests green; SC-02 adapters, live boot matrix
and independent verification remain OPEN.** Parent SEC-SENSITIVE-PERSISTENCE stays unchecked.

## 1. What changed

### 1.1 Mandatory real-data default (`modules/encryption/boot-options.ts`)
- New `DU_DATA_MODE` (`real` default when unset, `synthetic` explicit) and `DU_SYNTHETIC_DATA_ACK` (JSON validated
  with the SEC-ENC-01 `SyntheticDataExemptionSchema`: mode + reason + approvedBy + acknowledgedAt +
  `isolatedFromRealData: true`). A missing/incomplete acknowledgement, an unknown mode or a bad JSON refuses the
  boot with a content-safe `EncryptionBootConfigError` — encryption can never be disabled by omission.
- `encryptionIsRequired()` is now **always true in real-data mode**; only explicit synthetic mode keeps the legacy
  rule (s3 or an enable flag). `resolveEncryptionBoot()` forces BOTH blocks in real mode regardless of backend/flags;
  the missing-surface error names the real-data mode and the explicit opt-out instead of suggesting a flag.
- New `summarizeEncryptionPolicy(env)`: content-free `{dataMode, syntheticReason?, metadataEncryption,
  publicUploadEncryption, metadataPlaintextReadMode}` resolved through the same validation the boot uses.

### 1.2 Boot + health surface (`main.ts`, `server.ts`)
- `main.ts` resolves the effective policy once, passes `encryptionPolicy` to `createApp`, and logs a loud warning with
  the exemption reason in synthetic mode (no real tenant data may run there).
- `ServerConfig` gains `encryptionPolicy`, `secretResolver` and `secrets` seams. `GET /health` (and
  `/api/v1/health`) now carries `body.encryption = {...policy, secretResolver: boolean}` — the applied policy is
  observable, content-free (no tokens, keys or Vault paths).

### 1.3 Composition wiring (`app/bootstrap/create-app.ts`)
- **SEC-ENC-04 artifact encryption**: one shared `CryptoStorageFacade` now feeds the public upload gateway, the
  worker artifact service (`createArtifactService({ encryption: { facade, keyRef, keyVersion, required } })`) and the
  S3 decrypt deps. `required` is true in real-data mode unless the approved artifact migration window is open;
  synthetic mode keeps compatibility reads. `createMultipartService` receives
  `encryptionRequired = publicUploadEncryption configured && !window`, so plaintext worker multipart fails closed
  until a server-mediated sealed multipart writer exists.
- **SC-02 secret resolver seam**: a prebuilt `config.secretResolver` wins; otherwise composition calls
  `createRuntimeSecretResolver(config.secrets)` with the injected adapter options. No adapter is fabricated when
  neither is provided (consumers fail closed), and `/health` reports `secretResolver` availability.

### 1.4 Test adjustments required by the policy change
- `tests/encryption-boot-options.test.ts`: legacy opt-in cases now declare synthetic mode explicitly; new
  SEC-ENC-05 matrix (real default refusal, forced blocks, missing/incomplete ack, unknown mode, summary).
- `tests/sec-enc-05-boot-wiring.test.ts` (new): artifact/multipart/resolver wiring + `/health` policy assertions.
- `tests/v1-boot-typed-denial.test.ts`: the partial `boot-options` mock now provides `summarizeEncryptionPolicy`
  (main calls it unconditionally).
- `tests/multipart-service-offline.test.ts`: offline fixtures declare the explicit synthetic exemption and restore
  the environment (RFX-03 env cases keep their meaning: synthetic still forces encryption for s3 and malformed flags).

## 2. Changed paths and hashes

| File | SHA-256 |
|---|---|
| `src/modules/encryption/boot-options.ts` | `42BA26376DC4F950CB8E250670572C0FDFE7E9A1513B6CF8C3CACA50CB443F8E` |
| `src/server.ts` | `B8FBA4F05EC193DE1F60DE345FBA163861ECC80C654E950C850782D10589D690` |
| `src/main.ts` | `6F3F291DDBAAD414084D6F59D41B477DFF5F5CF235D72D823E74029889C3B70A` |
| `src/app/bootstrap/create-app.ts` | `0AF843A4F7D7602483DF6F7AA0F630EA4EDB23B3082EAF98A4E09FEE160FD6A9` |
| `tests/encryption-boot-options.test.ts` | `6B9BF9D836B3F2104CDAF458D5FDA916FA8B8F5ACFD60E851ACFDCF69FAD5BE1` |
| `tests/sec-enc-05-boot-wiring.test.ts` (new) | `8F0424D281B983E7A06972EEB299AF0B208AD2FF5FD77569F1A64F6701439D9B` |
| `tests/v1-boot-typed-denial.test.ts` | `AFFB37A163D66C3C394C5271D6325DDB76204C60B4C0D5EBE3019BD3581F8FC5` |
| `tests/multipart-service-offline.test.ts` | `152BD4EC3EC112BAD5A3E9C6DFC4C4D4BD0CD9E68AA063C2C1DC97531D402C55` |

Transient edits to `modules/artifacts/multipart-service.ts` and the multipart harness fixture were reverted to their
original form (net change: none).

## 3. Test evidence (real runs, cwd `du-rework`)

| Command | Exit | Result | Log |
|---|---|---|---|
| `pnpm --filter @du/orchestrator run typecheck` | **0** | tsc clean | `raw/sec-enc-05-typecheck-final.log` |
| Focused: `encryption-boot-options` + `sec-enc-05-boot-wiring` | **0** | **40 passed / 40** | `raw/sec-enc-05-tests2.log` |
| Related set (23 suites: boot, secrets/resolver seams, metadata/artifact/delivery/multipart encryption, crx01/02, v1-boot, oidc-boot, plat-mig-01) | **0** | **23 suites / 473 tests passed** | `raw/sec-enc-05-related-suites2.log` |

The related run prints one Jest "worker process failed to exit gracefully" warning (pre-existing timer leak in the
suite set); exit code and results are green.

## 4. Acceptance mapping (SEC-ENC-05)

| Item | Status here |
|---|---|
| Real-data default across PG/S3; missing flag/config/key fails startup | Done: real mode forces both blocks; missing surface/mode/ack refuses with content-safe error |
| Only explicit synthetic mode may opt out, isolated | Done: `DU_DATA_MODE=synthetic` + complete `DU_SYNTHETIC_DATA_ACK`; loud warning; health shows mode/reason |
| Strict metadata read mode after readiness | Unchanged and still required whenever metadata encryption is on; real mode always has it |
| Surface effective policy in health/admin | Done for `/health` (content-free policy + resolver availability); Portal/admin views are CB/SC-03 follow-ups |
| Wire `ManagedValueDecryptor` + SC-02 resolver | Composition seam done: prebuilt resolver or `createRuntimeSecretResolver(config.secrets)`; concrete Vault KV reader/decryptor adapters are SC-02's deliverable (not fabricated here) |
| Wire SEC-ENC-04 streaming options | Done: shared facade into `createArtifactService.encryption`; `createMultipartService.encryptionRequired` fail-closed |
| Boot matrix PG/S3 × real/synthetic × missing/outage; no real plaintext write | Offline matrix tests cover real/synthetic × missing/incomplete/malformed; live PG/S3/Vault matrix and byte inspection remain VFY-SEC-ENC-01 |
| Local runner/Compose/env/deployment docs | Not in this pass; env names documented in code/receipt for the deployment owner (SEC-ENC-05 remaining item + CB-05/SC-05 docs lanes) |

## 5. Limitations / handoff

- Concrete `ManagedValueDecryptor` and `VaultReferenceReader` implementations (SC-02) are still required before the
  resolver can serve real consumers; the composition accepts them via `config.secrets`/`config.secretResolver` and
  reports availability. Nothing fabricates crypto.
- Real-data mode makes worker artifact reads strict (`required: true`), so historical plaintext worker artifacts need
  the approved `artifactStorage.migrationWindow` or the SEC-ENC-06 backfill.
- No live PG/S3/Vault boot or byte-scan was run (no isolated live window); synthetic tests only.
- Deployment surfaces (Compose/env samples, runbooks, S3 SSE/KMS defense-in-depth docs) are the remaining SEC-ENC-05
  items, owned with the deployment/build integrator.
- Evidence hashes: `sec-enc-05-typecheck-final.log`
  `8EA0CC2391A3DA924A9FCB376EC417FA1E0D8FC07F48740A4177572B65C39DAF`, `sec-enc-05-tests2.log`
  `CC8F2B4CD637B494F2A7D18E985F3CBD3206D43A498B67114DDF592FCDD0B026`, `sec-enc-05-related-suites2.log`
  `CC8C2800C35EFAE2D38BB1A481F4DFEA9F96EDE8D95CE483342B0B197C97F3B0`; raw failure history is retained in
  `sec-enc-05-related-suites.log` `A2ADA688036BB7ADC0878CE3E9397CE77C93B51BB824C6E2B61F283FC5EB02D5`,
  `sec-enc-05-fixed-two.log` `AD86683AC5EB965D6F205EFBA2F94340CFF78AFE9B7303EEFBCB0F1141188D3B`,
  `sec-enc-05-tsc1.log` `ED6BC8F01138FF05DF2D336855B9F93968F54040DB24F6E352DF43596D28C827`.
- Next: SC-02 adapters + VFY-SEC-ENC-01 boot/deployment verification and Claude review before acceptance.
  No commit/tick/push performed.
