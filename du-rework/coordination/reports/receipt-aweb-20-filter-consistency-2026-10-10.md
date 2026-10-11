# AWEB-20 - Nhat quan bo loc voi keyset cursor tren Operations screen

| Muc | Gia tri |
|---|---|
| Task | AWEB-20 (sau AWEB-20a/20b) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Lease | apps/admin-web/src/features/operations/{state.ts, operations-screen.tsx}, apps/admin-web/tests/operations-state.test.mjs, receipt nay |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED |
| Receipt | coordination/reports/receipt-aweb-20-filter-consistency-2026-10-10.md |

## 1. Bang chung: bo loc nao reset cursor, bo loc nao khong

Doc `operations-screen.tsx` **truoc khi sua** va doi chieu tung bo loc voi duong dan reset cursor. Token cursor duoc sinh boi `encodeOperationsListCursor` (`src/modules/operations/list-query.ts:158`) chi mang `createdAt|id|sort|dir` - **khong mang tenant, state, cua so window, id filter**.

| Bo loc | Cach doi | Co onChange rieng | Reset cursor truoc sua |
|---|---|---|---|
| state | select cuc bo | Co | **Co** |
| limit (page size) | select cuc bo | Co | **Co** |
| id contains | input cuc bo | Co | **Co** |
| from (AWEB-20a) | input cuc bo | Co | **Co** |
| to (AWEB-20a) | input cuc bo | Co | **Co** |
| **tenant** | **GlobalTenantSelector o app-shell** | **KHONG** | **KHONG** |

## 2. Loi that: doi tenant khong lam cursor chet

`tenant` khong phai state cuc bo ma den tu `useTenant()` (`operations-screen.tsx:43`), nen khong co onChange de reset cursor. Khi operator doi tenant trong bo chon toan cuc:

1. `load()` chay lai vi `globalTenantId` doi trong dependency array (`:113`),
2. nhung `cursor` van la token cua tenant TRUOC va duoc gui nguyen vao query.

Route **khong** kiem tra danh tinh tenant cua token - no chi chan **sai sort** (`list-query.ts:294-308`). Nen backend ap filter cua tenant MOI nhung tim tu **vi tri cua tenant CU** trong population moi. Ket qua: **bo qua hoac lap lai dong mot cach im lang**, va nut Previous tro ve trang ma operator khong con nhin thay.

Day la loi cung loai voi phan AWEB-20a vua sua, nhung **im lang hon**: no khong loai dong nao khoi bang, no lam sai thu tu.

## 3. Sua - dat quy tac vao mot cho, khong nhac tung control

### 3.1 `state.ts` (test duoc offline)

- `operationsPopulation(input)` - van tay cua state + tenant + id (trim) + from + to + limit. Day la gia tri duy nhat phai doi de cursor chet.
- `operationsCursorIsStale(cursor, mintedPopulation, selectedPopulation)` - true khi cursor con song ma population no sinh ra khac voi population dang chon.

### 3.2 `operations-screen.tsx`

- Mot `ref` nho population tai thoi diem cursor duoc gan, mot `applyCursor(next)` la **diem vao duy nhat** de gan cursor, va mot effect bo cursor khi staleness duoc phat hien.
- **Ca 8 duong gan cursor** (5 bo loc + Previous + Next + Newest) chuyen sang `applyCursor`. Sau khi sua, grep `setCursor` chi con 3 cho: khai bao state, ben trong `applyCursor`, va ben trong effect - khong con duong nao bo qua quy tac.

Vi sao khong giu nguyen 5 `setCursor(null)` cu va them rieng mot effect: neu giu, quy tac van nam o **hai cho**, va mot bo loc moi trong tuong lai se quen reset - chinh cach ma tenant bi bo sot. Bay gi them bo loc moi chi can nam trong fingerprint.

## 4. Test bo sung (14 test moi, 8 -> 22)

| Test | WIN | LOSE |
|---|---|---|
| population on dinh khi khong doi gi | render lai khong lam cursor chet | cursor chet o moi lan render |
| population doi khi state / tenantId / id / fromDate / toDate / limit doi (6 case) | tung truong shaping population doi danh dau | bo truong nao khoi fingerprint |
| id duoc trim truoc khi bam dau | go them khoang trang khong churn population | khong trim |
| tenant null va tenant rong cung mot population | deu bi bo khoi query wire | doi chieu voi buildOperationsQuery |
| khong co cursor -> khong bao gio stale | | |
| population giong nhau -> khong stale | paging tiep tuc chay | cursor bi giat khi khong can |
| **cursor cua tenant A sang tenant B -> stale** | **dung loi AWEB-20** | chinh loi cua task nay |
| population doi (state/window/id/limit) -> stale | | |
| khong ro nguon goc cursor -> stale (fail-safe) | bo thay vich replay vong population khong ai ghi nhan | |

**Trung thuc ve mot test:** `treats an absent tenant and an empty one as the same population` la **bang tai lieu**, khong mang tinh load-bearing cho fix nay - no xanh ca khi mutation bo tenant khoi fingerprint, vi khi do ca hai deu giong nhau. Ghi ro de khong dem nham mot test bam an.

## 5. Bang chung chay

