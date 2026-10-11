# SEC-01V - Doc lap thu SEC-01 (cutover legacy admin shell)

- **Spec:** coordination/dispatch-specs/2026-10-11-SEC-01V-review.md
- **Receipt cua implementer:** coordination/reports/receipt-sec-01-cutover-2026-10-11.md
- **Ngay:** 2026-10-11. **Vai tro:** reviewer doc lap. **Lease:** READ-ONLY - 0 sua file san pham/test.
- **Phuong phap:** doc source + chay lai test bang lenh cua minh. KHONG tin receipt cua implementer; KHONG dung mutation (lease cam sua).

## 0. Ket luan 1 dong

5 tieu chi deu DAT, bang bang chung tu source va lan chay test cua chinh toi. 3 suite do trong lan chay rong **khong do cutover gay ra** - nguyen nhan doc truoc tu source, khong phai suy dien tu receipt.

---

## 1. Tieu chi 1 - /admin/legacy va toan bo /admin/legacy/* tra 404

**DAT.** Doc shell-server.ts:

- Dong :866: `if (pathname === '/admin/legacy' || pathname.startsWith('/admin/legacy/'))` -> 404, body co `NOT_FOUND` + `Legacy Admin Shell closed`.
- Thu tu nhanh trong `createServer` (doc truoc tu source): `isBffPath` (:838-850) -> redirect `/portal` (:851-865) -> **block 404** (:866-881) -> `isAdminWebPath` (:882-886).
- Block **khong** bi gate boi `adminWebMount` - no chan ca khi topology B (DU_ADMIN_WEB=0). Manh me hon spec: cutover dung cho ca 2 topology.
- `pathname` da tach query truoc khi so, nen `/admin/legacy?x=1` cung bi chan.

Chay lan cua toi:

    npx jest tests/sec-or-01-legacy-read-scope-offline.test.ts --runInBand
    Test Suites: 1 passed, 1 total
    Tests:       6 passed, 6 total

Test wire bao gom 4 path (`/admin/legacy`, `/admin/legacy/`, `/admin/legacy/businesses`, `/admin/legacy/audit`) deu 404 + body chua `NOT_FOUND` + `Legacy Admin Shell closed`. Baseline truoc khi sua: 4/4 xanh (4 test SEC-01F read scope, chuyen path, khong bi xoa).

## 2. Tieu chi 2 - Khong route SPA nao hong

**DAT.** Block chi khop `/admin/legacy` exact va tien to `/admin/legacy/`. Doc router.tsx:42-57 - danh sach route SPA la overview, audit, trace, connectors, profiles, operations, businesses, usage, security, secrets, identity, settings, workflows, docs, api-doc, `*`. **Khong** route nao bat dau bang `/admin/legacy`.

Canh bao: `/admin/legacyXYZ` (khong co slash) **khong** bi block chan - no roi vao `isAdminWebPath` -> SPA -> route `*` (NotFound). Day la hanh vi dung, khong phai hong.

Grep doc lap:

    findstr /s /n /c:"admin/legacy" orchestrator\apps\admin-web\src\*.ts *.tsx  -> 0 byte output
    grep_search /admin/legacy trong apps/admin-web/src                              -> 0 matches

## 3. Tieu chi 3 (CHINH) - BFF van tra du lieu that

**DAT.** `isBffPath` nam o :838-850, **truoc** block 404 o :866. `BFF_BASE_PATH = '/admin/api'` (handle.ts:56) - khong giao voi `/admin/legacy`. Nen BFF khong bao gio bi chan.

Chay lan cua toi 5 suite theo spec:

    npx jest tests/admin-api-keys.test.ts tests/aweb02-bff-foundation.test.ts tests/aweb04-bff-profiles.test.ts tests/aweb05-bff-reads.test.ts tests/aweb07-bff-security.test.ts --runInBand
    Test Suites: 5 passed, 5 total
    Tests:       103 passed, 103 total

Chay bo sung nhom shell rong cua toi (doc lap, khong tin receipt):

    npx jest --runInBand --testPathPatterns "admin-shell-|admin-render-|admin-view-model-|business-|admin-error-boundary-offline-|admin-audit-mount-|rfx11-"
    Test Suites: 1 skipped, 14 passed, 14 of 15 total
    Tests:       1 skipped, 378 passed, 379 total

**Chenh lech mo ta (khong phai chenh lech ket qua):** receipt cua implementer ghi 623 passed / 17 suite; lan cua toi ra 378 passed / 14 suite. Ca deu xanh, khong suite nao do. Chenh lech la do dang mo rong pattern chay khac nhau. So song: cai nao cung khong co do nao nhom shell.

