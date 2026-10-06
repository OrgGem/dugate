# PAR-11..17 — Code-state gap matrix (READ-ONLY, tu re-derive)

## RESUME POINT — 2026-10-03

- **Vai tro:** read-only gap matrix. **Khong chay test, khong sua file, khong tick, khong commit.** Chi ghi receipt nay.
- **Phuong phap:** doc working tree hien tai, **khong tin mo ta Gap cua plan**. Moi claim deu kem file:line do duoc luc ghi.
- **Phat hien lon nhat:** **`server.ts` con 375 dong** (khong con route table) — route family da tach sang `src/http/routes/*`, composition sang `src/app/bootstrap/create-app.ts`. Serialize list cua plan **da lech** (Muc 4).
- **Ket luan ngan:** 7/7 row **thieu** so voi plan; nhung **PAR-11 va PAR-17 da xong nhieu hon plan mo ta** (copy-once, audit, no-store, usage projection).

## 1 — Ban doan chung (nen de doc Muc 2)

| Fact | Do duoc |
|---|---|
| `server.ts` | **375 dong** — route table da sang `src/http/routes/{runtime,public,admin}.ts`, composition sang `src/app/bootstrap/create-app.ts` |
| `app/admin/shell-router.ts` | da tach (CONV-12) thanh `auth-dispatch.ts`, `section-dispatch.ts`, `mutation-dispatch.ts`, `crypto-config-dispatch.ts`, `shell-router-shared.ts` |
| `modules/admin-actions/dispatcher.ts` | **774 dong**, `ADMIN_ACTIONS` = **12 action** tai `:96-120` |
| `modules/profiles/profiles.ts` | **165 dong** |
| `modules/connectors/connectors.ts` | **84 dong** (readiness probe + base URL) |
| `docs/21-openapi.json` | **44 path**, chi **6** path `/admin`, **0** api-keys, **0** settings, chi `profile-bindings` |
| migrations | 16 bang; **khong co** bang user↔key assignment, profile-endpoint, settings, connection, workflow schema; co `0023_admin_local_users`, `0004_profile_bindings`, `0020_admin_crypto_config` |

## 2 — Bang gap matrix (dong yeu cau)

### PAR-11 — API key lifecycle field-level

| Cot | Noi dung |
|---|---|
| **Da co gi** | `dispatcher.ts:105` `apikey.issue` (case `:540`): tenant fence `:556`, hash `:560`, prefix `:563-566`, `INSERT INTO api_keys (tenant_id, hash, prefix)` `:573`, audit `apikey.create` `:581-585`, raw tra **mot lan** trong 201 (comment `:544-545`); `:106` `apikey.revoke` (case `:619`, doi status); `:100` `apikey.bind-profile`; DDL `0001_platform_v1.sql:14-21` (`hash` unique, `prefix`, `status` default ACTIVE); `routes/admin.ts:505,513` `GET /api/v1/admin/api-keys(/:keyId)`; UI `mutation-dispatch.ts:71` + **3 response `cache-control: no-store`** (`:46,:87,:111`) |
| **Thieu gi so voi plan** | (a) **note**: DDL **khong co** cot `note`, khong co action update-note; (b) **rotate giu nguyen id**: roster khong co `apikey.rotate` — chi co revoke la terminal; (c) **delete-guard Global Profile**: **0 hit** toan repo; (d) **list scope theo user assignment**: khong co bang/API assignment, scope hien la **tenant**; (e) acceptance 2-replica live chua chay |
| **Loai** | code + migration (note) + **decision** (scope: tenant vs assignment; co xoa apikey.* khong) |
| **Lease de xuat** | `dispatcher.ts`, `src/http/routes/admin.ts`, migration moi, `app/admin/api-key-section-*.ts`, offline test |
| **Size** | **M** |

### PAR-12 — ProfileEndpoint policy + merge/lock

| Cot | Noi dung |
|---|---|
| **Da co gi** | profile revision co `connectorBindings` (slot → connectorId@revision): `packages/contracts/src/runtime.ts:63,65`; dispatcher `:485-487`; `routes/admin.ts:193,200`; `POST /api/v1/admin/profile-bindings` `:151`; `GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName` `:420` |
| **Thieu gi** | **0 hit** toan `src/` cho `allowedFileExtensions`, `jobPriority`, `connectionsOverride`, `fileUrlAuthConfig`; khong co truong policy versioned (lock semantics khong ton tai); admission seam trong submission chua goi chung policy; thieu golden-profile matrix (locked same-value 400, CAS stale revision 409, disabled 4xx) |
| **Loai** | code + contract |
| **Lease de xuat** | `packages/contracts` (schema profile policy), `modules/profiles/profiles.ts`, seam admission o `modules/operations/submission.ts`, `routes/admin.ts`, offline test. **Serialize** voi `dispatcher.ts` neu sua action |
| **Size** | **L** |

