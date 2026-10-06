# VFY-06 & VFY-SC-01 — Independent evidence verification — 2026-10-06

- Tasks: `VFY-06` (SEC-SENSITIVE-PERSISTENCE audit close-out (a)–(d)) and `VFY-SC-01` (SECRET-CATALOG audit
  close-out (a)–(c)), as required by `coordination/reports/claude-audit-review-r4-2026-10-06.md:46,63,100-104`.
- Owner: oc_1 (term_cefb27a0…), Platform Crypto & Boot Integrator. CWD `D:\Git\dugate\du-rework`.
- Constraints honored: **no commit, no push, no task-row tick**. All runs offline: no live PostgreSQL, Redis, S3,
  MinIO, Vault or receiver was contacted. Two transient jest probes were created for this pass and deleted afterwards
  (deletion proven in §6).
- Environment: Windows, Node v22.16.0, pnpm 10.18.3 (toolchain engine warning only). Raw logs:
  `coordination/reports/raw/vfy-06-sc01/`.

## 0. Verdict summary (honest, no ACCEPTED claim)

| Close-out item | Status in this pass |
|---|---|
| VFY-06 (a) encrypt-on-write call-sites + migration refs | **DONE** — §1.1 |
| VFY-06 (b) ciphertext-only read (no plaintext column/field) | **DONE offline** (service, ledger, smoke); **no live PG/S3 byte scan** — §1.2 |
| VFY-06 (c) boot matrix (missing surface/token → refuse; unreachable Vault) | **DONE for the Vault surface**; **FINDING F-VFY6-01** for `ENCRYPTION_KEY` (warn, not refuse) — §1.3 |
| VFY-06 (d) `artifact_blobs` pilot scope vs S3 truth | **DONE** — §1.4 |
| VFY-SC-01 (a) no-plaintext-readback audit (Portal + API) | **PARTIAL** — BFF/UI surfaces verified (probe + parser); **upstream catalog API absent** (FINDING F-VFYSC1-01) — §2.1 |
| VFY-SC-01 (b) KV2 resolver tests incl. negative paths | **DONE offline** — §2.2 |
| VFY-SC-01 (c) OpenAPI recount + provenance | **DONE** — §2.3 |

## 1. VFY-06 — Persistence & fail-closed

### 1.1 Encrypt-on-write call-sites and migration refs

| Surface | Exact encrypt-on-write call-site | Bytes land in | Migration reference |
|---|---|---|---|
| Public upload gateway (S3) | `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:446` (`cryptoStorage.encrypt`) and `:464` (`encryptStream`), before the S3 object write | S3 object + `*.crypto-manifest.json` sidecar | n/a (object store) |
| Source cache (S3, SEC-ENC-03) | `services/orchestrator/src/modules/operations/ingestion-storage-s3.ts:603` (`facade.encrypt`) and `:620` (`encryptStream`) | S3 object + manifest | n/a (object store) |
| Worker artifacts — seal | `services/orchestrator/src/modules/artifacts/artifact-encryption.ts:175` (`facade.encrypt`) / `:179` (`encryptStream`), called from `artifacts.ts:707` (`sealWorkerArtifact`) | both backends | — |
| Worker artifacts — S3 write | `artifacts.ts:730-743` → `s3-storage-facade.ts:273-314` `putServerObject` (`PutObjectCommand` at `:288`); VersionId required, unversioned write refused at `:296-300` | S3 object + sidecar | `migrations/0025_artifact_manifest_version.sql:3-4` (`manifest_version_id`) |
| Worker artifacts — PostgreSQL write | `artifacts.ts:712-723`: `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes)` with `sealed.ciphertext` (:716) and `sealed.sidecar` (:720-723) | `artifact_blobs.bytes` (bytea) | `migrations/0003_artifacts_grants.sql:8-11` (`artifact_blobs(bytes bytea NOT NULL)`) |
| Connector invocation request (PG) | `services/connector/src/db/repository.ts:220-221` (`sealField`, slot `connector_invocations.request`) before the INSERT | `connector_invocations.request` (JSONB) | `services/connector/src/db/migrations/001_connector.sql:31` |
| Connector invocation result (PG) | `repository.ts:296-297` (`sealField`, slot `…result`) | `connector_invocations.result` (JSONB) | `001_connector.sql:33` |
| Connector async session ref (PG, CR06-04) | `repository.ts:394` (`sealField`, slot `…session_ref`) | `connector_invocations.session_ref` (TEXT) | `009_connector_invocation_session_ref.sql` |
| Legacy inline public artifact | `artifacts.ts:777-783` refuses when encryption is configured (no envelope carrier) | — | — |

