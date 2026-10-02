# ACUI-00 — Catalog cấu hình vận hành Orchestrator

**Task:** ACUI-00 · **Date:** 2026-10-02 · **Status:** inventory + classification, read-only. No source, test, config, gate or `tasks/*.md` was modified; no commit.

Plan: `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` §Nguyên tắc cấu hình chung. Machine-readable seed: `qwen-acui-00-config-catalog-2026-10-02.json` (same directory).

## 0. Method and what counts as covered

Every env key was enumerated by grep against the seven sources §1 of the plan names, then read in context. **Coverage statement:** the only `process.env` reads in the whole orchestrator tree are `main.ts:27,33` and `storage-migration-cli.ts:10,16` (grep over `services/orchestrator/src` returns 4 matches, all inside those helpers). Everything else goes through `buildOidcAdminComponents(process.env)`, `buildEncryptionBootOptions(process.env)`, `multipartLimitsFromEnv()` or a zod schema — so the inventory is complete by construction, not by sampling.

**A row is classified `managed` only if a versioned PostgreSQL store with a real write path already exists.** A table that exists but has no Admin mutation route is classified `managed-no-ui`, not managed. This distinction is the whole point of the catalog.

## 1. Sources read

| # | Source | Result |
|---|---|---|
| 1 | `services/orchestrator/src/main.ts` (all 179 lines) | 24 env keys |
| 2 | `services/orchestrator/src/app/admin/oidc-boot.ts` | 12 env keys |
| 3 | `businesses/document-core/src/config.ts` | 10 env keys |
| 4 | `services/connector/src/entrypoint.ts` | 12 env keys |
| 5 | `.env.example` (20 keys) | template — see §11 |
| 6 | `services/orchestrator/migrations/*.sql` | 20 `CREATE TABLE` |
| 7 | connector `src/db/migrations/*.sql` (8 files) | revision + credential tables |
| a | `services/orchestrator/src/server.ts` `multipartLimitsFromEnv` | 4 keys |
| b | `services/orchestrator/src/modules/encryption/boot-options.ts` | 5 keys |
| c | `services/orchestrator/src/storage-migration-cli.ts` | 7 keys |
| d | legacy `.env.example` + `lib/db/schema.ts` | mapping input |

## 2. Catalog A — Orchestrator process / deployment

All rows: scope `global`, mechanism **deployment**. **None is manageable through any Admin UI today** — there is no deployment adapter in this tree.

