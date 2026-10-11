# VERIFY INDEPENDENT - SEC-01 Cutover legacy admin shell

- **Vai tro:** independent verifier, READ-ONLY. Khong sua source, khong sua test.
- **Receipt chu:** coordination/reports/receipt-sec-01-cutover-2026-10-11.md
- **Packet:** coordination/dispatch-specs/2026-10-11-SEC-01-cutover-legacy-admin.md
- **Ngay:** 2026-10-11. **Ket luan:** XAC NHAN OFFLINE - khong phat hien loi trong 3 muc lenh duoc giao. **Khong tick gate, khong ACCEPT, khong phat sinh dispatch ID.**

---

## 0. Tom tat mot dong

Ba muc lenh user giao deu chay lai doc lap va deu dat: lease suite 6 passed / 6 total, tsc --noEmit exit 0, va wire that tren loopback HTTP xac nhan /admin/legacy + toan bo /admin/legacy/* tra **404 voi body NOT_FOUND + Legacy Admin Shell closed** trong khi /portal* van 302 va /admin/api/* van chay BFF. **Khong co hang muc nao sai.**

---

## 1. Muc 1 - npm test -- tests/sec-or-01-legacy-read-scope-offline.test.ts

Chay tai du-rework/orchestrator/services/orchestrator (cwd cua lenh, de nguyen theo lenh user).

+ PASS  tests/sec-or-01-legacy-read-scope-offline.test.ts
+   SEC-OR-20261011-01 legacy operations and overview read scope
+     uses the session tenant credential and overrides the legacy operations tenant filter
+     uses the session tenant and tenant credential for legacy overview despite a foreign query value
+     denies viewers and operators without a mapped tenant credential before either fetcher runs
+     preserves platform admin access and its explicitly requested tenant filters
+   SEC-OR-20261011-01 cutover: legacy admin shell surface is closed
+     no longer maps /admin/legacy or /admin/legacy/ to the admin root
+     answers 404 over the wire for /admin/legacy and every /admin/legacy/* path
+ 
+ Test Suites: 1 passed, 1 total
+ Tests:       6 passed, 6 total
+ CMD_EXIT=0

- Khop dung receipt chu: 6 passed, 6 total.
- **Khong dung findstr hay %ERRORLEVEL%** de do exit code. Dung && ... || .... Mot so lan cho phep --silent khong bao gio dung, vi %VAR% tren cmd.exe parse truoc khi chay va bao xanh gia.
- Doc them file test (tests/sec-or-01-legacy-read-scope-offline.test.ts:181-242): **2 test cutover co that, khong phai assert rong.**
  - expect(matchShellRoute(GET, /admin/legacy)).toBeNull() va .../admin/legacy/ - kiem mapping route, khong phai chi kiem HTTP.
  - Test HTTP loopback that, bat server tren 43_940 + (pid % 10) * 4 cong offset, quet 4 path va **assert ca status 404 LAN body** (toContain NOT_FOUND, toContain Legacy Admin Shell closed).
  - Day la diem dung: chi assert status 404 se khong bat duoc regression vi route da bi go khoi admin-root o shell-router.ts nen legacy renderer cung tra 404. Receipt chu da tu phat hien dung diem nay o §3.4 cua ho.
  - **Ghi nho port:** 43_940 + (pid % 10) * 4 nam duoi 49_152, trong Windows ephemeral range. Dung cho test nay.

---

## 2. Muc 2 - npx tsc --noEmit

Tai du-rework/orchestrator/services/orchestrator.

+ (khong output byte nao)
+ CMD_EXIT=0
+ Exit Code: 0

- Exit 0, khong output. Khop receipt chu §3.3.
- Khong dung -p tsconfig.json (receipt chu dung) - mac dinh da tro dung tsconfig.json cua package nen ket qua tuong duong.

---

## 3. Muc 3 - Kiem tra wire HTTP 404 cho /admin/legacy*

### 3.1 Doc source - thu tu handler

src/app/admin/shell-server.ts, doc lai tu working tree (dong 838-886):

| Thu tu | Nhanh | Dong | Dieu kien |
|---|---|---|---|
| 1 | isBffPath -> handleBffRequest | :838-851 | adminWebMount && |
| 2 | /portal* -> 302 | :852-864 | adminWebMount && |
| 3 | **/admin/legacy* -> 404** | **:865-880** | **khong co dieu kien** |
| 4 | isAdminWebPath -> SPA | :881-885 | adminWebMount && |