Envelope implementation and strict read fence: `services/connector/src/db/invocation-crypto.ts` (`seal`/`open`,
`NOT_SEALED`, `KEY_PROVIDER_FAILED`) and `repository.ts:92-113` — a stored value that is not a sealed envelope is
refused (`INVOCATION_UNKNOWN`) unless the explicit legacy-plaintext migration window is set (`:111-112`).

### 1.2 Ciphertext-only reads / no plaintext fallback (offline evidence)

| # | Command (cwd) | Result | Raw |
|---|---|---|---|
| 1 | `npx jest --runTestsByPath tests/sec-enc-02-invocation-crypto.test.ts tests/sec-enc-02-ledger-encryption.test.ts tests/sc-02-vault-runtime.test.ts --silent` (`services/connector`) | **exit 0 — 3 suites / 57 tests passed** | `raw/vfy-06-sc01/connector-suites.log` |
| 2 | `pnpm --filter @du/orchestrator exec jest --runTestsByPath tests/sc-02-runtime-secret-resolver.test.ts tests/sec-enc-03-source-s3-encryption.test.ts tests/rv0104-live-encryption.test.ts tests/artifact-read-decrypt-offline.test.ts tests/encryption-boot-options.test.ts tests/sec-enc-05-boot-wiring.test.ts tests/crx02-rfx05res-s3-read-guard.test.ts tests/public-upload-encryption-gateway.test.ts --verbose` | **exit 0 — 8 suites / 119 tests passed** (rv0104 live rows 4-6 SKIP: no live MinIO/Vault) | `raw/vfy-06-sc01/orchestrator-suites.log` |
| 3 | `node coordination/reports/raw/sec-enc-04-seal-roundtrip.cjs` | **exit 0 — 37/37 checks passed** | `raw/vfy-06-sc01/sec-enc-04-smoke.log` |

Representative assertions that make "ciphertext-only" checkable, quoted from the suites that passed:

- `sec-enc-02-ledger-encryption.test.ts`: “claim persists the request as an envelope; **no plaintext sentinel reaches
  the INSERT parameters**”; “…complete persists the provider result as an envelope; content/data/session **never appear
  in SQL parameters**”; “wrong tenant, transplanted row and wrong slot are refused, **never decrypted**”; “tampered
  ciphertext is refused as an authenticated failure, **not returned**”; “a wrapping outage creates no row and **no
  plaintext fallback**”; “strict reads **refuse a legacy plaintext row** instead of serving it”.
- `sec-enc-02-invocation-crypto.test.ts`: “wrap/unwrap outage fails `KEY_PROVIDER_FAILED` and never emits an envelope”;
  “a value that is not an envelope is `NOT_SEALED`, not silently accepted”.
- Smoke checks 33-37: tampered stored ciphertext refuses the read; unsealed row refused on strict deployment; worker
  multipart refuses while encryption is required and touches no database/presign.
- Worker output: `artifact-read-decrypt-offline.test.ts` + `crx02-rfx05res-s3-read-guard.test.ts` + SEC-ENC-03 suite all
  green in #2; `artifact_blobs` and S3 both carry the sealed envelope (SEC-ENC-04 smoke full service flow).

Limitation: no live byte scan of a real PG table / S3 object was performed (no isolated live window). Item (b) remains
**offline-verified only**.

### 1.3 Boot matrix (content-safe refusals)

Transient probe (deleted after run), jest exit 0. Exact captured messages (log `boot-matrix-probe-2.log`):