| id | env key | src | type / validation | default | secret | managed? |
|---|---|---|---|---|---|---|
| CFG-ORCH-01 | `DATABASE_URL` | `main.ts:117` | required, non-empty | — | yes (DSN pw) | no |
| CFG-ORCH-02 | `REDIS_URL` | `main.ts:118` | optional | `redis://127.0.0.1:6379` | yes | no |
| CFG-ORCH-03 | `ORCHESTRATOR_PORT` / `PORT` | `main.ts:116` | positive int, nested fallback | `3000` | no | no |
| CFG-ORCH-04 | `RUNTIME_TOKEN` | `main.ts:119` | optional | — | **yes** | no |
| CFG-ORCH-05 | `ADMIN_TOKEN` | `main.ts:121` | optional | — | **yes** | no |
| CFG-ORCH-06 | `USAGE_TOKEN` | `main.ts:122` | optional | — | **yes** | no |
| CFG-ORCH-07 | `INVOCATION_GRANT_SECRET` | `main.ts:123` | optional | — | **yes** | no |
| CFG-ORCH-08 | `WEBHOOK_SECRET` | `main.ts:124` | optional | — | **yes** | no |
| CFG-ORCH-09 | `WORKER_IDENTITY_TOKENS_BY_BUSINESS` | `main.ts:55` | JSON object, string values | — | **yes** | no |
| CFG-ORCH-10 | `ARTIFACT_STORAGE_BACKEND` | `main.ts:76` | `postgres` or `s3` | `postgres` | no | no |
| CFG-ORCH-11 | `ARTIFACT_S3_BUCKET` | `main.ts:85` | required when backend=s3 | — | no | no |
| CFG-ORCH-12 | `ARTIFACT_S3_REGION` | `main.ts:86` | optional | — | no | no |
| CFG-ORCH-13 | `ARTIFACT_S3_ENDPOINT` | `main.ts:87` | optional | — | no | no |
| CFG-ORCH-14 | `ARTIFACT_S3_FORCE_PATH_STYLE` | `main.ts:88` | strict bool | — | no | no |
| CFG-ORCH-15 | `ARTIFACT_STORAGE_MIGRATION_WINDOW` | `main.ts:77` | strict bool; rejected when backend=postgres (`main.ts:79`) | — | no | no |
| CFG-ORCH-16 | `WEBHOOK_DISPATCH_INTERVAL_MS` | `main.ts:125-126` | positive int | `5000` | no | no |
| CFG-ORCH-17 | `WEBHOOK_DRAIN_TIMEOUT_MS` | `main.ts:128-129` | positive int | `5000` | no | no |
| CFG-ORCH-18 | `SHUTDOWN_TIMEOUT_MS` | `main.ts:131` | positive int | `30000` | no | no |
| CFG-ORCH-19 | `SHUTDOWN_BUDGET_MS` | `main.ts:165` | positive int | `45000` | no | no |
| CFG-ORCH-20 | `AUTO_MIGRATE` | `main.ts:132` | string compare | `false` | no | no |
| CFG-ORCH-21 | `AUTO_DISPATCH` | `main.ts:133` | string compare | `true` | no | no |
| CFG-ORCH-22 | `ADMIN_SHELL_COOKIE_SECRET` | `main.ts:144` | optional | — | **yes** | no |
| CFG-ORCH-23 | `ADMIN_SHELL_PORT` | `main.ts:145` | positive int | `3001` | no | no |
| CFG-ORCH-24 | `ADMIN_SHELL_HOST` | `main.ts:146` | optional | `127.0.0.1` | no | no |
| CFG-ORCH-25 | `MULTIPART_PART_SIZE_BYTES` | `server.ts:4289` | safe positive int | unset | no | no |
| CFG-ORCH-26 | `MULTIPART_MAX_TOTAL_BYTES` | `server.ts:4290` | safe positive int | unset | no | no |
| CFG-ORCH-27 | `MULTIPART_SESSION_TTL_MS` | `server.ts:4291` | safe positive int | unset | no | no |
| CFG-ORCH-28 | `MULTIPART_PART_URL_TTL_MS` | `server.ts:4292` | safe positive int | unset | no | no |

**Impact / rollback for all of §2:** changing any row requires a process restart; rollback is restoring the previous value and restarting. The process reads once at boot, so **desired equals applied by construction** and a failed rollout is discovered by the service being down, not by a status check. ACUI-09 must add that distinction; until then every row here is `unmanaged / requires deployment action`.

### 2.1 ServerConfig fields the packaged entrypoint never sets

`main.ts:116-146` passes 26 fields to `createApp`; `ServerConfig` declares roughly 40. These are **unreachable from the shipped entrypoint** and belong in the catalog as dead capabilities, not configurable settings:

`connectorBaseUrls`, `connectorId`, `connectorRevision`, `tenantAdminTokens`, `credentialWorkflow`, `deliveryEncryption`, `cryptoConfig`, `jsonBaseUrl`, `leaseRecoveryIntervalMs`, `queueIntegrityGraceMs`, `queueIntegrityBatch`, `queueIntegrityMaxAttempts`, `ingestionConsumer`, `shutdownPollIntervalMs`, `webhookAllowPrivateNetworks`.

**ACUI-M06 consequence:** `connectorBaseUrls` being unset is why the Connector pane is a fake projection (`server.ts:2512-2555` over an empty map). `deliveryEncryption`/`cryptoConfig` unset means the ENC-08 durable store is not wired at boot.

## 3. Catalog B — Orchestrator identity / OIDC (boot-only)

Sources: `oidc-boot.ts:79-85` (names), `:132-220` (reads). Scope `global`.