- Thu tu **dung** nhu receipt chu §1.1 khai. Nhanh chan nam **sau BFF** va **sau redirect portal**, **truoc** nhanh SPA. Day la vi tri dung:
  - Neu dat **truoc** nhanh 2, /admin/legacy se bi redirect 302 sang /admin - cutover khong fail-closed.
  - Neu dat **sau** nhanh 4, request se vao SPA - dung tai hoai cua bao §3 cua receipt chu (2 nhanh loai tru da bi bo khoi isAdminWebPath, nen isAdminWebPath(/admin/legacy) se tra true).
- isAdminWebPath (shell-server.ts:480-499) con dung 4 nhanh loai tru: isBffPath, /admin/login, /admin/logout, /admin/oidc/callback. **Khong con nhanh loai tru /admin/legacy*.** Khop receipt chu §1.1.
- Nhanh chan **khong co guard adminWebMount** - hau qua co chu dung: khi DU_ADMIN_WEB=0 (topology B, legacy la mat cu), /admin/legacy* **van** tra 404 Legacy Admin Shell closed chu khong quay ve legacy renderer. Day la fail-closed, dung huong spec. Da do duoc bang probe §3.2 lan 1 (boot khong adminWeb).
- Header cua nhanh chan: content-type: text/html; charset=utf-8, cache-control: no-store, x-content-type-options: nosniff, x-correlation-id. **Khong co err.message, khong co stack** - dung policy ADM-BASE-03 ma handler 500 ngay tren (:886-906) cung dung.

### 3.2 Wire that - probe doc lap cua verifier

Viet probe rieng (file temp ngoai repo, khong dung lai harness cua test), boot createAdminShellServer that tren loopback, bat node:http that, do status + location + body + header.

**Lan 1 - KHONG bat adminWeb mount:**

+ BOOTED
+ PATH=/admin/legacy                       STATUS=404 LEGACY_CLOSED_BODY=true  NOT_FOUND=true BODY_LEN=208     CC=no-store NOSNIFF=nosniff CORR_SET=true
+ PATH=/admin/legacy/                      STATUS=404 LEGACY_CLOSED_BODY=true  NOT_FOUND=true BODY_LEN=208     CC=no-store NOSNIFF=nosniff CORR_SET=true
+ PATH=/admin/legacy/businesses            STATUS=404 LEGACY_CLOSED_BODY=true  NOT_FOUND=true BODY_LEN=208     CC=no-store NOSNIFF=nosniff CORR_SET=true
+ PATH=/admin/legacy/audit                 STATUS=404 LEGACY_CLOSED_BODY=true  NOT_FOUND=true BODY_LEN=208     CC=no-store NOSNIFF=nosniff CORR_SET=true
+ PATH=/admin/legacy/operations/deep/deeper STATUS=404 LEGACY_CLOSED_BODY=true NOT_FOUND=true BODY_LEN=208     CC=no-store NOSNIFF=nosniff CORR_SET=true
+ PATH=/admin/legacyXYZ                    STATUS=404 LEGACY_CLOSED_BODY=false NOT_FOUND=false BODY_LEN=31407
+ PATH=/portal                             STATUS=404 LEGACY_CLOSED_BODY=false NOT_FOUND=false BODY_LEN=31398
+ PATH=/admin/overview                     STATUS=401 LEGACY_CLOSED_BODY=false NOT_FOUND=false BODY_LEN=31402
+ PATH=/admin/login                        STATUS=200 LEGACY_CLOSED_BODY=false NOT_FOUND=false BODY_LEN=31897
+ CLOSED

