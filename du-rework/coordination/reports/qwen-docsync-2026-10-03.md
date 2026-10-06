# DOC-SYNC-01..03 — doi chieu architecture/docs voi code (DOC-ONLY)

## RESUME POINT — 2026-10-03

- **Ket luan 1 dong:** **phan lon DOC-SYNC-01..03 da LAND truoc khi dispatch nay toi.** Plan lay so lieu tu mot snapshot cu, da lech code hien tai. Lane nay **verify tung muc** va chi sua **3 cho that su sai**.
- **Da sua (3 dong, 2 file):** `architecture/12-flows-and-data.md:11` (bo line-range `server.ts:2840-2850` da hu), `architecture/16-interface-catalog.md:42` (them `/api/runtime/v1` vao path workspace-reference), `16-interface-catalog.md:48` (cau «shell van huong dan goi route khong ton tai» da het dung sau CODE-FIX-01).
- **Khong sua:** 3 muc nam ngoai write path (Muc 5) + 1 blocker tooling (Muc 6).
- **Khong tick gate, khong commit, khong cham file `.ts`/test nao.**
- **Buoc ke tiep:** Reviewer kiem tra Muc 2 (bang trang thai 17 muc) va quyet dinh 3 muc ngoai lease o Muc 5.

## 1 — Viec that su con lai, va vi sao

Ba thay doi duoc sua deu **cua chinh nhung noi plan yeu cau sua**, nhung noi do da duoc lane khac ghi nhung **sau luc audit doc het**:

| # | File | Dong | Truoc | Sau | Ly do |
|---|---|---:|---|---|---|
| A | `architecture/12-flows-and-data.md` | 11 | «`assertAdminAuth` o `server.ts:2840-2850` so `Bearer <adminToken>`» | «`assertAdminAuth` trong `services/orchestrator/src/server.ts` chi so `Bearer <adminToken>`» | line-range 2840-2850 khong con tro toi ham nua (nay o 2907). Bo han so dong, chi dan theo **symbol** de khong rot lai. |
| B | `architecture/16-interface-catalog.md` | 42 | `GET /workspace-reference?…` | `GET /api/runtime/v1/workspace-reference?…` | matcher that la `pathname === '/api/runtime/v1/workspace-reference'` (`server.ts:1787`); doc thieu tien to. |
| C | `architecture/16-interface-catalog.md` | 48 | «admin shell **hien van huong dan** operator goi `POST /api/v1/admin/connector-bindings` … de quyet dinh sua huong dan hay bo sung route» | «CODE-FIX-01 da chot **phuong an A** (sua huong dan, khong bo sung route) va **phan code da sua**: `connector-section-renderer.ts` (`renderNotFound`) nay ghi ro khong co platform route tao connector binding, connector dang ky o Connector service, con doi/thu hoi/kiem credential thi qua `POST /api/v1/admin/actions`. `connector-bindings` van **khong co** trong router (0 match) — do la trang thai dung, khong phai route dang cho land» | Cau cu da **sai sau khi CODE-FIX-01 sua renderer** (verify: `connector-section-renderer.ts:318` hien noi «There is no platform route for creating connector bindings»). Doc neu tiep «van huong dan» se dan nguoi doc toi mot huong dan da bi go bo. |

- `git diff --stat`: **3 insertions, 3 deletions** tren 2 file. Khong viet lai trang, khong doi so dong: `12-flows-and-data.md` **109 dong**, `16-interface-catalog.md` **69 dong** truoc va sau khi sua.
- EOL kiem: CRLF=0, LF-only, ket thuc bang newline — khong lam hong EOL goc.

## 2 — Trang thai tung muc cua plan (verify, khong tin plan)

### DOC-SYNC-01 (`architecture/10,12,15,16`)