| id | env key | src | type | default | mechanism |
|---|---|---|---|---|---|
| CFG-OIDC-01 | `DU_ADMIN_OIDC_ISSUER` | `:80,155,166` | required if any OIDC key set | — | deployment |
| CFG-OIDC-02 | `DU_ADMIN_OIDC_CLIENT_ID` | `:81,156,186` | required if any set | — | deployment |
| CFG-OIDC-03 | `DU_ADMIN_OIDC_REDIRECT_URI` | `:82,157,167` | required if any set | — | deployment |
| CFG-OIDC-04 | `DU_ADMIN_OIDC_CLIENT_SECRET_FILE` | `:84,171-174` | file path, read at boot | — | **secret-ref** |
| CFG-OIDC-05 | `DU_ADMIN_OIDC_CLIENT_SECRET` | `:85,173` | inline alternative | — | **secret-ref** |
| CFG-OIDC-06 | `DU_ADMIN_OIDC_ALLOWED_ISSUERS` | `:168-170` | CSV | `[issuer]` | deployment |
| CFG-OIDC-07 | `DU_ADMIN_OIDC_PKCE_METHOD` | `:162` | uppercased enum | — | deployment |
| CFG-OIDC-08 | `DU_ADMIN_OIDC_SESSION_BACKEND` | `:195` | enum | memory | deployment |
| CFG-OIDC-09 | `DU_ADMIN_OIDC_PUBLIC_ORIGIN` | `:220` | URL | origin of redirectUri | deployment |
| CFG-OIDC-10 | `DU_ADMIN_TRUST_PROXY_PROTOCOL` | `:132` | lowercased | — | deployment |
| CFG-OIDC-11 | `DU_ADMIN_COOKIE_SECURE` | `:138` | `enforce` or other | `enforce` in prod | deployment |
| CFG-OIDC-12 | `NODE_ENV` | `:142` | string | — | deployment |

**Partial configuration refuses to boot** (`:152-158`): any key present but not all four required throws. Absent entirely, the whole OIDC plane is null. This is the `local`/`oidc`/`both` mode of ACUI-02, and it is currently a **boot-time env decision, not a managed policy** — the catalog must record that ACUI-02 converts these 12 rows into managed rows with revisions, or ACUI-02 stays `unmanaged`.

`DU_ADMIN_OIDC_CLIENT_SECRET_FILE` is the one row with a real secret-ref shape today (path, read once at boot). **Rollback is a restart plus file swap**; there is no dual-secret overlap window, which ACUI-02 needs for zero-downtime rotation.

## 4. Catalog C — Encryption / Vault

Source: `modules/encryption/boot-options.ts:21-25` (names), `:159-259` (reads). Scope `global`.

| id | env key | src | type | notes |
|---|---|---|---|---|
| CFG-ENC-01 | `DU_VAULT_TRANSIT_OPTIONS` | `:21,212` | JSON, `allowedKeyRefs` non-empty | required when encryption on |
| CFG-ENC-02 | `DU_VAULT_TRANSIT_ENC_TOKEN` | `:22,258` | secret | falls back to inline token |
| CFG-ENC-03 | `DU_VAULT_TRANSIT_DEC_TOKEN` | `:23,259` | secret | must differ from enc |
| CFG-ENC-04 | `DU_ENCRYPTION_METADATA_ENABLED` | `:24,208` | strict bool | forced on when backend=s3 |
| CFG-ENC-05 | `DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED` | `:25,209` | strict bool | forced on when backend=s3 |

**Fail-closed, confirmed:** `backend === s3` forces both flags (`boot-options.ts:206-209`), and a half-specified surface throws rather than degrading (`main.ts:104-108`). Rollback is **not symmetric** — already-written encrypted rows stay encrypted after the flag is turned off.

## 5. Catalog D — Orchestrator managed (PostgreSQL)

These are the only rows where `managed` can honestly be claimed.

| id | store | scope | revisioned? | Admin write path today | class |
|---|---|---|---|---|---|
| CFG-PG-01 | `admin_crypto_config` (`0020:5-15`) | tenant | **no revision column**, only `created_at`/`updated_at` | **yes**, real | managed, but no effective/desired revision |
| CFG-PG-02 | `profile_bindings` (`0004:14-27`) | tenant | **yes**, PK `(profile_id, revision)` | partial, `POST /api/v1/admin/profile-bindings` | managed |
| CFG-PG-03 | `api_keys` (`0001:14-22`) | tenant | no | **yes** via `apikey.issue`/`revoke` (`dispatcher.ts:540-674`) | managed |
| CFG-PG-04 | `admin_local_users` (`0023:4`) | global | no | no route found | managed-no-ui |
| CFG-PG-05 | `business_versions` (`0001:24`) | global | version is the revision | no route found | managed-no-ui |
| CFG-PG-06 | `budget_reservations` (`0022:3`) | tenant | no | no | managed-no-ui |
| CFG-PG-07 | `admin_audit_events` (`0010:25`) | tenant | append-only | read-only route | not configuration |
| CFG-PG-08 | operation pin columns (`0004:30-32`) | per-operation | immutable snapshot | n/a | not configuration |

**Only 2 of 8 rows have an Admin write path.** `admin_crypto_config` is the single pane that genuinely writes to the database today, matching the plan's own progress note.

