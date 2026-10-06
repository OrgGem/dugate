# RECON-I — Chot vong reconcile: file plan con lai (READ-ONLY)

## RESUME POINT — 2026-10-03

- **Ket luan 1 dong:** **reconcile sweep COMPLETE** — ca **37/37** file trong `tasks/*.md` da co chu so hoac khong con row mo; **khong con file nao thieu owner**.
- **RECON-I adjudication truc tiep: 5 file / 40 row** (COMP 12, CRX 5, DOC-SYNC+CODE-FIX 5, ORCH-PAR-11..17 7, ACUI-00..10 11).
- **Khong adjudication:** 12 file do RECON-A..H phu (5 receipt da co, **D/F/H con bay**), 8 file **0 row mo**, 2 template, P8 (da co `codex-p8-open-audit-2026-10-03.md`).
- **Phat hien quan trong:** compat facade **DA MOUNTED** — `server.ts:1856` -> `src/compat/legacy-http-mount.ts:383`; `/api/v1/docs/*` co bang route that tai `legacy-action-router.ts:68` va duoc RV01 chay tren socket that. COMP-03 **khong con open**.
- **Ranh gioti:** read-only, khong chay test, khong sua file nao, khong tick, khong commit.

## 1 — Bang phu (37 file)

| Nhom | File | Chu so |
|---|---|---|
| A | `REVIEW-FIXES-2026-09-23`, `PLAN-MISMATCH-FIXES-2026-09-23` | `recon-old-plans-a` (da co) |
| B | `FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24`, `ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27`, `REVIEW-FIXES-2026-09-24` | `recon-old-plans-b` (da co) |
| C | `ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01`, `ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01` | `recon-old-plans-c` (da co) |
| **D (bay)** | `CODE-REVIEW-FOLLOWUP-2026-09-28`, `IMPLEMENTATION-FIRST-COORDINATION-2026-10-01` | spec `2026-10-03-0022-RECON-D.md`, **receipt chua co** |
| E | `APP-ENCRYPTION-2026-09-27` | `recon-old-plans-e` (da co) |
| **F (bay)** | `ADMIN-OPS-UX-2026-09-24`, `ADMIN-LOCAL-AUTH-2026-09-30`, `P7-extension-proof` | spec `2026-10-03-0032-RECON-F.md`, **receipt chua co** |
| G | `DEPLOY-STORAGE-LOGGING-2026-09-24`, `P0-business-specs`, `P1-foundation-contracts`, `P2-orchestrator`, `DETAILED-BUSINESS-VERIFICATION-2026-10-01` | `recon-old-plans-g` (da co) |
| **H (bay)** | `SEC-OIDC-VAULT-2026-09-24`, `P9-business-backlog` | spec `2026-10-03-0044-RECON-H.md`, **receipt chua co** |
| Lane khac | `P8-release-readiness` | `codex-p8-open-audit-2026-10-03.md` — da adjudicate ca 8 dong, co de xuat dispatch; **khong dong nao du evidence de tick** |
| **RECON-I** | `API-COMPAT-DUGATE-2026-09-28` (12), `CODE-REVIEW-ADDENDUM-2026-10-01` (5), `ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02` (5), `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02` (7), `ADMIN-CONTROL-PLANE-UI-2026-10-02` (11) | **receipt nay — Muc 2** |
| 0 row mo | `P3-connector` (8 `[x]`), `P4-worker-sdk` (`[x]` het; 4 `[~]` chi nam trong comment reconcile), `P6-admin` (`[x]` het), `P5-document-core` (10 `[x]`), `CODE-REVIEW-FIXES-2026-10-01`, `ORCH-REVIEW-FIXES-2026-10-02`, `ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01`, `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02` (khong co cot trang thai; status o `tasks/README.md`), `README.md` (chi la board/index) | khong can reconcile |
| Template | `AGENT-TASK-TEMPLATE.md`, `CLAUDE-REVIEW-TEMPLATE.md` | khong phai plan |

