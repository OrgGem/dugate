# Receipt - MDB-POLICY-04: readFileCacheBytes + artifactTokenFor + artifactPurposeFor

| Truong | Gia tri |
|---|---|
| Task ID | MDB-POLICY-04 |
| Ngay | 2026-10-10 |
| Repo scope | du-rework (khong dung legacy root lam pham vi sua, khong dung live DB/Redis/S3) |
| Canonical plan | `coordination/PLAN-OPEN-2026-10-09.md` §9.2/§9.3 (hang 5) + `coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7 |
| Dispatch spec | `coordination/dispatch-specs/2026-10-10-MDB-POLICY-04-filecache.md` |
| Dispatch proof | DISPATCH-LIVE 2026-10-10 (MDB-POLICY-04, owner Qwen-C `term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`); packet dong thoi duoc giao truc tiep trong phien |
| Lease | `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (3 callback); `orchestrator/services/orchestrator/tests/mdb-policy-04-filecache.test.cjs` (moi); receipt nay |
| Owner lane | Qwen-C (implement) |
| Trang thai | **IMPLEMENTED + offline-verified [PASS] - CHUA ACCEPTED** (can independent verifier doc lap; lane khong tu accept) |
| Offline | Co - khong mo cua so DB/Redis/S3 nao; object reader test dung thu muc tam tren dia cuc bo |
| Git | Khong `git add`, khong commit, khong push; khong co gi staged |
| Ky tu nhay kep | **0** tren ca 2 file |

---

## 1. Hop dong da doc (bang chung)

Runner `scripts/ldba-03-backfill.cjs` - `mapFileCache` (`:690-733`):
- `readFileCacheBytes` (`:704-715`): phai la Buffer/Uint8Array; sau do runner tu kiem **do dai byte phai bang `row.size`** va **MD5 cua bytes phai bang `row.md5Hash`**.
- `artifactTokenFor(row, id)` (`:718-720`): string, `length >= 32`.
- `artifactPurposeFor(row)` (`:721-723`): thuoc `input|output|intermediate|session`.
- Moi loi nem ra trong transform duoc ghi thanh `TRANSFORM_ERROR` va **chi giu `String(error.message)`** (`:856`) - code nam tren error object khong xuat hien trong report.

Adapter `scripts/ldba-03-production-adapter.cjs`:
- `readFileCacheBytes` di qua `asyncContext` (`:653`) nen tra ve gia tri dong bo van duoc `await` binh thuong;
- `artifactTokenFor` / `artifactPurposeFor` di qua `syncContext` (`:654-655`) => phai synchronous, khong thenable.

Harness `scripts/ldba-09-harness.cjs`:
- env cua rehearsal (`:571-579`) chi set `LDBA_A1_*`, `LDBA03_SOURCE_VERSION`, `LDBA03_ADAPTER_MODULE`, `LDBA_SKIP_POLICY` - **khong** set object root;
- `:690` pin rang preflight cua production adapter **phai** co `FileCache` + `TRANSFORM_ERROR` => hanh vi fail-closed khi khong co reader la hanh vi duoc mong doi, khong phai regression.

Legacy (chi doc):
- `lib/db/schema.ts:156-167` - `FileCache` khong co cot purpose; chi `id, md5Hash, s3Key, fileName, mimeType, size, refCount, createdAt, lastAccessedAt`.
- `lib/upload-helper.ts:43` - khoa luu co dang id operation ghep ten file; `lib/storage/local-backend.ts` resolve khoa duoi root cua no (safePath).
- Ba writer duy nhat cua FileCache (`upload-helper.ts:52`, `file-url-downloader.ts:256`, `pipelines/submit.ts:240` qua upload-helper) deu la **phia input** (file nguon cua operation).

Target (chi doc): `migrations/0001_platform_v1.sql:128-141` - `artifacts.purpose text NOT NULL DEFAULT output` (comment: input|output|intermediate|session), `token text NOT NULL`; runner ghi `operation_id: null` cho moi hang FileCache.

---

## 2. Thay doi

### 2.1 `scripts/ldba-context-provider.cjs` (untracked)

- them 2 require builtin: `node:fs`, `node:path` (khong them dependency ngoai nao);
- them khoi MDB-POLICY-04 + `fileCacheFailure` (theo dung khuon `workflowSchemaFailure` cua MDB-POLICY-03);
- 3 stub `requireApprovedPolicy(...)` duoc thay bang implementation that;
- comment cuoi file cap nhat: chi `prepareAdminLocalUser` con fail-closed.