**Schema gap for ACUI-08:** `admin_crypto_config` has no `revision` column, so ACUI-08 needs a migration before its pane can show pending-vs-applied. `profile_bindings` already models this correctly and should be the reference shape.

## 6. Catalog E — Connector

Source: `services/connector/src/entrypoint.ts:7-27` (reads), `:53-73` (helpers).

| id | env key | src | type | default | secret |
|---|---|---|---|---|---|
| CFG-CON-01 | `CONNECTOR_PORT` / `PORT` | `:7` | positive int | `8080` | no |
| CFG-CON-02 | `HOST` | `:10` | string | `0.0.0.0` | no |
| CFG-CON-03 | `DATABASE_URL` | `:11` | required | — | yes |
| CFG-CON-04 | `REDIS_URL` | `:12` | optional | `redis://127.0.0.1:6379` | yes |
| CFG-CON-05 | `REDIS_KEY_PREFIX` | `:13` | optional | `du:connector:` | no |
| CFG-CON-06 | `CONNECTOR_MIGRATION_DIRECTORY` | `:14` | path | — | no |
| CFG-CON-07 | `DRAIN_TIMEOUT_MS` | `:15` | positive int | `30000` | no |
| CFG-CON-08 | `SERVICE_IDENTITY_SECRET` | `:16` | base64, exactly 32 bytes | — | **yes** |
| CFG-CON-09 | `INVOCATION_GRANT_SECRET` | `:18` | base64 32 bytes | — | **yes** |
| CFG-CON-10 | `CONNECTOR_ENCRYPTION_KEY` | `:20` | base64 32 bytes | — | **yes** |
| CFG-CON-11 | `PROVIDER_ALLOW_HOSTS` | `:21-23` | CSV | — | no |
| CFG-CON-12 | `ALLOW_PRIVATE_PROVIDER_NETWORKS` | `:24` | string compare | `false` | no |
| CFG-CON-13 | `USAGE_SINK_URL` and `USAGE_SINK_TOKEN` | `:25-27` | both-or-neither | — | **yes** |

`requiredSecret` (`:69-73`) decodes base64 and throws unless exactly 32 bytes — CFG-CON-08/09/10 have a **hard 32-byte constraint at boot**, unlike every orchestrator token, which is unconstrained. A UI cannot apply an arbitrary string here.

## 7. Catalog F — Worker (`businesses/document-core`)

Source: `businesses/document-core/src/config.ts:4-31`. This is the **only config surface in the repo with a declared schema** (zod), and it validates cross-field (`superRefine` `:32-40`).

| id | env key | src | type | default |
|---|---|---|---|---|
| CFG-WRK-01 | `RUNTIME_URL` | `:4` | url | — |
| CFG-WRK-02 | `RUNTIME_TOKEN` | `:5` | non-empty | — |
| CFG-WRK-03 | `REDIS_URL` | `:6` | non-empty | — |
| CFG-WRK-04 | `CONNECTOR_URL` | `:7` | url, optional | — |
| CFG-WRK-05 | `CONNECTOR_SERVICE_TOKEN` | `:8` | **required if CFG-WRK-04 set** | — |
| CFG-WRK-06 | `CONCURRENCY` | `:9-13` | int >= 1 | `1` |
| CFG-WRK-07 | `HEARTBEAT_INTERVAL_MS` | `:14-18` | int >= 100 | `10000` |
| CFG-WRK-08 | `WORKER_INSTANCE_ID` | `:19` | optional | `worker-document-core-<uuid>` |
| CFG-WRK-09 | `IMAGE_DIGEST` | `:20` | optional | `sha256:placeholder-document-core-v1` |
| CFG-WRK-10 | `SHUTDOWN_GRACE_MS` | `:21-25` | int >= 0 | `15000` |

CFG-WRK-08 and CFG-WRK-09 default to a random uuid and a literal `placeholder` string — a worker booted without them **reports a fake image digest**, which defeats rollout verification. ACUI-09 should mark both required in production.

## 8. Catalog G — storage-migration CLI (operator-only)

`storage-migration-cli.ts:33-47`. Gated by a four-key interlock: `ARTIFACT_STORAGE_MIGRATION_WINDOW` plus `ARTIFACT_BLOB_BACKUP_VERIFIED` plus `ARTIFACT_BLOB_ROLLBACK_SIGNOFF` plus `ARTIFACT_BLOB_MIGRATION_CONFIRM=YES`. **Keep it out of any Admin surface** — it is a break-glass tool, and ACUI-09 must not offer it as a staged setting.

## 9. Three-mechanism classification (§Nguyên tắc 2)

