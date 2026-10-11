# Dispatch Spec: SEC-03 — verify duong ghi nguon da ma hoa + gop 4 bieu thuc `required` ve mot

| Muc | Gia tri |
|---|---|
| Task ID | SEC-03 |
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Repo scope | du-rework |
| Owner | PENDING — chon sau khi inspect runtime that (xem §6) |
| Lease | `services/orchestrator/src/app/bootstrap/create-app.ts`, `services/orchestrator/tests/sec-enc-05-boot-wiring.test.ts` (them test moi neu can) |
| Canonical plan | `coordination/PLAN-SECURITY-ORCHESTRATOR-2026-10-11.md` §2 SEC-03 |
| Receipt | `coordination/reports/receipt-sec-03-verify-encryption-policy-2026-10-11.md` |

## 0. Tinh trang thuc te — task nay KHONG phai noi lai

Co so do noi san truoc day. Coordinator da doc lai `create-app.ts` va xac nhan day la dung:

```
create-app.ts:655  const requireEncryptedSourceWrites = config.encryptionPolicy?.dataMode === 'real'
create-app.ts:660  storage: config.publicUploadEncryption && artifactCryptoFacade
create-app.ts:661    ? createS3EncryptedPinnedSourceStorage({ ... })
create-app.ts:674    : createS3PinnedSourceStorage({ ... })
create-app.ts:681    requireEncryptedSourceWrites,
```

⇒ **Phan ghi nguon da noi dung. Khong can sua phan do.** Task con lai dung hai viec: **(A)** verify doc lap, **(B)** gop 4 bieu thuc `required` dang tra loi 4 cau hoi khac nhau cho cung mot quyet dinh.

## 1. PHAN A — verify doc lap (offline, chay duoc ngay)

Khong sua gi. Chi chung minh hoac bai bo claim ben §0.

1. Doc lai 6 dong o §0 tu file, khong tin receipt nao.
2. Chay `tests/sec-enc-05-boot-wiring.test.ts` va `tests/sec-enc-03-source-s3-encryption.test.ts`, ghi so pass/fail that.
3. Xac nhan bang test, khong bang doc code: **co that** khi `dataMode === 'real'` thi `createS3EncryptedPinnedSourceStorage` moi duoc chon va `requireEncryptedSourceWrites` moi `true`.
4. Xac nhan `dataMode` mac dinh la `real` khi env unset va fail-closed: `src/modules/encryption/boot-options.ts:198-201` tra `{ mode: 'real' }` khi env rong; `:209-211` nem loi neu `synthetic` ma thieu ack. Ghi ro dieu kien nao co the tat encryption (khong co dieu kien nao neu dung env).
5. Xac nhan `synthetic` thi that su co `approvedBy` + `acknowledgedAt` + `isolatedFromRealData` bat buoc: `boot-options.ts:219-225`.

Neu bat ky diem nao trong §0 **sai**, dung `fix` chu khong `verify` — ghi vao receipt va bao lai, khong sua silently.

## 2. PHAN B — gop 4 bieu thuc ve mot (day la phan sua code duy nhat)

**Van de:** mot quyet dinh duy nhat — co bat buoc ma hoa hay khong — hien duoc tra loi o bon cho khac nhau, va **hai trong bon cho dang tra loi nguoc nhau** trong cung mot cau hinh.

```
create-app.ts:484  syntheticDataExempt = config.encryptionPolicy?.dataMode === 'synthetic'
create-app.ts:492  ghi artifact   : required = !syntheticDataExempt && !artifactMigrationWindowOpen
create-app.ts:508  multipart      : encryptionRequired = Boolean(publicUploadEncryption) && !artifactMigrationWindowOpen
create-app.ts:528  doc artifact   : artifactEncryptionRequired = encryptedWritesRequired && !artifactMigrationWindowOpen
create-app.ts:655  ghi nguon      : requireEncryptedSourceWrites = dataMode === 'real'
```

| Duong | Co exemption synthetic khong? |
|---|---|
| `:492` ghi artifact | **Co** |
| `:508` multipart | **Khong** |
| `:528` doc artifact | **Khong** |
| `:655` ghi nguon | Co, nhung **ngam**: chi `real` moi bat |

**Vi sao la loi song chu khong phai tranh luan:** `boot-options.ts:293` bat `publicUploadEnabled` khi backend la `s3`, **ke ca o synthetic**. Vay o synthetic + S3 thi `:508` = `true` (multipart bat buoc ma hoa) con `:492` = `false` (ghi artifact mien ma hoa) — hai duong ghi cung mot bucket ma quyet dinh nguoc nhau.

**Khong phai moi — test hien tai da dong dinh hanh vi sai nay.** `tests/sec-enc-05-boot-wiring.test.ts:235-247` assert `required === false` va `encryptionRequired === true` cung mot lan boot. Neu gop policy ma khong doi test do, task se bi coi la khong hoan thanh.

**Cach lam — mot ham, khong them bieu thuc thu nam:**

```
resolveEncryptionRequirement(dataMode, migrationWindowOpen) -> boolean
```