So dong: **919 -> 1039** (+120) theo chinh tool edit bao truoc/sau.
sha256 **sau** `89c6ec07f6cf83dd28aabbf060d1ab88f9704f226b42b37fa901fbda429cff57`.

### 2.2 `tests/mdb-policy-04-filecache.test.cjs` (moi, 212 dong)

sha256 `43d324b7348fa315889516ac00b38512f3c7e338d7b88e80e0131753a5d164f1`
16 test `node:test`: token (3), purpose (3), object reader (5), regression guard (5).

### 2.3 Ve sinh

- 0 ky tu nhay kep, 0 dong trailing whitespace, LF (khong CR) tren ca 2 file.
- `node --check scripts/ldba-context-provider.cjs` -> exit 0.

---

## 3. Quyet dinh thiet ke (va lua chon bi loai)

### 3.1 `readFileCacheBytes` - doc byte that, khong bao gio bia byte

Doc tu root duoc cau hinh qua env moi `LDBA03_FILECACHE_OBJECT_DIR`; khong cau hinh -> nem `ARTIFACT_READER_REQUIRED`;
khoa khong hop le / thoat root / object khong doc duoc -> nem `INVALID_ARTIFACT_BYTES`. Tra mot Buffer sao moi lan goi.

**Lua chon bi loai: sinh dummy bytes theo MD5.** Spec co nhac phuong an nay, nhung no **bat kha thi ve mat ma hoa**:
runner kiem `md5(bytes) === row.md5Hash` (`:712-715`), nen byte gia khong the qua cong do; ket qua chi la doi mot loi that
(`ARTIFACT_READER_REQUIRED`) thanh mot loi sai lech (`ARTIFACT_MD5_MISMATCH`) va van lam hong hang. Vi vay lane khong cai nhanh do.

An toan duong dan: khoa den tu hang legacy nen tung segment duoc kiem (segment rong, dot segment, chuoi gach keo moi, backslash, dau dua phan
cach duong dan deu bi tu choi), roi `path.resolve` duoi root + kiem tien to, roi `fs.realpathSync` kiem lai tien to de chan symlink thoat root.
`root` cung duoc `realpath` truoc khi so sanh.

### 3.2 `artifactTokenFor` - deterministic la bat buoc, khong phai lua chon

SHA-256 hex cua chuoi `s3Key` + dau hai cham + `id` = 64 ky tu (runner yeu cau toi thieu 32). Deterministic vi duong replay so sanh gia tri da plan
de nhan dien (`applyImmutableBatch` trong `ldba-03-production-adapter.cjs`): token ngau nhien se bien moi lan replay thanh `IMMUTABLE_CONFLICT`.

### 3.3 `artifactPurposeFor` - cai dat dung luat marker cua spec, va ghi ro van de

Cai dat: `input` khi khoa nguon chua marker `upload` (khong phan biet hoa/thuong), nguoc lai `output` - dung vi du trong spec.

**Canh bao (xem Δ2):** hang `FileCache` legacy **khong co cot purpose** va **ca ba writer deu la phia input**
(`upload-helper.ts:52`, `file-url-downloader.ts:256`, `pipelines/submit.ts:240`), trong khi khoa that khong chua marker `upload`
=> luat nay se tra `output` cho **moi** hang that. Lane van cai dat theo luat duoc phe, nhung khong tu doi chinh sach: day la quyet dinh cua
coordinator (doi sang `input` la sua 1 dong + 1 test).

---

## 4. Bang chung chay (literal + exit code)

Tat ca lenh chay trong `orchestrator/services/orchestrator`.

### 4.1 RED (test viet truoc, implementation sau)

```
$ node --test tests/mdb-policy-04-filecache.test.cjs
tests 16 | pass 5 | fail 11
Exit Code: 1

ly do dung (khong phai loi compile/test sai):
  Error [ContextPolicyError]: approved LDBA03 context policy is not configured for artifactTokenFor
  Error [ContextPolicyError]: approved LDBA03 context policy is not configured for artifactPurposeFor
  Error [ContextPolicyError]: approved LDBA03 context policy is not configured for readFileCacheBytes
  cac test tu choi nhan actual CONTEXT_POLICY_REQUIRED thay vi code cua policy
5 test xanh ngay tu RED: 4 regression guard + boot contract.
```

### 4.2 GREEN x3 lien tiep

```
$ node --test tests/mdb-policy-04-filecache.test.cjs
tests 16 | pass 16 | fail 0 | duration_ms 83.5165    Exit Code: 0
tests 16 | pass 16 | fail 0 | duration_ms 81.5352    Exit Code: 0
tests 16 | pass 16 | fail 0 | duration_ms 79.5265    Exit Code: 0
```