### PAR-13 — Per-key per-step prompt override (key-4)

| Cot | Noi dung |
|---|---|
| **Da co gi** | **khong co gi** — `promptOverride`, `extConnections`, `ext-connections`, `_default` deu **0 hit** trong `src/`; khong co bang `ext_api_overrides` trong migrations |
| **Thieu gi** | toan bo slot key-4 trong profile revision; Admin GET enrichment; CRUD + audit/diff/rollback theo revision; cross-tenant fence |
| **Loai** | code + migration + contract |
| **Lease de xuat** | migration moi, `packages/contracts`, `routes/admin.ts`, `modules/profiles/profiles.ts`, offline test |
| **Size** | **M** |

### PAR-14 — Connection lifecycle + Vault write-only

| Cot | Noi dung |
|---|---|
| **Da co gi** | `modules/connectors/connectors.ts:31-36` readiness probe + base URL; `routes/admin.ts:229` `POST/GET .../credentials`, `:459,:469` `GET .../revisions/:rev`; `dispatcher.ts:118-120` 3 action `connectors.rotate_credential` / `revoke_credential` / `test_credential` (admin-only, comment VAULT-04 `:114-117`); phia Connector **co** lifecycle revision: `services/connector/src/http/server.ts:230` `revisions/bootstrap`, `:282` `revisions/current`, `:288` `revisions/:n` |
| **Thieu gi** | `authType`, `authSecret`, `authKeyHeader` **0 hit**; `vaultRef`/`vaultPath` **0 hit** → **khong co** credential write-only Vault ref, khong co Admin proxy create/list/detail/update-as-new-revision/activate/retire/disable/binding, khong co allowlist egress |
| **Loai** | code + Vault + contract |
| **Lease de xuat** | `dispatcher.ts`, `routes/admin.ts`, `modules/connectors/connectors.ts`, module vault; **can them lease `services/connector`** neu dung revision lifecycle. Serialize voi `dispatcher.ts` |
| **Size** | **L** |

### PAR-15 — Settings 17 key → replacement map

| Cot | Noi dung |
|---|---|
| **Da co gi** | **khong co gi** — `ai_provider`, `ai_api_key`, `s3_bucket`, `s3_cache_ttl_hours`, `ai_compare_prompt` **0 hit**; **khong co** route `/api/v1/admin/settings` trong `routes/admin.ts`; `docs/21-openapi.json` **0** path settings |
| **Thieu gi** | ca bang mapping 17 key → replacement; surface doc setting moi; diagnostics bounded; redaction/rollback test |
| **Loai** | **decision truoc** (bang mapping la do **PAR-00** ky) → roi moi la code |
| **Lease de xuat** | **khong the tu dispatch** — cho `PAR-00` ky register truoc; sau do: module settings moi + `routes/admin.ts` + UI |
| **Size** | **L** (decision + code) |

### PAR-16 — User ↔ key assignment + workflow schema catalog

| Cot | Noi dung |
|---|---|
| **Da co gi** | **khong co** user↔key assignment: `apiKeyIds` **0 hit** trong code (cac hit chi la comment ve assignment pane cua UI grant); co `apikey.bind-profile` (`dispatcher.ts:100`) + `POST /api/v1/admin/profile-bindings` (`routes/admin.ts:151`) — day la **profile binding**, khong phai gan key cho user; co `0023_admin_local_users` |
| **Thieu gi** | schema catalog: `schemaSlug`, `validateSchema`, `saveSchema`, `workflow-schemas` **0 hit**; khong co bang schema/DAG/cycle guard; **quyet dinh PAR-05** (giu assignment hay thay bang role×tenant×profile) chua co |
| **Loai** | **decision** (PAR-05) + code + migration |
| **Lease de xuat** | sau decision: migration moi (assignment + schema), `routes/admin.ts`, `dispatcher.ts`, offline test |
| **Size** | **M** (assignment) / **L** (schema catalog) |

### PAR-17 — Ops/analytics/docs + explicit non-parity

| Cot | Noi dung |
|---|---|
| **Da co gi** | usage projection qua service: `src/app/bootstrap/create-app.ts:30` `createUsageService`, wire `GET /api/v1/usage` (`overview-section-data.ts:630`); `GET /api/v1/admin/audit` (`routes/admin.ts:666`); `POST .../operations/sweep-deadlines` (`:262`); crypto-config GET/POST (`:575`) |
| **Thieu gi** | (a) **khong co OpenAPI duoc serve**: `openapi` **0 hit** trong `src/`; (b) `docs/21-openapi.json` chi **44 path / 6 admin / 0 api-keys / 0 settings** → chua bao gio control-plane; (c) safe-ops console action con thieu (stalled lease/recovery, retry/deadline, queue depth, retention) — chi co sweep-deadlines; (d) bang **explicit non-parity** chua co register/migration/rollback |
| **Loai** | code + decision (non-parity retire) + docs |
| **Lease de xuat** | `routes/admin.ts` (safe-ops actions), `docs/21-openapi.json` (**freeze sau COMP-02**), ops docs; khong mo `packages/contracts` |
| **Size** | **M** (safe-ops) / **L** (OpenAPI + non-parity register) |