| mechanism | rows |
|---|---|
| **managed** (PG versioned, real write path) | CFG-PG-01, CFG-PG-02, CFG-PG-03 |
| **secret-ref** (Vault or file) | CFG-ORCH-04, -05, -06, -07, -08, -09, -22; CFG-ENC-02, -03; CFG-OIDC-04, -05; CFG-CON-08, -09, -10 |
| **deployment** | all remaining env rows |
| **unmanaged / requires deployment action** | identical to the deployment set — no adapter exists to stage any of them |

**The single most important line in this receipt:** the overwhelming majority of operational settings are `unmanaged`. No amount of Admin UI work makes them configurable until a deployment adapter exists. ACUI-09 is therefore the pacing item for §2, §3, §6 and §7, and the catalog is what makes that ratio visible instead of implicit.

Exact counts, derived rather than estimated: §2 = 28 rows, §3 = 12, §4 = 5, §6 = 13, §7 = 10, §8 = 7 — **75 env keys**; §5 = 8 store rows. Of the 75, **14 are secret-ref** and **0 are managed**; of the 8 store rows, **3 are managed**.

## 10. Legacy config to replacement

| legacy (du-gate) | src | replacement | status |
|---|---|---|---|
| `ExternalApiConnection` (endpoint/auth/prompt/timeout/state) | `schema.ts:72-96` | Connector revisions | partial — ledger exists (`connector/src/db/migrations/006`), Admin pane is a projection (`ACUI-M03`) |
| `ExternalApiOverride` (per-key/endpoint/step prompt) | `schema.ts:103-115` | **no equivalent** | **unmapped** |
| `ProfileEndpoint` (enabled/params/connectionsOverride/jobPriority/fileUrlAuth/extension allowlist) | `schema.ts:122-136` | `profile_bindings` | partial — bindings only, the policy fields have no column |
| `AppSetting` (key/value) | `schema.ts:142-146` | **no equivalent** | **unmapped** |
| `User` / `UserProfileAssignment` | `schema.ts:170-196` | `admin_local_users` | partial — no user-to-key assignment (ORCH-PAR-00: cutover-required) |
| `ENCRYPTION_KEY` | legacy `.env.example:11` | `CONNECTOR_ENCRYPTION_KEY` | name and semantics changed |
| `NEXTAUTH_SECRET` | legacy `.env.example:6` | `ADMIN_SHELL_COOKIE_SECRET` | **not equivalent** — no fallback chain |
| `NEXTAUTH_URL` | legacy `.env.example:7` | `DU_ADMIN_OIDC_PUBLIC_ORIGIN` | renamed |
| `OIDC_*` (4 keys) | legacy `.env.example:16-19` | `DU_ADMIN_OIDC_*` (5 keys) | renamed, one more required |
| `UPLOAD_DIR` / `OUTPUT_DIR` | legacy `.env.example:22-23` | **none** | **unmapped** — rework stores artifacts in PG/S3 |
| `MIGRATION`, `SEED_ADMIN_*` | legacy `.env.example:26-28` | `AUTO_MIGRATE`, seed CLI | partial |
| legacy AI-provider key UI | legacy `.env.example:14-15` | Connector credential (Vault) | different model — per-connector, not global |

**Three unmapped legacy surfaces** (`ExternalApiOverride`, `AppSetting`, `UPLOAD_DIR`/`OUTPUT_DIR`). None has a rework equivalent and none appears in the ORCH-PAR-00 journey table I read — they must be added to the dependency register or explicitly retired before cutover.

## 11. Defects found while cataloging

Read-only findings; **no file was changed**. Each is a template-versus-code disagreement, so the template misleads whoever deploys from it.

