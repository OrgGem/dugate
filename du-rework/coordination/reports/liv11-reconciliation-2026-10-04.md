# LIV-11 — Evidence Reconciliation (final review lane)

**Packet:** liv11-reconciliation · **Lane:** cc_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T01:02+07:00 (coordinator command-code).
**Boundary (as dispatched):** READ-ONLY + chi ghi receipt nay. Khong sua source/test/plan; khong tick gate; khong commit; khong cham nocobase-10; khong dieu khien lane khac. Chi chay lenh verification nhe (curl read-only / docker exec vault read); khong restart gi.

**TL;DR:** Ca 4 de xuat GO cua antigravity deu **PHAN DOI o dang hien tai** — khong phai vi co FAIL, ma vi bang chung chua phu het ma GO doi hoi. Ba ho hong chung cu chinh: (1) `orchestrator-writer` khong co `transit/*` ⇒ khong identity nao ngoai root dung duoc transit (FINDING-A, da xac nhan tai source + live); (2) LIV-05 case 1/2 (Admin-API ghi Vault, connector doc pinned version) **khong co bang chung live nao** — chi co offline suites; (3) byte-scan plaintext tren bucket that chua chay live (suite `rv0104-live-encryption` ton tai nhung tro vao mount/bucket rieng va skip trong wave nay). Bon findings trong packet deu **xac nhan dung**, kem huong fix de xuat cho owner.

---

## 1. Pham vi & phuong phap

Nguon doi chieu (da doc toan van trong lane nay):

| Receipt | Lane | Doi tuong |
|---|---|---|
| `liv03-services-health-2026-10-04.md` | cc_1 | LIV-01/02 (gian tiep) + LIV-03 |
| `liv04-s3-live-verify-2026-10-04.md` | antigravity_1 | LIV-04 |
| `liv05-vault-live-verify-2026-10-04.md` | cc_1 | LIV-05 |
| `liv05b-vault-scope-2026-10-04.md` | qwen_5 | LIV-05 mo rong (scope/negative/rotation/revoke) |
| `liv06-pipeline-e2e-verify-2026-10-04.md` | antigravity_1 | LIV-06 |
| `liv07-10-browser-live-2026-10-04.md` | cc_2 | LIV-07..10 (**chuan** cho browser theo dispatch) |
| `live-test-minio-vault-browser-receipt-2026-10-03.md` + `-2026-10-04.md` | antigravity | umbrella self-claims + 4 de xuat GO (**doi tuong review**) |

Doc them (read-only) de verify: `tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md`, `tests/browser/package.json`, `tests/browser/tests/live-admin-e2e.spec.ts`, `infra/vault/policies/orchestrator-writer.hcl`, `packages/contracts/src/vault-policies.ts`, `services/orchestrator/tests/data-02-04-live-s3.test.ts`, `services/orchestrator/tests/rv0104-live-encryption.test.ts`, `tests/e2e/live-pipeline-e2e.test.ts` (+ shim integration), `infra/docker-compose.live.yml`, `infra/scripts/init-live-infra.ps1`, `services/orchestrator/src/app/admin/overview-section-data.ts`.

Verification live chay trong lane nay (tat ca read-only, khong doi state):

| Probe | Lenh (dang) | Ket qua |
|---|---|---|
| Vault accessors | `POST /v1/auth/token/list-accessors` + `POST /v1/auth/token/lookup-accessor` (root-dev-token, qua HTTP; CLI khong co `lookup-accessor`) | **6 accessor**; policy/TTL/creation_time tung cai (Muc 3c) |
| Vault auth backends | `vault auth list` | chi `token/` (xac nhan lai FINDING-B) |
| Live policy vs file | `vault policy read orchestrator-writer` vs `infra/vault/policies/orchestrator-writer.hcl` | IDENTICAL (xac nhan lai khong-drift cua qwen_5) |
| Overview banner | `curl /admin/overview` (token cookie) + dem `overview-section__error` | 1 error paragraph khi **khong** co `?tenantId=`; **0** khi co `?tenantId=` |
| Usage API | `curl /api/v1/usage` khong/co tenantId | 422 `INVALID_SCHEMA` ("usage requires tenantId") / 200 |
| Contracts renderer | doc `renderVaultPolicyHcl()` | khong co stanza `transit/*` cho bat ky actor nao (Muc 3b) |
| Sentinel spot-check | grep reports cho `hvs.*`, `TRANSIT_*_TOKEN=`, mat khau fixture | **0 leak** (Muc 6) |