- **Canh bao stale trong P5-document-core:** 8 dong `[x]` van ghi «28 variants» / «5 variants» cho extract/analyze, trong khi code **va docs da la 31** (do o DOC-SYNC lane truoc). Marker tick dung, **so lieu trong bang sai** — nen sua text, khong phai tick/untick.

## 2 — Verdict tung row (RECON-I)

Tat ca cite duoi la **do duoc luc receipt nay**, khong lai receipt khac.

### 2.1 `API-COMPAT-DUGATE-2026-09-28.md` (12 row COMP-00..11, L49-60, het `[ ]`)

| ID | Verdict | Bang chung | Con thieu |
|---|---|---|---|
| COMP-00 | **uncertain** | characterization: `codex-legacy-auth-fence-inventory-2026-10-01.md`, `cmdcomp01-q15-{1hop,close-1hop}-2026-10-02.md` | quyet dinh URL/bounds/lifecycle/auth **chua co sign-off** san |
| COMP-01 | **open** | 8 slice `codex-comp01-slice-a..h-2026-10-02.md` + hop nhat `qwen-comp01-consolidate-2026-10-02.md` | chua co dong acceptance nao dong lai bang chung |
| COMP-02 | **open** | `cmdcomp01-q15-*`, `qwen-comp01-g1-guide-mismatch-2026-10-02.md` | chua co **freeze sign-off** cho legacy default tren path cu |
| COMP-03 | **done (mechanism)** | `server.ts:1856` goi `handleLegacyRoute`; `src/compat/legacy-http-mount.ts:383`, `legacy-action-router.ts:68` (`/api/v1/docs/`), 6 action + `workflows` + `workflows/schema`; `tests/rv01-loopback-http-offline.test.ts:707,767` chay 6 submit tren **socket that** | con parity defect pin bang `it.failing` trong receipt RV01 |
| COMP-04 | **open** | `codex-document-core-missing-variants-2026-10-01.md`, `codex-crx05-recipe-catalog-smoke-2026-10-02.md`; do: 3 variant `id-card`/`fact-check`/`summarize-eval` co trong manifest **va** recipes | chua co bang doi 31/31 co sign-off |
| COMP-05 | **open** | `codex-comp05-result-projection-gap-2026-10-01.md` — ban than **gap**; them `codex-comp05-executable-fixture-spec-2026-10-01.md` | projection `result` chua dong |
| COMP-06 | **open** | RV01 chay list + `page_token` tren socket; `codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md` | parity + gap COMP-05 |
| COMP-07 | **open** | RV01 chay cancel/resume/download/DELETE tren socket | parity defect chua dong |
| COMP-08 | **open** | chi co characterization: `cmdcomp09-workflow-brief-2026-10-02.md`, `codex-legacy-opsadmin-settings-journeys-2026-10-01.md` | chua co projection `/services`, `/billing/*` |
| COMP-09 | **open** | `qwen-connector-bindings-inventory-2026-10-02.md`, `qwen-legacy-process-name-evidence-2026-10-02.md`, `cmdcomp09-workflow-brief-2026-10-02.md` | mapping + quyet dinh chua chot |
| COMP-10 | **open** | **khong co** dual-run harness; RV01 chi chay 1 he thong va so voi fixture legacy | can runner cua he thong cu + consumer sign-off |
| COMP-11 | **uncertain** | 4 file doc ton tai va co noi dung compat: `docs/06-public-api.md` 209 dong, `docs/20-openapi-descriptions.md` 189, `docs/21-openapi.json` 2158, `compatibility-matrix.md` 105 | thieu diff tung claim de chung minh da sync |

### 2.2 `CODE-REVIEW-ADDENDUM-2026-10-01.md` (5 row CRX-01..05, L9-13, **khong co checkbox**)