```
BOOT-REFUSAL [real-no-surface] refusing to boot: DU_VAULT_TRANSIT_OPTIONS is required when artifact encryption is enabled (real-data mode; export DU_DATA_MODE=synthetic with an explicit DU_SYNTHETIC_DATA_ACK only for isolated synthetic data); refusing to store artifacts in plaintext
BOOT-REFUSAL [real-options-only] refusing to boot: DU_VAULT_TRANSIT_ENC_TOKEN is required when artifact encryption is enabled
BOOT-REFUSAL [real-missing-decrypt-token] refusing to boot: DU_VAULT_TRANSIT_DEC_TOKEN is required when artifact encryption is enabled
BOOT-REFUSAL [synthetic-no-ack] refusing to boot: synthetic-data mode requires an explicit DU_SYNTHETIC_DATA_ACK acknowledgement; encryption cannot be disabled by an omitted flag
BOOT-REFUSAL [synthetic-incomplete-ack] refusing to boot: DU_SYNTHETIC_DATA_ACK must be a complete synthetic-data exemption (mode, reason, approvedBy, acknowledgedAt, isolatedFromRealData)
BOOT-REFUSAL [unknown-mode] refusing to boot: DU_DATA_MODE must be real or synthetic, got "prod"
BOOT-REFUSAL [unreachable-vault] boot surface built with no Vault dial (pure validation)
BOOT-REFUSAL [unreachable-vault] first use rejected: {"name":"VaultTransitError","message":"Vault Transit request failed"}
```

The probe seeded sentinel token values (`hvs.SENTINEL-…`) and asserted **no captured message contains them** — the
refusals are content-safe. Unreachable Vault: `buildEncryptionBootOptions` performs pure validation and does not dial
(boot succeeds), and the first provider use against a closed port rejects with `VaultTransitError` — fail-closed at
use, not at boot. Connector equivalent: wrap/unwrap outage → `KEY_PROVIDER_FAILED`, no envelope, no fallback
(`sec-enc-02-invocation-crypto.test.ts`).

**FINDING F-VFY6-01 — `ENCRYPTION_KEY` is warn-only at boot.** `services/orchestrator/src/main.ts:270-274` logs
`profile cipher key absent — configured-cipher acquisition will deny with AUTH_DECRYPT_FAILED; set ENCRYPTION_KEY or
NEXTAUTH_SECRET` and continues booting. Audit item (c) explicitly asks that a missing `ENCRYPTION_KEY` refuse startup.
Current truth: the Vault persistence surface refuses boot, but the legacy profile-cipher key path fails closed only at
acquisition. Owner: platform boot integrator; either harden to a boot refusal for real-data mode or record as accepted
by-design separation (profile cipher is not a persistence-encryption key).

### 1.4 `artifact_blobs` pilot scope vs S3 truth

- `artifact_blobs` is the PostgreSQL/local pilot store (`migrations/0003_artifacts_grants.sql:8-11`); the multipart
  migration records the invariant “bytes never enter PostgreSQL on this path … no new artifact_blobs writes”
  (`migrations/0015_artifact_multipart.sql:6-9`).
- Backend selection is `ARTIFACT_STORAGE_BACKEND`; with encryption configured, the PostgreSQL branch writes the sealed
  ciphertext + sidecar into `artifact_blobs` (`artifacts.ts:712-723`), while the S3 branch writes ciphertext + manifest
  through `putServerObject` with a mandatory VersionId (`artifacts.ts:725-743`, `s3-storage-facade.ts:273-314`).
- The legacy inline writer cannot bypass the policy (`artifacts.ts:777-783` refuses while encryption is configured).
- **Scope statement:** S3 is the production truth; `artifact_blobs` is the pilot/fallback that is now also sealed under
  SEC-ENC-04 and wired at boot under SEC-ENC-05 (`create-app.ts` passes one shared `CryptoStorageFacade` +
  `required` policy). No real-data path writes plaintext when encryption is configured.

## 2. VFY-SC-01 — Secret catalog

### 2.1 No-plaintext-readback audit

**BFF `/admin/api/secrets*`** (`services/orchestrator/src/app/admin/bff/secrets.ts`):