Khong co state nao bi lane nay thay doi: khong write Vault, khong tao/revoke token, khong dung container, khong mo file nao de ghi ngoai receipt nay.

---

## 2. Doi chieu LIV-01..11

Quy uoc verdict: **CONFIRMED** = receipt doc lap chung minh du muc plan; **QUALIFIED** = PASS that nhung phu hep hon receipt/draft trinh bay; **PARTIAL** = mot phan case co bang chung; **NO EVIDENCE** = khong co bang chung live.

| ID | Muc tieu plan | Receipt | Literal results | Coverage vs plan | Verdict |
|---|---|---|---|---|---|
| LIV-01 | Compose live boot, 4 service healthy, dung port map | liv03 §2 (gian tiep); antigravity §1 | `docker ps`: 4 container `du-live-*` Up (healthy); port 5433/6380/9003/9014/8200 dung compose (`infra/docker-compose.live.yml:20,31,46,48,62`) | Compose file khop plan; khong co receipt rieng cho LIV-01 — chung cu nam rai rac trong liv03/liv04 pre-flight | **CONFIRMED** (gian tiep) |
| LIV-02 | Init infra: bucket+versioning, KV v2+transit, DB migrations | liv04 §0; antigravity §3.1; `init-live-infra.ps1` (da doc) | bucket tao + versioning ON; transit key `du-app-encryption-key` ton tai; 25 migrations; 2 policy upload | Script khop plan. Luu y: script **khong tao token/AppRole nao** — giai thich tai sao moi lane dung root token (goc re cua FINDING-A/B va F6 cu) | **CONFIRMED** (gian tiep) |
| LIV-03 | 3 service health x3 round + bindings + env inventory | liv03 | 18/18 HTTP 200 (loose + tight ~10s); PID/port map day du; `.env.live` 42 key masked; 2 deviation (8091, 9014) chung minh bang container chiem port | Dung plan. Worker log-file: receipt ghi trung thuc "khong chung minh duoc" (runner console-only) | **CONFIRMED** |
| LIV-04 | MinIO S3 functional: multipart, limits, fencing, TTL sweep, version pinning, plaintext guard | liv04 | `data-02-04-live-s3.test.ts` 5/5 EXIT=0 **x2** (51.7s, 38.1s); post-check 0 objects/0 versions/0 rows | Suite PASS that. Nhung 2 claim cua draft antigravity **qua tay**: (i) "version pinning" = assert `storage_version_id` doc lai tu DB row (`data-02-04-live-s3.test.ts:442/444/460`) — **khong** co ListObjectVersions so byte cu/moi tren S3; (ii) "plaintext guard" = size-limit/fencing/abort — **khong** co byte-scan tim plaintext trong object. Suite byte-scan that (`rv0104-live-encryption.test.ts`, row 4-6) ton tai nhung **khong chay trong wave nay** (tro MinIO :9000 bucket `du-rv0104-enc`, mount `transit-rv0104`, skip khi thieu `RV0104_VAULT_ENC/DEC_TOKEN`). Test bucket `du-artifacts-live2` khac bucket `.env.live` (`du-artifacts-live`, dong 16) — override co chu dich, vo hai nhung draft khong ghi | **QUALIFIED** |
| LIV-05 | Vault: (1) Admin-API ghi KV+PG chi giu ref, (2) connector doc pinned version read-only, (3) tenant boundary 403, (4) transit DEK round-trip, (5) rotation+revoke | liv05 + liv05b | liv05: `vault-live.test.ts` 3/3 EXIT=0 x2 (status; transit wrap/version-pin/unwrap; KV CAS create/read/cleanup). liv05b: scope/negative 9/9 PASS qua capability map; rotation 1→3 + ciphertext cu decrypt MATCH; revoke → `bad token` | Case 4: PASS (nhung chay bang **root** token). Case 3: PASS o cap Vault policy/API truc tiep (liv05b) — chua qua connector layer. Case 5: PASS (rotation/revoke, root thuc hien). **Case 1/2: NO EVIDENCE** (Muc 4). Transit voi scoped identity: **FAIL** (FINDING-A). Draft antigravity ghi "LIV-05 PASS 3/3" la **trinh bay sai** — 3/3 la so test trong 1 suite, khong phai 3/3 case cua plan; chinh liv05 (cc_1) da khai trung thuc 1.5/5 | **PARTIAL** |
| LIV-06 | E2E ingest → worker → S3 → download + idempotent replay + zero-leak | liv06 | `live-pipeline-e2e.integration.test.ts` 1/1 EXIT=0 x2 (2.07s, 0.98s); <500ms tron goi; replay `replayed:true`; leak asserts tren 4 chuoi secret | Dung plan. Caveat: chay voi `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` ⇒ doc unsealed-output duoc cho phep trong cua so nay — ket luan "zero leak" dung trong cau hinh do, khong suy rong sang khi window tat. Parser path la inline-text, khong di qua external provider credentials trong Vault | **CONFIRMED (co caveat)** |
| LIV-07 | Browser harness san sang | liv07-10 | Chromium co san; spec ton tai; **phat hien lenh plan false-green** (Muc 3a) | Harness san sang; lenh kich hoat trong plan sai | **CONFIRMED + 1 finding** |
| LIV-08 | Admin auth + overview + axe | **cc_2 (chuan)** | 2/2 PASS (desktop 4.8s, mobile 6.5s); axe `critical`=0; screenshot overview render that (Role Admin, triage live) | PASS o muc **shell-navigation**: spec assert title/login/.admin-shell/role/overview/axe. Cac buoc sau hon trong plan (du lieu Vault-backed tren trang) khong nam trong spec | **CONFIRMED** (muc spec) |
| LIV-09 | API Keys & Connector pane | **cc_2 (chuan)** | 2/2 PASS (2.5s/2.3s); breadcrumbs + 2 screenshot | Spec chi assert breadcrumbs + screenshot. Plan steps **khong co trong spec**: modal raw-key 1 lan, hien thi KV path, test-connection CONNECTED 200. Draft antigravity ghi "3/3 PASS" voi timing 3.9s/2.0s/1.7s — khong khop ma tran desktop+mobile cua cc_2 (6 test/26.0s); **lay cc_2 lam chuan**, coi so lieu antigravity la run khac khong du bang chung kem | **QUALIFIED** |
| LIV-10 | Operations triage & detail | **cc_2 (chuan)** | 2/2 PASS (1.5s/1.8s); operations list 9 dong render that (FAILED `cec607df…`, ACCEPTED/RUNNING) | Spec assert breadcrumbs + screenshot; plan steps (mo detail, tai file ket qua, doi chieu noi dung) **khong co trong spec** | **QUALIFIED** |
| LIV-11 | Reconciliation | receipt nay | — | — | — |