## 4. Tieu chi 4 - Nav SPA het link legacy

**DAT.** 0 match `/admin/legacy` trong `apps/admin-web/src` (bang chung o muc 2). `app-shell.tsx:15-22` - NAV la literal const, khong sinh link dong. Trong NAV: Administration co Audit, Security, Secrets, Identity, Settings - **khong** con API keys (dich sang panel per-profile).

Grep bo sung: `tests/browser` cung 0 match `/admin/legacy` - khong co browser spec nao phai cap nhat.

## 5. Tieu chi 5 - login / logout / oidc callback khong hong

**DAT.** `isAdminWebPath` (:479-501) giu nguyen **4** nhanh loai tru: `isBffPath`, `/admin/login`, `/admin/logout`, `/admin/oidc/callback`. Doc truoc tu source sau khi sua.

Chay lan cua toi 3 suite OIDC/session:

    npx jest tests/admin-shell-oidc-flow-integration.test.ts tests/admin-oidc-flow.test.ts tests/admin-shell-session-lifecycle.test.ts --runInBand
    Test Suites: 3 passed, 3 total
    Tests:       65 passed, 65 total

Typecheck (doc lap):

    npx tsc --noEmit -p tsconfig.json (services/orchestrator)  -> exit 0, 0 byte output
    npx tsc --noEmit -p tsconfig.json (apps/admin-web)         -> exit 0, 0 byte output

## 6. PHAN BAC BUOC - 3 suite do, doc lai tu SOURCE (spec yeu cau bat buoc)

**Ket luan: ca 3 deu KHONG do cutover gay ra.** Bang chung tu source, khong tu receipt.

### 6.1 `admin-action-dispatcher.test.ts` - 4 test do

- Import cua test: `shell-auth` (signCookie), `db`, `http/errors`, `audit`, `modules/admin-actions/dispatcher`, `modules/admin-actions/rbac`. **Khong** import `shell-router` hay `shell-server`.
- Nguyen nhan: `modules/admin-actions/dispatcher.ts` them `OPERATION_CONTROL_ACTIONS = new Set(['operations.cancel', 'operations.retry', 'operations.resume'])` (dong :9). Test matrix filter chi loai `cancel` va `resume`, nen `retry` bi test cho la 403 nhung code cho `ok=true`.
- Do la drift RBAC trong module `admin-actions` - product cua lane khac, commit cung wave. **Khong** lien quan shell-server / shell-router / app-shell.

### 6.2 `aweb-16a-overview-tenant-operations.test.ts` - 2 test do

- Loi: `ReferenceError: setWorkerInstances is not defined`.
- Test doc source `overview-screen.tsx` bang readFileSync, trich `load` callback, eval voi danh sach dependency co dinh. File nay duoc lane AWEB sua trong cung wave commit: them `useState` + `setWorkerInstances` (overview-screen.tsx:234, 403-418).
- Test khong khai bao `setWorkerInstances` trong injected deps -> eval ra ReferenceError.
- **Khong** lien quan 3 file cua cutover.

### 6.3 `aweb06-bff-operations.test.ts` - 1 test do (case rui ro nhat, import shell-server)

- Import `createAdminShellServer` tu shell-server - lien quan truc tiep. Phai kiem ky.
- Test that bai: `worker inventory is platform-scoped...` - operator nhan **200** thay vi 403.
- Doc `bff/handle.ts`:
  - Dong :123-133: nhanh `if (relative === '/worker-instances')` -> `handleAdminGetRelay`.
  - Dong :176: `matchOperationsRoute` chay **sau** nhanh tren.
  - `bff/operations.ts:118-131` co fence `route.kind === 'worker-instances'` -> 403 `ADMIN_CREDENTIAL_REQUIRED`, nhung **khong bao gio chay** cho path nay vi handle.ts da serve truoc.
  - `handleAdminGetRelay` (:503-540) **khong** co role check - chi check session, principal.kind, credential, upstream. Nen operator session nhan 200.
- `git log -S "worker-instances" -- bff/handle.ts`: chi co commit ae6fc72 them nhanh nay - do lane BIZ-09/AWEB-11C, **khong** phai SEC-01. Truoc commit do, handle.ts **khong** co nhanh worker-instances (da kiem bang `git show ae6fc72~1`).
- Kiem cut: block 404 cutover nam o :866, sau `isBffPath` o :838. Path `/admin/api/worker-instances` la BFF path, duoc serve o :838-850 **truoc** khi toi block. 3 thay doi cua cutover (isAdminWebPath, block 404, shell-router admin-root) deu khong cham vao duong di nay.
- **Ket luan: do la fence thieu trong lane worker-instances, khong do cutover.**

### 6.4 Tong ket phan bac buoc