Ca 4 cho doc **no**. Tieu chi bao dam, do la **bat bien** chu khong phai hinh thuc cu the:

- **B1.** `dataMode === 'real'` ⇒ bat buoc ma hoa tren **ca 4** duong. Khong duong nao bat exemption.
- **B2.** `dataMode === 'synthetic'` ⇒ **ca 4** duong giu nguyen plaintext byte-identical, dung hop dong da ghi o `ingestion-consumer.ts:158-160` (*keeps the historical plaintext path byte-identical for synthetic/legacy environments*).
- **B3.** **Migration window KHONG ap cho duong ghi nguon (`:655`).** Ly do: migration window la mien tru cho artifact da ghi truoc, con `:655` quyet dinh cho **du lieu moi dang vao**. Ap migration window cho du lieu moi nghia la mot co vat hanh tam thoi mo lo hong cho du lieu that. `:655` hien da dung — **giu nguyen y nghia**.
- **B4.** Khong duong nao duoc tro thanh `true` ma nguon la `false`. Neu ham tra `false` o synthetic, ca 4 ke ca multipart.

**Ve test:** sua expectation o `:235-247` cho khop B2, va **doi ten** case do — ten hien noi *while still blocking plaintext multipart* se thanh mo ta sai sau khi da gop. Khong xoa case. Test co san o `:151,168,185,205,249,267` phai giu va xanh.

## 3. PHAN C — kiem ke object that (BI CHAN, tach rieng)

Khong nam trong task nay. Review yeu cau: liet ke object da ghi qua duong ghi nguon, voi tung object xem co sealed marker khong, co manifest sidecar khong. **Khong duoc gia dinh coi chung la sealed** — strict reader co the tu choi.

Phan nay can cua so S3 that. Ba phan deu chua duoc chay tren du lieu that thi phai ghi ro, **khong duoc ghi 0 va khong duoc gia dinh**. Bao cao o §5 dong trong receipt.

## 4. Lease va ranh gioi

- Sua duoc: `create-app.ts`, `tests/sec-enc-05-boot-wiring.test.ts`, va **file test moi** neu tach rieng.
- **Khong sua** `ingestion-consumer.ts` neu chi doi wiring o `create-app.ts`. Ke flag do doi nghia thi dung lai dong `create-app.ts:655`.
- **Khong sua** compose, migration, `.env.*`, `docs/`. Khong them bieu thuc thu nam o bat ky file nao.
- **Khong** dung cung file voi SEC-02 (`ingestion-consumer.ts`) — xem §6.

## 5. Tieu chi hoan thanh

| # | Dieu kien |
|---|---|
| 1 | Phan A co bang chung chay that, khong phai doc code |
| 2 | Mot ham resolve, ca 4 duong doc no — bang chung la grep khong con bieu thuc `required` rai rac o `:492/:508/:528/:655` |
| 3 | B1-B4 bat bien, **moi** co bang chong bang test |
| 4 | Toan bo suite `tests/sec-enc-05` + `tests/sec-enc-03` + `encryption-boot-options.test.ts` xanh |
| 5 | Phan C ghi ro chua chay hay da chay; khong ghi 0 cho thu chua chay |
| 6 | Receipt 0 ky tu nhay kep ASCII, kem command + exit code |
| 7 | Khong tu nhan ACCEPTED |

## 6. Rang buoc va bang chung dispatch

- **Khong `git add` / `commit` / `push`. Khong tick gate.** Khong dung ky tu nhay kep ASCII.
- **Owner: PENDING.** Phep giao bat buoc inspect runtime that qua `orca terminal list --json` + doc screen; `connected` khac `idle` khac `executing`. `DISPATCH-LIVE-2026-10-10.md` la ledger lich su — trong do `term_ae2d7e42` da `exited`, dung lam bang chung hien tai.
- **Khong co request/dispatch ID ⇒ khong co bang chung dispatch.** Ghi ID vao receipt.
- **Ranh gi voi SEC-02:** ke neu bao cao cho rang SEC-02 cung cham vao `ingestion-consumer.ts` — **cung owner thi serialize**, tranh hai lease tren mot file.
- **Khong mo cua so DB hay S3 that** neu chua duoc yeu cau.

## 7. Hanh dung dung

Khong sua file san pham ngoai §4. Khong `git add`/`commit`/`push`. Khong tick gate.
Khong tu sua neu gap quyet dinh — ghi vao receipt roi hoi dispatcher. **Neu gap quyet dinh ve policy, hoi coordinator; toi la nguoi quyet ke truc he thong va da chot san huong di cua task nay o §2 B1-B4.**

## 8. Ghi chu cua coordinator ve do tin cay

Claim *da noi san* trong §0 la cua chinh toi va **da tu bi dinh chinh mot lan** (lan truoc toi ghi `create-app.ts` co 0 tham chieu hai ten nay). Phan A ton tai dung de mot claim sai nua khong lan nua. Neu §0 sai, bao toi — sai mot lan hon cong viec sua lai ca luoi quyet dinh policy.