- **5/5 path /admin/legacy* ra 404 + body dung** - ke ca path sau nhieu cap (/admin/legacy/operations/deep/deeper). **Tieu chi 5 DAT.**
- /admin/legacyXYZ khong khop block (dung, chu startsWith(/admin/legacy/) va bang bang /admin/legacy), nhan body legacy renderer 31 KB chu khong phai body 208 byte. **Block hep, khong over-block.**
- Cac path khac (404/401) trong lan 1 **khong co bang chung gi** vi adminWebMount undefined nen nhanh BFF/portal/SPA deu bi bo qua, request rot xuong legacy renderer. Do la ly do co lan 2.

**Lan 2 - BAT adminWeb mount (stub index.html temp):**

+ admin web mount enabled
+ BOOTED_WITH_ADMINWEB
+ PATH=/admin/legacy              STATUS=404 LEGACY_CLOSED=true  SPA_INDEX=false BODY_LEN=208   CC=no-store
+ PATH=/admin/legacy/             STATUS=404 LEGACY_CLOSED=true  SPA_INDEX=false BODY_LEN=208   CC=no-store
+ PATH=/admin/legacy/businesses   STATUS=404 LEGACY_CLOSED=true  SPA_INDEX=false BODY_LEN=208   CC=no-store
+ PATH=/admin/legacy/audit/1      STATUS=404 LEGACY_CLOSED=true  SPA_INDEX=false BODY_LEN=208   CC=no-store
+ PATH=/portal                    STATUS=302 LOCATION=/admin              BODY_LEN=0  CC=no-store
+ PATH=/portal/overview           STATUS=302 LOCATION=/admin/overview     BODY_LEN=0  CC=no-store
+ PATH=/portal/audit?x=1          STATUS=302 LOCATION=/admin/audit?x=1    BODY_LEN=0  CC=no-store
+ PATH=/admin                     STATUS=302 LOCATION=/admin/login        BODY_LEN=0  CC=no-store
+ PATH=/admin/overview            STATUS=302 LOCATION=/admin/login        BODY_LEN=0  CC=no-store
+ PATH=/admin/operations          STATUS=302 LOCATION=/admin/login        BODY_LEN=0  CC=no-store
+ PATH=/admin/login               STATUS=200                              BODY_LEN=31897
+ PATH=/admin/api/profiles        STATUS=401                              BODY_LEN=171   CC=no-store
+ CLOSED