| Suite | Test do | Nguyen nhan doc tu source | Do cutover? |
|---|---|---|---|
| `admin-action-dispatcher.test.ts` | 4 | drift RBAC trong `admin-actions/dispatcher.ts` (them `operations.retry`) | **KHONG** |
| `aweb-16a-overview-tenant-operations.test.ts` | 2 | test eval source stale so voi `overview-screen.tsx` moi (them `setWorkerInstances`) | **KHONG** |
| `aweb06-bff-operations.test.ts` | 1 | `handle.ts:123` serve `/worker-instances` truoc `matchOperationsRoute`, bo qua fence `operations.ts:118` | **KHONG** |

Ca 3 deu la product cua lane khac, commit cung wave `ae6fc72`. Receipt cua implementer khai dung; toi xac nhan lai bang doc, khong bang tin.

## 7. Danh gia muc "khong port gi" (spec section 5)

**Dung.** Ly do:

- `shell-router.ts:202` `checkPath` giu nguyen - dung theo spec §4, thuoc SEC-01F. **Luu y:** sau khi co block 404 o :866, duong wire khong con toi `matchShellRoute` cho `/admin/legacy*` - `checkPath` bay gio la hang phong thu cho topology B va cho nguoi goi truc tiep. Giu la dung.
- `section-dispatch.ts` khong sua - dung, no la product SEC-01F.
- `/admin/api-keys` he thong + `/admin/grants` mat san - chu da chap nhan (spec §1). Toi xac nhan: SPA nav khong con link API keys (dich sang per-profile panel), `lib/api/client.ts:358` van con method `listApiKeys` nhung khong con UI goi; `section-dispatch` khong co route `grants`. That la that mat san, da duoc chap nhan.
- **Spec §5 co phan stale:** spec ghi "SEC-01F van chua lam - topology B van lo /admin/businesses va /admin/audit cross-tenant". Commit wave `ae6fc72` **da** land SEC-01F: co test `sec-01f-tenant-credential-fetchers-offline.test.ts` (5/5 xanh, chay lan cua toi) va `section-dispatch.ts` co `legacyReadCredential` + `sectionHasProtectedRead` fencing. Nen topology B gio da co fence. Day la thay doi moi so voi gia dinh cua spec, khong phai loi cua SEC-01.
- Khong tick gate, khong claim dispatch ID - dung thai do.

## 8. Gioi han cua ban review nay

- **Khong chay mutation probe.** Receipt implementer khai 2 probe (tat block -> do; thu hep khop exact -> do). Toi khong chay vi lease cam sua file. Thay vao do, toi kiem bang cach doc: test assert **body** chua `NOT_FOUND` + `Legacy Admin Shell closed` - body ma renderer legacy khong san xuat. Nen claim "chi assert status 404 la khong du" la dung theo doc, nhung **chuong trinh chua duoc thuc su mutate** de kiem chung.
- **Khong co bang chung browser.** Giong receipt implementer. Toi danh gia: **chap nhan duoc**. 5 tieu chi deu o muc HTTP, du chung minh bang source + wire test offline + tsc. Tieu chi 4 (nav het link legacy) chung minh bang grep 0 match tren `apps/admin-web/src` va NAV la literal const - khong co sinh link dong. Browser evidence chi bo sung them bang chung render UI, khong phai tieu chi quyet dinh.
- **Khong co lan A/B dao nguoc cua chinh toi.** Lease READ-ONLY cam sua file. Toi dung phan bac buoc bang cach doc source + `git log -S` + `git show ae6fc72~1` de kiem nguyen nhan do, thay vi dao sua lai code.
- Lan chay nhom shell cua toi ra 378 passed / 14 suite, receipt implementer ghi 623 / 17. Ca deu xanh. Chenh lech do dang pattern, khong do ket qua.

## 9. Cua so mo cho owner (khong phai lane nay)

1. `bff/handle.ts:123` - fence thieu cho `/worker-instances` (muc 6.3). Day la regression authz cua lane AWEB/BIZ-09: operator session nhan 200 cho platform-scoped inventory. Ngoai lease SEC-01. Can owner giao lai lane do.
2. `admin-actions/dispatcher.ts` - drift matrix `operations.retry` (muc 6.1). Test va code chua khop; can chot ai dung ai.
3. `overview-screen.tsx` - test `aweb-16a` stale so voi source (muc 6.2). Can lane AWEB cap nhat injected deps cua test.
4. SEC-01F da land cung wave - topology B gio co fence. Spec §5 va receipt implementer van ghi "SEC-01F chua lam"; can cap nhat tai lieu cho khop cay.

---

**SEC-01V: ACCEPTED**