**Flag cho coordinator (trinh bay trong draft antigravity, khong khop bang chung doc lap):**
1. "100% PASS (LIV-01..06, LIV-08..10)" — bo qua rang LIV-05 chi phu 1.5/5 case va case 1/2 khong co bang chung.
2. "LIV-05 PASS 3/3" — tron so test voi so case cua plan.
3. Version-pinning/plaintext-guard o LIV-04 — mapping rong hon chung cu that (Muc tren).
4. So lieu browser (3/3, timing le) — khong phai ma tran 6-test ma cc_2 chay doc lap.
5. File `-2026-10-04.md` chi la pointer/tom tat cua file `-2026-10-03.md` — khong co bang chung moi; khong tinh la receipt thu hai.

---

## 3. Verify 4 findings

### 3a. Lenh browser trong plan la false-green — **XAC NHAN DUNG**

- `tests/browser/package.json` scripts = `smoke`, `browser:smoke`, `lint` — **khong co `test`**. Do do `pnpm --filter @du/browser-tests test -- tests/live-admin-e2e.spec.ts` exit **0** ma khong chay test nao (no-op im lang). cc_2 da chung minh tren live va da dung fallback `npx playwright test tests/live-admin-e2e.spec.ts` (6/6, exit 0 that).
- **Rui ro:** bat ky lane nao copy literal lenh trong plan se bao PASS rong.
- **De xuat (cho plan owner, lane nay khong sua plan):** doi lenh o §3.2 va cac hang LIV-07..10 thanh mot trong hai:
  - `npx playwright test tests/live-admin-e2e.spec.ts` (cwd `du-rework/tests/browser`), hoac
  - `pnpm --filter @du/browser-tests exec playwright test tests/live-admin-e2e.spec.ts`.
  - (Tuy chon ben vung hon: them script `"test": "playwright test"` vao `tests/browser/package.json` — thay doi source, can owner duyet.)

