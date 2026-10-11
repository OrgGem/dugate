# AWEB-20a - Operations screen: noi bo loc from/to vao API query

| Muc | Gia tri |
|---|---|
| Task | AWEB-20a (UI integration) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Lease | apps/admin-web/src/features/operations/operations-screen.tsx, apps/admin-web/src/features/operations/state.ts, apps/admin-web/tests/operations-state.test.mjs (moi), receipt nay |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED |
| Receipt | coordination/reports/receipt-aweb-20a-ui-2026-10-10.md |

## 1. Kiem chung tien de TRUOC khi sua: backend co that su nhan from/to?

Packet noi backend vua bo sung `from`/`to`. Theo kinh nghiem (dispatch spec hay sai), toi do lai truoc khi viet mot dong nao. **Ket qua: dung, va ca ba tang deu san sang.**

| Tang | Bang chung |
|---|---|
| Route admin list | `src/modules/operations/list-query.ts:279-280` doc `want('from')` / `want('to')` qua `parseOperationsListTimeBound` |
| Rang buoc | `:281-282` tra 422 `INVALID_SCHEMA` khi `from` sau `to` |
| SQL | `:410-411` sinh `created_at >= $n::timestamptz` / `created_at <= $n::timestamptz` |
| Dinh dang chap nhan | `packages/contracts/src/public-api.ts:531-543`: `ADMIN_LIST_TIME_PATTERN` = `YYYY-MM-DDThh:mm:ss(.f{1,6})?Z`, **va** phai la ngay that (so sanh lai `toISOString`) |
| BFF | `src/app/admin/bff/operations.ts:46` `OPERATIONS_PARAM_ALLOWLIST` **da co `from`, `to`**; `:182` forward theo allowlist |

⇒ Khong co thieu hut o backend. Duong ong thong tu BFF toi SQL.

## 2. Loi that: UI khong he gui from/to

`operations-screen.tsx` (truoc sua) co hai o `type=date` nhung:

1. `load()` gui len `limit`, `state`, `sort`, `tenant`, `id`, `cursor` - **khong co `from`/`to`**.
2. `fromDate`/`toDate` duoc dung boi `inWindow` (:193-208), mot ham **loc client-side tren trang da tai**, kem ghi chu nguyen van:

       // OPU-OPS-4: date bounds are inclusive UTC days over the LOADED page only.

3. Dong ghi chu tren UI cung noi dung vay: `Time window applies to the loaded page (UTC dates).`

He qua that voi nhan vien van hanh: dat From/To ma operation khop nam o trang 2 thi **khong bao gio hien** - no bi loc mat truoc khi ai kip nhin thay. Va `total` do server tra ve se **khong khop** voi so dong bang hien thi. Day la loi im lang, khong phai loi hien.

## 3. Sua

### 3.1 `features/operations/state.ts` - them 3 helper thuan (test duoc offline)

- `operationsTimeWindow(fromDate, toDate)` - doi ngay (YYYY-MM-DD) thanh instant UTC. **Giu dung ngu nghia cu**: ngay bat dau mo o `T00:00:00.000Z`, ngay ket thuc dong o `T23:59:59.999Z` (ngay UTC tron ven). Tra `null` cho ben khong dat, de ben do **vang mat** khoi query thay vi gui chuoi rong.
- `operationsWindowInvalid(fromDate, toDate)` - true khi ngay bat dau sau ngay ket thuc.
- `buildOperationsQuery(input)` - dung dung query gui BFF, mirror `buildAuditQuery` da co trong `features/audit/state.ts`.

### 3.2 `operations-screen.tsx`

- `load()` goi `buildOperationsQuery(...)`, va them `fromDate`/`toDate` vao dependency array (truoc do doi ngay khong kich hoat tai lai).
- **Bo** `inWindow`; `visibleItems` gio la `pane.data.items` nguyen ven - server da loc.
- Guard `operationsWindowInvalid` dat **dau** `load()`, truoc moi `setState`: neu dat sai, giu nguyen trang cu thay vi thay ca bang bang hop loi 422. Kem mot `AlertBanner` canh bao bang chu.
- Sua ghi chu UI thanh: `From/To are inclusive UTC days and are applied by the server, not by this page.`

### 3.3 Vi sao giu `type=date` chu khong doi sang `datetime-local`

Man Audit (da co, `features/audit/`) dung `datetime-local` + `localDateTimeToUtc`. Nhung Operations dang la **ngay UTC tron ven** va do la mo hinh tinh than cua operator. Doi sang datetime-local la doi trai nghiem ngoai pham vi sua loi, va se lam moi anh chup/script cu sai. Nen toi giu `type=date` va chi doi **noi gui di**. Neu product muon datetime-local thi do la mot quyet dinh rieng.

## 4. Bang chung chay

CWD `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`. Node v24.21.0. Test chay bang `node --test` (admin-web khong co script test trong package.json; cac file `.test.mjs` import truc tiep nguon `.ts` nho type-stripping cua Node - da xac nhan bang cach chay `tests/audit-state.test.mjs` truoc khi sua: exit 0).

### 4.1 RED

    node --test tests/operations-state.test.mjs    -> RED=FAIL

    SyntaxError: The requested module '../src/features/operations/state.ts'
    does not provide an export named 'buildOperationsQuery'