- Route table `:57-66`; method dispatch `:79-100` (GET `/secrets` → list, POST `/secrets` → create; everything else 405).
- List relays the upstream projection only (`:136-145`); mutations require platform admin + session CSRF
  (`:148-158`); bodies are validated against frozen contract schemas and Zod issues are projected to
  `{pointer, message}` only (`:212-252`, projection `:217-223`) — never the offending value.
- Independent transient probe (jest exit 0, 6/6; deleted after run): list GET relays
  `GET /api/v1/admin/secrets?tenantId=…`; create POST reaches `POST /api/v1/admin/secrets`, sends the write-only
  literal upstream **and the BFF response contains no literal**; invalid schema → 422 `{pointer,message}` with the
  sentinel absent; missing CSRF → 403 `CSRF_REJECTED` with zero upstream calls; operator mutation → 403
  `ADMIN_CREDENTIAL_REQUIRED`; `PUT` → 405 with zero upstream calls.

**Portal `/admin/web/secrets`** (SC-03):

- Parser rejects **any** row containing a `value` member (`apps/admin-web/src/features/secrets/state.ts:94-97`), so a
  plaintext readback would blank the list rather than render.
- Create sends the literal once and clears the draft/DOM state after success, with a write-only notice
  (`secrets-screen.tsx:142-176`); rotate clears the value (`:178-195`); the list renders `valueConfigured` as a badge
  only (`:321-322`).

**FINDING F-VFYSC1-01 — upstream catalog API absent.** `/api/v1/admin/secrets*` has no implementation in the working
tree (confirmed by `sc-03-cb-04-portal-ui-2026-10-06.md` §5.1 and `sc-04-cb-05-openapi-sync-2026-10-06.md` SC-04-M01).
Consequences: live list/create/rotate/disable cannot be verified end-to-end; BFF honestly returns the upstream
404/503; no production API response sample exists to audit. VFY-SC-01(a) stays **PARTIAL** until the SC-01 catalog
backend lands. The BFF method-dispatch defect recorded as SC-04-M02 is fixed in the current tree (`secrets.ts:79-100`)
and my probe confirms it, but no **permanent** regression test covers it
(**FINDING F-VFYSC1-02**, minor: promote the transient probe into `tests/`).
Note: the SC-03 owner browser probe (20/20, `raw/sc-03-cb-04-browser-probe.cjs`) exists but was **not re-run** in this
pass (it requires the AWEB harness server env); Portal evidence here is source+parser based.

### 2.2 Vault KV2 resolver incl. negative paths

`tests/sc-02-runtime-secret-resolver.test.ts` (part of the 8-suite/119 run, exit 0). Negative-path titles:
“cross-tenant, wrong-purpose and inactive states fail closed before decryption”; “tampered envelope and empty values
fail closed with **secret-free errors**”; “unpinned version requires the explicit latest-read policy”; “**reader
outage fails closed without a fallback value**”; “no vault reader configured fails closed for vault references”;
“probe **never returns the value** and reports typed error codes”; “invalidateAll drops every cached generation after a
global revocation sweep”; “malformed references fail with `INVALID_REFERENCE`”.