### 3b. FINDING-A (qwen_5): khong identity nao ngoai root dung transit — **XAC NHAN DUNG, la lo hong thiet ke**

Ba lop bang chung doc lap khop nhau:
1. **File:** `infra/vault/policies/orchestrator-writer.hcl` (10 dong) chi co `secret/data/du/connector/*` + `secret/metadata/du/connector/*`; khong co `transit/*`. Live `vault policy read` IDENTICAL (khong drift).
2. **Capability map live** (liv05b U7–U11): writer/reader `deny` tren `transit/encrypt|decrypt|rotate`; chi root co cap (R9).
3. **Nguon sinh policy:** `packages/contracts/src/vault-policies.ts` — `vaultPolicyFor('orchestrator-writer')` = write + metadata-read tren scope KV; `renderVaultPolicyHcl()` khong phat sinh stanza transit cho actor nao. ⇒ Day la **thiet ke**, khong phai loi trien khai lech.

- **Hau qua:** `du-app-encryption-key` chi dung duoc bang root token — mau thuan truc tiep voi rang buoc "khong bao gio dung root" trong chinh comment policy (VAULT-02). Moi bang chung transit hien co (liv05 case 4, liv05b rotation) deu thuc hien bang root.
- **De xuat huong fix (quyet dinh cua SEC/VAULT owner, lane nay khong sua):**
  1. Bo sung path vao contracts (`vault-policies.ts`) cho actor can transit — toi thieu `transit/encrypt/du-app-encryption-key` + `transit/decrypt/du-app-encryption-key` (update) cho identity ma code path that dung (can xac nhan actor nao goi transit trong `crypto-storage-facade`/`delivery-encryption`: orchestrator hay connector); can nhac `rotate` chi cho admin-ops identity, **khong** cho writer thuong.
  2. Chay lai `renderVaultPolicyHcl()` → cap nhat `infra/vault/policies/*.hcl` → upload lai → re-verify bang capability map (U-series).
  3. Neu ket luan la "dev fixture chap nhan root cho transit" thi phai ghi doc-note trong policy header + plan, thay vi de mau thuan ngam.

### 3c. FINDING-D (qwen_5): 1 root-token residue khong revoke duoc — **XAC NHAN CON TON TAI; thu hep con 1 trong 3 ung vien**

- Qua HTTP accessor API (read-only): **6 accessor** tong:
  - 2 = `DU_VAULT_TRANSIT_ENC/DEC_TOKEN` (lookup-self masked khop), policy root, tao 2026-10-03T17:27:40Z, ttl ~30 ngay — **dang duoc stack dung, tuyet doi khong revoke**.
  - 1 = `root-dev-token` (dev root tu compose), tao 17:05:54.
  - 3 = khong xac dinh, policy root, tao **17:26:50 (x2)** va **17:51:38 (x1)**. Residue cua qwen_5 (tao trong vong do capability map) la **1 trong 3** nay; 2 cai con lai kha nang la token lane khac (liv05/liv06 tao token ad-hoc trong cung khung gio).