CWD `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`. Node v24.21.0. Runner: `node --test` (admin-web khong co script test; xem receipt AWEB-20a).

### 5.1 RED cua vong nay

Test moi nhac vao **cac helper da co** (AWEB-20a vua them), nen khong co RED module-level cho phan nay. RED load-bearing lay bang mutation o 5.2.

### 5.2 Mutation - bo tenant khoi fingerprint (tai hien dung loi cua task)

    node --test tests/operations-state.test.mjs    -> MUT=FAIL

Dung hai test do, va chi hai:

- `changes when tenantId changes`
- `drops a cursor minted for another tenant - the AWEB-20 defect`

Test lien quan state/window/id/limit van xanh - dung mong doi, chung khong phu thuoc viec co tenant hay khong.

### 5.3 GREEN - 3 lan lien tiep, gan bang chung voi digest

Chay trong mot script in sha256 cua 3 file **truoc** va **sau** moi lenh, de chung minh khong co writer nao dung vao giua:

    DIGEST_BEFORE  state.ts ac9e825bc1b40d9c | operations-screen.tsx f2ca1c649ef262c7 | operations-state.test.mjs 995cc505234c1798
    RUN1_EXIT=0 / RUN2_EXIT=0 / RUN3_EXIT=0
    ALL_EXIT=0
    DIGEST_AFTER   y het

Sha la binding: **cung mot byte** cho ca 4 lenh chay.

### 5.4 Toan bo test admin-web + typecheck

    ALL_EXIT=0    (operations-state + audit-state + trace-state)
    TSC=0         (tsc --noEmit -p tsconfig.json)

## 6. DELTA - co writer khac cham vao cung file giua chung

Phai ghi vi no lam suy bang chung giua vong nay:

Co mot lan `node --test` **that bai** ca 3 run, va do lai cho thay `operationsPopulation` tra ve **chuoi JSON** (cac phan tu bao trong ngoac vuong, tenant hien la `null` thay vi chuoi rong) thay vi chuoi join bang `|`. Ban do **khong phai** ma cua toi (`join('|')` voi `tenantId ?? ''`), va do lai khong phai do test cua toi. Doc lai `state.ts` thi thay khop ban toi, chay lai thi xanh; digest truoc/sau o 5.3 giong nhau.

⇒ **Khong loai truy cap hay revert gi.** Hai kha nang: writer khac sua roi tra lai, hoac ban trung gian den tu tac phat sinh. Ca hai khong phai viec toi sua, va toi khong ghi de gi.

**Hau qua thuc te:** neu ai do doi tiep `state.ts` thi ket qua 5.3 mat hieu luc. Do la ly do toi in digest truoc va sau, de verifier doi chieu duoc byte cu the cua lan chay do.

## 7. Gioi han cua bang chung

1. **Khong chay UI that** (khong browser/Playwright). `useEffect` va `ref` chi duoc doc code + typecheck, khong phai do thuc thi. Mot loi runtime (vi du effect lam vong lap) se khong lo ra o day.
2. **Khong goi API that.** Test kiem hai helper thuan; chua chung minh route that tra dung trang cho cursor da bo.
3. Khong co test cho phan JSX cua Previous/Next; viec chuyen sang `applyCursor` duoc bao dam bang typecheck + grep (setCursor con 3 cho).
4. `apps/admin-web/tests/` **untracked trong git**, nen provenance la sha256 chu khong phai `git diff`.
5. Khong co debounce cho `id` (mo ky tu goi API) - tinh trang tu truoc, ngoai pham vi nay.

## 8. Phan gioi

Sha256 cua ban cuoi (bang chung 5.3 chay tren chinh cac byte nay):

    src/features/operations/state.ts              200 dong  ac9e825bc1b40d9c93fc34abe15e8228c1109bd0bc539e9d266b89cdb29dc4d1
    src/features/operations/operations-screen.tsx 913 dong  f2ca1c649ef262c715c46bb1620467c6f1d25a3bdb2219f2395bbedce1b522b4
    tests/operations-state.test.mjs                202 dong  995cc505234c179869861f1fcde48764468bf29dd250522a9a8fc82bebe23c9d

- `state.ts` va `operations-state.test.mjs`: **0 ky tu nhay kep**. Nhay kep trong `operations-screen.tsx` la thuoc tinh JSX co san, khong phai do toi them.
- KHONG `git add` / `commit` / push. Khong sua file ngoai lease. Khong tick gate, khong tu nhan ACCEPTED.

## 9. Verdict

| Hang muc | Ket qua |
|---|---|
| Nhung bo loc reset cursor (bang chung o §1) | **DA DO** |
| Tenant doi ma giu cursor | **DA SUA** |
| Tat ca duong gan cursor di qua mot quy tac | **DA SUA** (grep: setCursor con 3 cho) |
| Test moi | **14 test, 22/22 PASS**, 3 lan lien tiep |
| Mutation bo tenant | **2 test do** |
| Toan bo test admin-web | **PASS** |
| Typecheck | **exit 0** |

⇒ **AWEB-20: IMPLEMENTED, offline [PASS], chua ACCEPTED.** Con can mot luot integration/browser de dong, va can doi chieu digest o §8 truoc khi tin - xem DELTA §6.