Connector reader side (`tests/sc-02-vault-runtime.test.ts`, in run #1): AppRole rejection non-retryable; renew outage
tolerated through margin then re-login; Vault outage → retryable `PROVIDER_UNAVAILABLE` with **zero provider calls**;
rotated version reaches the provider on the next revision pin; no-live-lease refuses with zero requests.

### 2.3 OpenAPI recount and provenance

- Recount from the artifact itself: `info.version = 1.4.0`, **58 paths / 62 operations / 51 schemas** — matches the
  claimed inventory.
- `docs/21-openapi.json` SHA-256 `7F0AFB86C151E5EE204E82CC75C4DDA3CFCA1F14C51CF6AB403B51DA26A46840` and
  `tools/openapi/gen_openapi.py` SHA-256 `482719C63A9008B96F7702805FE4EC13F4455FE74529FF8CE6C9CF645B1730E2` both
  **match `raw/sc-04-cb-05-openapi-sync-2026-10-06/SHA256SUMS.txt`** (generator-written, never hand-edited).
- `python tools/openapi/validate_openapi.py` → **exit 0** (`PASS … OPENAPI-EXAMPLES-VALIDATED`), log
  `raw/vfy-06-sc01/openapi-validator.log`.

## 3. Commands and evidence index (all exit codes literal)

| Log | Command summary | Exit | SHA-256 |
|---|---|---|---|
| `connector-suites.log` | connector SEC-ENC-02 ×2 + SC-02 reader | 0 | `6ED47BA787289443F9209D4757162EED955BBB3A1488E46B39D9BC348B878711` |
| `orchestrator-suites.log` | 8 orchestrator SC-02/SEC-ENC suites (verbose) | 0 | `06D6E75EAF02F307683FC9C2F02795A4B7AFD2A53CB41F3B11298DBF85D00789` |
| `sec-enc-04-smoke.log` | seal roundtrip smoke 37/37 | 0 | `E8020028344740184353C501FF057564617862727A15D3A445BAF01A3F3356CB` |
| `boot-matrix-probe-2.log` | boot refusal matrix + unreachable Vault | 0 | `21E84806BA444DF84254D6EAD06388D2CA2A253CF023AE0CC6DE47435E38E487` |
| `probes-boot-and-bff.log` | boot probe + BFF secrets probe (8/8) | 0 | `E7DFBABFD788DBE5099AA1CC81B0FA700E672D6F04A8F0231AC8DA67B82667AF` |
| `openapi-validator.log` | `python tools/openapi/validate_openapi.py` | 0 | `46E8CD414CE471B3EC90436490E4109F393F7059FD8F403C992579CAEF4D9827` |
| `boot-matrix-probe.log` | first probe run (failure history, kept) | 1 | `3C0D323ACDC3EE588E8762265F774F7684716C843461D31DD7443799AD722564` |

The orchestrator run prints one Jest “worker process failed to exit gracefully” warning (pre-existing timer leak);
exit code and all assertions are green. `rv0104-live-encryption` rows 4-6 are skipped without a live MinIO/Vault
window — skipped is not pass.

## 4. Findings register

| ID | Severity | Description | Owner |
|---|---|---|---|
| F-VFY6-01 | MEDIUM | Missing `ENCRYPTION_KEY` warns at boot (`main.ts:270-274`) instead of refusing; fail-closed only at acquisition (`AUTH_DECRYPT_FAILED`) | Platform boot integrator |
| F-VFYSC1-01 | HIGH (blocking acceptance) | Upstream `/api/v1/admin/secrets*` absent; live no-plaintext readback cannot be proven | SC-01 catalog backend owner |
| F-VFYSC1-02 | LOW | BFF secrets method dispatch has no permanent regression test (transient probes only) | BFF owner |
| F-VFY6-02 | MEDIUM (gate) | No live PG/S3/Vault byte-scan or live boot matrix performed in this pass (offline only) | VFY-06 live tester |
| F-VFYSC1-03 | LOW | Portal has no unit tests for the `value`-rejecting parser; owner browser probe not re-run here | Admin UI owner |

## 5. What this changes / does not change

- No product code, tests, migrations or docs were modified. Only evidence logs under
  `coordination/reports/raw/vfy-06-sc01/` and this receipt were written. No commit, no push, no tick.
- This pass does **not** claim VERIFIED or ACCEPTED for VFY-06/VFY-SC-01. VFY-06 (b) and VFY-SC-01 (a) remain
  gated on live windows (PG/S3/Vault) and the missing upstream catalog API respectively.

## 6. Transient-probe deletion proof

Two probe files were created for this pass and removed immediately after the runs:

- `services/orchestrator/tests/__vfy06-boot-probe-oc1.test.ts` — `Test-Path` → `False`.
- `services/orchestrator/tests/__vfy06-secrets-probe-oc1.test.ts` — `Test-Path` → `False`;
  `git status --porcelain -- services/orchestrator/tests/` lists no `__vfy06` path.
- The oc_3 transient probe read during reconnaissance (`__probe-sc04-m02-oc3.test.ts`) was deleted by its owner before
  this pass's run (jest `ENOENT` in `boot-matrix-probe.log`); its checks are superseded by my BFF probe above.