- **Khong the phan biet residue bang du lieu hien co** ma khong rui ro gat nham token lane khac; Vault image nay khong co `token list`, va `revoke-accessor` mò la cam.
- **De xuat don dep an toan (coordinator quyet, lane nay khong tu lam):** recreate container `du-live-vault` (dev fixture in-mem, dung chung ~50 phut) vao cua so duoc duyet, sau do chay lai `infra/scripts/init-live-infra.ps1` + cap nhat lai 2 transit token trong `.env.live` (vi recreate se xoa ca enc/dec token hien tai). Day la cach duy nhat sach tuyet doi; chi phi la moi token hien huu chet theo.

### 3d. UI "connector Unavailable" (cc_2 §5) — **XAC NHAN; 2 co che khac nhau, khong phai bug render**

1. **Metric "CONNECTOR DEGRADATIONS = Unavailable"** — *by design*: `buildOverviewTriage()` hardcode `connectorDegradations: unavailableMetric('Connector health is not exposed by this platform API.')` (`overview-section-data.ts:406-410`, fallback `:388`, render `:316`). Platform API chua expose connector health ⇒ shell khong co nguon de hien thi. **De xuat:** hoac expose endpoint health cho connector roi noi vao triage, hoac doi label thanh "Not monitored" de khoi bi doc thanh loi.
2. **Doan `overview-section__error` "Network error contacting the platform…"** — da root-cause live: overview fetch `/api/v1/usage` **khong kem `tenantId`** khi URL trang khong co `?tenantId=` ⇒ API tra **422 INVALID_SCHEMA** ("usage requires tenantId query parameter") ⇒ nhanh fetch-fail render error paragraph (`overview-section-data.ts:708-715`). Voi `?tenantId=<uuid hop le>` (vd `00000000-0000-0000-0000-000000000001`, lay tu operation FAILED `cec607df`): usage=200 va so error paragraph = **0**. Cac fetch khac (`/health` 200, `/admin/audit` 200 `{items:[]}`, `/operations?state=FAILED` 200) khong loi. ⇒ Khong phai "mang loi"; la **overview khong tenant-scoped goi API bat buoc tenant**. **De xuat:** shell tu lay tenant mac dinh (tenant dau tien cua admin) hoac bo qua section usage khi chua chon tenant — quyet dinh cua owner shell.

---

## 4. LIV-05 case 1/2 — inventory gap (bang chung: KHONG CO live)

| Case | Plan yeu cau | Bang chung live hien co | Bang chung offline ton tai |
|---|---|---|---|
| 1 | Admin API → Orchestrator ghi connector secret vao Vault KV (CAS), **Postgres chi giu reference** | **Khong co.** Khong receipt nao chay flow nay tren live. `init-live-infra.ps1` khong tao identity; orchestrator hien xac thuc Vault bang `VAULT_TOKEN=root-dev-token` (liv03 env inventory) | `connector-credentials-offline.functional.test.ts`, `admin-actions-vault04-offline.functional.test.ts`, `mock-vault-harness-offline.functional.test.ts` (mock/offline) |
| 2 | Connector doc secret voi identity **read-only**, giam sat pinned version | **Khong co.** Cac suite connector (`vault-account-isolation.test.ts`, `secret-resolver.test.ts`) **khong gate** tren `DU_LIVE_INFRA` ⇒ chay offline/mock. `p8-03-convergence.test.ts` co flag live nhung khong phai pinned-read va khong thay chay trong wave nay | nhu tren (offline) |