### 4.3 Syntax + typecheck

```
$ node --check scripts/ldba-context-provider.cjs     -> (khong output) Exit Code: 0
$ npx tsc --noEmit -p tsconfig.json                  -> (khong output) Exit Code: 0
```

### 4.4 Hoi quy runner (khong bi anh huong)

```
$ node --test tests/ldba-03-backfill-offline.test.cjs
tests 21 | pass 21 | fail 0
Exit Code: 0
```

---

## 5. Hau qua ngoai lease - chuoi guard fail-closed (can coordinator adjudicate)

Moi packet policy land deu lam do guard fail-closed cua packet truoc. Bon lan lien tiep, do doc lap:

| Guard | Vi tri | Bi do boi | Trang thai |
|---|---|---|---|
| MDB-01 composition | `tests/mdb-01-composition-provider.test.ts:39-42` | chinh MDB-POLICY-01 (prepareConnector) | da co truoc, DSH da ghi |
| MDB-POLICY-01 suite | `tests/mdb-policy-01-connector.test.cjs:292` | MDB-POLICY-02 (cycle truoc cua lane) | da ghi o receipt P-02 Δ1 |
| MDB-POLICY-02 suite | `tests/mdb-policy-02-profiles.test.cjs:216` | MDB-POLICY-03 (land giua hai cycle cua lane) | **khong do cycle nay** |
| MDB-POLICY-03 suite | `tests/mdb-policy-03-workflow-schema.test.cjs:420` | MDB-POLICY-04 (cycle nay) | **do cycle nay, can adjudicate** |

Bang chung do doc lap:

```
$ node --test tests/mdb-policy-01-connector.test.cjs       -> pass 19 | fail 1    Exit Code: 1  (do tu P-02)
$ node --test tests/mdb-policy-02-profiles.test.cjs        -> pass 18 | fail 1    Exit Code: 1
      ✖ the five remaining callbacks stay fail-closed  (:216)  actual INVALID_SOURCE  <- prepareWorkflowSchema (P-03)
$ node --test tests/mdb-policy-03-workflow-schema.test.cjs -> pass 16 | fail 1    Exit Code: 1
      ✖ the four remaining callbacks stay fail-closed  (:420)  actual INVALID_ARTIFACT_BYTES  <- artifactPurposeFor (P-04, cycle nay)
```

Khong file nao trong so do bi lane sua: `tests/mdb-policy-02-profiles.test.cjs` giu nguyen sha256 `ae2ecdbb...`; `mdb-policy-01` va `mdb-policy-03`
cung khong bi cham (chi doc + chay).

**De nghi:** thay cac danh sach `callback con lai fail-closed` chep tay trong tung packet bang **mot nguon duy nhat** (vi du mot test suy ra tap chua
land, hoac coordinator cap nhat guard cua packet truoc nhu mot phan cua packet moi). Rieng cycle nay: cap lease nho de cap nhat
`mdb-policy-03-workflow-schema.test.cjs:420` (bo 3 callback da land) hoac giao owner P-03.

---

## 6. Acceptance (doi chieu spec §2 va §3)

- [x] `readFileCacheBytes` tra Buffer/Uint8Array that, fail-closed voi code `ARTIFACT_READER_REQUIRED`/`INVALID_ARTIFACT_BYTES`.
- [x] `artifactTokenFor` tra string >= 32 ky tu, deterministic (test pin dung cong thuc SHA-256).
- [x] `artifactPurposeFor` tra dung tap 4 gia tri; test pin luat marker cua spec.
- [x] Regression: 4 policy da land giu nguyen hoat dong; `prepareAdminLocalUser` van `PASSWORD_RESET_REQUIRED`; boot contract 8 callback + `Object.isFrozen`.
- [x] Test offline pass 3 lan lien tiep; `node --check` + `tsc --noEmit` pass.
- [x] Khong them dependency ngoai vao file `.cjs` (chi `node:fs`, `node:path` builtin).
- [x] Khong `git add`, commit, push; khong dung ky tu nhay kep.
- [ ] Independent verifier doc lap moi tinh ACCEPTED.

---

## 7. Lease / git