**Noi that ve chat luong bang chung nay:** day la RED o **tang module** (thieu export), khong phai assertion that bai. Mot RED nhu vay chua chung minh duoc test co rang buoc that su. Vi vay toi lam them buoc 4.2.

### 4.2 Mutation - chung minh test co rang buoc

Tam go `from`/`to` khoi `buildOperationsQuery`, chay lai chinh file test cuoi:

    node --test tests/operations-state.test.mjs    -> MUT=FAIL
    tests 8 / pass 6 / fail 2

Hai test do la **dung hai test khang dinh from/to duoc gui**:

- `turns a half-open window into the bound that was asked for`
- `sends an inclusive UTC day window that the admin list contract accepts`

6 test con lai van xanh vi chung khong phu thuoc viec gui from/to - dung thiet ke. Khoi phuc lai: 8/8 pass.

### 4.3 GREEN - 3 lan lien tiep

    for %i in (1 2 3) do @(node --test tests/operations-state.test.mjs ...)

    RUN1_EXIT=0 / RUN2_EXIT=0 / RUN3_EXIT=0

### 4.4 Toan bo test cua admin-web

    node --test tests/operations-state.test.mjs tests/audit-state.test.mjs tests/trace-state.test.mjs

Exit 0. Literal:

    tests 20
    suites 3
    pass 20
    fail 0

### 4.5 Typecheck

    node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json    -> exit 0, khong output

Luu y: tsconfig admin-web bat `noUnusedLocals`/`noUnusedParameters`, nen viec bo `inWindow` ma con sot tham chieu se **khong build duoc** - typecheck chinh la bang chung cho thay da don sach.

## 5. Dinh dang gui len - kiem bang test, khong bang mat

`operationsTimeWindow('2026-10-01', '2026-10-10')` tra:

    from = 2026-10-01T00:00:00.000Z
    to   = 2026-10-10T23:59:59.999Z

Test `sends an inclusive UTC day window that the admin list contract accepts` kiem hai instant nay bang **ban sao cua `ADMIN_LIST_TIME_PATTERN`** cong phep kiem ngay that (`toISOString().slice(0,19)` phai bang tien to input) - dung nhu `isAdminListTimeBound` lam. Toi ghi ro trong test day la ban sao: **backend van la noi phan quyet**, va mot instant sai se bi route tra 422 chu khong bi am tham bo qua.

## 6. Gioi han cua bang chung nay

1. **Chua chay UI that.** Khong browser, khong Playwright. Cac khang dinh ve trai nghiem (vi du bang giu trang cu khi cua so sai) la suy ra tu code, khong phai do tuong tac.
2. **Chua goi API that.** Test kiem query duoc dung, khong kiem route that tra du lieu dung - do la viec cua mot buoc integration.
3. **Khong co test cho phan JSX.** Test chi phu hai helper thuan trong `state.ts`. Viec `load()` goi dung helper va `inWindow` da bi bo chi duoc bao dam boi typecheck + doc code, khong boi test.
4. `apps/admin-web/tests/` **untracked trong git** (ca `audit-state.test.mjs` lan `trace-state.test.mjs` deu vay), nen provenance o day la sha256 chu khong phai `git diff`.
5. Cay dang di chuyen: trong luc lam, mot lane khac da them man Audit voi `buildAuditQuery`/`buildAuditCsv`. Neu doc lai file:line sau nay, doi chieu lai.

## 7. Phan gioi

File da doi (dung lease, khong sua `ldba-context-provider.cjs`):

    src/features/operations/state.ts              157 dong  sha256 c14b0faf636f1efa29b2ebba8541b6727f625c605844db87a30642e1e2462025
    src/features/operations/operations-screen.tsx 885 dong  sha256 277d0eb92607dfba6e430546df3b119b151f5126ba153d5066d8a79bbc7dd966
    tests/operations-state.test.mjs                98 dong  sha256 e2b3219440936d8dfa9ee5424ac132706679f7917be80cfb7abc1db788fbc06a

Sha ghi tren la **ban cuoi**. Ban `state.ts` trung gian co sha khac truoc khi toi go 2 ky tu nhay kep ra khoi comment (rang buoc packet), nen neu ai do doi chieu sha thi phai so sanh tren ban cuoi, con khong se tuong la file da bi sua lai.

- KHONG `git add` / `commit` / push. Khong mo cua so DB/Redis/S3. Khong sua file ngoai lease.
- Khong tick gate, khong cap nhat task row/plan, khong tu nhan ACCEPTED.
- Hai file toi sua deu **0 ky tu nhay kep moi**; 420 ky tu nhay kep trong `operations-screen.tsx` la thuoc tinh JSX co san tu truoc, khong phai do toi them.

## 8. Verdict

| Hang muc | Ket qua |
|---|---|
| Backend nhan from/to | **XAC NHAN** (route + BFF allowlist + SQL predicate) |
| UI gui from/to | **DA NOI** - truoc do khong gui |
| Loc client-side tren trang da tai | **DA BO** |
| Test moi | **8/8 PASS** x3 exit 0 |
| Mutation | **2/8 do** dung hai test khang dinh from/to |
| Toan bo test admin-web | **20/20 PASS** exit 0 |
| Typecheck | **exit 0** |

⇒ **AWEB-20a: IMPLEMENTED, offline [PASS], chua ACCEPTED.** Can mot buoc integration (goi API that hoac browser) truoc khi dong.