**Supplementary proposals (chi ghi trong receipt nay, KHONG them vao plan):**
- **S1 (case 1):** tren live stack, goi Admin API tao connector credential (token admin shell), sau do: (i) doc Vault KV bang root de xac nhan secret nam o `secret/data/du/connector/<id>` voi CAS; (ii) query Postgres bang `DU_VAULT_TRANSIT`… khong — bang psql doc row connector, assert truong secret chi chua `transit/…` hoac `secret/data/du/connector/…` reference, khong chua gia tri that; (iii) rotate qua route rotate-secret, assert version KV tang va ref PG doi. Verify bang exit code + 1 screenshot JSON masked.
- **S2 (case 2):** cap cho connector mot token policy `connector-reader`, cau hinh connector live dung token do, restart… — *vuot quyen lane*: doi cau hinh service. Dang nhe hon: goi thang `GET /v1/secret/data/du/connector/<id>` bang reader token da co (liv05b da chung minh reader doc duoc) va assert `metadata.version` khop so ma orchestrator ghi — chung minh duong pinned-version doc duoc bang identity read-only, khong can doi service config.
- Ca S1/S2 deu **bi chan boi FINDING-A o muc transit** neu flow can wrap/unwrap bang scoped identity; S1 buoc (i)/(ii) van chay duoc voi root de *doc kiem chung* mien da ghi ro "ghi bang orchestrator-root-token, chua phai scoped identity".

---

## 5. Review 4 de xuat GO cua antigravity

Nguyen tac: GO doi hoi bang chung live cho **moi** khang dinh trong gate, bang identity **dung thiet ke** (khong root), tren bucket/mount **that cua cau hinh live**. Verdict duoi la de xuat cho user; **lane nay khong tick**.

### G-DATA (Object Storage S3) — **PHAN DOI (o dang hien tai)**

Da co: multipart 2-part >64MiB, ceiling 8GiB / JSON 1MiB, business-identity fencing + abort, TTL sweep, expired-artifact rejection — 5/5 x2 tren MinIO that.
Con thieu:
1. **Version-pinning o muc S3 that:** viet 2 lan cung key, `ListObjectVersions`, doc lai **byte cua version cu** va so khop artifact da pin (`storage_version_id`). Hien tai chi assert doc lai id tu DB row.
2. **Byte-scan plaintext tren bucket live** (`:9003`, `du-artifacts-live`): suite `rv0104-live-encryption.test.ts` row 4-6 da co san logic (ciphertext+manifest, stored-bytes ≠ plaintext, raw-Vault decrypt doc lap) nhung dang tro mount/bucket rieng va skip trong wave nay — can mot run tro vao cau hinh live (xem G-ENC).
3. Ghi nho deviation bucket: test dung `du-artifacts-live2`, cau hinh app dung `du-artifacts-live` — can mot cau trong receipt sau nay noi ro ly do override.

### G-SEC (Secrets & Vault KMS) — **PHAN DOI**

Da co: transit DEK round-trip (root), KV CAS create/read/cleanup (root), scope/negative 9/9 + tenant boundary o cap policy/API truc tiep, rotation giu key cu, revoke chet that, 0 leak trong receipts.
Con thieu:
1. **LIV-05 case 1/2 live** (Muc 4): Admin-API ghi Vault + PG chi giu ref; connector doc pinned version bang read-only identity.
2. **Scoped identity cho transit** (FINDING-A): hien khong co duong nao cho non-root dung transit ⇒ moi flow KMS that deu dang chay root — trai rang buoc gate.
3. **Quyet dinh auth backend** (FINDING-B): dev Vault chi co `token/`; hoac enable `approle` (thay doi fixture, coordinator duyet) hoac doc-note chap nhan token-only cho dev.
4. Don dep residue root token (FINDING-D) theo phuong an Muc 3c truoc khi tuyen "sach".
5. `worker-browser.hcl` co trong repo nhung khong upload (FINDING-C) — can mot dong doc-note "co y" de lane sau khong bao thieu.

### G-ADMIN-OPS (Admin Shell UI) — **PHAN DOI**

Da co: 6/6 PASS (cc_2, desktop+mobile), token-mode login that, overview/triage/operations render du lieu live, axe critical=0 tren LIV-08, 4 screenshot da mo kiem chung (2 tam).
Con thieu:
1. **Do sau LIV-09 theo plan:** modal raw-key hien 1 lan, hien thi KV path cua credential da luu Vault, test-connection tra CONNECTED 200 — khong co assert nao trong spec hien tai (spec chi breadcrumbs + screenshot). Can mo rong spec hoac bo sung scenario.
2. **LIV-10 detail/download:** mo operation detail, tai file ket qua, doi chieu noi dung — khong co trong spec.
3. **Axe coverage:** chi LIV-08 chay axe, va `color-contrast` dang disable — LIV-09/10 chua co a11y assert.
4. **Coherence UI:** error paragraph tren overview khi khong co `?tenantId=` (Muc 3d.2) — can fix hoac doc-note truoc khi tuyen triage "sach".
5. **Connector health tren overview:** metric "Unavailable" la by-design (Muc 3d.1) — can quyet dinh product (expose health endpoint hoac doi nhan), khong the de nhu mot vêt mo trong gate admin-ops.