## 3 — Thu tu dispatch de xuat

1. **PAR-11 (M)** — ngan, khong can contract freeze; tach 2 dong route moi, lam duoc ngay, tao nen cho fixture external.
2. **PAR-12 (L)** — dat contract truoc (`packages/contracts`), roi profile policy + admission seam.
3. **PAR-14 (L)** — can Vault lease truoc; chen sau PAR-12 de profile revision da co version de gan revision.
4. **PAR-13 (M)** — phu thuoc revision shape cua PAR-12 nen **sau PAR-12** (ke ca khi size nho hon).
5. **PAR-16 (M/L)** — tach 2 phan: assignment (M) va schema catalog (L); **assignment** truoc, schema catalog sau.
6. **PAR-15 (L)** — **chi sau khi `PAR-00` ky bang mapping**; khong chan cutover-required.
7. **PAR-17 (M/L)** — safe-ops truoc (M), OpenAPI + non-parity sau (L) va **sau COMP-02 freeze**.

> **Khac plan mot chút:** plan xep PAR-11/12/13/14/16 cung mot hang va PAR-15/17 theo sau. Do code hien tai, **PAR-13 phai sau PAR-12** (moi can revision versioned) va **PAR-16 phai tach 2 phan**. Doc lai truoc khi ban giao coordinator.

## 4 — Cho doan plan DA LECH so voi code

| # | Plan noi | Code do duoc | Muc do |
|---:|---|---|---|
| 1 | Serialize bat buoc gom `services/orchestrator/src/server.ts` | `server.ts` = **375 dong**, khong con route table; route o `src/http/routes/*` | **Lech lon** — serialize list phai chuyen sang `routes/admin.ts` + `app/bootstrap/create-app.ts` + `dispatcher.ts` |
| 2 | Cite `shell-router.ts` nhu file serialize | da tach thanh 5 module dispatch (CONV-12) | **Lech** |
| 3 | PAR-11 thieu copy-once `no-store` | `dispatcher.ts:540-545` raw tra 1 lan + `mutation-dispatch.ts:46,87,111` `no-store` | **Da xong, plan stale** |
| 4 | PAR-11 thieu prefix/hash contract | `:560` hash, `:563-566` prefix, `:573` insert ca 2 | **Da xong** |
| 5 | PAR-12: profiles.ts chi revision connectorBindings | dung (`profiles.ts` 165 dong, 0 hit policy field) | **Dung** |
| 6 | PAR-14: chi probe readiness, khong credential/header | dung (`connectors.ts` 84 dong, 0 hit authType/authSecret) | **Dung** |
| 7 | Plan nhac dispatcher `:95-121` co apikey.issue/revoke/bind-profile | dung, va **con** `operations.sweep-deadlines` + 3 `connectors.*_credential` → tong **12** | **Plan thieu 4 action** |
| 8 | Plan gia dinh migration co bang cho assignment/endpoint | 16 bang, **khong co** bang nao cho assignment/profile-endpoint/settings/connection/schema | **Plan thieu context** |

## 5 — Method + ranh gioti

- Chi doc file (`.ts`, `.sql`, `.json`). **Khong chay test, khong build, khong typecheck** (packet cam).
- Moi claim kem file:line do duoc; ket luong **0 hit** la phep kiem negative co dieu kien (regit chua dung) — neu do la false negative, nhan o `uncertain`.
- **Khong sua** plan, source, test; **khong tick** gate; **khong commit**; **khong cham** `nocobase-10`.
- File doc nhieu: `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md`, `dispatcher.ts`, `routes/admin.ts`, `packages/contracts/src/runtime.ts`, migrations, `docs/21-openapi.json`, `connector/src/http/server.ts`, `shell-router*.ts`.

## 6 — Ledger

- 1 — Do lai nen chung: server.ts 375 dong, shell-router da tach, 12 admin action, OpenAPI 44 path — Muc 1.
- 2 — Gap matrix 7 row (da co gi / thieu gi / loai / lease / size) — Muc 2.
- 3 — Thu tu dispatch de xuat; tach 2 phan PAR-16; PAR-13 sau PAR-12 — Muc 3.
- 4 — 8 cho plan lech so voi code, gom 2 lech lon ve serialize list — Muc 4.
- 5 — Read-only, khong chay test, khong tick/commit — Muc 5.