| Muc | Yeu cau plan | Trang thai | Bang chung |
|---:|---|---|---|
| 1 | Thu hep mo ta admin auth | **DA LAND** (nua lane nay sua line cu) | `12:11` + `16:46`; code: `assertAdminAuth` **chi so Bearer**, 9 call site; `resolveAdminActionAuthAsync` impl tai `modules/admin-actions/rbac.ts:386`, goi o `server.ts:2459` |
| 2 | `/tasks/{id}/context` vang han | **DA LAND** | `16:40` «khong ton tai trong router … Khong phai cho config»; code: 0 match route `/context` trong `server.ts` |
| 3 | them `workspace-reference` vao bang runtime | **DA LAND** (nua lane nay them tien to) | `16:42`; matcher `server.ts:1787`, params `workspacePath` + `tenantId` (`server.ts:1778`) |
| 4 | them bang `human_waits` vao `12` §5 | **DA LAND** | `12:88` nhom bang Orchestrator co `human_waits`; that: `migrations/0005_continuation.sql:9` |
| 5 | them route Connector bi bo | **DA LAND** | `16:56`; code: `bootstrap` 230, `current` 282, `/{n}` 288 trong `connector/src/http/server.ts` |
| 6 | them workflow `doc-compare` vao `15` §2 **ke kem caveat «khong dang ky»** | **DA LAND — va doc hien tai DUNG HON plan** | `15:38` noi «Dang ky thanh handler kind + action rieng, khong gop vao `compare`»; code xac nhan: `handlerKinds` co `'doc-compare'` tai `document-core.manifest.ts:110`, action rieng tai `:431` |
| 7a | ghi ro admin shell huong dan route khong ton tai | **DA LAND, nhung cau da CU** | `16:48`; gap van that (`connector-bindings` = 0 match trong `server.ts`; dispatcher action tai `dispatcher.ts:677/727/753`) |
| 7b | ghi ro `webhook.ts` chua wire | **DA LAND** | `16:58`; code: `webhook.ts` export `verifyWebhookSignature`/`parseWebhookPayload`, re-export `index.ts:28`, `http/server.ts` 0 match `webhook` |
| 8 | sua so dong `server.ts` trong `CODE-ARCHITECTURE.md` | **NGOAI WRITE PATH** | file nay thuoc orchestrator, khong nam trong allowed paths cua DOC-SYNC-01 — Muc 5 |
| 9 | ghi ro pham vi root compose trong doc 13 | **NGOAI WRITE PATH** | `architecture/13-*.md` khong nam trong allowed paths — Muc 5 |

### DOC-SYNC-02 (`docs/07`, `docs/21`, `docs/10`, `businesses/document-core/docs/variant-matrix.md`)

| Muc | Yeu cau plan | Trang thai | Bang chung |
|---:|---|---|---|
| 1 | go khang dinh `/tasks/{id}/context` | **DA LAND o 2/3 noi** | `docs/07-internal-api.md:41` da ghi «**Chua implement trong router.**»; `docs/21-openapi.json:2157` nam trong mang `x-absent` (2150-2158). noi thu ba `architecture/05-internal-api.md:56` **van con** — Muc 5 |
| 2 | `docs/21-openapi.json`: sua nguon sinh neu co tooling | **KHONG CO GENERATOR** | quet toan repo: chi co doc/task/report **tham chieu ten file**; khong script nao ghi file nay (`tools/file-size-guard.cjs` chi allowlist). La **artifact hand-maintained**, va muc `/context` da dung nen **khong sua tay** |
| 3 | dong bo 28 → 31 | **DA LAND** | `variant-matrix.md:1` tieu de «31-Variant», `:3`/`:5` ghi 31, `:7` co `id-card`, `:8` co `fact-check` + `summarize-eval`; `docs/10-document-core.md:16` «Tong cong **31 subcases**: 4+6+7+5+6+3» |

### DOC-SYNC-03 (`architecture/01,04,README,07,09`)

| Muc | Trang thai | Bang chung |
|---:|---|---|
| 1 | **DA LAND** | `01-product.md:20` «6 action, **31 bien the** (4+6+7+5+6+3)» |
| 2 | **DA LAND** | `01-product.md:14` co `id-card`; `:15` co `fact-check`, `summarize-eval` |
| 3 | **DA LAND** | `04-core-api.md:144` «ap dung ca **31 bien the**»; `:148` nhan link «31 variants» |
| 4 | **DA LAND** | `README.md:38` «31 bien the»; `07-capacity.md:59` «31 variant validation»; `09-readiness.md:22` GAP-10, `:23` GAP-11 da co cau «Cap nhat 2026-10-02: source rework hien da khai bao du 31 variant», `:34` ghi ro 3 variant da co trong 31, `:62` GL-02 |
| 5 | **KHONG tick GAP-11** | khong co task/gate nao bi tick boi lane nay |

**Y nghia «da land»:** khong phai lane nay vua lam — ma la noi do **da dung san trong working tree** luc dispatch toi. Bang chung thoi gian: cac file doc co mtime `2026-10-02T05:56Z`–`06:08Z`, con plan file `ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md` co mtime `2026-10-02T06:27:59Z` — tức **doc da duoc cap nhat ~20-30 phut truoc khi plan duoc ghi**, nen claim cua plan da lech ngay khi no duoc luu.

## 3 — Drift do duoc trong luc lam viec (ly do bo line-range)