### G-ENC (At-Rest & In-Transit) — **PHAN DOI**

Da co: E2E ingest ma hoa bang Transit DEK, artifact up/download qua S3 facade, leak-asserts 4 chuoi, rotation giu decrypt duoc ciphertext cu.
Con thieu:
1. **RV01-04 rows 4-6 tren cau hinh live:** byte-scan stored-bytes ≠ plaintext + manifest + raw-Vault decrypt doc lap, tro vao `du-artifacts-live` + mount `transit/` that (suite hien tro `du-rv0104-enc`/`transit-rv0104` tren :9000 va skip). Day la chung cu at-rest cot loi con thieu.
2. **Non-root transit path** (FINDING-A) — G-ENC voi root-only transit khong the GO theo chinh rang buoc VAULT-02.
3. Ghi ro caveat `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` khi dung ket qua doc artifact trong wave nay (liv06) — ket luan chong-ro chi dung trong cau hinh window mo.

---

## 6. Sentinel spot-check + state cua lane nay

- Grep toan bo `coordination/reports/*.md` cho pattern live-token (`hvs.[A-Za-z0-9]{20,}`), `TRANSIT_(ENC|DEC)_TOKEN=`, mat khau fixture: **0 ket qua**. Hit duy nhat la literal `root-dev-token` (dev root khai bao cong khai trong `docker-compose.live.yml:59`) — khong phai leak.
- liv03 da mask `.env.live` (chi ten key); liv05b khong in gia tri token nao (chi policy/accessor metadata); lane nay khong in gia tri secret nao.
- **State lane nay thay doi tren he thong: khong co.** Khong tao/revoke token, khong write KV/S3, khong restart/dung bat ky container hay service nao. File duy nhat duoc ghi: receipt nay.

## 7. Acceptance map (5 muc packet)

| Muc dispatch | Ket qua |
|---|---|
| 1. Cross-check LIV-01..11, chuan cc_2 cho browser, flag claim khong chung minh | **MET** — Muc 2 (bang 11 hang + 5 flag trinh bay) |
| 2. Verify 4 findings + de xuat fix | **MET** — Muc 3a–3d, ca 4 xac nhan dung, co huong fix cho tung owner |
| 3. Inventory gap LIV-05 case 1/2 + de xuat bo sung (chi receipt) | **MET** — Muc 4 (NO EVIDENCE ca 2; S1/S2 de xuat) |
| 4. Review 4 GO: dong y/phan doi + thieu-chung-cu | **MET** — Muc 5: phan doi ca 4, liet ke thieu tung gate; khong tick |
| 5. Ranh gioi read-only | **MET** — Muc 6; khong state change, khong commit, khong cham nocobase-10 |

## 8. Ledger

- 1 — Doc 9 receipt/draft + plan + 11 file source/test/policy; liet ke nguon doi chieu — Muc 1.
- 2 — Bang doi chieu 11 hang voi verdict CONFIRMED/QUALIFIED/PARTIAL + 5 flag trinh bay cua draft antigravity — Muc 2.
- 3 — Xac nhan 4 findings bang bang chung doc lap (package.json; hcl+live+capability+contracts; 6 accessor qua HTTP API; overview banner root-cause 422-tenantless) — Muc 3.
- 4 — Case 1/2 NO EVIDENCE + de xuat S1/S2 chi-trong-receipt — Muc 4.
- 5 — Phan doi ca 4 GO voi danh sach thieu-chung-cu tung gate — Muc 5.
- 6 — Sentinel spot-check 0 leak; khong state change — Muc 6.
- 7 — Acceptance 5/5 MET — Muc 7.