```
$ git status --porcelain -- orchestrator/services/orchestrator/scripts orchestrator/services/orchestrator/tests
 M .../scripts/ldba-03-backfill.cjs                 (co san tu truoc, khong phai cua lane)
 M .../scripts/ldba-03-production-adapter.cjs       (co san tu truoc, khong phai cua lane)
 M .../tests/ldba-03-backfill-offline.test.cjs      (co san tu truoc, khong phai cua lane)
 M .../tests/<6 file .ts khac>                      (co san tu truoc, khong phai cua lane)
?? .../scripts/ldba-context-provider.cjs            (lease - lane sua)
?? .../tests/mdb-policy-01-connector.test.cjs       (khong sua)
?? .../tests/mdb-policy-02-profiles.test.cjs        (khong sua)
?? .../tests/mdb-policy-03-workflow-schema.test.cjs (khong sua)
?? .../tests/mdb-policy-04-filecache.test.cjs       (lease - moi)

$ git diff --cached --name-only
(rong)
```

---

## 8. DELTA

**Δ1 (ngoai lease).** Guard fail-closed cua MDB-POLICY-03 do 1 test sau khi land (muc 5); lane khong sua ngoai lease.

**Δ2 (chinh sach purpose - can adjudicate).** Luat marker cua spec tra `output` cho moi hang that vi khoa legacy khong chua marker `upload`, trong khi
ca ba writer cua FileCache deu la phia input. Blast radius: `artifacts.purpose` cua cac hang migrate; `operation_id` = null nen khong anh huong
ket qua operation dang linked, nhung co the anh huong retention/visibility theo purpose.

**Δ3 (token khong co thanh phan bi mat).** Cong thuc spec suy ra tu hai dinh danh cong khai, nen token la dinh danh on dinh chu khong phai bearer co
entropy bi mat. Voi hang migrate (`state` READY, `expires_at` null) dieu nay lam giam y nghia bao mat cua cot `token`; can coordinator xac nhan
day la chu y (doi thanh HMAC voi secret la thay doi chinh sach, khong tu lam).

**Δ4 (baseline hash).** Provider la untracked va da bi MDB-POLICY-03 ghi giua hai cycle cua lane, nen lane khong chup duoc hash truoc khi sua
trong cycle nay. Thay the: so dong 919 -> 1039 theo tool edit, hai doan anchor cu/moi ghi ro o muc 2.1, va bang chung doc lap rang chi hanh vi cua 3
callback nay doi (guard P-03 do dung o `artifactPurposeFor`; 18/19 test con lai cua P-02 van xanh).

**Δ5 (env moi chua duoc tai lieu hoa).** `LDBA03_FILECACHE_OBJECT_DIR` moi ton tai trong provider + test; `.env.example`/docs nam ngoai lease nen
lane khong sua. Rollout phai set bien nay truoc khi chay backfill FileCache that, neu khong moi hang FileCache se fail `TRANSFORM_ERROR`.

**Δ6 (nhanh chan symlink chua duoc chay that).** Da cai `realpathSync` + kiem lai tien to, nhung test khong tao duoc symlink (Windows can quyen dac
bien), nen bang chung cho nhanh nay la doc code chu khong phai ket qua chay.

**Δ7 (reader dong bo).** `readFileCacheBytes` doc dong bo; adapter goi qua `asyncContext` nen van dung hop dong. Voi object lon dieu nay chan event
loop trong luc migrate - chap nhan duoc voi script backfill, nhung ghi nhan de verifier biet.

---

## 9. Trang thai 4 muc

1. **Implemented**: co - 3 callback that + 16 test moi.
2. **Offline-verified**: co - RED 11 fail/5 pass (exit 1) -> GREEN 16/16 x3 (exit 0); `node --check` 0; `tsc --noEmit` 0; runner offline 21/21.
3. **Accepted**: KHONG - can independent verifier doc lap.
4. **Merged/deployed**: KHONG - chua commit/push; chua chay rehearsal PG (A1 van mo).

**Rollout note:** FileCache chi migrate duoc khi (a) `LDBA03_FILECACHE_OBJECT_DIR` tro dung root object legacy, va (b) byte that khop ca `size` lan
`md5Hash` cua hang nguon. Khong set bien nay thi moi hang FileCache fail `TRANSFORM_ERROR` - dung nhu harness LDBA-09 dang pin.

---

## 10. RESUME POINT

- Da xong: 3 callback + test + bang chung literal + receipt nay.
- Con lai (khong thuoc lane): (i) adjudicate Δ1 (guard P-03), Δ2 (chinh sach purpose) va Δ3 (token);
  (ii) independent verifier chay lai `node --test tests/mdb-policy-04-filecache.test.cjs` x3 + doc lai sha256 provider;
  (iii) coordinator tick gate sau verify.
- Khong pending nao khac trong lease. Khong commit/push.