| Tai nguyen | Plan ghi | Do duoc luc lane chay |
|---|---:|---:|
| `services/orchestrator/src/server.ts` | 4.299 dong | **4.414** (probe dau) → **4.425** (~20 phut sau) |
| `assertAdminAuth` | `2840-2850` | `2907` |
| route `revisions/bootstrap` | `:221` | `:230` |
| route `revisions/current` | `:273` | `:282` |
| route `revisions/{n}` | `:279` | `:288` |
| `shell-router.ts` | (plan doc `shell-router.ts:396`) | **447 dong** — CONV-12 da tach file |
| `doc-compare` trong manifest | «khong co trong `handlerKinds`» | **co, tai `:110`** |

- Mot lane khac dang **sua `server.ts` ngay luc lane nay chay**. Vi vay **khong** ghi line-range vao doc: chi dan theo **ten symbol/duong dan** de bao tri duoc.
- Muc 6 cua plan («ghi kem: doc-compare chua dang ky») **da thanh sai** — code da dang ky. Doc `15:38` hien tai dung hon plan; lane nay **khong** dua cau sai do vao doc.

## 4 — Ba muc ngoai write path (de Reviewer/owner xu ly)

| Muc | File | Trang thai | Gia tri do duoc |
|---:|---|---|---|
| 1 | `services/orchestrator/CODE-ARCHITECTURE.md:114` | ghi «`server.ts` hien **khoang 4.100 dong**» | that tai luc ghi receipt: **4.425** (dang tang). File nay thuoc package orchestrator, **khong** nam trong allowed paths cua DOC-SYNC-01 |
| 2 | `architecture/05-internal-api.md:56` | van ghi `GET /tasks/{id}/context` → «200 snapshot + refs + cancel flag» — **khang dinh route ton tai**, mau thuan voi `docs/07:41`, `16:40`, `docs/21:2157` | khong nam trong allowed paths cua DOC-SYNC-02 **va** DOC-SYNC-03 |
| 3 | `architecture/13-*.md` §1 | pham vi root compose | do: `docker-compose.yml:11-14` chi `include` 3 deployable (orchestrator, connector, document-core); thieu `example-review` va `lc-checker` | `13` khong nam trong allowed paths |

- Khong sua 3 muc tren: dung lease, va chung **thuoc task khac** (CODE-FIX-01 / lane docs khac). Chuyen sang owner trong handoff.

## 5 — Ranh gioti le giu

- **Chi 2 file bi sua**, ca hai deu trong allowed paths cua DOC-SYNC-01: `git diff --stat` = **3 insertions / 3 deletions**; `git status --porcelain` tren `architecture/ docs/ businesses/document-core/docs/` chi co 2 dong `M` nay, khong co file moi hay file khac bi dong vao.
- **Khong mo file `.ts` nao** (chi doc de verify), **khong chay test**, **khong tick gate nao** (`DOC-SYNC`/`CODE-FIX` van `[~]`), **khong commit/push**.
- **Khong cham** `agent-watch-state.json`, `tasks/*` (chi doc), `coordination/gates/*`.
- mtime file dich: `12-flows-and-data.md` `2026-10-02T05:56:13Z` → `2026-10-02T17:28:47Z`; `16-interface-catalog.md` `2026-10-02T05:57:30Z` → `2026-10-02T17:28:47Z`. Ca hai **>11 gio truoc** khi va (khong co lane nao vua ghi trong ~15 phut truoc do, theo quy tac trong packet).

## 6 — Acceptance

| Tieu chi | Ket luan | Bang chung |
|---|---|---|
| Thuc hien dung noi dung DOC-SYNC-01..03 | **MET voi ngoai le da bao cao** | 17 muc co phan loai: 14 da land truoc, 3 fix cua lane nay, 3 ngoai lease + 1 blocker tooling (Muc 2, 4) |
| Receipt ghi file nao doi, diff ngan, mtime truoc/sau | **MET** | Muc 1 (bang 3 dong) + Muc 5 |
| Khong tick `DOC-SYNC`/`CODE-FIX`/gate nao | **MET** | Muc 5 |
| Khong sua code/tests | **MET** | Muc 5 |
| Khong tick gate, khong commit | **MET** | Muc 5 |

## 7 — Ledger

- 1 — Sua 3 cho that su sai: 12:11 line-range, 16:42 tien to path, 16:48 cau cu sau CODE-FIX-01 — Muc 1.
- 2 — Verify 17 muc DOC-SYNC-01..03; 14 da land truoc khi dispatch — Muc 2.
- 3 — Drift do duoc: `server.ts` 4299→4414→4425; line-range khong bao tri duoc, chuyen sang symbol — Muc 3.
- 4 — 3 muc ngoai write path (CODE-ARCHITECTURE.md, arch/05, arch/13) chuyen owner — Muc 4.
- 5 — Le giu: chi 2 file M, 3 insertions/3 deletions, khong code/test/gate/commit — Muc 5.