| ID | Verdict | Bang chung | Con thieu |
|---|---|---|---|
| CRX-01 | **open — dang co lane khac chay** | `cc-crx01-metadata-seam-2026-10-03.md`, `cc-enc-meta-writer-scan-2026-10-03.md` (vua sinh hom nay) | de lane do khong lap |
| CRX-02 | **open** | chi co `codex-crx03-seam-decision-pack-2026-10-03.md` + register | chua co implementation receipt |
| CRX-03 | **done** | `packages/worker-sdk/src/crypto-storage.ts` + `crypto-seam.ts` ton tai; `codex-crx03-worker-seam-2026-10-02.md` | lane nay **khong chay lai test** (read-only) |
| CRX-04 | **open** | chi co register; P9-01/P9-02 da co code nhung quyet dinh boundary chua ghi | can decision record |
| CRX-05 | **done** | 3 variant do co trong manifest + recipes; docs da doi 31 (`docs/10-document-core.md:16`, `variant-matrix.md:1/3/5`, `architecture/01,04,07,09,README`) | — |

### 2.3 `ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md` (5 packet `[~]`)

| ID | Verdict | Bang chung | Con thieu |
|---|---|---|---|
| DOC-SYNC-01 | **done** | 14/17 muc da land san; 3 sua cua lane nay (`qwen-docsync-2026-10-03.md`) | 3 muc ngoai lease (Muc 5 file do) |
| DOC-SYNC-02 | **done** | `docs/07-internal-api.md:41` + `docs/21-openapi.json:2157` (`x-absent`) da dung; `variant-matrix.md` + `docs/10:16` da 31 | `architecture/05:56` con sai, ngoai lease |
| DOC-SYNC-03 | **done** | `architecture/01:14,15,20`, `04:144,148`, `README:38`, `07-capacity:59`, `09-readiness:22,23,34,62` deu 31 | — |
| CODE-FIX-01 | **done** | code da sua: `app/admin/connector-section-renderer.ts:318` noi dung; action tai `dispatcher.ts:677,727,753`; `connector-bindings` 0 match trong `server.ts` | chua chay lai test |
| CODE-FIX-02 | **done** | `connector/src/webhook.ts` export + re-export `index.ts:28`; `http/server.ts` 0 match `webhook` | chua chay lai test |

### 2.4 `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` (7 row ORCH-PAR-11..17, L29/41/61/75/90/106/121, het `[ ]`)

| ID | Verdict | Bang chung (chi co o ID khac) | Con thieu |
|---|---|---|---|
| ORCH-PAR-11 | **open** | `codex-legacy-apikey-user-admin-journeys-2026-10-01.md`, `codex-j01-j03-auth-apikey-characterization.md` | chua co packet/receipt theo ID nay |
| ORCH-PAR-12 | **open** | `codex-profileendpoint-lock-override-field-inventory-2026-10-01.md` | nhu tren |
| ORCH-PAR-13 | **open** | `codex-profileendpoint-lock-override-field-inventory-2026-10-01.md`, `codex-j01-j03-...` | nhu tren |
| ORCH-PAR-14 | **open** | `codex-j04-connector-capability-inventory.md`, `qwen-vault.md` | nhu tren |
| ORCH-PAR-15 | **open** | `codex-legacy-opsadmin-settings-journeys-2026-10-01.md` | nhu tren |
| ORCH-PAR-16 | **open** | `codex-legacy-apikey-user-admin-journeys-2026-10-01.md`, `cmdcomp09-workflow-brief-2026-10-02.md` | nhu tren |
| ORCH-PAR-17 | **open** | `codex-legacy-opsadmin-settings-journeys-2026-10-01.md`, `codex-opt-admin-api-gaps-2026-10-02.md` | nhu tren |

- **8/7 dong nay chi co `plan-open-task-register-2026-10-03.md`** — RECON-A/C da canh bao day la **transcription**, khong phai bang chung. Evidence that lay o cac ID khac, khong noi duoc tu dong sang row.

### 2.5 `ADMIN-CONTROL-PLANE-UI-2026-10-02.md` (11 row ACUI-00..10, L37-47, het `[ ]`)