| Kiem | Nhan | Do chung minh |
|---|---|---|
| /admin/legacy* -> 404 + body | **DAT** | 4/4 path, body 208 byte NOT_FOUND + Legacy Admin Shell closed, **khong** phai SPA index |
| /portal* van 302 | **DAT** | 3/3 path, /portal/audit?x=1 giu nguyen query string |
| SPA route van load duoc | **DAT** | /admin/overview, /admin/operations -> 302 /admin/login (chua dang nhap, dung behavior), /admin/login -> 200 |
| BFF route van chay | **DAT** | /admin/api/profiles -> **401** chu khong phai 404 legacy-closed, chung minh nhanh 1 chay truoc nhanh chan |
| **/admin/legacy khong lot vao SPA** | **DAT** | SPA_INDEX=false tren ca 4 path legacy, trong khi /admin/* khac van tot |

**Ket luan muc 3: toan bo tieu chi wire cua packet dat, va dat o cap HTTP that tren socket that, khong phai suy dien tu test.**

---

## 4. Kiem tra them (ngoai 3 muc lenh, de khong tin hoan toan vao receipt chu)

### 4.1 Nav SPA khong con link legacy - tieu chi 4

- grep /admin/legacy trong orchestrator/apps/admin-web/src = **1 ket qua**, va no **khong phai** link: src/features/settings/catalog.ts:4, comment Source of truth: tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md section 3.
- The <a href=/admin/legacy> da bi go khoi app-shell.tsx (xac nhan qua diff duoi). **Tieu chi 4 DAT.**

### 4.2 Diff trong dung lease - tieu chi 7

+ apps/admin-web/src/app-shell/app-shell.tsx                        | 15 ++++-----------
+ services/orchestrator/src/app/admin/shell-router.ts              |  2 +-
+ services/orchestrator/src/app/admin/shell-server.ts              | 22 +++++++++++++++++++---
+ 3 files changed, 24 insertions(+), 15 deletions(-)

- **Dung 24 insertions / 15 deletions tren 3 file san pham** nhu receipt chu §2 khai.
- Test file tests/sec-or-01-legacy-read-scope-offline.test.ts la ?? (untracked) - git status --porcelain xac nhan M cho 3 file san pham, ?? cho test file. Khong file nao ngoai lease bi sua.
- **Chi co 3 file san pham, khong phai 3 + khac.**

### 4.3 shell-router.ts:201 giu nguyen - dung §2.1 receipt chu

+ if (p.startsWith(String.fromCharCode(47) + admin + String.fromCharCode(47))) {
+   const checkPath = p.startsWith(String.fromCharCode(47) + admin + String.fromCharCode(47) + legacy + String.fromCharCode(47)) ? p.replace(String.fromCharCode(47) + admin + String.fromCharCode(47) + legacy, String.fromCharCode(47) + admin) : p;

- Cong thuc checkPath **gia nguyen** nhu spec §4 yeu cau (phong thu topology B, san pham SEC-01F). **Khop receipt chu §2.1.**
- matchShellRoute khong con map /admin/legacy va /admin/legacy/ sang admin-root - xac nhan bang test mau 1 va doc shell-router.ts:171-175 (nhanh root chi nhan /, /admin, /admin/).

### 4.4 So nhay kep ASCII khong tang - rang buoc cua receipt chu §7

Dem byte ASCII 0x22 trong shell-server.ts:

+ DQ_HEAD=33
+ DQ_CUR=33
+ LINES_HEAD=1025
+ LINES_CUR=1041

- **33 = 33**, so nhay kep khong tang so voi HEAD. **Khop receipt chu §7.** 16 dong net tang len chinh la nhanh chan 404 + 2 dong bo khoi isAdminWebPath.

### 4.5 Route SPA khong bi regression - tieu chi 1

Doc orchestrator/apps/admin-web/src/router.tsx:31-63: 16 route SPA (overview, audit, trace, connectors, profiles, operations, businesses, usage, security, secrets, identity, settings, workflows, docs, api-docs) + index + catch-all * -> NotFound.
- **Khong route SPA nao trung voi /admin/legacy** nen nhanh chan khong the lam hong route SPA nao. Tieu chi 1 co mat bang: don lap, khong dua vao mau xanh cua 623 test.
- **Luu y Concurrent writer:** router.tsx dang M trong working tree va **khong nam trong lease SEC-01**. Diff hien tai la api-keys -> audit + trace (route legacy bi thay bang route hien hanh) - **day la thay doi cua lane khac trong tree, khong phai cua SEC-01**. Khong git add gi.

### 4.6 Nhom shell regression - so voi receipt chu

+ Test Suites: 1 skipped, 14 passed, 14 of 15 total
+ Tests:       1 skipped, 378 passed, 379 total

- **Khong suite nao do, khong test nao do.**
- **CHENH SO VOI RECEIPT CHU:** ho ghi 17 passed / 623 total, toi do duoc 14 passed / 378 total tren **cung lenh, cung cwd**. Chay lai 2 lan (mot lan truyen nhieu --testPathPatterns, mot lan truyen mot regex gop) cho **cung ket qua 14/378**.
  - **Hai kha nang, chua phan biet duoc:** (a) ho chay o thoi diem khac va tree da doi, nhieu lenh bi merge xoa; (b) chieu --testPathPatterns xu phieu khac nhau giup phu them suite (neu chay tu du-rework/ chu root hon, se thay them suite o package khac).
  - **Y nghia cho quyet dinh:** **khong co hieu ung den ket luan.** Ca hai lan chay deu **0 do**. Con lai **la kiem chung phu**, khong phai tieu chi. Tieu chi 1 da duoc chung minh doc lap o §4.5.
  - Nhung nen **hieu chinh §3.2 cua receipt chu** neu bao cao nay duoc dung lam can cu - so 17/623 khong reproduce duoc.

### 4.3b Ba suite do bi khai - kiem lai doc lap

Receipt chu §3.5 khai 3 suite / 7 test do va **tu chung minh** bang A/B dao nguoc 4 sua doi cua ho. **Toi khong lam A/B dao nguoc** (read-only, khong duoc sua file). Tai do lap bang cach doc import va doc loi:

+ Test Suites: 3 failed, 3 total
+ Tests:       7 failed, 70 passed, 77 total

- **7 do - dung so receipt chu khai.**

| Suite | Import | Loi thuc te doc tu output | Do phan dinh |
|---|---|---|---|
| admin-action-dispatcher.test.ts | shell-auth, db, http/errors, audit - **khong import shell-server, shell-router, app-shell** | 4 do, authorizeAdminAction matrix: Expected false / Received true; Expected substring: role / Received: operator sessions must carry a server-side tenant | **Khong phai SEC-01** - test RBAC thuan, khong cham HTTP handler nao |
| aweb-16a-overview-tenant-operations.test.ts | node:fs, node:path, typescript - doc source bang readFileSync, **khong import shell** | 2 do, ReferenceError: setWorkerInstances is not defined | **Khong phai SEC-01** - loader doc ma nguon can, san pham lane AWEB-15 |
| aweb06-bff-operations.test.ts | **createAdminShellServer co that** - nen can phan biet ky | 1 do, worker inventory is platform-scoped... Expected: 403 / Received: 200 | **Xac nhan nguyen nhan receipt chu §6.3** |

- Voi suite thu 3 (co import shell-server that, nen khong loai duoc bang ly do import): doc bff/handle.ts:123-133 - nhanh if (relative === /worker-instances) -> handleAdminGetRelay **phuc vu truoc** nhanh matchOperationsRoute, va handleAdminGetRelay (:503) khong co kiem tra role. Do la **regression authz cua lane khac (AWEB-11C), khong phai cua cutover** - khop nguyen nhan receipt chu doc source, khong doan.
- **Hoi quy o cap wire doc lap cua toi:** probe §3.2 lan 2 chung minh /admin/api/* van chay qua BFF binh thuong (/admin/api/profiles -> 401). Cutover khong cat duong BFF.

---

## 5. Bang chung dispatch - sua mot diem trong receipt chu

Receipt chu §6.2 ghi Owner: PENDING va **khong co dispatch ID**, nen **khong co bang chung dispatch**.

- **Xac nhan:** tree co coordination/reports/receipt-aweb-origin-credential-count-2026-10-11.md voi bang chung dispatch that: run_bd5609db31ae, task_a231ad97baca, ctx_f1c7c0e52e3a, owner term_e97ba66f.
- **NHANH QUAN TRONG:** day la cua **AWEB-ORIGIN-CREDENTIAL-COUNT**, **khong phai cua SEC-01**. Khong duoc dung de dong §6.2 cua SEC-01.
- **Ngoai ra:** spec cua SEC-01 van ghi Owner: PENDING. Khong tu gan, khong tick gate, khong nhin suy trang thai dispatch cua SEC-01 tu bang chung cua lane khac.

---

## 6. Trang thai SEC-01 - kiem lai mot lan nua

Receipt chu §0 tinh trang **IMPLEMENTED + offline-verified, chua ACCEPTED**. Reviewer lap doc lap khong doi phan do.

**Van con BLOCKED o tien to chua chay - va day la viec cua owner khac, khong phai cua toi:**

- File coordination/reports/receipt-sec-01-origin-credential-count-2026-10-11.md (owner khac viet, **khong phai toi**) ghi trang thai blocked at the required schema preflight; no cipher row count was run.
- Nguyen nhan ghi lai: migration **0041 chua duoc ap dung** tren DB dich - profile_bindings co file_url_auth_cipher (nullable text) nhung **khong co cot allowed_origins**.
- **Toi khong chay lai va khong phaim viem viec nay.** Lease toi la read-only verification cua phan offline, va khong co cua so DB nao duoc mo trong lane nay.
- **Hau qua:** SEC-01 **khong the ACCEPT** khi con thieu so dem credential origin. Reviewer can biet dieu nay truoc khi quyet dinh.

---

## 7. Gioi han cua bao cao nay - doc de khong doc nham

1. **Chi xac nhan 3 muc lenh user giao, o cap offline.** Khong co bang chung browser, khong Playwright, khong screenshot UI. Tieu chi 4 (nav SPA khong con link legacy) verifier chung minh bang **grep + diff**, khong phai bang **mang hinh thay**.
2. **Khong phat hien dist/.** @du/contracts resolve ve dist/ gitignored. Cac route BFF can upstream that nen offline cho 401/503 - **khong co bang chung BFF tra du lieu that tu DB that**. Tieu chi 3 xac nhan o cap *van cham den BFF*, khong phai *BFF tra dung du lieu*. Receipt chu cung phat bien do o §8 khi no noi chung cho ca hai. **Neu review can, day la thu con.**
3. **Khong A/B dao nguoc sua doi.** Read-only, khong duoc sua source. §4.3b phan biet 3 suite do bang doc import + doc loi thay vi bang thu nghiem. Ly do doi voi 2 suite da doc import la **manh**; ly do doi voi aweb06 la **do doc source**, cung la cach receipt chu lam, nhung **khong phai thi nghiem**.
4. **Wire probe chay tren loopback, khong phai deployment that.** createAdminShellServer duoc goi truc tiep voi stub store. Khong mo Postgres, khong Redis, khong Vault, khong upstream that.
5. **Stub index.html temp** cho probe lan 2 - chi de kich hoat nhanh SPA; noi dung stub khong co y nghia gi.
6. **Khong mo file nao trong repo ra khi so sanh HEAD** - dung git show HEAD: de lay ban HEAD cua shell-server.ts vao thu muc temp.

---

## 8. Rang buoc da tuan

- **READ-ONLY tren repo.** Khong sua source, khong sua test, khong tao file trong repo. File du nhat duoc ghi la file bao cao nay. Probe + stub + ban HEAD tach ra **thu muc temp he thong**.
- **Khong git add / commit / push.** 3 file san pham + 1 file test van o trang thai M / ?? nganh trong working tree.
- **Khong tick gate. Khong gan ACCEPTED. Khong phat sinh dispatch ID.**
- **Khong sua file cua lane khac** ke ca khi phat hien router.tsx dang bi lane khac sua (§4.5) va bff/handle.ts dang mang regression authz (§4.3b) - **de nguyen, chuyen Reviewer/owner**.
- **0 ky tu nhay kep ASCII trong file bao cao nay.**

---

## 9. Ket luan cho Reviewer

| Muc lenh | Khop receipt chu | Ghi chu |
|---|---|---|
| npm test -- tests/sec-or-01-legacy-read-scope-offline.test.ts | **6/6 xanh** | Test co that: assert ca status LAN body |
| npx tsc --noEmit | **exit 0, 0 loi** | |
| Wire 404 cho /admin/legacy* | **DAT** | 5 path o 2 cau hinh server, body + header dung, khong lot SPA |

**Ba muc lenh user giao: dat ca 3.** Phan offline cua SEC-01 **khong co loi de sua gap.**

**Nhung chua du de dong:**

1. **SEC-01 con BLOCKED** o tien to dem credential origin - migration 0041 chua ap dung tren DB dich (§6). Can owner khac mo cua so dung DB dung.
2. **Khong co bang chung browser.** Neu Reviewer yeu cau tieu chi 1 va 4 o cap giao dien, can mot vong Playwright rieng.
3. **bff/handle.ts:123 - regression authz /worker-instances** (High, **lane khac**, AWEB-11C): operator session nhan 200 cho inventory platform-scoped thay vi 403 (§4.3b). **Khong phai san pham SEC-01, ngoai lease.**
4. **Chinh sua 1 dong so trong receipt chu §3.2** - 14 suite / 378 test khong phai 17 / 623 (§4.6).
5. **Khong tick gate.** Quyet dinh ACCEPT thuoc Reviewer, va SEC-01 chua du dieu kien de ACCEPT (§6).

**Khong co gi trong 3 muc lenh nay bi block boi tu so 2.**