| # | Defect | evidence |
|---|---|---|
| **D1** | `.env.example:26` sets `CONNECTOR_REDIS_PREFIX`; the code reads **`REDIS_KEY_PREFIX`** (`connector/src/entrypoint.ts:13`). The template key is dead. | grep |
| **D2** | `.env.example:34` sets `DOCUMENT_CORE_CONCURRENCY`; the schema reads **`CONCURRENCY`** (`document-core/src/config.ts:9`). Dead. | grep |
| **D3** | `.env.example:32-33` sets `CONNECTOR_URL` but omits `CONNECTOR_SERVICE_TOKEN`, which `config.ts:35-38` makes **mandatory** whenever `CONNECTOR_URL` is present — the template's own combination fails validation. | grep |
| **D4** | `.env.example:27` ships `SERVICE_IDENTITY_SECRET=` **empty**, but `entrypoint.ts:69-73` requires a base64 32-byte value. The template cannot boot the connector as written. | grep |
| **D5** | The same logical secret has **two different env names**: orchestrator reads `INVOCATION_GRANT_SECRET` (`main.ts:123`) while compose gives the connector `CONNECTOR_INVOCATION_GRANT_SECRET` (`infra/docker-compose.yml:51`), and `.env.example:28` documents the orchestrator spelling. Following the template leaves the connector with an empty secret. | grep |
| **D6** | **A real 32-byte key is committed**: `.env.local.sample:31` sets `CONNECTOR_ENCRYPTION_KEY=JkfxSXSNv9dy56bWh0w+CVfHU3EWaw+IA/5AcB8CVnc=`. Anyone copying the sample into a real deployment publishes the credential-encryption key. `.env.example:29` correctly leaves it blank — the sample does not. | verified by grep |
| **D7** | `.env.example` omits **17 of the 41 orchestrator keys** — every OIDC, Vault, encryption, multipart, webhook, shutdown and admin-shell row. | §2 vs `.env.example` |
| **D8** | `infra/docker-compose.yml:48` sets `REDIS_KEY_PREFIX` to a colon-bearing value; this is the compose parse failure already recorded as a P8-06 defect. The value is **quoted** here, so this copy appears fixed while other copies may not be. | grep |

**D5 and D6 can break or expose a deployment** and should be raised before any ACUI work touches templates.

## 12. Cross-check against ACUI-M01..M07

| finding | covered by this catalog | remaining gap |
|---|---|---|
| **M01** forms write nothing | §5 CFG-PG-03 — the only real mutation path | API-key pane wiring is ACUI-05's scope |
| **M02** profile editor reads no revision | §5 CFG-PG-02 — `profile_bindings` **is** revisioned | the read path still returns `revision: 0` (`server.ts:2466-2510`); the store is fine, the projection is not |
| **M03** connector pane is a fake projection | §2.1 `connectorBaseUrls` unset, plus §6 | needs the deployment adapter before any real listing |
| **M04** OIDC/role not manageable | §3 — all 12 rows are boot-time env | needs managed policy and revision; ACUI-02 |
| **M05** shell depends on a static token | CFG-ORCH-05 plus §5 CFG-PG-04 | `admin_local_users` exists with no route |
| **M06** deployment config has no applied state | §2 (28), §6 (13), §7 (10), §8 (7) — **58 rows** | this catalog is the missing register; the applied-state mechanism does not exist |
| **M07** BFF reads with platform privilege | out of scope for a config catalog | ACUI-01's problem, flagged because it changes the read-permission column above |

M06 is now quantified: **58 rows** carry no applied-state concept. That is the number ACUI-09 starts from.

## 13. Not determined — stated, not guessed

1. **Connector revision/credential column semantics.** The 8 connector migrations exist (`001`-`008`) but I did not read their column definitions, so the connector managed rows are catalogued as *ledger existence proven, schema not read*. **ACUI-06 must read them before designing its pane.**
2. **`admin_crypto_config` read path for a DB-less deployment** — whether `buildCryptoConfigOptions` falls back to in-memory was not traced here.
3. **Effective-revision semantics for `profile_bindings`** — whether a new revision activates immediately or needs a publish step lives in `modules/profiles/profiles.ts`, which I did not read.
4. **Whether a deployment adapter exists outside this repo.** §9 says the deployment rows are unmanaged **based on this tree**; an external platform (ECS/K8s/SSM) could stage some of them.
5. **Legacy `AppSetting` contents** — which keys were actually used was not determined. The table is unmapped but may be empty in practice.
6. **lc-checker / doc-compare worker config.** Only `document-core` was in scope per the plan; other business packages may carry their own env surface.

## 14. What ACUI-00 unblocks

- **ACUI-09** now has a concrete row list (58 deployment rows) instead of the phrase process/infra config.
- **ACUI-02/04/06/08** each map to specific tables and columns, and the missing-revision gap for `admin_crypto_config` is named with the migration it needs.
- **ACUI-01** can build the catalog API contract from §Nguyên tắc 1 because every row now carries `id`, scope, mechanism and a managed flag.
- **Bootstrap** (§Nguyên tắc 2, last sentence): CFG-ORCH-05 plus CFG-PG-04 is the only current path to a first login, and CFG-PG-04 has no Admin route — so the bootstrap story is **unbuilt**, not merely unmapped.

**No gate is ticked by this receipt.**