| ID | Verdict | Bang chung | Con thieu |
|---|---|---|---|
| ACUI-00 | **open (partial)** | `qwen-acui-00-config-catalog-2026-10-02.md` — inventory + classification, **read-only** | chua co UI/implementation catalog |
| ACUI-01 | **open** | `qwen-acui01-prep-2026-10-02.md` (PREP read-only), `codex-acui-decision-pack-2026-10-02.md` | ACUI-M07 chua xu ly |
| ACUI-02 | **open** | chi co register | admin/ **khong co** thu muc `oidc`; chi co 7 bo `*-section-renderer/data` |
| ACUI-03 | **open** | chi co register | khong co thu muc `users` |
| ACUI-04 | **open** | chi co register | co `profile-section-renderer.ts` (doc) nhung khong co UI lifecycle |
| ACUI-05 | **open** | chi co register | co `api-key-section-renderer.ts` (doc) nhung khong co UI lifecycle |
| ACUI-06 | **open** | chi co register | co `connector-section-renderer.ts` (doc) |
| ACUI-07 | **open** | chi co register | — |
| ACUI-08 | **open** | chi co register | — |
| ACUI-09 | **open** | chi co register | — |
| ACUI-10 | **open** | chi co register (1 lan xuat hien) | thieu browser/API matrix 2 tenant x 2 replica |

## 3 — Ket luan coverage + phu luc phu san

- **Sweep complete.** 37/37 file: 12 thuoc A..H (trong do **D/F/H con bay**), 1 da duoc lane khac audit (P8), 5 thuoc RECON-I, 8 khong con row mo, 2 template. **Khong con file plan nao thieu adjudicator.**
- **Tong so row da phan xu trong vong nay:** 40 (COMP 12, CRX 5, DOC-SYNC/CODE-FIX 5, ORCH-PAR 7, ACUI 11) — trong do **done 7** (COMP-03, CRX-03, CRX-05, DOC-SYNC-01/02/03, CODE-FIX-01/02), **open 31**, **uncertain 2** (COMP-00, COMP-11).
- **De xuat cho coordinator:** (a) dung 3 receipt D/F/H truoc khi dispatch lai trung pham vi; (b) ACUI-00..10 + ORCH-PAR-11..17 la **2 board lon nhat con nguyen**, 18 row, chi co evidence o ID khac — nen **noi receipt characterization vao row** thay vi tao packet lap lai; (c) COMP-10 (dual-run) va COMP-11 (doc diff) la hai dong **khong ai co the tu chong minh bang doc** — can nguoi chay/ky.

### 3.1 Method + gioi han

- **Read-only:** chi doc file, khong chay test, khong mo DB/Redis/S3/Vault, khong sua file nao, khong tick gate, khong commit.
- Verdict dua tren **do trong working tree luc ghi receipt**, khong lai noi dung receipt; khi gap thi ghi `uncertain` + thieu gi.
- `plan-open-task-register-2026-10-03.md` **khong duoc tinh la bang chung** (RECON-A/C da canh bao no la transcription).
- **Chua lam:** kiem soat row-level cho P8 (da co `codex-p8-open-audit`), va 3 file D/F/H dang bay — khong tranh cham.

## 4 — Ledger

- 1 — Bang phu 37 file + ket luan sweep complete — Muc 1.
- 2 — COMP-00..11: COMP-03 done (facade da mounted, RV01 socket), 9 open, 2 uncertain — Muc 2.1.
- 3 — CRX-01..05: CRX-03/CRX-05 done, CRX-01 dang chay boi lane khac, CRX-02/04 open — Muc 2.2.
- 4 — DOC-SYNC-01..03 + CODE-FIX-01/02 done (theo bang chung lane truoc) — Muc 2.3.
- 5 — ORCH-PAR-11..17 open, evidence chi nam o ID khac — Muc 2.4.
- 6 — ACUI-00..10 open, admin/ chua co UI surface tuong ung — Muc 2.5.
- 7 — De xuat: dung D/F/H, noi evidence ACUI/ORCH-PAR, COMP-10/11 can nguoi ky — Muc 3.